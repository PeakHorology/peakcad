import type { SketchCylinderSurface, SketchPlane, SketchProfile, WorkplaneShape } from "@/types/sketchforge";
import { loadBrepWithOcct, type Brep, type BrepSolid } from "@/lib/brepKernel";
import { faceHoleOvershootMm } from "@/lib/csgTree";
import { isDefaultSketchPlane, isFaceHostedSketch, resolveSketchPlane, sketchPlaneVAxis } from "@/lib/sketchPlane";
import { orderedSketchPaths, type OrderedSketchPath } from "@/lib/sketch/profiles";
import {
  barrelHoleCutDepthMm,
  cylinderOutwardNormalAtUV,
  cylinderUVToWorld,
  isCylinderSketchPlane,
} from "@/lib/sketchCylinder";
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

function circleFromUvPoints(points: { x: number; z: number }[]) {
  if (points.length < 8) return null;
  const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const cz = points.reduce((sum, point) => sum + point.z, 0) / points.length;
  const radii = points.map((point) => Math.hypot(point.x - cx, point.z - cz));
  const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  if (radius < 0.05) return null;
  const spread = Math.max(...radii) - Math.min(...radii);
  if (spread > Math.max(0.05, radius * 0.02)) return null;
  return { cx, cz, radius };
}

function subsamplePoints<T>(points: T[], max: number) {
  if (points.length <= max) return points;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(points[Math.floor((i * points.length) / max)]);
  return out;
}

function closedWire(brep: Brep, points: { x: number; y: number; z: number }[]) {
  const edges = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-6) continue;
    edges.push(brep.line([a.x, a.y, a.z], [b.x, b.y, b.z]));
  }
  if (edges.length < 3) return null;
  const loop = brep.wireLoop(edges);
  return loop.ok ? loop.value : null;
}

function radialSketchSolid(
  brep: Brep,
  surface: SketchCylinderSurface,
  points: { x: number; z: number }[],
  depth: number,
  cutIntoFace: boolean,
): BrepSolid | null {
  const circle = circleFromUvPoints(points);
  if (circle) {
    const normal = cylinderOutwardNormalAtUV(surface, circle.cx);
    const axis = surface.axisDir;
    const onAxis = {
      x: surface.axisOrigin.x - axis.x * circle.cz,
      y: surface.axisOrigin.y - axis.y * circle.cz,
      z: surface.axisOrigin.z - axis.z * circle.cz,
    };
    const length = cutIntoFace ? Math.max(depth, barrelHoleCutDepthMm(surface)) : depth;
    const at = cutIntoFace
      ? onAxis
      : {
        x: onAxis.x + normal.x * (surface.radius + length / 2),
        y: onAxis.y + normal.y * (surface.radius + length / 2),
        z: onAxis.z + normal.z * (surface.radius + length / 2),
      };
    return brep.cylinder(circle.radius, length, {
      axis: [normal.x, normal.y, normal.z],
      centered: true,
      at: [at.x, at.y, at.z],
    }) as unknown as BrepSolid;
  }

  const samples = subsamplePoints(points, 24);
  const overshoot = faceHoleOvershootMm(surface.radius * 2);
  const outerR = cutIntoFace ? surface.radius + overshoot : surface.radius + depth;
  const innerR = cutIntoFace ? -(surface.radius + overshoot) : surface.radius;
  const outer = samples.map((point) => cylinderUVToWorld(surface, point.x, point.z, outerR));
  const inner = samples.map((point) => cylinderUVToWorld(surface, point.x, point.z, innerR));
  const innerWire = closedWire(brep, inner);
  const outerWire = closedWire(brep, outer);
  if (!innerWire || !outerWire) return null;
  const lofted = brep.loft([innerWire, outerWire], { ruled: true });
  if (!lofted.ok) return null;
  return lofted.value as unknown as BrepSolid;
}

async function bakeCylinderSketchExtrusion(
  brep: Brep,
  surface: SketchCylinderSurface,
  paths: ClosedPath[],
  depth: number,
  cutIntoFace: boolean,
): Promise<SketchBrepBakeResult | null> {
  const sorted = [...paths].sort((a, b) => pathArea(b) - pathArea(a));
  const solids: BrepSolid[] = [];
  for (const path of sorted) {
    const solid = radialSketchSolid(brep, surface, path.points, depth, cutIntoFace);
    if (!solid) return null;
    solids.push(solid);
  }
  if (solids.length === 0) return null;
  let acc = solids[0];
  for (let i = 1; i < solids.length; i += 1) {
    let nest = 0;
    for (let j = 0; j < i; j += 1) {
      if (pathContains(sorted[j], sorted[i])) nest += 1;
    }
    const next = nest % 2 === 1 ? brep.cut(acc as never, solids[i] as never) : brep.fuse(acc as never, solids[i] as never);
    if (!next.ok) return null;
    acc = next.value as unknown as BrepSolid;
  }
  return exportSolidStep(brep, acc);
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
  const brep = await loadBrepWithOcct();
  if (isCylinderSketchPlane(plane)) {
    try {
      return await bakeCylinderSketchExtrusion(brep, plane.surface, paths, safeHeight, Boolean(options?.cutIntoFace));
    } catch {
      return null;
    }
  }

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

export function densifyClosedPathUv(path: OrderedSketchPath, curveSegments = 20): Array<{ x: number; z: number }> {
  const samples: Array<{ x: number; z: number }> = [];
  path.steps.forEach(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const control1 = forward ? from.handleOut : from.handleIn;
    const control2 = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && control1 && control2) {
      const count = Math.max(4, curveSegments);
      for (let i = 0; i < count; i += 1) {
        const t = i / count;
        const mt = 1 - t;
        samples.push({
          x: mt * mt * mt * from.x + 3 * mt * mt * t * control1.x + 3 * mt * t * t * control2.x + t * t * t * to.x,
          z: mt * mt * mt * from.z + 3 * mt * mt * t * control1.z + 3 * mt * t * t * control2.z + t * t * t * to.z,
        });
      }
    } else {
      samples.push({ x: from.x, z: from.z });
    }
  });
  return samples;
}

/**
 * Exact solid for a sketch feature, built from the profile at export time.
 * The editor keeps the mesh; this is the STEP bake.
 */
export async function bakeSketchShapeSolid(
  shape: WorkplaneShape,
  frameOrigin?: { x: number; y: number; z: number },
): Promise<BrepSolid | null> {
  if (!shape.sketchProfile) return null;
  const resolved = resolveSketchPlane(shape.sketchPlane ?? shape.sketchProfile.sketchPlane);
  const plane = frameOrigin
    ? {
      ...resolved,
      origin: {
        x: resolved.origin.x - frameOrigin.x,
        y: resolved.origin.y - frameOrigin.y,
        z: resolved.origin.z - frameOrigin.z,
      },
      surface: resolved.surface?.kind === "cylinder"
        ? {
          ...resolved.surface,
          axisOrigin: {
            x: resolved.surface.axisOrigin.x - frameOrigin.x,
            y: resolved.surface.axisOrigin.y - frameOrigin.y,
            z: resolved.surface.axisOrigin.z - frameOrigin.z,
          },
        }
        : resolved.surface,
    }
    : resolved;
  if (
    isDefaultSketchPlane(plane)
    && (shape.kind === "box" || shape.kind === "cylinder" || shape.kind === "sphere" || shape.kind === "cone")
  ) {
    return null;
  }
  const closed = orderedSketchPaths(shape.sketchProfile).filter((path) => path.closed);
  if (closed.length === 0) return null;
  const closedPaths = closed.map((path) => ({ points: densifyClosedPathUv(path) }));
  if (shape.sketchFinish === "revolve" && shape.sketchRevolveAxis) {
    const baked = await bakeSketchRevolveBrep(shape.sketchProfile, shape.sketchRevolveAxis, { plane, closedPaths });
    return baked?.solid ?? null;
  }
  const faceHosted = isFaceHostedSketch(plane, shape.sketchProfile.faceReferenceLoops);
  const baked = await bakeSketchExtrusionBrep(shape.sketchProfile, shape.height, {
    plane,
    cutIntoFace: Boolean(shape.hole && faceHosted),
    closedPaths,
  });
  return baked?.solid ?? null;
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
