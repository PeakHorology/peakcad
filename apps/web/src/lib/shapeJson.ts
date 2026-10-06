import { lookup3mfPackage, remember3mfPackage } from "@/lib/threeMfSource";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import { bakedImportedBrepStep } from "@/lib/importedBrepSource";
import type { WorkplaneShape } from "@/types/sketchforge";

function numericArrayFromUnknown(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, Number);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.length === "number" && record.length >= 0) {
      return Array.from(record as unknown as ArrayLike<number>, Number);
    }
    const keys = Object.keys(record);
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
      const next: number[] = [];
      for (const key of keys) next[Number(key)] = Number(record[key]);
      return next;
    }
  }
  return undefined;
}

function jsonSafeMesh(mesh: NonNullable<WorkplaneShape["importedMesh"]>): NonNullable<WorkplaneShape["importedMesh"]> {
  const brepStep = bakedImportedBrepStep(mesh);
  return {
    ...mesh,
    ...(brepStep ? { brepStep } : {}),
    positions: Array.from(mesh.positions),
    ...(mesh.indices ? { indices: Array.from(mesh.indices) } : {}),
    ...(mesh.normals ? { normals: Array.from(mesh.normals) } : {}),
  };
}

/** Convert typed arrays to real arrays so JSON stays compact and round-trips as arrays. */
export function jsonSafeShape(shape: WorkplaneShape): WorkplaneShape {
  return canonicalizeShape({
    ...shape,
    importedMesh: shape.importedMesh ? jsonSafeMesh(shape.importedMesh) : undefined,
    groupedShapes: shape.groupedShapes?.map(jsonSafeShape),
    edgeTreatmentHistory: shape.edgeTreatmentHistory?.map((entry) => ({
      ...entry,
      before: jsonSafeShape(entry.before),
    })),
    threadHistory: shape.threadHistory?.map((entry) => ({
      ...entry,
      before: jsonSafeShape(entry.before),
    })),
  });
}

function hydrateMesh(mesh: NonNullable<WorkplaneShape["importedMesh"]>): NonNullable<WorkplaneShape["importedMesh"]> {
  const positions = numericArrayFromUnknown(mesh.positions) ?? [];
  const indices = numericArrayFromUnknown(mesh.indices);
  const normals = numericArrayFromUnknown(mesh.normals);
  return {
    ...mesh,
    positions,
    ...(indices ? { indices } : {}),
    ...(normals ? { normals } : {}),
  };
}

export function hydrateClipboardShape(shape: WorkplaneShape): WorkplaneShape {
  const source3mf = shape.source3mf
    ? remember3mfPackage(shape.source3mf)
    : lookup3mfPackage(shape.source3mfKey);
  return canonicalizeShape({
    ...shape,
    ...(source3mf ? { source3mf, source3mfKey: source3mf.key } : {}),
    importedMesh: shape.importedMesh ? hydrateMesh(shape.importedMesh) : undefined,
    groupedShapes: shape.groupedShapes?.map(hydrateClipboardShape),
    edgeTreatmentHistory: shape.edgeTreatmentHistory?.map((entry) => ({
      ...entry,
      before: hydrateClipboardShape(entry.before),
    })),
    threadHistory: shape.threadHistory?.map((entry) => ({
      ...entry,
      before: hydrateClipboardShape(entry.before),
    })),
  });
}
