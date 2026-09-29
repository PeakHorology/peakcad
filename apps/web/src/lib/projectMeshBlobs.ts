import type { EditorHistoryEntry, EditorHistoryMeshBlob } from "@/lib/editorHistory";
import { meshGeometryKey, textContentKey } from "@/lib/meshContentHash";
import type { WorkplaneShape } from "@/types/sketchforge";

/**
 * Project records keep mesh payloads (tessellation + STEP text) out of line: every importedMesh
 * and history mesh-vault blob is replaced by content keys into one blob table, so a mesh shared
 * by the live scene and fifty undo entries is stored — and written — once.
 */

export const PROJECT_RECORD_FORMAT = 3;

/** `g` = geometry blob (positions/indices/normals), `s` = STEP text blob. */
export type MeshBlobRef = { g?: string; s?: string };

export type StoredMeshBlob = {
  key: string;
  positions?: Float64Array;
  indices?: Uint32Array | Float64Array;
  normals?: Float64Array;
  text?: string;
};

export type MeshPayload = {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
  normals?: ArrayLike<number>;
  brepStep?: string;
};

export type StoredProjectRecord = {
  id: string;
  revision: number;
  format: typeof PROJECT_RECORD_FORMAT;
  updatedAt: number;
  shapes: WorkplaneShape[];
  /** Last full-history checkpoint. */
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  /** Cursor entry of the newest save; may be ahead of the checkpoint. */
  historyHead?: EditorHistoryEntry;
  historyKeys?: string[];
  blobKeys: string[];
};

export type LegacyProjectRecord = {
  id: string;
  revision: number;
  shapes: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  updatedAt: number;
};

/** `source` is the importedMesh / vault blob object the payload came from (stable across saves). */
export type MeshBlobSink = (payload: MeshPayload, source: object) => MeshBlobRef;

/** Hydrated arrays by geometry key, sharing instances with the hydrated shapes. */
export type MeshBlobSeed = {
  key: string;
  positions: number[];
  indices?: number[];
  normals?: number[];
  stepKey?: string;
  stepLength?: number;
};

type ImportedMesh = NonNullable<WorkplaneShape["importedMesh"]>;
type DehydratedMesh = ImportedMesh & { meshBlobRef?: MeshBlobRef };
type DehydratedVaultBlob = EditorHistoryMeshBlob & { meshBlobRef?: MeshBlobRef };

export function isStoredProjectRecord(record: unknown): record is StoredProjectRecord {
  return Boolean(record && typeof record === "object" && (record as { format?: unknown }).format === PROJECT_RECORD_FORMAT);
}

function allUint32(values: ArrayLike<number>) {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  }
  return true;
}

export function geometryBlob(key: string, payload: MeshPayload): StoredMeshBlob {
  return {
    key,
    positions: Float64Array.from(payload.positions),
    ...(payload.indices
      ? { indices: allUint32(payload.indices) ? Uint32Array.from(payload.indices) : Float64Array.from(payload.indices) }
      : {}),
    ...(payload.normals ? { normals: Float64Array.from(payload.normals) } : {}),
  };
}

export function hasGeometry(payload: MeshPayload) {
  return payload.positions.length > 0 || Boolean(payload.indices?.length) || Boolean(payload.normals?.length);
}

/** Stateless sink: keys every payload and collects one blob per key. */
export function createCollectingSink() {
  const blobs = new Map<string, StoredMeshBlob>();
  const seeds = new Map<string, MeshBlobSeed>();
  const sink: MeshBlobSink = (payload) => {
    const ref: MeshBlobRef = {};
    if (hasGeometry(payload)) {
      const g = meshGeometryKey(payload);
      if (!blobs.has(g)) {
        blobs.set(g, geometryBlob(g, payload));
        seeds.set(g, {
          key: g,
          positions: payload.positions as number[],
          ...(payload.indices ? { indices: payload.indices as number[] } : {}),
          ...(payload.normals ? { normals: payload.normals as number[] } : {}),
        });
      }
      ref.g = g;
    }
    if (payload.brepStep) {
      const s = textContentKey(payload.brepStep);
      if (!blobs.has(s)) blobs.set(s, { key: s, text: payload.brepStep });
      ref.s = s;
      const seed = ref.g ? seeds.get(ref.g) : undefined;
      if (seed) Object.assign(seed, { stepKey: s, stepLength: payload.brepStep.length });
    }
    return ref;
  };
  return { sink, blobs, seeds };
}

function shouldStoreOutOfLine(payload: MeshPayload) {
  return payload.positions.length >= 9 || Boolean(payload.brepStep);
}

function addRefKeys(ref: MeshBlobRef, keys: Set<string>) {
  if (ref.g) keys.add(ref.g);
  if (ref.s) keys.add(ref.s);
}

function dehydrateMesh(mesh: ImportedMesh, sink: MeshBlobSink, keys: Set<string>): ImportedMesh {
  if (!shouldStoreOutOfLine(mesh)) return mesh;
  const { positions, indices, normals, brepStep, ...meta } = mesh;
  const ref = sink({ positions, indices, normals, brepStep }, mesh);
  addRefKeys(ref, keys);
  return { ...meta, positions: [], meshBlobRef: ref } as DehydratedMesh;
}

export function dehydrateShape(shape: WorkplaneShape, sink: MeshBlobSink, keys: Set<string>): WorkplaneShape {
  return {
    ...shape,
    ...(shape.importedMesh ? { importedMesh: dehydrateMesh(shape.importedMesh, sink, keys) } : {}),
    ...(shape.groupedShapes ? { groupedShapes: shape.groupedShapes.map((child) => dehydrateShape(child, sink, keys)) } : {}),
    ...(shape.edgeTreatmentHistory
      ? { edgeTreatmentHistory: shape.edgeTreatmentHistory.map((entry) => ({ ...entry, before: dehydrateShape(entry.before, sink, keys) })) }
      : {}),
    ...(shape.threadHistory
      ? { threadHistory: shape.threadHistory.map((entry) => ({ ...entry, before: dehydrateShape(entry.before, sink, keys) })) }
      : {}),
  };
}

export function dehydrateHistoryEntry(entry: EditorHistoryEntry, sink: MeshBlobSink, keys: Set<string>): EditorHistoryEntry {
  return {
    ...entry,
    shapes: entry.shapes.map((shape) => dehydrateShape(shape, sink, keys)),
    ...(entry.meshVault
      ? {
          meshVault: Object.fromEntries(
            Object.entries(entry.meshVault).map(([path, blob]) => {
              const ref = sink(blob, blob);
              addRefKeys(ref, keys);
              return [path, { positions: [], meshBlobRef: ref } as DehydratedVaultBlob];
            }),
          ),
        }
      : {}),
  };
}

type HydratedPayload = { positions: number[]; indices?: number[]; normals?: number[] };

export class MeshBlobHydrator {
  private readonly arrays = new Map<string, HydratedPayload>();
  private readonly stepByGeometry = new Map<string, { stepKey: string; stepLength: number }>();
  readonly missing = new Set<string>();

  constructor(private readonly blobs: Map<string, StoredMeshBlob>) {}

  private geometry(key: string): HydratedPayload {
    const cached = this.arrays.get(key);
    if (cached) return cached;
    const blob = this.blobs.get(key);
    if (!blob) {
      this.missing.add(key);
      return { positions: [] };
    }
    const payload: HydratedPayload = {
      positions: blob.positions ? Array.from(blob.positions) : [],
      ...(blob.indices ? { indices: Array.from(blob.indices) } : {}),
      ...(blob.normals ? { normals: Array.from(blob.normals) } : {}),
    };
    this.arrays.set(key, payload);
    return payload;
  }

  private text(key: string): string | undefined {
    const blob = this.blobs.get(key);
    if (typeof blob?.text !== "string") {
      this.missing.add(key);
      return undefined;
    }
    return blob.text;
  }

  payload(ref: MeshBlobRef): HydratedPayload & { brepStep?: string } {
    const geometry = ref.g ? this.geometry(ref.g) : { positions: [] };
    const brepStep = ref.s ? this.text(ref.s) : undefined;
    if (ref.g && ref.s && brepStep) this.stepByGeometry.set(ref.g, { stepKey: ref.s, stepLength: brepStep.length });
    return { ...geometry, ...(brepStep ? { brepStep } : {}) };
  }

  /** Hydrated arrays by key; the same array instances the shapes reference. */
  seeds(): MeshBlobSeed[] {
    return [...this.arrays.entries()].map(([key, payload]) => ({ key, ...payload, ...this.stepByGeometry.get(key) }));
  }

  shape(shape: WorkplaneShape): WorkplaneShape {
    const mesh = shape.importedMesh as DehydratedMesh | undefined;
    let importedMesh = shape.importedMesh;
    if (mesh?.meshBlobRef) {
      const { meshBlobRef, ...meta } = mesh;
      importedMesh = { ...meta, ...this.payload(meshBlobRef) };
    }
    return {
      ...shape,
      ...(importedMesh ? { importedMesh } : {}),
      ...(shape.groupedShapes ? { groupedShapes: shape.groupedShapes.map((child) => this.shape(child)) } : {}),
      ...(shape.edgeTreatmentHistory
        ? { edgeTreatmentHistory: shape.edgeTreatmentHistory.map((entry) => ({ ...entry, before: this.shape(entry.before) })) }
        : {}),
      ...(shape.threadHistory
        ? { threadHistory: shape.threadHistory.map((entry) => ({ ...entry, before: this.shape(entry.before) })) }
        : {}),
    };
  }

  historyEntry(entry: EditorHistoryEntry): EditorHistoryEntry {
    return {
      ...entry,
      shapes: entry.shapes.map((shape) => this.shape(shape)),
      ...(entry.meshVault
        ? {
            meshVault: Object.fromEntries(
              Object.entries(entry.meshVault).map(([path, blob]) => {
                const ref = (blob as DehydratedVaultBlob).meshBlobRef;
                return [path, ref ? this.payload(ref) : blob];
              }),
            ),
          }
        : {}),
    };
  }
}

/**
 * Fold the newest cursor entry into the last full checkpoint. Undo/redo land on an entry the
 * checkpoint already has; a new edit is appended after the checkpoint cursor (dropping its redo
 * tail, as the editor did). Entries made between checkpoints other than the head are lost.
 */
export function mergeHistoryHead(
  history: EditorHistoryEntry[] | undefined,
  historyIndex: number | undefined,
  head: EditorHistoryEntry | undefined,
): { history: EditorHistoryEntry[] | undefined; historyIndex: number | undefined } {
  if (!head) return { history, historyIndex };
  if (!history?.length) return { history: [head], historyIndex: 0 };
  const index = Math.min(Math.max(0, historyIndex ?? history.length - 1), history.length - 1);
  if (history[index]?.fingerprint === head.fingerprint) return { history, historyIndex: index };
  const found = history.findIndex((entry) => entry.fingerprint === head.fingerprint);
  if (found >= 0) return { history, historyIndex: found };
  const next = [...history.slice(0, index + 1), head];
  return { history: next, historyIndex: next.length - 1 };
}

/** Rewrite an old inline record (format ≤ 2) into keys + blobs without dropping anything. */
export function migrateLegacyProjectRecord(legacy: LegacyProjectRecord) {
  const { sink, blobs, seeds } = createCollectingSink();
  const shapeKeys = new Set<string>();
  const historyKeys = new Set<string>();
  const shapes = (Array.isArray(legacy.shapes) ? legacy.shapes : []).map((shape) => dehydrateShape(shape, sink, shapeKeys));
  const history = Array.isArray(legacy.history)
    ? legacy.history.map((entry) => dehydrateHistoryEntry(entry, sink, historyKeys))
    : undefined;
  const record: StoredProjectRecord = {
    id: legacy.id,
    revision: legacy.revision,
    format: PROJECT_RECORD_FORMAT,
    updatedAt: legacy.updatedAt,
    shapes,
    ...(history ? { history, historyIndex: legacy.historyIndex, historyKeys: [...historyKeys] } : {}),
    blobKeys: [...new Set([...shapeKeys, ...historyKeys])],
  };
  return { record, blobs, seeds };
}

/** Full editor snapshot from a stored record plus its blobs. */
export function hydrateStoredProjectRecord(record: StoredProjectRecord, blobs: Map<string, StoredMeshBlob>) {
  const hydrator = new MeshBlobHydrator(blobs);
  const shapes = record.shapes.map((shape) => hydrator.shape(shape));
  const merged = mergeHistoryHead(record.history, record.historyIndex, record.historyHead);
  const history = merged.history?.map((entry) => hydrator.historyEntry(entry));
  return {
    revision: record.revision,
    shapes,
    history,
    historyIndex: merged.historyIndex,
    seeds: hydrator.seeds(),
    missing: [...hydrator.missing],
  };
}
