import type { EditorHistoryEntry } from "@/lib/editorHistory";
import { buildPeakcadDocument, serializePeakcadDocument, type PeakcadProjectMeta } from "@/lib/peakcadDocument";
import {
  PROJECT_RECORD_FORMAT,
  hydrateStoredProjectRecord,
  isStoredProjectRecord,
  migrateLegacyProjectRecord,
  type LegacyProjectRecord,
  type MeshBlobSeed,
  type StoredMeshBlob,
  type StoredProjectRecord,
} from "@/lib/projectMeshBlobs";
import type { WorkplaneShape } from "@/types/sketchforge";

// Store names are the user's data: never rename or delete them in an upgrade.
export const PROJECT_SHAPES_DB_NAME = "sketchForge.projectShapes";
export const PROJECT_SHAPES_STORE_NAME = "projectShapes";
export const PROJECT_THUMBNAILS_STORE_NAME = "projectThumbnails";
export const PROJECT_MESH_BLOBS_STORE_NAME = "meshBlobs";
export const PROJECT_BLOB_REFS_STORE_NAME = "projectBlobRefs";
/** Pre-blob-store records, copied here before migration rewrites them. */
export const PROJECT_LEGACY_BACKUP_STORE_NAME = "legacyProjectShapes";
export const PROJECT_SHAPES_DB_VERSION = 3;

const GC_DELAY_MS = 20_000;

export function openProjectStoreDb(factory: IDBFactory | undefined) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!factory) {
      reject(new Error("Project shape storage is unavailable"));
      return;
    }
    const request = factory.open(PROJECT_SHAPES_DB_NAME, PROJECT_SHAPES_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_SHAPES_STORE_NAME)) {
        database.createObjectStore(PROJECT_SHAPES_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PROJECT_THUMBNAILS_STORE_NAME)) {
        database.createObjectStore(PROJECT_THUMBNAILS_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PROJECT_MESH_BLOBS_STORE_NAME)) {
        database.createObjectStore(PROJECT_MESH_BLOBS_STORE_NAME, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(PROJECT_BLOB_REFS_STORE_NAME)) {
        database.createObjectStore(PROJECT_BLOB_REFS_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PROJECT_LEGACY_BACKUP_STORE_NAME)) {
        database.createObjectStore(PROJECT_LEGACY_BACKUP_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open project shape storage"));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export type ProjectStoreSaveRequest = {
  type: "save";
  requestId: number;
  projectId: string;
  revision: number;
  shapes: WorkplaneShape[];
  shapeKeys: string[];
  /** Present on checkpoints; otherwise the stored checkpoint is carried forward. */
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  historyKeys?: string[];
  historyHead?: EditorHistoryEntry;
  headKeys: string[];
  blobs: StoredMeshBlob[];
};

export type ProjectStoreRequest =
  | ProjectStoreSaveRequest
  | { type: "load"; requestId: number; projectId: string }
  | { type: "delete"; requestId: number; projectId: string }
  | { type: "serialize"; requestId: number; projectId: string; project: PeakcadProjectMeta };

export type ProjectStoreSnapshotPayload = {
  revision: number;
  shapes: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  seeds: MeshBlobSeed[];
  /** Seeds are known to be in the blob store (false when a legacy migration could not be written). */
  seedsPersisted: boolean;
  missing: string[];
};

export type ProjectStoreResponse =
  | { requestId: number; type: "saved" }
  | { requestId: number; type: "stale" }
  | { requestId: number; type: "missing"; keys: string[] }
  | { requestId: number; type: "loaded"; snapshot: ProjectStoreSnapshotPayload | null }
  | { requestId: number; type: "deleted" }
  | { requestId: number; type: "serialized"; text: string | null }
  | { requestId: number; type: "error"; message: string }
  | { requestId: 0; type: "collected"; deleted: string[] };

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Project storage request failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Project storage transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Project storage transaction aborted"));
  });
}

async function readBlobs(store: IDBObjectStore, keys: Iterable<string>) {
  const blobs = new Map<string, StoredMeshBlob>();
  await Promise.all(
    [...new Set(keys)].map(async (key) => {
      const blob = (await requestResult(store.get(key))) as StoredMeshBlob | undefined;
      if (blob) blobs.set(key, blob);
    }),
  );
  return blobs;
}

async function readStoredRecordWithBlobs(database: IDBDatabase, projectId: string) {
  const transaction = database.transaction([PROJECT_SHAPES_STORE_NAME, PROJECT_MESH_BLOBS_STORE_NAME], "readonly");
  const done = transactionDone(transaction);
  const record = (await requestResult(transaction.objectStore(PROJECT_SHAPES_STORE_NAME).get(projectId))) as
    | StoredProjectRecord
    | LegacyProjectRecord
    | undefined;
  const blobs = isStoredProjectRecord(record)
    ? await readBlobs(transaction.objectStore(PROJECT_MESH_BLOBS_STORE_NAME), record.blobKeys)
    : new Map<string, StoredMeshBlob>();
  await done;
  return { record, blobs };
}

/** Rewrite a legacy record in place (backing up the original) unless it changed since it was read. */
async function migrateLegacyRecord(
  database: IDBDatabase,
  legacy: LegacyProjectRecord,
  { record, blobs }: ReturnType<typeof migrateLegacyProjectRecord>,
) {
  const transaction = database.transaction(
    [PROJECT_SHAPES_STORE_NAME, PROJECT_MESH_BLOBS_STORE_NAME, PROJECT_BLOB_REFS_STORE_NAME, PROJECT_LEGACY_BACKUP_STORE_NAME],
    "readwrite",
  );
  const done = transactionDone(transaction);
  const shapesStore = transaction.objectStore(PROJECT_SHAPES_STORE_NAME);
  const current = (await requestResult(shapesStore.get(legacy.id))) as StoredProjectRecord | LegacyProjectRecord | undefined;
  if (!current || isStoredProjectRecord(current) || current.revision !== legacy.revision) {
    transaction.abort();
    await done.catch(() => undefined);
    return false;
  }
  transaction.objectStore(PROJECT_LEGACY_BACKUP_STORE_NAME).put(current);
  const blobStore = transaction.objectStore(PROJECT_MESH_BLOBS_STORE_NAME);
  blobs.forEach((blob) => blobStore.put(blob));
  shapesStore.put(record);
  transaction.objectStore(PROJECT_BLOB_REFS_STORE_NAME).put({ id: record.id, keys: record.blobKeys });
  await done;
  return true;
}

export async function loadProjectRecordOp(database: IDBDatabase, projectId: string): Promise<ProjectStoreSnapshotPayload | null> {
  const { record, blobs } = await readStoredRecordWithBlobs(database, projectId);
  if (!record) return null;
  if (isStoredProjectRecord(record)) {
    const hydrated = hydrateStoredProjectRecord(record, blobs);
    return {
      revision: hydrated.revision,
      shapes: hydrated.shapes,
      history: hydrated.history,
      historyIndex: hydrated.historyIndex,
      seeds: hydrated.seeds,
      seedsPersisted: true,
      missing: hydrated.missing,
    };
  }
  // Legacy inline record: hand it back untouched; migration is best-effort and never blocks the open.
  const legacy = record as LegacyProjectRecord;
  let seedsPersisted = false;
  let seeds = new Map<string, MeshBlobSeed>();
  try {
    const migrated = migrateLegacyProjectRecord(legacy);
    seeds = migrated.seeds;
    seedsPersisted = await migrateLegacyRecord(database, legacy, migrated);
  } catch {
    seedsPersisted = false;
  }
  return {
    revision: legacy.revision,
    shapes: Array.isArray(legacy.shapes) ? legacy.shapes : [],
    history: legacy.history,
    historyIndex: legacy.historyIndex,
    seeds: [...seeds.values()],
    seedsPersisted,
    missing: [],
  };
}

export async function saveProjectRecordOp(
  database: IDBDatabase,
  request: ProjectStoreSaveRequest,
): Promise<{ type: "saved" } | { type: "stale" } | { type: "missing"; keys: string[] }> {
  const transaction = database.transaction(
    [PROJECT_SHAPES_STORE_NAME, PROJECT_MESH_BLOBS_STORE_NAME, PROJECT_BLOB_REFS_STORE_NAME],
    "readwrite",
  );
  const done = transactionDone(transaction);
  const shapesStore = transaction.objectStore(PROJECT_SHAPES_STORE_NAME);
  const blobStore = transaction.objectStore(PROJECT_MESH_BLOBS_STORE_NAME);
  const existing = (await requestResult(shapesStore.get(request.projectId))) as StoredProjectRecord | LegacyProjectRecord | undefined;
  if (existing && existing.revision > request.revision) {
    transaction.abort();
    await done.catch(() => undefined);
    return { type: "stale" };
  }

  let history = request.history;
  let historyIndex = request.historyIndex;
  let historyKeys = request.historyKeys ?? [];
  const extraBlobs: StoredMeshBlob[] = [];
  if (!history && existing) {
    if (isStoredProjectRecord(existing)) {
      history = existing.history;
      historyIndex = existing.historyIndex;
      historyKeys = existing.historyKeys ?? [];
    } else if (Array.isArray(existing.history)) {
      // Head-only save over a not-yet-migrated record: keep its undo history by migrating it here.
      const migrated = migrateLegacyProjectRecord({ ...existing, shapes: [] });
      history = migrated.record.history;
      historyIndex = migrated.record.historyIndex;
      historyKeys = migrated.record.historyKeys ?? [];
      migrated.blobs.forEach((blob) => extraBlobs.push(blob));
    }
  }

  const provided = new Set([...request.blobs, ...extraBlobs].map((blob) => blob.key));
  const referenced = new Set([...request.shapeKeys, ...request.headKeys, ...historyKeys]);
  const unprovided = [...referenced].filter((key) => !provided.has(key));
  const presence = await Promise.all(unprovided.map((key) => requestResult(blobStore.count(key))));
  const missing = unprovided.filter((_, index) => presence[index] === 0);
  if (missing.length > 0) {
    transaction.abort();
    await done.catch(() => undefined);
    return { type: "missing", keys: missing };
  }

  request.blobs.forEach((blob) => blobStore.put(blob));
  extraBlobs.forEach((blob) => blobStore.put(blob));
  const blobKeys = [...referenced];
  const record: StoredProjectRecord = {
    id: request.projectId,
    revision: request.revision,
    format: PROJECT_RECORD_FORMAT,
    updatedAt: Date.now(),
    shapes: request.shapes,
    ...(history ? { history, historyIndex, historyKeys } : {}),
    ...(request.historyHead ? { historyHead: request.historyHead } : {}),
    blobKeys,
  };
  shapesStore.put(record);
  transaction.objectStore(PROJECT_BLOB_REFS_STORE_NAME).put({ id: request.projectId, keys: blobKeys });
  await done;
  return { type: "saved" };
}

export async function deleteProjectRecordOp(database: IDBDatabase, projectId: string) {
  const transaction = database.transaction([PROJECT_SHAPES_STORE_NAME, PROJECT_BLOB_REFS_STORE_NAME], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(PROJECT_SHAPES_STORE_NAME).delete(projectId);
  transaction.objectStore(PROJECT_BLOB_REFS_STORE_NAME).delete(projectId);
  await done;
}

/** Drop blobs no project references any more. Returns the deleted keys. */
export async function collectUnreferencedBlobsOp(database: IDBDatabase) {
  const transaction = database.transaction([PROJECT_BLOB_REFS_STORE_NAME, PROJECT_MESH_BLOBS_STORE_NAME], "readwrite");
  const done = transactionDone(transaction);
  const refs = (await requestResult(transaction.objectStore(PROJECT_BLOB_REFS_STORE_NAME).getAll())) as Array<{ keys?: string[] }>;
  const live = new Set<string>();
  refs.forEach((entry) => entry.keys?.forEach((key) => live.add(key)));
  const blobStore = transaction.objectStore(PROJECT_MESH_BLOBS_STORE_NAME);
  const keys = (await requestResult(blobStore.getAllKeys())) as string[];
  const deleted = keys.filter((key) => !live.has(key));
  deleted.forEach((key) => blobStore.delete(key));
  await done;
  return deleted;
}

export async function serializeProjectDocumentOp(database: IDBDatabase, projectId: string, project: PeakcadProjectMeta) {
  const { record, blobs } = await readStoredRecordWithBlobs(database, projectId);
  if (!record) return null;
  const snapshot = isStoredProjectRecord(record)
    ? hydrateStoredProjectRecord(record, blobs)
    : { shapes: record.shapes, history: record.history, historyIndex: record.historyIndex };
  const document = buildPeakcadDocument({
    project: { ...project, revision: record.revision },
    shapes: snapshot.shapes,
    history: snapshot.history,
    historyIndex: snapshot.historyIndex,
  });
  return serializePeakcadDocument(document);
}

/** One request at a time against a cached connection; used by the worker and the in-thread fallback. */
export class ProjectStoreHost {
  private database: Promise<IDBDatabase> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private gcTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly factory: IDBFactory | undefined,
    private readonly onCollected: (deleted: string[]) => void,
  ) {}

  private connect() {
    this.database ??= openProjectStoreDb(this.factory).then(
      (database) => {
        database.onclose = () => {
          this.database = null;
        };
        const closeOnVersionChange = database.onversionchange;
        database.onversionchange = (event) => {
          this.database = null;
          closeOnVersionChange?.call(database, event);
        };
        return database;
      },
      (error: unknown) => {
        this.database = null;
        throw error;
      },
    );
    return this.database;
  }

  private scheduleCollection() {
    if (this.gcTimer !== null) clearTimeout(this.gcTimer);
    this.gcTimer = setTimeout(() => {
      this.gcTimer = null;
      this.enqueue(async () => {
        const deleted = await collectUnreferencedBlobsOp(await this.connect());
        if (deleted.length > 0) this.onCollected(deleted);
      }).catch(() => undefined);
    }, GC_DELAY_MS);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run;
    return run;
  }

  handle(request: ProjectStoreRequest): Promise<ProjectStoreResponse> {
    return this.enqueue(async (): Promise<ProjectStoreResponse> => {
      const { requestId } = request;
      try {
        const database = await this.connect();
        switch (request.type) {
          case "save": {
            const result = await saveProjectRecordOp(database, request);
            if (result.type === "saved") this.scheduleCollection();
            return { requestId, ...result };
          }
          case "load":
            return { requestId, type: "loaded", snapshot: await loadProjectRecordOp(database, request.projectId) };
          case "delete":
            await deleteProjectRecordOp(database, request.projectId);
            this.scheduleCollection();
            return { requestId, type: "deleted" };
          case "serialize":
            return { requestId, type: "serialized", text: await serializeProjectDocumentOp(database, request.projectId, request.project) };
        }
      } catch (error) {
        return { requestId, type: "error", message: error instanceof Error ? error.message : "Project storage failed" };
      }
    });
  }
}
