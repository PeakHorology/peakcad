import type { WorkplaneShape } from "@/types/sketchforge";
import { meshGeometryKey, sampledArraySignature } from "@/lib/meshContentHash";

type ImportedMesh = NonNullable<WorkplaneShape["importedMesh"]>;

/**
 * Lazy exact B-Rep for STEP imports: import registers a thunk over the live kernel solid and the
 * first STEP export or explicit save runs exportSTEP; the text is cached here and attached to the
 * shape so that save persists it. Keyed by mesh geometry, so undo/duplicate/paste resolve too.
 * Kernel solids do not survive a reload — a project reopened before its first export or explicit
 * save exports faceted instead. Autosave never bakes (too slow for large assemblies).
 */

type PendingBake = () => Promise<string | undefined>;

const pendingByKey = new Map<string, PendingBake>();
const bakedByKey = new Map<string, string>();
const inflightByKey = new Map<string, Promise<string | undefined>>();
const keyMemo = new WeakMap<object, { indices: ArrayLike<number> | undefined; signature: string; key: string }>();

function geometryKey(mesh: ImportedMesh): string {
  const memo = keyMemo.get(mesh.positions);
  if (memo && memo.indices === mesh.indices && memo.signature === sampledArraySignature(mesh.positions)) {
    return memo.key;
  }
  const key = meshGeometryKey({ positions: mesh.positions, indices: mesh.indices });
  keyMemo.set(mesh.positions, { indices: mesh.indices, signature: sampledArraySignature(mesh.positions), key });
  return key;
}

function tracksAnything() {
  return pendingByKey.size > 0 || bakedByKey.size > 0;
}

function lazyCandidate(mesh: ImportedMesh | undefined): mesh is ImportedMesh {
  return Boolean(mesh && !mesh.brepStep && mesh.sourceFormat === "step" && mesh.positions.length >= 9 && tracksAnything());
}

export function registerPendingImportedBrep(mesh: ImportedMesh, bake: PendingBake) {
  pendingByKey.set(geometryKey(mesh), bake);
}

/** Exact B-Rep is stored on the mesh or can still be baked from a live kernel solid. */
export function importedMeshHasExactSource(mesh: ImportedMesh | undefined): boolean {
  if (!mesh) return false;
  if (mesh.brepStep) return true;
  if (!lazyCandidate(mesh)) return false;
  const key = geometryKey(mesh);
  return bakedByKey.has(key) || pendingByKey.has(key);
}

/** STEP text already baked this session (no kernel work). */
export function bakedImportedBrepStep(mesh: ImportedMesh | undefined): string | undefined {
  if (!mesh) return undefined;
  if (mesh.brepStep) return mesh.brepStep;
  if (!lazyCandidate(mesh)) return undefined;
  return bakedByKey.get(geometryKey(mesh));
}

/** Stored STEP text, or bake it now from the live kernel solid. */
export async function resolveImportedBrepStep(mesh: ImportedMesh | undefined): Promise<string | undefined> {
  if (!mesh) return undefined;
  if (mesh.brepStep) return mesh.brepStep;
  if (!lazyCandidate(mesh)) return undefined;
  const key = geometryKey(mesh);
  const baked = bakedByKey.get(key);
  if (baked) return baked;
  const inflight = inflightByKey.get(key);
  if (inflight) return inflight;
  const bake = pendingByKey.get(key);
  if (!bake) return undefined;
  const run = (async () => {
    try {
      const text = await bake();
      if (text) bakedByKey.set(key, text);
      return text;
    } catch {
      return undefined;
    } finally {
      pendingByKey.delete(key);
      inflightByKey.delete(key);
    }
  })();
  inflightByKey.set(key, run);
  return run;
}

function withBakedStep(shape: WorkplaneShape): WorkplaneShape {
  let next = shape;
  const text = bakedImportedBrepStep(shape.importedMesh);
  if (text && shape.importedMesh && !shape.importedMesh.brepStep) {
    next = { ...next, importedMesh: { ...shape.importedMesh, brepStep: text } };
  }
  if (shape.groupedShapes?.length) {
    const children = shape.groupedShapes.map(withBakedStep);
    if (children.some((child, index) => child !== shape.groupedShapes![index])) {
      next = { ...next, groupedShapes: children };
    }
  }
  return next;
}

/** Attach STEP text baked this session to shapes still missing it. Returns `shapes` when unchanged. */
export function withBakedImportedBrepSteps(shapes: WorkplaneShape[]): WorkplaneShape[] {
  if (bakedByKey.size === 0) return shapes;
  const next = shapes.map(withBakedStep);
  return next.some((shape, index) => shape !== shapes[index]) ? next : shapes;
}

type AwaitingBrepStep = { key: string; mesh: ImportedMesh; name: string };

function collectAwaitingBrepSteps(shapes: WorkplaneShape[], byKey: Map<string, AwaitingBrepStep>) {
  for (const shape of shapes) {
    const mesh = shape.importedMesh;
    if (lazyCandidate(mesh)) {
      const key = geometryKey(mesh);
      if (!byKey.has(key) && (bakedByKey.has(key) || pendingByKey.has(key))) {
        byKey.set(key, { key, mesh, name: shape.name });
      }
    }
    if (shape.groupedShapes?.length) collectAwaitingBrepSteps(shape.groupedShapes, byKey);
  }
}

/** Distinct imported bodies that can still produce exact STEP text but do not carry it yet. */
export function importedBrepStepsAwaitingSave(shapes: WorkplaneShape[]): AwaitingBrepStep[] {
  if (!tracksAnything()) return [];
  const byKey = new Map<string, AwaitingBrepStep>();
  collectAwaitingBrepSteps(shapes, byKey);
  return [...byKey.values()];
}

export type ImportedBrepSaveBake = {
  shapes: WorkplaneShape[];
  baked: number;
  /** Bodies whose kernel solid could not produce STEP text; they keep exporting faceted. */
  failedNames: string[];
};

/**
 * Bake exact STEP text for every body in `shapes` that still has a live kernel solid, one body at
 * a time, and return the shapes with the text attached. A failing body does not stop the rest.
 */
export async function bakeImportedBrepStepsForSave(
  shapes: WorkplaneShape[],
  onProgress?: (done: number, total: number) => void | Promise<void>,
): Promise<ImportedBrepSaveBake> {
  const awaiting = importedBrepStepsAwaitingSave(shapes);
  const failedNames: string[] = [];
  for (let index = 0; index < awaiting.length; index += 1) {
    const text = await resolveImportedBrepStep(awaiting[index].mesh);
    if (!text) failedNames.push(awaiting[index].name);
    await onProgress?.(index + 1, awaiting.length);
  }
  return {
    shapes: withBakedImportedBrepSteps(shapes),
    baked: awaiting.length - failedNames.length,
    failedNames,
  };
}
