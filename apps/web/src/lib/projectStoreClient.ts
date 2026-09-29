import type { EditorHistoryEntry } from "@/lib/editorHistory";
import { bakedImportedBrepStep } from "@/lib/importedBrepSource";
import { meshGeometryKey, sampledArraySignature, textContentKey } from "@/lib/meshContentHash";
import type { PeakcadProjectMeta } from "@/lib/peakcadDocument";
import {
  dehydrateHistoryEntry,
  dehydrateShape,
  geometryBlob,
  hasGeometry,
  type MeshBlobRef,
  type MeshBlobSeed,
  type MeshBlobSink,
  type MeshPayload,
  type StoredMeshBlob,
} from "@/lib/projectMeshBlobs";
import {
  ProjectStoreHost,
  type ProjectStoreRequest,
  type ProjectStoreResponse,
  type ProjectStoreSaveRequest,
} from "@/lib/projectStoreOps";
import type { WorkplaneShape } from "@/types/sketchforge";

export type StoredProjectSnapshot = {
  revision: number;
  shapes: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  missing: string[];
};

export type ProjectStoreEntry = {
  revision: number;
  shapes: WorkplaneShape[];
  history: EditorHistoryEntry[];
  historyIndex: number;
};

/** Full undo history is written this long after the last autosave; autosaves carry only the cursor entry. */
const HISTORY_CHECKPOINT_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 120_000;

type RequestBody = ProjectStoreRequest extends infer R ? (R extends ProjectStoreRequest ? Omit<R, "requestId"> : never) : never;

// ---------------------------------------------------------------------------------------------
// Transport: dedicated worker, or the same host in-thread when workers are unavailable.

type Pending = {
  resolve: (response: ProjectStoreResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class ProjectStoreWorkerError extends Error {}

let worker: Worker | null = null;
/** Set once a worker has answered; a worker that dies before that is treated as unsupported. */
let workerAnswered = false;
let workerUnavailable = false;
let inThreadHost: ProjectStoreHost | null = null;
let nextRequestId = 1;
const pending = new Map<number, Pending>();

function rejectAll(error: Error) {
  for (const [requestId, entry] of pending) {
    pending.delete(requestId);
    clearTimeout(entry.timeout);
    entry.reject(error);
  }
}

function recycleWorker(error: Error) {
  worker?.terminate();
  worker = null;
  if (!workerAnswered) workerUnavailable = true;
  rejectAll(error);
  // Nothing the worker acknowledged is lost, but in-flight blobs may not have landed.
  persistedKeys.clear();
}

function onCollected(deleted: string[]) {
  deleted.forEach((key) => persistedKeys.delete(key));
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerUnavailable || typeof window === "undefined" || typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("../workers/projectStore.worker.ts", import.meta.url), { type: "module" });
  } catch {
    workerUnavailable = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<ProjectStoreResponse>) => {
    const response = event.data;
    workerAnswered = true;
    if (response.type === "collected") {
      onCollected(response.deleted);
      return;
    }
    const entry = pending.get(response.requestId);
    if (!entry) return;
    pending.delete(response.requestId);
    clearTimeout(entry.timeout);
    entry.resolve(response);
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    recycleWorker(new ProjectStoreWorkerError("Project storage worker failed"));
  };
  return worker;
}

/** Retry once after a worker failure; the retry lands on a fresh worker or the in-thread store. */
async function withWorkerRetry<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (!(error instanceof ProjectStoreWorkerError)) throw error;
    return task();
  }
}

function hostInThread() {
  inThreadHost ??= new ProjectStoreHost(typeof window === "undefined" ? undefined : window.indexedDB, onCollected);
  return inThreadHost;
}

function transferablesFor(request: ProjectStoreRequest): Transferable[] {
  if (request.type !== "save") return [];
  const transfer: Transferable[] = [];
  request.blobs.forEach((blob) => {
    if (blob.positions) transfer.push(blob.positions.buffer);
    if (blob.indices) transfer.push(blob.indices.buffer);
    if (blob.normals) transfer.push(blob.normals.buffer);
  });
  return transfer;
}

function send(body: RequestBody): Promise<ProjectStoreResponse> {
  const request = { ...body, requestId: nextRequestId++ } as ProjectStoreRequest;
  const active = ensureWorker();
  if (!active) return hostInThread().handle(request);
  return new Promise<ProjectStoreResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      recycleWorker(new ProjectStoreWorkerError("Project storage timed out"));
    }, REQUEST_TIMEOUT_MS);
    pending.set(request.requestId, { resolve, reject, timeout });
    try {
      active.postMessage(request, transferablesFor(request));
    } catch (error) {
      pending.delete(request.requestId);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error("Could not send project data to storage"));
    }
  });
}

function unwrapError(response: ProjectStoreResponse): never {
  throw new Error(response.type === "error" ? response.message : `Unexpected project storage reply: ${response.type}`);
}

// ---------------------------------------------------------------------------------------------
// Content keys. Hashing a mesh is O(size), so keys are memoized on the objects that carry them:
// importedMesh / vault blob objects (identity-checked) and, behind that, the positions array.

type SourceMemo = {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
  normals?: ArrayLike<number>;
  brepStep?: string;
  ref: MeshBlobRef;
};

type PositionsMemo = {
  indices?: ArrayLike<number>;
  normals?: ArrayLike<number>;
  signature: string;
  g?: string;
  stepKey?: string;
  stepLength?: number;
  stepText?: string;
};

const sourceMemo = new WeakMap<object, SourceMemo>();
const positionsMemo = new WeakMap<object, PositionsMemo>();
/** Blob keys the store is known (or already asked) to hold. */
const persistedKeys = new Set<string>();

function positionsEntry(payload: MeshPayload): PositionsMemo {
  const positions = payload.positions as unknown as object;
  const existing = positionsMemo.get(positions);
  if (existing && existing.indices === payload.indices && existing.normals === payload.normals) {
    const signature = sampledArraySignature(payload.positions);
    if (existing.signature === signature) return existing;
  }
  const entry: PositionsMemo = {
    indices: payload.indices,
    normals: payload.normals,
    signature: sampledArraySignature(payload.positions),
    ...(hasGeometry(payload) ? { g: meshGeometryKey(payload) } : {}),
  };
  positionsMemo.set(positions, entry);
  return entry;
}

function stepKeyFor(entry: PositionsMemo, text: string) {
  if (entry.stepText === text) return entry.stepKey!;
  // Seeded from a load: trust the stored key for the same text length on the same arrays.
  if (entry.stepKey && entry.stepText === undefined && entry.stepLength === text.length) {
    entry.stepText = text;
    return entry.stepKey;
  }
  entry.stepText = text;
  entry.stepLength = text.length;
  entry.stepKey = textContentKey(text);
  return entry.stepKey;
}

function refForPayload(payload: MeshPayload, source: object): MeshBlobRef {
  const bakedStep = payload.brepStep
    ?? ("sourceFormat" in source ? bakedImportedBrepStep(source as NonNullable<WorkplaneShape["importedMesh"]>) : undefined);
  const cached = sourceMemo.get(source);
  if (
    cached
    && cached.positions === payload.positions
    && cached.indices === payload.indices
    && cached.normals === payload.normals
    && cached.brepStep === bakedStep
  ) {
    return cached.ref;
  }
  const entry = positionsEntry(payload);
  const ref: MeshBlobRef = {
    ...(entry.g ? { g: entry.g } : {}),
    ...(bakedStep ? { s: stepKeyFor(entry, bakedStep) } : {}),
  };
  sourceMemo.set(source, { positions: payload.positions, indices: payload.indices, normals: payload.normals, brepStep: bakedStep, ref });
  return ref;
}

function seedMemo(seeds: MeshBlobSeed[], persisted: boolean) {
  seeds.forEach((seed) => {
    positionsMemo.set(seed.positions, {
      indices: seed.indices,
      normals: seed.normals,
      signature: sampledArraySignature(seed.positions),
      g: seed.key,
      ...(seed.stepKey ? { stepKey: seed.stepKey, stepLength: seed.stepLength } : {}),
    });
    if (persisted) {
      persistedKeys.add(seed.key);
      if (seed.stepKey) persistedKeys.add(seed.stepKey);
    }
  });
}

type SaveBatch = {
  sink: MeshBlobSink;
  /** Where each referenced key's bytes live, in case the store turns out not to have them. */
  sources: Map<string, { payload: MeshPayload; step?: string }>;
};

function createSaveBatch(): SaveBatch {
  const sources = new Map<string, { payload: MeshPayload; step?: string }>();
  const sink: MeshBlobSink = (payload, source) => {
    const ref = refForPayload(payload, source);
    if (ref.g && !sources.has(ref.g)) sources.set(ref.g, { payload });
    if (ref.s && !sources.has(ref.s)) {
      const step = payload.brepStep ?? bakedImportedBrepStep(source as NonNullable<WorkplaneShape["importedMesh"]>);
      sources.set(ref.s, { payload, step });
    }
    return ref;
  };
  return { sink, sources };
}

function blobFor(key: string, source: { payload: MeshPayload; step?: string }): StoredMeshBlob {
  return key.startsWith("s:") ? { key, text: source.step ?? "" } : geometryBlob(key, source.payload);
}

// History entries are immutable once made, so each is dehydrated once.
const historyMemo = new WeakMap<EditorHistoryEntry, { entry: EditorHistoryEntry; keys: string[]; sources: SaveBatch["sources"] }>();

function dehydrateHistory(entry: EditorHistoryEntry) {
  const cached = historyMemo.get(entry);
  if (cached) return cached;
  const batch = createSaveBatch();
  const keys = new Set<string>();
  const dehydrated = dehydrateHistoryEntry(entry, batch.sink, keys);
  const result = { entry: dehydrated, keys: [...keys], sources: batch.sources };
  historyMemo.set(entry, result);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Public API.

type HistoryCheckpointState = {
  checkpointed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  latest: ProjectStoreEntry | null;
};

const checkpointStates = new Map<string, HistoryCheckpointState>();

function checkpointState(projectId: string) {
  let state = checkpointStates.get(projectId);
  if (!state) {
    state = { checkpointed: false, timer: null, latest: null };
    checkpointStates.set(projectId, state);
  }
  return state;
}

function sendSave(projectId: string, entry: ProjectStoreEntry, withHistory: boolean) {
  return withWorkerRetry(() => sendSaveOnce(projectId, entry, withHistory));
}

async function sendSaveOnce(projectId: string, entry: ProjectStoreEntry, withHistory: boolean) {
  const batch = createSaveBatch();
  const shapeKeys = new Set<string>();
  const shapes = entry.shapes.map((shape) => dehydrateShape(shape, batch.sink, shapeKeys));
  const index = Math.min(Math.max(0, entry.historyIndex), Math.max(0, entry.history.length - 1));
  const headSource = entry.history[index];
  const head = headSource ? dehydrateHistory(headSource) : null;
  head?.sources.forEach((source, key) => batch.sources.has(key) || batch.sources.set(key, source));

  let history: EditorHistoryEntry[] | undefined;
  const historyKeys = new Set<string>();
  if (withHistory) {
    history = entry.history.map((historyEntry) => {
      const dehydrated = dehydrateHistory(historyEntry);
      dehydrated.keys.forEach((key) => historyKeys.add(key));
      dehydrated.sources.forEach((source, key) => batch.sources.has(key) || batch.sources.set(key, source));
      return dehydrated.entry;
    });
  }

  const referenced = new Set([...shapeKeys, ...(head?.keys ?? []), ...historyKeys]);
  const buildBlobs = (keys: Iterable<string>) => {
    const blobs: StoredMeshBlob[] = [];
    for (const key of keys) {
      const source = batch.sources.get(key);
      if (source) blobs.push(blobFor(key, source));
    }
    return blobs;
  };

  const body: Omit<ProjectStoreSaveRequest, "requestId" | "blobs"> = {
    type: "save",
    projectId,
    revision: entry.revision,
    shapes,
    shapeKeys: [...shapeKeys],
    ...(history ? { history, historyIndex: index, historyKeys: [...historyKeys] } : {}),
    ...(head ? { historyHead: head.entry } : {}),
    headKeys: head?.keys ?? [],
  };

  let unsent = [...referenced].filter((key) => !persistedKeys.has(key));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    unsent.forEach((key) => persistedKeys.add(key));
    let response: ProjectStoreResponse;
    try {
      response = await send({ ...body, blobs: buildBlobs(unsent) });
    } catch (error) {
      unsent.forEach((key) => persistedKeys.delete(key));
      throw error;
    }
    if (response.type === "saved") return;
    unsent.forEach((key) => persistedKeys.delete(key));
    if (response.type === "stale") return;
    if (response.type !== "missing") unwrapError(response);
    response.keys.forEach((key) => persistedKeys.delete(key));
    unsent = [...new Set([...unsent, ...response.keys])];
  }
  throw new Error("Could not save project meshes");
}

/**
 * Persist the live scene. Autosaves write shapes plus the history cursor entry and defer the full
 * undo history to a trailing checkpoint; `fullHistory` (document replaced, explicit save) writes it now.
 */
export async function saveStoredProject(projectId: string, entry: ProjectStoreEntry, options?: { fullHistory?: boolean }) {
  const state = checkpointState(projectId);
  state.latest = entry;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!state.checkpointed || options?.fullHistory) {
    await sendSave(projectId, entry, true);
    state.checkpointed = true;
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    const latest = state.latest;
    if (!latest) return;
    void sendSave(projectId, latest, true).catch(() => {
      state.checkpointed = false;
    });
  }, HISTORY_CHECKPOINT_DELAY_MS);
  await sendSave(projectId, entry, false);
}

export async function loadStoredProject(projectId: string): Promise<StoredProjectSnapshot | null> {
  const response = await withWorkerRetry(() => send({ type: "load", projectId }));
  if (response.type !== "loaded") unwrapError(response);
  const snapshot = response.snapshot;
  if (!snapshot) return null;
  seedMemo(snapshot.seeds, snapshot.seedsPersisted);
  return {
    revision: snapshot.revision,
    shapes: snapshot.shapes,
    history: snapshot.history,
    historyIndex: snapshot.historyIndex,
    missing: snapshot.missing,
  };
}

export async function deleteStoredProject(projectId: string) {
  const state = checkpointStates.get(projectId);
  if (state?.timer) clearTimeout(state.timer);
  checkpointStates.delete(projectId);
  const response = await withWorkerRetry(() => send({ type: "delete", projectId }));
  if (response.type !== "deleted") unwrapError(response);
}

/** `.peakcad` text for the stored project, built off the main thread. Null when nothing is stored. */
export async function serializeStoredProject(projectId: string, project: PeakcadProjectMeta): Promise<string | null> {
  const response = await withWorkerRetry(() => send({ type: "serialize", projectId, project }));
  if (response.type !== "serialized") unwrapError(response);
  return response.text;
}
