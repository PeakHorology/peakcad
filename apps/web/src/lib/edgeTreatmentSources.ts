import { rebuildSketchHoleCutterIfPossible, restoreGroupedChildren } from "@/lib/editorBoolean";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

/** A rectangular solid can be cut and filleted exactly, even if a display mesh is cached on it. */
export function shapeCanBeAnalyticBox(shape: WorkplaneShape) {
  if (shape.kind !== "box" || shape.groupedShapes?.length) return false;
  return [shapeWidth(shape), shapeDepth(shape), shape.height].every((value) => Number.isFinite(value) && value > 0);
}

/** A round cylinder can be filleted exactly. An oval is a mesh. */
export function shapeCanBeAnalyticCylinder(shape: WorkplaneShape) {
  if (shape.kind !== "cylinder" || shape.groupedShapes?.length || shape.cadBrep) return false;
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  if (![width, depth, shape.height].every((value) => Number.isFinite(value) && value > 0)) return false;
  return Math.abs(width - depth) < 1e-4;
}

function flattenEdgeTreatmentPart(shape: WorkplaneShape, forceHole = false): WorkplaneShape[] {
  const hole = Boolean(shape.hole || forceHole);
  const marked = hole ? { ...shape, hole: true as const } : shape;
  const prepared = marked.hole ? rebuildSketchHoleCutterIfPossible(marked) : marked;
  // A display mesh is a cache of this recipe. Rebuild from the boxes and cylinders
  // so a slotted plate is an exact solid instead of an open triangle soup.
  if (prepared.groupedShapes?.length && !prepared.cadBrep) {
    const children = restoreGroupedChildren(prepared).flatMap((child) => flattenEdgeTreatmentPart(child, hole));
    if (children.length > 0) return children;
  }
  return [prepared];
}

/**
 * Parts the fillet/chamfer tool should rebuild.
 * Nested groups are opened so each slot cutter stays its own solid.
 * A body that already has a fillet keeps its result mesh.
 */
export function edgeTreatmentSourceParts(shape: WorkplaneShape, options?: { keepResultMesh?: boolean }): WorkplaneShape[] {
  if (options?.keepResultMesh || !shape.groupedShapes?.length) return [shape];
  const parts = flattenEdgeTreatmentPart(shape);
  return parts.length > 0 ? parts : [shape];
}
