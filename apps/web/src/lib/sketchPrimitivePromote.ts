import type { SketchProfile, WorkplaneShape } from "@/types/sketchforge";
import { isDefaultSketchPlane, resolveSketchPlane } from "@/lib/sketchPlane";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";

export type ClosedSketchPathLike = {
  closed: boolean;
  points: { x: number; z: number }[];
};

/**
 * Detect an axis-aligned rectangle from a closed path (same spirit as editor helpers).
 * Returns width/depth/center in sketch UV (x/z).
 */
export function axisAlignedRectFromPoints(points: readonly { x: number; z: number }[]) {
  if (points.length < 4) return null;
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const width = maxX - minX;
  const depth = maxZ - minZ;
  if (width < 0.05 || depth < 0.05) return null;
  // Every point must land on the AABB boundary (axis-aligned rectangle / rounded-rect corners excluded).
  const tol = Math.max(0.02, Math.min(width, depth) * 0.02);
  const onBoundary = points.every((p) => {
    const onX = Math.abs(p.x - minX) <= tol || Math.abs(p.x - maxX) <= tol;
    const onZ = Math.abs(p.z - minZ) <= tol || Math.abs(p.z - maxZ) <= tol;
    return onX || onZ;
  });
  if (!onBoundary) return null;
  const corners = points.filter((p) => {
    const onX = Math.abs(p.x - minX) <= tol || Math.abs(p.x - maxX) <= tol;
    const onZ = Math.abs(p.z - minZ) <= tol || Math.abs(p.z - maxZ) <= tol;
    return onX && onZ;
  });
  if (corners.length < 4) return null;
  // Lying on the boundary is not enough, because it says nothing about traversal order. A bow-tie
  // like (0,0)→(10,10)→(10,0)→(0,10) hits all four AABB corners and was promoted to a solid box,
  // so STEP exported filled stock while the mesh path extruded two crossed triangles. A real
  // rectangle encloses its whole bounding box; a self-crossing order encloses much less.
  if (Math.abs(signedPolygonArea(points)) < width * depth * 0.9) return null;
  return {
    width,
    depth,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

function signedPolygonArea(points: readonly { x: number; z: number }[]) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum * 0.5;
}

/** Detect a circle from a closed polyline (uniform radius about centroid). */
export function circleFromPoints(points: readonly { x: number; z: number }[]) {
  if (points.length < 8) return null;
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cz = points.reduce((s, p) => s + p.z, 0) / points.length;
  const radii = points.map((p) => Math.hypot(p.x - cx, p.z - cz));
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  if (mean < 0.05) return null;
  const maxDev = Math.max(...radii.map((r) => Math.abs(r - mean)));
  if (maxDev > mean * 0.04 + 0.05) return null;
  return { radius: mean, centerX: cx, centerZ: cz };
}

/**
 * Promote a workplane-aligned sketch extrusion to analytic box/cylinder when the
 * profile is a simple rect/circle. Face-hosted sketches keep `kind: "mesh"` and
 * rely on brepStep bake (orientation is baked into the mesh).
 */
export function promoteWorkplaneSketchToPrimitive(
  shape: WorkplaneShape,
  closedPaths: readonly ClosedSketchPathLike[],
): WorkplaneShape {
  const plane = resolveSketchPlane(shape.sketchPlane ?? shape.sketchProfile?.sketchPlane);
  if (!isDefaultSketchPlane(plane)) return shape;
  if (closedPaths.length !== 1 || !closedPaths[0]?.closed) return shape;

  const points = closedPaths[0].points;
  const rect = axisAlignedRectFromPoints(points);
  if (rect) {
    return {
      ...shape,
      kind: "box",
      width: shapeWidth(shape) || rect.width,
      depth: shapeDepth(shape) || rect.depth,
      size: Math.max(shapeWidth(shape) || rect.width, shapeDepth(shape) || rect.depth),
      // Keep importedMesh for viewport/Manifold; STEP prefers EXACT_KINDS.
    };
  }

  const circle = circleFromPoints(points);
  if (circle) {
    const diameter = Math.max(shapeWidth(shape), shapeDepth(shape), circle.radius * 2);
    return {
      ...shape,
      kind: "cylinder",
      width: diameter,
      depth: diameter,
      size: diameter,
      radius: diameter / 2,
    };
  }

  return shape;
}

export function closedPathsFromProfile(profile: SketchProfile | undefined): ClosedSketchPathLike[] {
  if (!profile?.points?.length || !profile.segments?.length) return [];
  // Lightweight: use point cloud of each closed loop via existing ordered paths when available
  // is handled by the editor; here we only expose points for promote helpers when caller
  // already has closed path samples.
  return [];
}
