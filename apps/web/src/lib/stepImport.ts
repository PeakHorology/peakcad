import type { WorkplaneShape } from "@/types/sketchforge";
import { importTriangleSoup } from "@/lib/stlImport";
import { loadBrepWithOcct } from "@/lib/brepKernel";
import { quaternionToAxisAngleDegrees } from "@/lib/meshSeatOrientation";

const STEP_EXTENSIONS = new Set(["step", "stp"]);

export function isStepFile(fileName: string): boolean {
  return STEP_EXTENSIONS.has(fileName.split(".").pop()?.toLowerCase() ?? "");
}

export async function importedShapeFromStep(fileName: string, buffer: ArrayBuffer): Promise<WorkplaneShape> {
  const brep = await loadBrepWithOcct();

  const imported = await brep.importSTEP(new Blob([buffer]));
  if (!imported.ok) {
    throw new Error(`Could not read STEP: ${String(imported.error.message ?? imported.error)}`);
  }

  // STEP/CAD space is Z-up; SketchForge is Y-up. Rotating −90° about X maps CAD
  // +Z (up) to SketchForge +Y — the inverse of the exporter's +90°·X. Rigid
  // kernel ops (rotate/translate) are used throughout normalization because they
  // preserve the exact geometry; a matrix transform here corrupts later export.
  const flipped = brep.rotate(imported.value, -90, { axis: [1, 0, 0] });
  const tess = brep.mesh(flipped);
  if (tess.vertices.length < 9) {
    throw new Error("STEP file has no solid geometry to import");
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const hasNormals = tess.normals.length === tess.vertices.length;
  for (let i = 0; i < tess.triangles.length; i += 1) {
    const v = tess.triangles[i] * 3;
    positions.push(tess.vertices[v], tess.vertices[v + 1], tess.vertices[v + 2]);
    if (hasNormals) {
      normals.push(tess.normals[v], tess.normals[v + 1], tess.normals[v + 2]);
    }
  }

  // Seat on the largest flat face, then recenter. Apply the same rigid ops to the
  // stored B-Rep so display mesh and exact geometry share one local frame.
  const { shape, seatRotation, seatTranslation } = importTriangleSoup(
    fileName,
    positions,
    hasNormals ? normals : undefined,
    "step",
  );

  // Apply seat as rigid kernel ops only when needed — avoid redundant rotate/translate
  // before the single exportSTEP (display mesh is already seated via importTriangleSoup).
  let normalized = flipped;
  const { axis, angle } = quaternionToAxisAngleDegrees(seatRotation);
  const hasRotation = Math.abs(angle) > 1e-6;
  const hasTranslation = Math.hypot(seatTranslation.x, seatTranslation.y, seatTranslation.z) > 1e-6;
  if (hasRotation) {
    normalized = brep.rotate(normalized, angle, { axis });
  }
  if (hasTranslation) {
    normalized = brep.translate(normalized, [seatTranslation.x, seatTranslation.y, seatTranslation.z]);
  }

  const exported = brep.exportSTEP(normalized);
  const stepText = exported.ok ? await exported.value.text() : undefined;
  if (shape.importedMesh && stepText) {
    shape.importedMesh.brepStep = stepText;
  }
  return shape;
}
