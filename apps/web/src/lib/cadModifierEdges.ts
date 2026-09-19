/** Minimum dihedral (degrees) at which a CAD edge is drawn as a hard outline. */
export const CAD_DISPLAY_EDGE_MIN_ANGLE = 0.75;

/**
 * Hole rims (plane ∩ cylinder) are ~90°. Keep a modest floor so near-tangent
 * fillet rails can still be treated as treatment-detail after an earlier fillet.
 */
export const HOLE_RIM_MIN_ANGLE = 20;

const CURVED_SURFACE_TYPES = new Set([
  "cylinder",
  "cone",
  "sphere",
  "torus",
  "bspline",
  "bezier",
  "offset",
  "revolution",
  "extrusion",
]);

export type CadEdgeClassificationInput = {
  curveType: string;
  surfaceTypes: string[];
  angle: number;
  manifold: boolean;
  boundary: boolean;
  pointCount: number;
  faceAreas: number[];
};

export function isCurvedCadEdge(curveType: string) {
  return curveType.toLowerCase() !== "line";
}

export function touchesCurvedCadSurface(surfaceTypes: string[]) {
  return surfaceTypes.some((surfaceType) => CURVED_SURFACE_TYPES.has(surfaceType.toLowerCase()));
}

/** Circle/ellipse sitting on a planar face and a cylindrical or conical hole wall. */
export function isAnalyticHoleRim(edge: Pick<CadEdgeClassificationInput, "curveType" | "surfaceTypes">) {
  const curve = edge.curveType.toLowerCase();
  if (curve !== "circle" && curve !== "ellipse" && curve !== "bspline" && curve !== "unknown") return false;
  const surfaces = new Set(edge.surfaceTypes.map((surfaceType) => surfaceType.toLowerCase()));
  return surfaces.has("plane") && (surfaces.has("cylinder") || surfaces.has("cone"));
}

/**
 * Sharp curved feature edges (hole rims, rounded-pocket lips) must stay pickable
 * after an earlier chamfer/fillet. Straight rails on small blend faces stay hidden.
 */
export function isHoleRimFeatureEdge(edge: Pick<CadEdgeClassificationInput, "curveType" | "angle">) {
  if (!isCurvedCadEdge(edge.curveType)) return false;
  const effectiveAngle = Math.min(edge.angle, 180 - edge.angle);
  return effectiveAngle + 1e-3 >= HOLE_RIM_MIN_ANGLE;
}

export function isDisplayCadEdge(edge: Pick<CadEdgeClassificationInput, "manifold" | "boundary" | "pointCount" | "angle" | "surfaceTypes" | "curveType">) {
  if (!edge.manifold || edge.boundary || edge.pointCount < 6) return false;
  const effectiveAngle = Math.min(edge.angle, 180 - edge.angle);
  return effectiveAngle + 1e-3 >= CAD_DISPLAY_EDGE_MIN_ANGLE
    || touchesCurvedCadSurface(edge.surfaceTypes)
    || isCurvedCadEdge(edge.curveType);
}

export function treatmentDetailFaceAreaLimit(faceAreas: number[]) {
  const finiteAreas = faceAreas.filter((area) => Number.isFinite(area) && area > 1e-8);
  if (finiteAreas.length === 0) return 0;
  return Math.max(1e-8, Math.max(...finiteAreas) * 0.3);
}

export function touchesTreatmentDetailFace(faceAreas: number[], areaLimit: number) {
  return areaLimit > 0 && faceAreas.some((area) => area > 0 && area <= areaLimit);
}

export function isModifierDisplayCadEdge(edge: CadEdgeClassificationInput, treatmentAreaLimit: number) {
  if (!isDisplayCadEdge(edge)) return false;
  if (treatmentAreaLimit <= 0) return true;
  if (isHoleRimFeatureEdge(edge) || isAnalyticHoleRim(edge)) return true;
  return !touchesTreatmentDetailFace(edge.faceAreas, treatmentAreaLimit);
}

export function isSelectableModifierEdge(edge: Pick<CadEdgeClassificationInput, "manifold" | "boundary" | "pointCount">) {
  return edge.manifold && !edge.boundary && edge.pointCount >= 6;
}

/**
 * Recover a usable dihedral when UV sampling fails on a closed circle (seam /
 * tessellation drift) so the rim still passes the sharp-angle picker.
 */
export function recoveredHoleRimClassification(edge: Pick<CadEdgeClassificationInput, "curveType" | "surfaceTypes" | "angle" | "manifold" | "boundary">) {
  if (edge.manifold && !edge.boundary && edge.angle + 1e-3 >= HOLE_RIM_MIN_ANGLE) return edge;
  if (!isAnalyticHoleRim(edge)) return edge;
  return { ...edge, angle: 90, manifold: true, boundary: false };
}
