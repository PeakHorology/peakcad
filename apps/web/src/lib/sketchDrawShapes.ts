import { createLocalId } from "@/lib/localIds";
import type { SketchPoint, SketchProfile, SketchSegment } from "@/types/sketchforge";

const CIRCLE_KAPPA = 0.5522847498307936;

function closedLineRing(points: Array<{ x: number; z: number }>): Pick<SketchProfile, "points" | "segments"> {
  const ids = points.map(() => createLocalId("sketch-point"));
  const sketchPoints: SketchPoint[] = points.map((point, index) => ({
    id: ids[index],
    x: point.x,
    z: point.z,
    mode: "corner",
  }));
  const segments: SketchSegment[] = ids.map((startId, index) => ({
    id: createLocalId("sketch-segment"),
    startId,
    endId: ids[(index + 1) % ids.length],
    kind: "line",
  }));
  return { points: sketchPoints, segments };
}

/** Approximate a circle with four cubic beziers. */
export function circleSketchGeometry(center: { x: number; z: number }, radius: number): Pick<SketchProfile, "points" | "segments"> {
  const k = radius * CIRCLE_KAPPA;
  const rightId = createLocalId("sketch-point");
  const bottomId = createLocalId("sketch-point");
  const leftId = createLocalId("sketch-point");
  const topId = createLocalId("sketch-point");
  const points: SketchPoint[] = [
    {
      id: rightId,
      x: center.x + radius,
      z: center.z,
      mode: "smooth",
      handleIn: { x: center.x + radius, z: center.z - k },
      handleOut: { x: center.x + radius, z: center.z + k },
    },
    {
      id: bottomId,
      x: center.x,
      z: center.z + radius,
      mode: "smooth",
      handleIn: { x: center.x + k, z: center.z + radius },
      handleOut: { x: center.x - k, z: center.z + radius },
    },
    {
      id: leftId,
      x: center.x - radius,
      z: center.z,
      mode: "smooth",
      handleIn: { x: center.x - radius, z: center.z + k },
      handleOut: { x: center.x - radius, z: center.z - k },
    },
    {
      id: topId,
      x: center.x,
      z: center.z - radius,
      mode: "smooth",
      handleIn: { x: center.x - k, z: center.z - radius },
      handleOut: { x: center.x + k, z: center.z - radius },
    },
  ];
  const ring = [rightId, bottomId, leftId, topId];
  const segments: SketchSegment[] = ring.map((startId, index) => ({
    id: createLocalId("sketch-segment"),
    startId,
    endId: ring[(index + 1) % ring.length],
    kind: "bezier",
  }));
  return { points, segments };
}

/** Axis-aligned square from first corner toward opposite corner (equal sides). */
export function squareSketchGeometry(origin: { x: number; z: number }, corner: { x: number; z: number }): Pick<SketchProfile, "points" | "segments"> | null {
  const dx = corner.x - origin.x;
  const dz = corner.z - origin.z;
  const side = Math.max(Math.abs(dx), Math.abs(dz));
  if (side < 0.25) return null;
  const sx = Math.sign(dx) || 1;
  const sz = Math.sign(dz) || 1;
  return closedLineRing([
    { x: origin.x, z: origin.z },
    { x: origin.x + sx * side, z: origin.z },
    { x: origin.x + sx * side, z: origin.z + sz * side },
    { x: origin.x, z: origin.z + sz * side },
  ]);
}

/** Regular polygon (triangle when sides === 3). First vertex toward `vertex`. */
export function regularPolygonSketchGeometry(
  center: { x: number; z: number },
  vertex: { x: number; z: number },
  sides: number,
): Pick<SketchProfile, "points" | "segments"> | null {
  const count = Math.max(3, Math.min(64, Math.round(sides)));
  const radius = Math.hypot(vertex.x - center.x, vertex.z - center.z);
  if (radius < 0.25) return null;
  const startAngle = Math.atan2(vertex.z - center.z, vertex.x - center.x);
  const points = Array.from({ length: count }, (_, index) => {
    const angle = startAngle + (index * 2 * Math.PI) / count;
    return {
      x: center.x + Math.cos(angle) * radius,
      z: center.z + Math.sin(angle) * radius,
    };
  });
  return closedLineRing(points);
}

function circleFromThreePoints(
  a: { x: number; z: number },
  b: { x: number; z: number },
  c: { x: number; z: number },
): { center: { x: number; z: number }; radius: number } | null {
  const d = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
  if (Math.abs(d) < 1e-8) return null;
  const aSq = a.x * a.x + a.z * a.z;
  const bSq = b.x * b.x + b.z * b.z;
  const cSq = c.x * c.x + c.z * c.z;
  const center = {
    x: (aSq * (b.z - c.z) + bSq * (c.z - a.z) + cSq * (a.z - b.z)) / d,
    z: (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d,
  };
  const radius = Math.hypot(a.x - center.x, a.z - center.z);
  if (radius < 0.25) return null;
  return { center, radius };
}

function normalizeAngle(angle: number) {
  let value = angle;
  while (value <= -Math.PI) value += Math.PI * 2;
  while (value > Math.PI) value -= Math.PI * 2;
  return value;
}

/** Circular arc through three points, as cubic bezier spans (open path). */
export function arcSketchGeometry(
  start: { x: number; z: number },
  end: { x: number; z: number },
  through: { x: number; z: number },
): Pick<SketchProfile, "points" | "segments"> | null {
  const fitted = circleFromThreePoints(start, through, end);
  if (!fitted) return null;
  const { center, radius } = fitted;
  let startAngle = Math.atan2(start.z - center.z, start.x - center.x);
  let throughAngle = Math.atan2(through.z - center.z, through.x - center.x);
  let endAngle = Math.atan2(end.z - center.z, end.x - center.x);

  let sweep = normalizeAngle(endAngle - startAngle);
  const throughDelta = normalizeAngle(throughAngle - startAngle);
  // Pick the sweep direction that contains the through point.
  if (sweep >= 0 && (throughDelta < 0 || throughDelta > sweep)) {
    sweep -= Math.PI * 2;
  } else if (sweep < 0 && (throughDelta > 0 || throughDelta < sweep)) {
    sweep += Math.PI * 2;
  }
  if (Math.abs(sweep) < 0.05) return null;

  const quarter = Math.PI / 2;
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / quarter));
  const stepSweep = sweep / steps;
  const points: SketchPoint[] = [];
  const segments: SketchSegment[] = [];

  for (let index = 0; index <= steps; index += 1) {
    const angle = startAngle + stepSweep * index;
    const id = createLocalId("sketch-point");
    const alpha = (4 / 3) * Math.tan(stepSweep / 4);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Tangent direction for increasing angle: (-sin, cos)
    const tx = -sin;
    const tz = cos;
    const handleScale = radius * alpha;
    const point: SketchPoint = {
      id,
      x: center.x + cos * radius,
      z: center.z + sin * radius,
      mode: "smooth",
    };
    if (index > 0) {
      point.handleIn = {
        x: point.x - tx * handleScale,
        z: point.z - tz * handleScale,
      };
    }
    if (index < steps) {
      point.handleOut = {
        x: point.x + tx * handleScale,
        z: point.z + tz * handleScale,
      };
    }
    points.push(point);
    if (index > 0) {
      segments.push({
        id: createLocalId("sketch-segment"),
        startId: points[index - 1].id,
        endId: id,
        kind: "bezier",
      });
    }
  }

  // Pin exact endpoints
  points[0].x = start.x;
  points[0].z = start.z;
  points[points.length - 1].x = end.x;
  points[points.length - 1].z = end.z;
  return { points, segments };
}

/** Parallel copy of a straight segment offset toward `toward`. */
export function offsetLineSketchGeometry(
  start: { x: number; z: number },
  end: { x: number; z: number },
  toward: { x: number; z: number },
): Pick<SketchProfile, "points" | "segments"> | null {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.25) return null;
  const nx = -dz / length;
  const nz = dx / length;
  const mid = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
  const side = (toward.x - mid.x) * nx + (toward.z - mid.z) * nz;
  const distance = Math.abs(side);
  if (distance < 0.05) return null;
  const ox = nx * Math.sign(side || 1) * distance;
  const oz = nz * Math.sign(side || 1) * distance;
  const aId = createLocalId("sketch-point");
  const bId = createLocalId("sketch-point");
  return {
    points: [
      { id: aId, x: start.x + ox, z: start.z + oz, mode: "corner" },
      { id: bId, x: end.x + ox, z: end.z + oz, mode: "corner" },
    ],
    segments: [{ id: createLocalId("sketch-segment"), startId: aId, endId: bId, kind: "line" }],
  };
}

/** Axis-aligned rectangle from corner to opposite corner. */
export function rectangleSketchGeometry(origin: { x: number; z: number }, corner: { x: number; z: number }): Pick<SketchProfile, "points" | "segments"> | null {
  const width = Math.abs(corner.x - origin.x);
  const depth = Math.abs(corner.z - origin.z);
  if (width < 0.25 || depth < 0.25) return null;
  const minX = Math.min(origin.x, corner.x);
  const maxX = Math.max(origin.x, corner.x);
  const minZ = Math.min(origin.z, corner.z);
  const maxZ = Math.max(origin.z, corner.z);
  return closedLineRing([
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ]);
}

/** Ellipse inscribed in the corner-drag bounding box (4 cubic beziers). */
export function ellipseSketchGeometry(origin: { x: number; z: number }, corner: { x: number; z: number }): Pick<SketchProfile, "points" | "segments"> | null {
  const rx = Math.abs(corner.x - origin.x) / 2;
  const ry = Math.abs(corner.z - origin.z) / 2;
  if (rx < 0.25 || ry < 0.25) return null;
  const cx = (origin.x + corner.x) / 2;
  const cz = (origin.z + corner.z) / 2;
  const kx = rx * CIRCLE_KAPPA;
  const ky = ry * CIRCLE_KAPPA;
  const rightId = createLocalId("sketch-point");
  const bottomId = createLocalId("sketch-point");
  const leftId = createLocalId("sketch-point");
  const topId = createLocalId("sketch-point");
  const points: SketchPoint[] = [
    {
      id: rightId,
      x: cx + rx,
      z: cz,
      mode: "smooth",
      handleIn: { x: cx + rx, z: cz - ky },
      handleOut: { x: cx + rx, z: cz + ky },
    },
    {
      id: bottomId,
      x: cx,
      z: cz + ry,
      mode: "smooth",
      handleIn: { x: cx + kx, z: cz + ry },
      handleOut: { x: cx - kx, z: cz + ry },
    },
    {
      id: leftId,
      x: cx - rx,
      z: cz,
      mode: "smooth",
      handleIn: { x: cx - rx, z: cz + ky },
      handleOut: { x: cx - rx, z: cz - ky },
    },
    {
      id: topId,
      x: cx,
      z: cz - ry,
      mode: "smooth",
      handleIn: { x: cx - kx, z: cz - ry },
      handleOut: { x: cx + kx, z: cz - ry },
    },
  ];
  const ring = [rightId, bottomId, leftId, topId];
  return {
    points,
    segments: ring.map((startId, index) => ({
      id: createLocalId("sketch-segment"),
      startId,
      endId: ring[(index + 1) % ring.length],
      kind: "bezier" as const,
    })),
  };
}

function appendQuarterArc(
  points: SketchPoint[],
  segments: SketchSegment[],
  from: { x: number; z: number },
  to: { x: number; z: number },
  center: { x: number; z: number },
) {
  const startId = points.length === 0 ? createLocalId("sketch-point") : points[points.length - 1].id;
  if (points.length === 0) {
    points.push({ id: startId, x: from.x, z: from.z, mode: "smooth" });
  }
  const endId = createLocalId("sketch-point");
  const startAngle = Math.atan2(from.z - center.z, from.x - center.x);
  const endAngle = Math.atan2(to.z - center.z, to.x - center.x);
  let sweep = endAngle - startAngle;
  while (sweep <= 0) sweep += Math.PI * 2;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  // Prefer the short positive quarter (~π/2)
  if (Math.abs(sweep) < 0.01) sweep = Math.PI / 2;
  const radius = Math.hypot(from.x - center.x, from.z - center.z);
  const alpha = (4 / 3) * Math.tan(sweep / 4);
  const startCos = Math.cos(startAngle);
  const startSin = Math.sin(startAngle);
  const endCos = Math.cos(endAngle);
  const endSin = Math.sin(endAngle);
  const start = points[points.length - 1];
  start.handleOut = {
    x: start.x + -startSin * radius * alpha,
    z: start.z + startCos * radius * alpha,
  };
  points.push({
    id: endId,
    x: to.x,
    z: to.z,
    mode: "smooth",
    handleIn: {
      x: to.x - -endSin * radius * alpha,
      z: to.z - endCos * radius * alpha,
    },
  });
  segments.push({ id: createLocalId("sketch-segment"), startId, endId, kind: "bezier" });
}

function appendLine(points: SketchPoint[], segments: SketchSegment[], to: { x: number; z: number }) {
  const startId = points[points.length - 1].id;
  const endId = createLocalId("sketch-point");
  points.push({ id: endId, x: to.x, z: to.z, mode: "corner" });
  segments.push({ id: createLocalId("sketch-segment"), startId, endId, kind: "line" });
}

/** Rounded rectangle from corner drag; corner radius scales with the shorter side. */
export function roundedRectangleSketchGeometry(origin: { x: number; z: number }, corner: { x: number; z: number }): Pick<SketchProfile, "points" | "segments"> | null {
  const width = Math.abs(corner.x - origin.x);
  const depth = Math.abs(corner.z - origin.z);
  if (width < 0.5 || depth < 0.5) return null;
  const minX = Math.min(origin.x, corner.x);
  const maxX = Math.max(origin.x, corner.x);
  const minZ = Math.min(origin.z, corner.z);
  const maxZ = Math.max(origin.z, corner.z);
  const radius = Math.min(width, depth) * 0.22;
  const points: SketchPoint[] = [];
  const segments: SketchSegment[] = [];

  // Start at top edge after top-left corner, go clockwise.
  points.push({ id: createLocalId("sketch-point"), x: minX + radius, z: minZ, mode: "corner" });
  appendLine(points, segments, { x: maxX - radius, z: minZ });
  appendQuarterArc(points, segments, { x: maxX - radius, z: minZ }, { x: maxX, z: minZ + radius }, { x: maxX - radius, z: minZ + radius });
  appendLine(points, segments, { x: maxX, z: maxZ - radius });
  appendQuarterArc(points, segments, { x: maxX, z: maxZ - radius }, { x: maxX - radius, z: maxZ }, { x: maxX - radius, z: maxZ - radius });
  appendLine(points, segments, { x: minX + radius, z: maxZ });
  appendQuarterArc(points, segments, { x: minX + radius, z: maxZ }, { x: minX, z: maxZ - radius }, { x: minX + radius, z: maxZ - radius });
  appendLine(points, segments, { x: minX, z: minZ + radius });
  appendQuarterArc(points, segments, { x: minX, z: minZ + radius }, { x: minX + radius, z: minZ }, { x: minX + radius, z: minZ + radius });
  const closing = points[points.length - 1];
  points[0].handleIn = closing.handleIn;
  points[0].mode = "smooth";
  segments[segments.length - 1].endId = points[0].id;
  points.pop();
  return { points, segments };
}

/** Capsule / stadium (slot) from corner-drag bounds. */
export function slotSketchGeometry(origin: { x: number; z: number }, corner: { x: number; z: number }): Pick<SketchProfile, "points" | "segments"> | null {
  const width = Math.abs(corner.x - origin.x);
  const depth = Math.abs(corner.z - origin.z);
  if (width < 0.5 || depth < 0.5) return null;
  const minX = Math.min(origin.x, corner.x);
  const maxX = Math.max(origin.x, corner.x);
  const minZ = Math.min(origin.z, corner.z);
  const maxZ = Math.max(origin.z, corner.z);
  const points: SketchPoint[] = [];
  const segments: SketchSegment[] = [];

  if (width >= depth) {
    const r = depth / 2;
    const cz = (minZ + maxZ) / 2;
    const left = minX + r;
    const right = maxX - r;
    if (right - left < 0.05) {
      return circleSketchGeometry({ x: (minX + maxX) / 2, z: cz }, r);
    }
    points.push({ id: createLocalId("sketch-point"), x: left, z: minZ, mode: "corner" });
    appendLine(points, segments, { x: right, z: minZ });
    appendQuarterArc(points, segments, { x: right, z: minZ }, { x: maxX, z: cz }, { x: right, z: cz });
    appendQuarterArc(points, segments, { x: maxX, z: cz }, { x: right, z: maxZ }, { x: right, z: cz });
    appendLine(points, segments, { x: left, z: maxZ });
    appendQuarterArc(points, segments, { x: left, z: maxZ }, { x: minX, z: cz }, { x: left, z: cz });
    appendQuarterArc(points, segments, { x: minX, z: cz }, { x: left, z: minZ }, { x: left, z: cz });
    const closing = points[points.length - 1];
    points[0].handleIn = closing.handleIn;
    points[0].mode = "smooth";
    segments[segments.length - 1].endId = points[0].id;
    points.pop();
    return { points, segments };
  }

  const r = width / 2;
  const cx = (minX + maxX) / 2;
  const top = minZ + r;
  const bottom = maxZ - r;
  if (bottom - top < 0.05) {
    return circleSketchGeometry({ x: cx, z: (minZ + maxZ) / 2 }, r);
  }
  points.push({ id: createLocalId("sketch-point"), x: maxX, z: top, mode: "corner" });
  appendLine(points, segments, { x: maxX, z: bottom });
  appendQuarterArc(points, segments, { x: maxX, z: bottom }, { x: cx, z: maxZ }, { x: cx, z: bottom });
  appendQuarterArc(points, segments, { x: cx, z: maxZ }, { x: minX, z: bottom }, { x: cx, z: bottom });
  appendLine(points, segments, { x: minX, z: top });
  appendQuarterArc(points, segments, { x: minX, z: top }, { x: cx, z: minZ }, { x: cx, z: top });
  appendQuarterArc(points, segments, { x: cx, z: minZ }, { x: maxX, z: top }, { x: cx, z: top });
  const closing = points[points.length - 1];
  points[0].handleIn = closing.handleIn;
  points[0].mode = "smooth";
  segments[segments.length - 1].endId = points[0].id;
  points.pop();
  return { points, segments };
}

/** Regular star polygon; `points` is tip count (default 5). */
export function starSketchGeometry(
  center: { x: number; z: number },
  tip: { x: number; z: number },
  tips = DEFAULT_SKETCH_STAR_POINTS,
): Pick<SketchProfile, "points" | "segments"> | null {
  const count = Math.max(3, Math.min(16, Math.round(tips)));
  const outer = Math.hypot(tip.x - center.x, tip.z - center.z);
  if (outer < 0.25) return null;
  const inner = outer * 0.382;
  const startAngle = Math.atan2(tip.z - center.z, tip.x - center.x);
  const verts: Array<{ x: number; z: number }> = [];
  for (let index = 0; index < count * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = startAngle + (index * Math.PI) / count;
    verts.push({
      x: center.x + Math.cos(angle) * radius,
      z: center.z + Math.sin(angle) * radius,
    });
  }
  return closedLineRing(verts);
}

export const DEFAULT_SKETCH_POLYGON_SIDES = 6;
export const MIN_SKETCH_POLYGON_SIDES = 3;
export const MAX_SKETCH_POLYGON_SIDES = 16;
export const DEFAULT_SKETCH_STAR_POINTS = 5;
