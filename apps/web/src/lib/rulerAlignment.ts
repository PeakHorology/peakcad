/** Detect when a measure line is a true diameter or axis-aligned with the part. */

export type Vec3 = { x: number; y: number; z: number };

export type MeasureAlignKind = "diameter" | "axis" | "face";

export type MeasureAlignment = {
  kind: MeasureAlignKind;
  /** Local axis the measure follows, when kind is "axis". */
  axis?: "x" | "y" | "z";
};

export type CircleFit = {
  center: Vec3;
  axis: Vec3;
  radius: number;
};

export type ShapeAxes = {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
};

const AXIS_ALIGN_DOT = Math.cos((8 * Math.PI) / 180);
const FACE_ALIGN_DOT = Math.cos((10 * Math.PI) / 180);
const DIAMETER_AXIS_DOT = Math.cos((82 * Math.PI) / 180);

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function vecScale(a: Vec3, s: number): Vec3 {
  return vec3(a.x * s, a.y * s, a.z * s);
}

export function vecDot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

export function vecLength(a: Vec3) {
  return Math.hypot(a.x, a.y, a.z);
}

export function vecNormalize(a: Vec3): Vec3 {
  const length = vecLength(a);
  if (length < 1e-12) return vec3(0, 1, 0);
  return vecScale(a, 1 / length);
}

export function vecDistance(a: Vec3, b: Vec3) {
  return vecLength(vecSub(a, b));
}

export function vecLerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return vecAdd(a, vecScale(vecSub(b, a), t));
}

function almostParallel(a: Vec3, b: Vec3, minAbsDot = AXIS_ALIGN_DOT) {
  return Math.abs(vecDot(vecNormalize(a), vecNormalize(b))) >= minAbsDot;
}

function almostPerpendicular(a: Vec3, b: Vec3, maxAbsDot = DIAMETER_AXIS_DOT) {
  return Math.abs(vecDot(vecNormalize(a), vecNormalize(b))) <= maxAbsDot;
}

/** Closest point on an infinite axis (origin + t*axis) to `point`. */
export function projectPointOnAxis(point: Vec3, origin: Vec3, axis: Vec3): Vec3 {
  const dir = vecNormalize(axis);
  return vecAdd(origin, vecScale(dir, vecDot(vecSub(point, origin), dir)));
}

/** Opposite point through a cylinder/circle axis — the other end of a diameter. */
export function antipodeThroughAxis(point: Vec3, origin: Vec3, axis: Vec3): Vec3 {
  const onAxis = projectPointOnAxis(point, origin, axis);
  return vecAdd(onAxis, vecScale(vecSub(onAxis, point), 1));
}

/**
 * Push a pick on a tessellated cylinder wall out to the true radius.
 * Facet chords sit slightly inside the circle, which is why a 20 mm cylinder
 * can measure as 19.97 mm. Axial position is unchanged.
 */
export function snapPointToCylinder(point: Vec3, origin: Vec3, axis: Vec3, radius: number): Vec3 {
  if (!(radius > 1e-9)) return point;
  const onAxis = projectPointOnAxis(point, origin, axis);
  const radial = vecSub(point, onAxis);
  const current = vecLength(radial);
  if (current < 1e-9) return point;
  return vecAdd(onAxis, vecScale(radial, radius / current));
}

export function isAxialDirection(dir: Vec3, axis: Vec3) {
  return almostParallel(dir, axis);
}

export function radialsAreOpposite(a: Vec3, b: Vec3, origin: Vec3, axis: Vec3, maxDot = -0.85) {
  const aRadial = vecSub(a, projectPointOnAxis(a, origin, axis));
  const bRadial = vecSub(b, projectPointOnAxis(b, origin, axis));
  if (vecLength(aRadial) < 1e-9 || vecLength(bRadial) < 1e-9) return false;
  return vecDot(vecNormalize(aRadial), vecNormalize(bRadial)) <= maxDot;
}

export function axialSeparation(a: Vec3, b: Vec3, origin: Vec3, axis: Vec3) {
  return vecDistance(projectPointOnAxis(a, origin, axis), projectPointOnAxis(b, origin, axis));
}

/**
 * Snap the second measure point to the true opposite wall when the pointer is
 * on the far side of a cylinder/hole. Screen distance to the antipode is a
 * magnet, not a hard requirement — opposite radials at similar height count.
 */
export function diameterMagnetTarget(
  seed: Vec3,
  hit: Vec3,
  circle: CircleFit,
  antipodeScreenDistPx: number,
  options?: { maxPx?: number; oppositeDot?: number },
): Vec3 | null {
  const maxPx = options?.maxPx ?? 28;
  const snappedSeed = snapPointToCylinder(seed, circle.center, circle.axis, circle.radius);
  const snappedHit = snapPointToCylinder(hit, circle.center, circle.axis, circle.radius);
  const antipode = antipodeThroughAxis(snappedSeed, circle.center, circle.axis);
  if (antipodeScreenDistPx <= maxPx * 0.45) return antipode;
  const opposite = radialsAreOpposite(
    snappedSeed,
    snappedHit,
    circle.center,
    circle.axis,
    options?.oppositeDot ?? -0.6,
  );
  const axial = axialSeparation(snappedSeed, snappedHit, circle.center, circle.axis);
  if (opposite && (antipodeScreenDistPx <= maxPx || axial <= Math.max(4, circle.radius * 0.25))) return antipode;
  const chord = vecSub(snappedHit, snappedSeed);
  const length = vecLength(chord);
  const nearFull = Math.abs(length - circle.radius * 2) <= Math.max(1, circle.radius * 0.12);
  if (nearFull && almostPerpendicular(chord, circle.axis) && antipodeScreenDistPx <= maxPx * 1.5) return antipode;
  return null;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Closest point on segment AB to a camera ray. Used so screen-space edge snaps
 * don't pick a far/back rim that only looks close after projection.
 */
export function closestPointOnSegmentToRay(
  a: Vec3,
  b: Vec3,
  rayOrigin: Vec3,
  rayDir: Vec3,
): { point: Vec3; segmentT: number; rayT: number; distance: number } {
  const d1 = vecSub(b, a);
  const d2 = vecNormalize(rayDir);
  const w = vecSub(a, rayOrigin);
  const aa = vecDot(d1, d1);
  const ab = vecDot(d1, d2);
  const d = vecDot(d1, w);
  const e = vecDot(d2, w);
  const denom = aa - ab * ab;
  let segmentT = 0;
  if (aa < 1e-16) {
    segmentT = 0;
  } else if (denom > 1e-16) {
    segmentT = clamp01((ab * e - d) / denom);
  } else {
    segmentT = clamp01(-d / aa);
  }
  const point = vecAdd(a, vecScale(d1, segmentT));
  const rayT = Math.max(0, vecDot(vecSub(point, rayOrigin), d2));
  const closestOnRay = vecAdd(rayOrigin, vecScale(d2, rayT));
  return { point, segmentT, rayT, distance: vecDistance(point, closestOnRay) };
}

/** True when an edge/vertex snap is actually next to the mesh hit, not just overlapping on screen. */
export function rulerEdgeNearSurfaceHit(hit: Vec3, edgePoint: Vec3, worldPerPixel: number) {
  const maxDist = Math.max(1.5, Math.min(3, worldPerPixel * 10));
  return vecDistance(hit, edgePoint) <= maxDist;
}

/**
 * Nearest hit on a finite cylinder (side wall and caps). Used when a faceted
 * mesh raycast misses a silhouette the user is clearly pointing at.
 */
export function intersectRayFiniteCylinder(
  rayOrigin: Vec3,
  rayDir: Vec3,
  center: Vec3,
  axis: Vec3,
  radius: number,
  halfHeight: number,
): { point: Vec3; t: number } | null {
  if (!(radius > 1e-6) || !(halfHeight > 1e-6)) return null;
  const d = vecNormalize(rayDir);
  const a = vecNormalize(axis);
  let bestT = Infinity;
  let best: Vec3 | null = null;
  const consider = (t: number, point: Vec3) => {
    if (t > 1e-4 && t < bestT) {
      bestT = t;
      best = point;
    }
  };

  for (const side of [-1, 1]) {
    const capCenter = vecAdd(center, vecScale(a, side * halfHeight));
    const denom = vecDot(d, a);
    if (Math.abs(denom) < 1e-8) continue;
    const t = vecDot(vecSub(capCenter, rayOrigin), a) / denom;
    const point = vecAdd(rayOrigin, vecScale(d, t));
    if (vecDistance(point, capCenter) <= radius + 1e-5) consider(t, point);
  }

  const oc = vecSub(rayOrigin, center);
  const card = vecSub(oc, vecScale(a, vecDot(oc, a)));
  const dirp = vecSub(d, vecScale(a, vecDot(d, a)));
  const qa = vecDot(dirp, dirp);
  const qb = 2 * vecDot(card, dirp);
  const qc = vecDot(card, card) - radius * radius;
  if (qa > 1e-12) {
    const disc = qb * qb - 4 * qa * qc;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
        const point = vecAdd(rayOrigin, vecScale(d, t));
        if (Math.abs(vecDot(vecSub(point, center), a)) <= halfHeight + 1e-5) consider(t, point);
      }
    }
  }

  return best ? { point: best, t: bestT } : null;
}

/**
 * When two faces are parallel, the Inspect-style second point: first point
 * projected onto the second plane along the first face normal.
 */
export function faceToFacePoint(start: Vec3, startNormal: Vec3, hit: Vec3, hitNormal?: Vec3): Vec3 | null {
  const n = vecNormalize(startNormal);
  const n2 = hitNormal ? vecNormalize(hitNormal) : n;
  if (!almostParallel(n, n2, FACE_ALIGN_DOT)) return null;
  const denom = vecDot(n, n2);
  if (Math.abs(denom) < 1e-8) return null;
  const t = vecDot(vecSub(hit, start), n2) / denom;
  return vecAdd(start, vecScale(n, t));
}

/**
 * Fit a circle to a closed (or nearly closed) polyline. Returns null when the
 * points are not coplanar or the radius is unstable.
 */
export function fitCircleFromPoints(points: readonly Vec3[]): CircleFit | null {
  const unique = points.length >= 2 && vecDistance(points[0], points[points.length - 1]) < 1e-4
    ? points.slice(0, -1)
    : points;
  if (unique.length < 8) return null;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const point of unique) {
    cx += point.x;
    cy += point.y;
    cz += point.z;
  }
  const inv = 1 / unique.length;
  const centroid = vec3(cx * inv, cy * inv, cz * inv);

  let planeAxis = vec3(0, 1, 0);
  let bestArea = 0;
  for (let index = 1; index < unique.length - 1; index += 1) {
    const spanned = vecCross(vecSub(unique[index], unique[0]), vecSub(unique[index + 1], unique[0]));
    const area = vecLength(spanned);
    if (area > bestArea) {
      bestArea = area;
      planeAxis = vecNormalize(spanned);
    }
  }
  if (bestArea < 1e-8) return null;

  let radiusSum = 0;
  let radiusSq = 0;
  let planeErr = 0;
  for (const point of unique) {
    const d = vecSub(point, centroid);
    planeErr += Math.abs(vecDot(d, planeAxis));
    const radial = vecLength(vecSub(d, vecScale(planeAxis, vecDot(d, planeAxis))));
    radiusSum += radial;
    radiusSq += radial * radial;
  }
  const radius = radiusSum * inv;
  if (radius < 0.4) return null;
  const variance = radiusSq * inv - radius * radius;
  const rms = Math.sqrt(Math.max(0, variance));
  if (rms > Math.max(0.25, radius * 0.06)) return null;
  if (planeErr * inv > Math.max(0.25, radius * 0.08)) return null;

  return { center: centroid, axis: planeAxis, radius };
}

export function isRoundMeasureKind(kind: string | undefined, hole?: boolean) {
  if (hole) return true;
  return kind === "cylinder"
    || kind === "tube"
    || kind === "ring"
    || kind === "torus"
    || kind === "thread"
    || kind === "cone"
    || kind === "sphere"
    || kind === "halfSphere";
}

/** Constant-radius barrels where a faceted pick should snap to the true circle. */
export function isConstantRadiusRoundKind(kind: string | undefined) {
  return kind === "cylinder" || kind === "tube" || kind === "ring" || kind === "thread";
}

export type ClassifyMeasureInput = {
  start: Vec3;
  end: Vec3;
  axes?: ShapeAxes;
  circle?: CircleFit;
  cylinder?: { origin: Vec3; axis: Vec3; radius: number };
  startNormal?: Vec3;
  endNormal?: Vec3;
  round?: boolean;
};

function diameterFromCircle(start: Vec3, end: Vec3, circle: CircleFit): MeasureAlignment | null {
  const chord = vecSub(end, start);
  const length = vecLength(chord);
  if (length < 0.4) return null;
  if (!almostPerpendicular(chord, circle.axis)) return null;
  const mid = vecLerp(start, end, 0.5);
  const midOnAxis = projectPointOnAxis(mid, circle.center, circle.axis);
  const offAxis = vecDistance(mid, midOnAxis);
  const radiusTol = Math.max(0.5, circle.radius * 0.12);
  if (Math.abs(length - circle.radius * 2) > radiusTol * 2) return null;
  if (offAxis > Math.max(radiusTol, circle.radius * 0.16)) return null;
  return { kind: "diameter" };
}

function diameterFromCylinder(start: Vec3, end: Vec3, cylinder: { origin: Vec3; axis: Vec3; radius: number }): MeasureAlignment | null {
  return diameterFromCircle(start, end, {
    center: cylinder.origin,
    axis: cylinder.axis,
    radius: cylinder.radius,
  });
}

function axisAlignment(start: Vec3, end: Vec3, axes: ShapeAxes): MeasureAlignment | null {
  const dir = vecSub(end, start);
  if (vecLength(dir) < 0.4) return null;
  const options: Array<{ axis: "x" | "y" | "z"; vector: Vec3 }> = [
    { axis: "x", vector: axes.x },
    { axis: "y", vector: axes.y },
    { axis: "z", vector: axes.z },
  ];
  for (const option of options) {
    if (almostParallel(dir, option.vector)) return { kind: "axis", axis: option.axis };
  }
  return null;
}

function faceAlignment(start: Vec3, end: Vec3, startNormal?: Vec3, endNormal?: Vec3): MeasureAlignment | null {
  if (!startNormal) return null;
  const dir = vecSub(end, start);
  if (vecLength(dir) < 0.4) return null;
  if (!almostParallel(dir, startNormal, FACE_ALIGN_DOT)) return null;
  if (endNormal && !almostParallel(startNormal, endNormal, FACE_ALIGN_DOT)) return null;
  return { kind: "face" };
}

/**
 * Classify a two-point measure. Diameter wins over face/axis so a hole reads as ⌀.
 */
export function classifyMeasureAlignment(input: ClassifyMeasureInput): MeasureAlignment | null {
  if (input.circle) {
    const diameter = diameterFromCircle(input.start, input.end, input.circle);
    if (diameter) return diameter;
  }
  if (input.cylinder) {
    const diameter = diameterFromCylinder(input.start, input.end, input.cylinder);
    if (diameter) return diameter;
  }
  const face = faceAlignment(input.start, input.end, input.startNormal, input.endNormal);
  if (face) return face;
  if (input.axes) {
    const axis = axisAlignment(input.start, input.end, input.axes);
    if (axis) return axis;
  }
  return null;
}

export function measureAlignLabelPrefix(kind: MeasureAlignKind | null | undefined) {
  if (kind === "diameter") return "⌀ ";
  if (kind === "face" || kind === "axis") return "∥ ";
  return "";
}
