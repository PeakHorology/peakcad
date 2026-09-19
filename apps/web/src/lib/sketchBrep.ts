import type { SketchPlane, SketchProfile, WorkplaneShape } from "@/types/sketchforge";
import { loadBrepWithOcct, type Brep, type BrepSolid } from "@/lib/brepKernel";
import { faceHoleOvershootMm } from "@/lib/csgTree";
import { resolveSketchPlane, sketchPlaneVAxis } from "@/lib/sketchPlane";
import { isCylinderSketchPlane } from "@/lib/sketchCylinder";
import { shapeHasExactBrepSource } from "@/lib/stepQuality";

export type SketchBrepBakeResult = {
  brepStep: string;
  solid: BrepSolid;
};

export type ClosedPath = { points: { x: number; z: number }[] };

async function drawingFromClosedPaths(brep: Brep, paths: ClosedPath[]) {
  const sorted = [...paths].sort((a, b) => pathArea(b) - pathArea(a));
  let drawing = drawingFromPath(brep, sorted[0]);
  if (!drawing) return null;
  for (let i = 1; i < sorted.length; i += 1) {
    const loop = drawingFromPath(brep, sorted[i]);
    if (!loop) continue;
    // Count enclosing loops rather than testing only the single largest one. A sketch with two
    // separate outlines that each carry a hole put the second hole outside sorted[0], so it was
    // fused as solid material — the STEP gained a plug where the mesh viewport showed a hole.
    // Even depth is material, odd depth is a void, matching closedProfilesFromLegacy.
    let depth = 0;
    for (let j = 0; j < i; j += 1) {
      if (pathContains(sorted[j], sorted[i])) depth += 1;
    }
    drawing = depth % 2 === 1
      ? brep.drawingCut(drawing, loop)
      : brep.drawingFuse(drawing, loop);
  }
  return drawing;
}

function sketchOnPlane(brep: Brep, drawing: unknown, plane: ReturnType<typeof resolveSketchPlane>) {
  const origin = plane.origin;
  const normal = plane.normal;
  const uAxis = plane.uAxis;
  const vAxis = sketchPlaneVAxis(plane);
  const occtPlane = brep.createPlane(
    [origin.x, origin.y, origin.z],
    [uAxis.x, uAxis.y, uAxis.z],
    [normal.x, normal.y, normal.z],
  );
  const planeForSketch = {
    origin: occtPlane.origin,
    xDir: occtPlane.xDir,
    yDir: [vAxis.x, vAxis.y, vAxis.z] as [number, number, number],
    zDir: occtPlane.zDir,
  };
  return brep.drawingToSketchOnPlane(drawing as never, planeForSketch as never);
}

async function exportSolidStep(brep: Brep, solid: BrepSolid): Promise<SketchBrepBakeResult | null> {
  const exported = brep.exportSTEP(solid as never);
  if (!exported.ok) return null;
  const brepStep = await exported.value.text();
  if (!brepStep.trim()) return null;
  return { brepStep, solid };
}

/**
 * Build an OCCT solid from closed sketch UV loops extruded along the plane normal.
 * Face holes pull along the normal so the cutter spans past both skins (matches mesh bake).
 */
export async function bakeSketchExtrusionBrep(
  profile: SketchProfile,
  height: number,
  options?: {
    plane?: SketchPlane | null;
    cutIntoFace?: boolean;
    closedPaths?: ClosedPath[];
  },
): Promise<SketchBrepBakeResult | null> {
  const paths = options?.closedPaths?.filter((p) => p.points.length >= 3) ?? [];
  if (paths.length === 0) return null;
  const safeHeight = Math.max(0.05, height);
  const plane = resolveSketchPlane(options?.plane ?? profile.sketchPlane);
  if (isCylinderSketchPlane(plane)) {
    return null;
  }

  const brep = await loadBrepWithOcct();
  try {
    const drawing = await drawingFromClosedPaths(brep, paths);
    if (!drawing) return null;
    const sketch = sketchOnPlane(brep, drawing, plane);
    let solid = brep.sketchExtrude(sketch as never, safeHeight, {
      extrusionDirection: [plane.normal.x, plane.normal.y, plane.normal.z],
    }) as unknown as BrepSolid;

    if (options?.cutIntoFace) {
      const os = faceHoleOvershootMm(safeHeight);
      const pull = Math.max(0, safeHeight - os);
      const n = plane.normal;
      solid = brep.translate(solid, [-n.x * pull, -n.y * pull, -n.z * pull]);
    }

    return exportSolidStep(brep, solid);
  } catch {
    return null;
  }
}

/**
 * Bake a workplane revolve to STEP. Axis is in sketch UV (x/z); mapped onto the plane.
 */
export async function bakeSketchRevolveBrep(
  profile: SketchProfile,
  axis: { x1: number; z1: number; x2: number; z2: number },
  options?: {
    plane?: SketchPlane | null;
    closedPaths?: ClosedPath[];
  },
): Promise<SketchBrepBakeResult | null> {
  const paths = options?.closedPaths?.filter((p) => p.points.length >= 3) ?? [];
  if (paths.length === 0) return null;
  const plane = resolveSketchPlane(options?.plane ?? profile.sketchPlane);
  if (isCylinderSketchPlane(plane) || plane.normal.y < 0.99) {
    // Revolve bake currently targets default workplane sketches only.
    return null;
  }

  const brep = await loadBrepWithOcct();
  try {
    const drawing = await drawingFromClosedPaths(brep, paths);
    if (!drawing) return null;
    const sketch = sketchOnPlane(brep, drawing, plane);
    // Axis in UV: X→world X, Z→world -Y in sketch drawing space used by draw([x,z]).
    // sketchRevolve expects a 3D axis direction; for workplane Y-up, revolve about an
    // axis lying in the XZ plane through the profile.
    const axisDir: [number, number, number] = [axis.x2 - axis.x1, 0, axis.z2 - axis.z1];
    const axisLen = Math.hypot(axisDir[0], axisDir[2]);
    if (axisLen < 1e-6) return null;
    const solid = brep.sketchRevolve(sketch as never, axisDir, {
      origin: [axis.x1, 0, axis.z1],
    }) as unknown as BrepSolid;
    return exportSolidStep(brep, solid);
  } catch {
    return null;
  }
}

/** Attach baked STEP text onto a mesh shape for exact STEP round-trip. */
export function withBakedSketchBrepStep(shape: WorkplaneShape, brepStep: string): WorkplaneShape {
  if (!shape.importedMesh) return shape;
  return {
    ...shape,
    importedMesh: {
      ...shape.importedMesh,
      brepStep,
    },
  };
}

/** Sketch meshes that remesh/Group must bake before OCCT can run an exact boolean. */
export function sketchOperandsNeedingExactBake(shapes: readonly WorkplaneShape[]): WorkplaneShape[] {
  return shapes.filter((shape) => (
    !shapeHasExactBrepSource(shape)
    && Boolean(shape.sketchProfile)
    && Boolean(shape.importedMesh)
  ));
}

/**
 * Attach exact STEP on bakeable sketch meshes before Group/remesh so OCCT is eligible
 * instead of racing an async bake and falling to mesh CSG.
 */
export async function ensureExactBrepSources(
  shapes: WorkplaneShape[],
  bakeSketchBrepStep: (shape: WorkplaneShape) => Promise<string | null>,
): Promise<WorkplaneShape[]> {
  return Promise.all(shapes.map(async (shape) => {
    if (!sketchOperandsNeedingExactBake([shape]).length) return shape;
    try {
      const brepStep = await bakeSketchBrepStep(shape);
      return brepStep ? withBakedSketchBrepStep(shape, brepStep) : shape;
    } catch {
      return shape;
    }
  }));
}

/**
 * True (shoelace) area. The bounding-box area this used to return ranked a thin diagonal sliver
 * above a compact loop that genuinely enclosed it, which inverted outer/hole.
 */
export function pathArea(path: ClosedPath) {
  const pts = path.points;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return Math.abs(sum) * 0.5;
}

/**
 * Whether `inner` lies inside `outer`. Probes edge midpoints and takes the majority so a shared
 * or touching vertex cannot decide the answer on its own.
 */
export function pathContains(outer: ClosedPath, inner: ClosedPath) {
  const pts = inner.points;
  if (pts.length < 3) return false;
  let inside = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (pointInPath({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, outer)) inside += 1;
  }
  return inside * 2 > pts.length;
}

function pointInPath(point: { x: number; z: number }, path: ClosedPath) {
  let inside = false;
  const pts = path.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const zi = pts[i].z;
    const xj = pts[j].x;
    const zj = pts[j].z;
    const intersect = zi > point.z !== zj > point.z
      && point.x < ((xj - xi) * (point.z - zi)) / (zj - zi + 1e-18) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function drawingFromPath(brep: Brep, path: ClosedPath) {
  if (path.points.length < 3) return null;
  const first = path.points[0];
  let pen = brep.draw([first.x, first.z]);
  for (let i = 1; i < path.points.length; i += 1) {
    const p = path.points[i];
    pen = pen.lineTo([p.x, p.z]);
  }
  return pen.close();
}
