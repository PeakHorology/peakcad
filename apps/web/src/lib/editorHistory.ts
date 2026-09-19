import type { WorkplaneShape } from "@/types/sketchforge";
import { hardwareProfile } from "@/lib/desktopHardware";
import { canonicalizeShape } from "@/lib/workplaneShapes";

const profile = hardwareProfile();
export const MAX_EDITOR_HISTORY_ENTRIES = profile.historyEntries;
export const MAX_EDITOR_HISTORY_BYTES = profile.historyBytes;

/** Tessellation / STEP payloads relocated out of per-shape history clones. */
export type EditorHistoryMeshBlob = {
  positions: number[];
  indices?: number[];
  normals?: number[];
  brepStep?: string;
};

export type EditorHistoryMeshVault = Record<string, EditorHistoryMeshBlob>;

export type EditorHistoryEntry = {
  shapes: WorkplaneShape[];
  selectedIds: string[];
  fingerprint: string;
  estimatedBytes: number;
  /** Large mesh payloads keyed by shape path (see compactHistoryShape). */
  meshVault?: EditorHistoryMeshVault;
};

export type EditorHistoryState = {
  entries: EditorHistoryEntry[];
  index: number;
};

function meshVaultKey(path: string) {
  return path;
}

function hashNumberArray(values: ArrayLike<number>, sampleCount = 48) {
  let hash = values.length + 2166136261;
  if (values.length === 0) return hash >>> 0;
  const step = Math.max(1, Math.floor(values.length / sampleCount));
  for (let index = 0; index < values.length; index += step) {
    hash = Math.imul(hash ^ (Math.floor(values[index] * 1000) | 0), 16777619);
  }
  hash = Math.imul(hash ^ (Math.floor(values[0] * 1000) | 0), 16777619);
  hash = Math.imul(hash ^ (Math.floor(values[values.length - 1] * 1000) | 0), 16777619);
  return hash >>> 0;
}

/** Lightweight shape payload for fingerprints (avoids JSON of full mesh arrays). */
function shapeFingerprintPayload(shape: WorkplaneShape): unknown {
  const mesh = shape.importedMesh;
  return {
    id: shape.id,
    name: shape.name,
    kind: shape.kind,
    color: shape.color,
    hole: shape.hole || undefined,
    x: shape.x,
    z: shape.z,
    elevation: shape.elevation ?? 0,
    size: shape.size,
    width: shape.width,
    depth: shape.depth,
    height: shape.height,
    rotation: shape.rotation ?? 0,
    rotationX: shape.rotationX ?? 0,
    rotationZ: shape.rotationZ ?? 0,
    mirrorX: shape.mirrorX || undefined,
    mirrorY: shape.mirrorY || undefined,
    mirrorZ: shape.mirrorZ || undefined,
    radius: shape.radius,
    steps: shape.steps,
    sides: shape.sides,
    bevel: shape.bevel,
    segments: shape.segments,
    topRadius: shape.topRadius,
    baseRadius: shape.baseRadius,
    leftAngle: shape.leftAngle,
    rightAngle: shape.rightAngle,
    text: shape.text,
    font: shape.font,
    locked: shape.locked || undefined,
    hidden: shape.hidden || undefined,
    construction: shape.construction || undefined,
    patternFeature: shape.patternFeature,
    holeSpec: shape.holeSpec,
    csg: shape.csg,
    groupedBaseWidth: shape.groupedBaseWidth,
    groupedBaseDepth: shape.groupedBaseDepth,
    groupedBaseHeight: shape.groupedBaseHeight,
    edgeTreatments: shape.edgeTreatments,
    cadDisplayEdgesVersion: shape.cadDisplayEdgesVersion,
    edgeResizeMode: shape.edgeResizeMode,
    cadBrepLength: shape.cadBrep?.length ?? 0,
    cadBrepFrame: shape.cadBrepFrame,
    cadPrimitiveFrame: shape.cadPrimitiveFrame,
    sketchId: shape.sketchId,
    sketchFinish: shape.sketchFinish,
    sketchProfileIds: shape.sketchProfileIds,
    sketchPlane: shape.sketchPlane,
    sketchProfile: shape.sketchProfile,
    sketchDoc: shape.sketchDoc,
    imagePlate: shape.imagePlate
      ? {
          mimeType: shape.imagePlate.mimeType,
          pixelWidth: shape.imagePlate.pixelWidth,
          pixelHeight: shape.imagePlate.pixelHeight,
          dataUrlLen: shape.imagePlate.dataUrl.length,
        }
      : undefined,
    importedMesh: mesh
      ? {
          baseWidth: mesh.baseWidth,
          baseDepth: mesh.baseDepth,
          baseHeight: mesh.baseHeight,
          triangleCount: mesh.triangleCount,
          sourceFormat: mesh.sourceFormat,
          positionsLen: mesh.positions.length,
          positionsHash: hashNumberArray(mesh.positions),
          indicesLen: mesh.indices?.length ?? 0,
          normalsLen: mesh.normals?.length ?? 0,
          brepStepLen: mesh.brepStep?.length ?? 0,
        }
      : undefined,
    groupedShapes: shape.groupedShapes?.map(shapeFingerprintPayload),
    edgeTreatmentHistory: shape.edgeTreatmentHistory?.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      feature: entry.feature,
      before: shapeFingerprintPayload(entry.before),
    })),
  };
}

/**
 * Strip evaluated CSG mesh caches and relocate import tessellation / brepStep into
 * `vault` so undo snapshots stay small. Children + csg meta remain the source of truth
 * for boolean bodies; imports are restored via {@link expandHistoryShapes}.
 *
 * IMPORTANT: never use compacted history shapes as the live scene / project
 * `shapes` payload without expanding the vault first.
 */
export function compactHistoryShape(
  shape: WorkplaneShape,
  vault: EditorHistoryMeshVault = {},
  path = shape.id,
): WorkplaneShape {
  const groupedShapes = shape.groupedShapes?.map((child, index) =>
    compactHistoryShape(child, vault, `${path}/${child.id || index}`),
  );
  let next: WorkplaneShape = groupedShapes ? { ...shape, groupedShapes } : { ...shape };

  if (next.edgeTreatmentHistory?.length) {
    next = {
      ...next,
      edgeTreatmentHistory: next.edgeTreatmentHistory.map((entry, index) => ({
        ...entry,
        before: compactHistoryShape(entry.before, vault, `${path}/edgeBefore/${index}/${entry.before.id}`),
      })),
    };
  }

  const op = next.csg?.op;
  if (next.csg && next.groupedShapes?.length && op && op !== "assemble" && next.importedMesh) {
    // Vault tessellation + baked STEP so undo can restore instantly. Remeshing every boolean
    // body on undo/redo was the main source of multi-second history stalls.
    const mesh = next.importedMesh;
    const hasTessellation = mesh.positions.length >= 9;
    if (hasTessellation || mesh.brepStep) {
      vault[meshVaultKey(path)] = {
        positions: mesh.positions,
        ...(mesh.indices ? { indices: mesh.indices } : {}),
        ...(mesh.normals ? { normals: mesh.normals } : {}),
        ...(mesh.brepStep ? { brepStep: mesh.brepStep } : {}),
      };
    }
    next = {
      ...next,
      importedMesh: {
        positions: [],
        baseWidth: mesh.baseWidth,
        baseDepth: mesh.baseDepth,
        baseHeight: mesh.baseHeight,
        triangleCount: hasTessellation ? mesh.triangleCount : 0,
        sourceFormat: mesh.sourceFormat,
      },
      // Keep a live dirty flag so an unevaluated boolean still remeshes on restore.
      csg: { ...next.csg, dirty: hasTessellation ? Boolean(next.csg.dirty) : true },
    };
    return next;
  }

  if (next.importedMesh && (next.importedMesh.positions.length >= 9 || next.importedMesh.brepStep)) {
    const mesh = next.importedMesh;
    vault[meshVaultKey(path)] = {
      positions: mesh.positions,
      ...(mesh.indices ? { indices: mesh.indices } : {}),
      ...(mesh.normals ? { normals: mesh.normals } : {}),
      ...(mesh.brepStep ? { brepStep: mesh.brepStep } : {}),
    };
    next = {
      ...next,
      importedMesh: {
        positions: [],
        baseWidth: mesh.baseWidth,
        baseDepth: mesh.baseDepth,
        baseHeight: mesh.baseHeight,
        triangleCount: mesh.triangleCount,
        sourceFormat: mesh.sourceFormat,
      },
    };
  }

  return next;
}

export function compactHistoryShapes(
  shapes: WorkplaneShape[],
  vault: EditorHistoryMeshVault = {},
): WorkplaneShape[] {
  return shapes.map((shape) => compactHistoryShape(shape, vault, shape.id));
}

/** Reattach vaulted mesh payloads onto compacted history shapes. */
export function expandHistoryShapes(
  shapes: WorkplaneShape[],
  vault: EditorHistoryMeshVault | undefined,
): WorkplaneShape[] {
  if (!vault || !Object.keys(vault).length) return shapes;

  const expand = (shape: WorkplaneShape, path: string): WorkplaneShape => {
    const groupedShapes = shape.groupedShapes?.map((child, index) =>
      expand(child, `${path}/${child.id || index}`),
    );
    let next: WorkplaneShape = groupedShapes ? { ...shape, groupedShapes } : { ...shape };

    if (next.edgeTreatmentHistory?.length) {
      next = {
        ...next,
        edgeTreatmentHistory: next.edgeTreatmentHistory.map((entry, index) => ({
          ...entry,
          before: expand(entry.before, `${path}/edgeBefore/${index}/${entry.before.id}`),
        })),
      };
    }

    const blob = vault[meshVaultKey(path)];
    if (blob && next.importedMesh) {
      next = {
        ...next,
        importedMesh: {
          ...next.importedMesh,
          positions: blob.positions,
          ...(blob.indices ? { indices: blob.indices } : {}),
          ...(blob.normals ? { normals: blob.normals } : {}),
          ...(blob.brepStep ? { brepStep: blob.brepStep } : {}),
          triangleCount:
            next.importedMesh.triangleCount > 0
              ? next.importedMesh.triangleCount
              : Math.floor(blob.positions.length / 9),
        },
      };
    }
    return next;
  };

  return shapes.map((shape) => expand(shape, shape.id));
}

export function historyShapeNeedsRemesh(shape: WorkplaneShape): boolean {
  const op = shape.csg?.op;
  if (!shape.csg || !shape.groupedShapes?.length || !op || op === "assemble") return false;
  if (shape.csg.dirty) return true;
  return !shape.importedMesh || shape.importedMesh.positions.length < 9;
}

/** Project-load heal only — a dirty flag with a usable mesh must not remesh (that snaps moved groups back). */
export function historyShapeMissingTessellation(shape: WorkplaneShape): boolean {
  const op = shape.csg?.op;
  if (!shape.csg || !shape.groupedShapes?.length || !op || op === "assemble") return false;
  return !shape.importedMesh || shape.importedMesh.positions.length < 9;
}

export function serializedSceneSignature(shapes: WorkplaneShape[]) {
  const serialized = JSON.stringify(shapes.map(shapeFingerprintPayload));
  let hashA = 2166136261;
  let hashB = 5381;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 16777619);
    hashB = Math.imul(hashB, 33) ^ code;
  }
  return {
    fingerprint: `${serialized.length}:${hashA >>> 0}:${hashB >>> 0}`,
    estimatedBytes: serialized.length * 2,
  };
}

export function projectShapesFingerprint(shapes: WorkplaneShape[]) {
  return serializedSceneSignature(shapes).fingerprint;
}

function estimateHistoryEntryBytes(shapes: WorkplaneShape[], vault: EditorHistoryMeshVault) {
  let bytes = serializedSceneSignature(shapes).estimatedBytes;
  for (const blob of Object.values(vault)) {
    bytes += blob.positions.length * 8;
    bytes += (blob.indices?.length ?? 0) * 4;
    bytes += (blob.normals?.length ?? 0) * 8;
    bytes += blob.brepStep?.length ?? 0;
  }
  return bytes;
}

export function editorHistoryEntry(shapes: WorkplaneShape[], selectedIds: string[]): EditorHistoryEntry {
  const liveCanonical = shapes.map(canonicalizeShape);
  // Fingerprint the live scene before stripping meshes so undo dedupe stays accurate.
  const signature = serializedSceneSignature(liveCanonical);
  const vault: EditorHistoryMeshVault = {};
  const canonicalShapes = compactHistoryShapes(liveCanonical, vault);
  const validSelection = selectedIds.filter((id, index) => selectedIds.indexOf(id) === index && canonicalShapes.some((shape) => shape.id === id));
  return {
    shapes: canonicalShapes,
    selectedIds: validSelection,
    fingerprint: signature.fingerprint,
    estimatedBytes: estimateHistoryEntryBytes(canonicalShapes, vault),
    ...(Object.keys(vault).length ? { meshVault: vault } : {}),
  };
}

export function boundedEditorHistory(entries: EditorHistoryEntry[]) {
  const bounded = entries.slice(-MAX_EDITOR_HISTORY_ENTRIES);
  let totalBytes = bounded.reduce((total, entry) => total + entry.estimatedBytes, 0);
  while (bounded.length > 2 && totalBytes > MAX_EDITOR_HISTORY_BYTES) {
    const removed = bounded.shift();
    totalBytes -= removed?.estimatedBytes ?? 0;
  }
  return bounded;
}

export function appendEditorHistorySnapshot(entries: EditorHistoryEntry[], requestedIndex: number, entry: EditorHistoryEntry) {
  const index = Math.min(Math.max(0, requestedIndex), Math.max(0, entries.length - 1));
  const current = entries[index];
  if (current?.fingerprint === entry.fingerprint) {
    const selectionChanged = current.selectedIds.join("\0") !== entry.selectedIds.join("\0");
    return {
      entries: selectionChanged ? entries.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, selectedIds: entry.selectedIds } : candidate) : entries,
      index,
      changed: false,
    };
  }

  const nextEntries = boundedEditorHistory([...entries.slice(0, index + 1), entry]);
  return { entries: nextEntries, index: nextEntries.length - 1, changed: true };
}

export function hydrateEditorHistoryState(
  currentShapes: WorkplaneShape[],
  storedEntries: EditorHistoryEntry[] | undefined,
  requestedIndex: number | undefined,
): EditorHistoryState {
  const fallback = editorHistoryEntry(currentShapes, []);
  if (!Array.isArray(storedEntries) || storedEntries.length === 0) {
    return { entries: [fallback], index: 0 };
  }

  try {
    const normalized = storedEntries.map((entry) => {
      // Prefer already-compacted entries (with vault) — avoid re-walking every mesh.
      if (
        entry
        && typeof entry.fingerprint === "string"
        && Array.isArray(entry.shapes)
        && typeof entry.estimatedBytes === "number"
      ) {
        return {
          shapes: entry.shapes,
          selectedIds: Array.isArray(entry.selectedIds)
            ? entry.selectedIds.filter((id): id is string => typeof id === "string")
            : [],
          fingerprint: entry.fingerprint,
          estimatedBytes: entry.estimatedBytes,
          ...(entry.meshVault ? { meshVault: entry.meshVault } : {}),
        } satisfies EditorHistoryEntry;
      }
      return editorHistoryEntry(
        Array.isArray(entry?.shapes) ? entry.shapes : [],
        Array.isArray(entry?.selectedIds) ? entry.selectedIds.filter((id): id is string => typeof id === "string") : [],
      );
    });
    const index = Number.isInteger(requestedIndex)
      ? Math.min(Math.max(0, requestedIndex as number), normalized.length - 1)
      : normalized.length - 1;
    if (normalized[index]?.fingerprint !== fallback.fingerprint) {
      return { entries: [fallback], index: 0 };
    }

    const entries = boundedEditorHistory(normalized);
    const boundedIndex = index - (normalized.length - entries.length);
    if (boundedIndex < 0 || boundedIndex >= entries.length) {
      return { entries: [fallback], index: 0 };
    }
    return { entries, index: boundedIndex };
  } catch {
    return { entries: [fallback], index: 0 };
  }
}
