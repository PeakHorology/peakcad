import type { WorkplaneShape } from "@/types/sketchforge";
import { isEvaluatedCsgBody } from "@/lib/csgTree";
import { NATIVE_FACETED_KINDS, shapeSupportsExactNativeBrep } from "@/lib/shapeBrep";
import { aabbsOverlap, worldAabb } from "@/lib/shapeBounds";

export type ShapeExportQualityHint =
  | "exact"
  | "faceted"
  | "pending"
  /** Nothing the STEP writer can consume; the body would be dropped from the file. */
  | "unsupported";

export type StepPreflightRow = {
  name: string;
  kind: WorkplaneShape["kind"];
  quality: ShapeExportQualityHint;
  detail: string;
};

/** True when this leaf can participate in exact OCCT CSG / STEP. */
export function shapeHasExactBrepSource(shape: WorkplaneShape): boolean {
  if (shape.cadBrep) return true;
  if (shape.importedMesh?.brepStep) return true;
  if (shapeSupportsExactNativeBrep(shape)) return true;
  return false;
}

/**
 * Honest inspector/export badge for a body.
 * Native exact kinds and stored B-Rep → exact; otherwise faceted/pending.
 */
export function shapeExportQualityHint(shape: WorkplaneShape): ShapeExportQualityHint {
  if (shape.csg?.dirty) return "pending";
  if (isEvaluatedCsgBody(shape)) {
    if (shape.importedMesh?.brepStep || shape.cadBrep) return "exact";
    // Evaluated Manifold mesh without bake yet — still downloadable as faceted.
    if (shape.importedMesh?.positions && shape.importedMesh.positions.length >= 9) return "faceted";
    return "pending";
  }
  if (shape.cadBrep || shape.importedMesh?.brepStep) return "exact";
  if (shapeSupportsExactNativeBrep(shape)) return "exact";
  if (shape.importedMesh?.positions && shape.importedMesh.positions.length >= 9) return "faceted";
  // A faceted-by-nature kind whose geometry only exists in the viewport — text glyphs built
  // from a font, an icosahedron — gives the STEP writer nothing to consume, so the body is
  // dropped from the file. Reporting "faceted" here promised an export that never happened.
  if (NATIVE_FACETED_KINDS.has(shape.kind)) return "unsupported";
  return "pending";
}

export function shapeExportQualityLabel(quality: ShapeExportQualityHint): string {
  if (quality === "exact") return "CAD ready";
  if (quality === "faceted") return "Mesh";
  if (quality === "unsupported") return "No STEP";
  return "Pending";
}

export function shapeExportQualityTitle(quality: ShapeExportQualityHint): string {
  if (quality === "exact") return "Exact CAD geometry available for STEP export";
  if (quality === "faceted") return "Exports as faceted STEP (mesh-based interchange)";
  if (quality === "unsupported") return "Cannot be written to STEP — export this body as STL or 3MF instead";
  return "Exact bake pending — Group or export will finish CAD geometry when possible";
}

/**
 * Loose cutters (holes that are not part of an evaluated body) that the STEP writer will bore
 * through anything they overlap. A cutter with no exact B-Rep is tessellated first, and cutting a
 * part with a faceted tool leaves faceted walls, so the part is no longer exact however clean its
 * own geometry is.
 */
function facetedLooseCutters(shapes: WorkplaneShape[]): WorkplaneShape[] {
  return shapes.filter((shape) =>
    shape.hole
    && !shape.hidden
    && !shape.suppressed
    && !shape.csg?.suppressed
    && !isEvaluatedCsgBody(shape)
    && !shapeHasExactBrepSource(shape));
}

/** Names of the faceted cutters that reach this part, in the STEP writer's own terms. */
function facetedCuttersReaching(shape: WorkplaneShape, cutters: WorkplaneShape[]): WorkplaneShape[] {
  // An evaluated body already carries its cuts, and the writer does not re-cut it.
  if (cutters.length === 0 || isEvaluatedCsgBody(shape)) return [];
  const box = worldAabb(shape);
  return cutters.filter((cutter) => aabbsOverlap(box, worldAabb(cutter)));
}

/**
 * Badge for a body as it will actually be written, given the rest of the scene.
 *
 * The per-shape hint only looks at the body itself, so a pristine analytic part sitting under a
 * mesh cutter reported "exact" right up until the download handed back faceted walls.
 */
export function shapeExportQualityHintInScene(
  shape: WorkplaneShape,
  shapes: readonly WorkplaneShape[],
): ShapeExportQualityHint {
  const quality = shapeExportQualityHint(shape);
  if (quality !== "exact") return quality;
  return facetedCuttersReaching(shape, facetedLooseCutters([...shapes])).length > 0 ? "faceted" : "exact";
}

/** Preflight rows for Download STEP (before kernel work). */
export function buildStepExportPreflight(shapes: WorkplaneShape[]): StepPreflightRow[] {
  const cutters = facetedLooseCutters(shapes);
  return shapes
    .filter((shape) => !shape.hole && !shape.hidden && !shape.suppressed && !shape.csg?.suppressed)
    .map((shape) => {
      let quality = shapeExportQualityHint(shape);
      let detail = "";
      if (quality === "exact") {
        const reaching = facetedCuttersReaching(shape, cutters);
        if (reaching.length > 0) {
          quality = "faceted";
          const first = reaching[0].name || "a mesh cutter";
          detail = reaching.length === 1
            ? `cut by ${first} — a faceted cutter, so the cut walls are faceted`
            : `cut by ${reaching.length} faceted cutters, so the cut walls are faceted`;
        } else {
          detail = shape.importedMesh?.brepStep || shape.cadBrep
            ? "stored B-Rep"
            : "native analytic solid";
        }
      } else if (quality === "faceted") {
        detail = NATIVE_FACETED_KINDS.has(shape.kind)
          ? "tessellated / specialty solid"
          : "mesh-based interchange";
      } else if (quality === "unsupported") {
        detail = "no STEP geometry — export as STL or 3MF";
      } else {
        detail = shape.csg?.dirty ? "CSG needs remesh" : "waiting for bake";
      }
      return { name: shape.name, kind: shape.kind, quality, detail };
    });
}

export function selectionSupportsOcctCsg(shapes: WorkplaneShape[]): boolean {
  const active = shapes.filter((shape) => !shape.suppressed && !shape.csg?.suppressed && !shape.locked);
  if (active.length < 1) return false;
  const hasSolid = active.some((shape) => !shape.hole);
  if (!hasSolid) return false;
  return active.every((shape) => shapeHasExactBrepSource(shape));
}
