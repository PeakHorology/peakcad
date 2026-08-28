import type { SketchPoint, SketchProfile, SketchSegment } from "@/types/sketchforge";
import type { SketchClosedProfile, SketchDoc, SketchEntity, SketchPointEntity, SketchVec2 } from "./types";

export type OrderedSketchStep = { segment: SketchSegment; from: SketchPoint; to: SketchPoint };
export type OrderedSketchPath = { points: SketchPoint[]; steps: OrderedSketchStep[]; closed: boolean };

export function orderedSketchPaths(profile: SketchProfile): OrderedSketchPath[] {
  const pointById = new Map(profile.points.map((point) => [point.id, point]));
  const adjacency = new Map<string, Array<{ pointId: string; segment: SketchSegment }>>();
  profile.points.forEach((point) => adjacency.set(point.id, []));
  const validSegments = profile.segments.filter((segment) => {
    if (!pointById.has(segment.startId) || !pointById.has(segment.endId) || segment.startId === segment.endId) return false;
    adjacency.get(segment.startId)?.push({ pointId: segment.endId, segment });
    adjacency.get(segment.endId)?.push({ pointId: segment.startId, segment });
    return true;
  });
  const unvisited = new Set(validSegments.map((segment) => segment.id));
  const paths: OrderedSketchPath[] = [];
  while (unvisited.size > 0) {
    const seedId = unvisited.values().next().value as string | undefined;
    const seed = validSegments.find((segment) => segment.id === seedId);
    if (!seed) break;
    const componentIds = new Set<string>();
    const queue = [seed.startId, seed.endId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id || componentIds.has(id)) continue;
      componentIds.add(id);
      adjacency.get(id)?.forEach((entry) => queue.push(entry.pointId));
    }
    const startId =
      [...componentIds].find((id) => (adjacency.get(id)?.filter((entry) => unvisited.has(entry.segment.id)).length ?? 0) === 1)
      ?? seed.startId;
    const first = pointById.get(startId);
    if (!first) {
      unvisited.delete(seed.id);
      continue;
    }
    const points = [first];
    const steps: OrderedSketchStep[] = [];
    const stepIndexByPoint = new Map<string, number>([[startId, 0]]);
    let currentId = startId;
    let loopStart: number | null = null;
    for (let guard = 0; guard <= validSegments.length; guard += 1) {
      const edge = adjacency.get(currentId)?.find((entry) => unvisited.has(entry.segment.id));
      if (!edge) break;
      const from = pointById.get(currentId);
      const to = pointById.get(edge.pointId);
      if (!from || !to) break;
      unvisited.delete(edge.segment.id);
      steps.push({ segment: edge.segment, from, to });
      currentId = to.id;
      const seenAt = stepIndexByPoint.get(currentId);
      if (seenAt !== undefined) {
        // Walked back onto our own trail. Only comparing against startId meant that a single
        // stray segment touching a corner made the walk begin at the dangling end, so the return
        // to the corner did not register and an otherwise closed loop was reported open — the
        // sketch then had no profile at all and would not extrude.
        loopStart = seenAt;
        break;
      }
      stepIndexByPoint.set(currentId, points.length);
      points.push(to);
    }

    if (loopStart === null) {
      paths.push({ points, steps, closed: false });
      continue;
    }
    if (loopStart > 0) {
      // The tail that led into the loop is its own open path.
      paths.push({
        points: points.slice(0, loopStart + 1),
        steps: steps.slice(0, loopStart),
        closed: false,
      });
    }
    const loopSteps = steps.slice(loopStart);
    paths.push({ points: points.slice(loopStart), steps: loopSteps, closed: loopSteps.length >= 3 });
  }
  return paths;
}

function pointInPolygon(point: SketchVec2, polygon: SketchVec2[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const zi = polygon[i].z;
    const xj = polygon[j].x;
    const zj = polygon[j].z;
    const intersect = zi > point.z !== zj > point.z && point.x < ((xj - xi) * (point.z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Samples per curved segment when measuring a loop. Enough that area settles to ~0.1%. */
const CURVE_MEASURE_SAMPLES = 16;

function cubicPoint(
  start: SketchVec2,
  control1: SketchVec2,
  control2: SketchVec2,
  end: SketchVec2,
  t: number,
): SketchVec2 {
  const inv = 1 - t;
  return {
    x: inv ** 3 * start.x + 3 * inv ** 2 * t * control1.x + 3 * inv * t ** 2 * control2.x + t ** 3 * end.x,
    z: inv ** 3 * start.z + 3 * inv ** 2 * t * control1.z + 3 * inv * t ** 2 * control2.z + t ** 3 * end.z,
  };
}

/**
 * Outline of a loop with its curved segments sampled.
 *
 * Measuring and testing containment against the bare anchor points treated a bezier loop as its
 * inscribed polygon — a circle drawn from four anchors measured as a square of 2r² rather than πr².
 * That understated area could invert which loop was considered the outer one, and containment tests
 * against the shrunken outline missed holes sitting near a curved boundary.
 */
export function sampledPathOutline(path: OrderedSketchPath): SketchVec2[] {
  if (path.steps.length === 0) return path.points.map((point) => ({ x: point.x, z: point.z }));
  const outline: SketchVec2[] = [];
  for (const { segment, from, to } of path.steps) {
    outline.push({ x: from.x, z: from.z });
    if (segment.kind === "line") continue;
    const forward = segment.startId === from.id;
    const control1 = forward ? from.handleOut : from.handleIn;
    const control2 = forward ? to.handleIn : to.handleOut;
    if (!control1 || !control2) continue;
    for (let step = 1; step < CURVE_MEASURE_SAMPLES; step += 1) {
      outline.push(cubicPoint(from, control1, control2, to, step / CURVE_MEASURE_SAMPLES));
    }
  }
  // Closed paths wrap back to the first point, so the final `to` is already the outline's head.
  if (!path.closed) {
    const last = path.steps[path.steps.length - 1].to;
    outline.push({ x: last.x, z: last.z });
  }
  return outline;
}

function polygonArea(points: SketchVec2[]) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area) * 0.5;
}

function polygonCentroid(points: SketchVec2[]): SketchVec2 {
  let cx = 0;
  let cz = 0;
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.z - b.x * a.z;
    area += cross;
    cx += (a.x + b.x) * cross;
    cz += (a.z + b.z) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const n = points.length || 1;
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / n,
      z: points.reduce((sum, p) => sum + p.z, 0) / n,
    };
  }
  return { x: cx / (3 * area), z: cz / (3 * area) };
}

/** Closed profiles from a legacy point/segment graph (nested loops become holes). */
export function closedProfilesFromLegacy(profile: SketchProfile): SketchClosedProfile[] {
  const closed = orderedSketchPaths(profile).filter((path) => path.closed);
  const loops = closed.map((path, index) => {
    // Measure the curve, not the anchors it was drawn from.
    const outline = sampledPathOutline(path);
    return {
      id: `profile-${index}`,
      pointIds: path.points.map((p) => p.id),
      holePointIdLoops: [] as string[][],
      area: polygonArea(outline),
      centroid: polygonCentroid(outline),
      points: outline,
    };
  });
  loops.sort((a, b) => b.area - a.area);

  // Nest by containment depth against every larger loop. Claiming any smaller contained loop as a
  // hole of the outermost one meant a solid island inside a hole (a post standing in a bore) was
  // recorded as a second hole; cutting it from already-void space did nothing, so the island
  // silently vanished. Even depth is material, odd depth is a void.
  type Loop = (typeof loops)[number];
  const parentById = new Map<string, Loop | null>();
  const depthById = new Map<string, number>();
  loops.forEach((loop, index) => {
    let parent: Loop | null = null;
    for (let j = 0; j < index; j += 1) {
      const candidate = loops[j];
      if (!pointInPolygon(loop.centroid, candidate.points)) continue;
      // Loops are sorted largest first, so the smallest enclosing one is the immediate parent.
      if (!parent || candidate.area < parent.area) parent = candidate;
    }
    parentById.set(loop.id, parent);
    depthById.set(loop.id, parent ? (depthById.get(parent.id) ?? 0) + 1 : 0);
  });

  const holesByParentId = new Map<string, string[][]>();
  for (const loop of loops) {
    if ((depthById.get(loop.id) ?? 0) % 2 === 0) continue;
    const parent = parentById.get(loop.id);
    if (!parent) continue;
    const existing = holesByParentId.get(parent.id) ?? [];
    existing.push(loop.pointIds);
    holesByParentId.set(parent.id, existing);
  }

  return loops
    .filter((loop) => (depthById.get(loop.id) ?? 0) % 2 === 0)
    .map((loop) => ({
      id: loop.id,
      pointIds: loop.pointIds,
      holePointIdLoops: holesByParentId.get(loop.id) ?? [],
      area: loop.area,
      centroid: loop.centroid,
    }));
}

function pointEntities(doc: SketchDoc): SketchPointEntity[] {
  return doc.entities.filter((e): e is SketchPointEntity => e.kind === "point");
}

function curveEntities(doc: SketchDoc) {
  return doc.entities.filter(
    (e): e is Extract<SketchEntity, { kind: "line" | "bezier" | "smooth" }> =>
      e.kind === "line" || e.kind === "bezier" || e.kind === "smooth",
  );
}

/** Profiles from SketchDoc curve graph (ignores construction + projected-only when they don't form solid curves). */
export function closedProfilesFromDoc(doc: SketchDoc): SketchClosedProfile[] {
  const points = pointEntities(doc).filter((p) => !p.construction || true);
  const pointById = new Map(points.map((p) => [p.id, p]));
  const curves = curveEntities(doc).filter((c) => !c.construction);
  const legacy: SketchProfile = {
    points: points.map((p) => ({
      id: p.id,
      x: p.x,
      z: p.z,
      handleIn: p.handleIn,
      handleOut: p.handleOut,
      mode: p.mode,
    })),
    segments: curves.map((c) => ({
      id: c.id,
      startId: c.startId,
      endId: c.endId,
      kind: c.kind === "line" ? "line" : c.kind,
    })),
  };
  // Circles as synthetic closed loops (4 quadrant points) for profile picking
  const circleProfiles: SketchClosedProfile[] = [];
  for (const entity of doc.entities) {
    if (entity.kind !== "circle" || entity.construction) continue;
    const center = pointById.get(entity.centerId);
    if (!center) continue;
    const r = entity.radius;
    const pts = [
      { x: center.x + r, z: center.z },
      { x: center.x, z: center.z + r },
      { x: center.x - r, z: center.z },
      { x: center.x, z: center.z - r },
    ];
    circleProfiles.push({
      id: `circle-${entity.id}`,
      pointIds: [entity.centerId],
      holePointIdLoops: [],
      area: Math.PI * r * r,
      centroid: { x: center.x, z: center.z },
    });
    void pts;
  }
  const fromCurves = closedProfilesFromLegacy(legacy);
  return [...fromCurves, ...circleProfiles].sort((a, b) => b.area - a.area);
}

export function pickProfileAtPoint(profiles: SketchClosedProfile[], point: SketchVec2, legacy: SketchProfile): string | null {
  const byId = new Map(legacy.points.map((p) => [p.id, p]));
  for (const profile of profiles) {
    if (profile.id.startsWith("circle-")) {
      const dist = Math.hypot(point.x - profile.centroid.x, point.z - profile.centroid.z);
      const radius = Math.sqrt(profile.area / Math.PI);
      if (dist <= radius) return profile.id;
      continue;
    }
    const poly = profile.pointIds.map((id) => byId.get(id)).filter(Boolean).map((p) => ({ x: p!.x, z: p!.z }));
    if (poly.length >= 3 && pointInPolygon(point, poly)) return profile.id;
  }
  return null;
}
