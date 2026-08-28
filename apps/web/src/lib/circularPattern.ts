import { cloneWorkplaneShapeSnapshot } from "@/lib/edgeTreatmentHistory";
import type { WorkplaneShape } from "@/types/sketchforge";

export const CIRCULAR_PATTERN_MIN_COUNT = 2;
export const CIRCULAR_PATTERN_MAX_COUNT = 72;
export const CIRCULAR_PATTERN_DEFAULT_COUNT = 6;
export const CIRCULAR_PATTERN_MIN_RADIUS = 1;
export const CIRCULAR_PATTERN_MAX_RADIUS = 100;
export const CIRCULAR_PATTERN_RADIUS_STEP = 0.1;
/** Discrete yaw offsets applied on top of “face center” orientation. */
export const CIRCULAR_PATTERN_ROTATION_STEPS = [0, 90, 180, 270] as const;
export type CircularPatternRotationStep = (typeof CIRCULAR_PATTERN_ROTATION_STEPS)[number];
const MIN_PATTERN_RADIUS = 1e-4;
/** Workplane ±X/±Z clamp applied to patterned instance positions (mm). */
export const CIRCULAR_PATTERN_POSITION_LIMIT = 110;
const POSITION_LIMIT = CIRCULAR_PATTERN_POSITION_LIMIT;
const MIN_ELEVATION = 0;
const MAX_ELEVATION = 180;

export type CircularPatternCenter = { x: number; z: number };

export type CircularPatternOptions = {
  /** When set, every instance uses this orbit radius (mm) instead of each source’s distance. */
  radius?: number;
  /**
   * Bottom elevation (mm) for every instance — typically the pivot’s top so patterned
   * shapes sit on the selected orbit shape.
   */
  seatElevation?: number;
  /** Extra yaw in degrees, snapped to 0 / 90 / 180 / 270. */
  rotationOffset?: number;
  createId?: (sourceId: string, index: number) => string;
};

function clampElevation(value: number) {
  return Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, value));
}

function clampPosition(value: number) {
  return Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, value));
}

function normalizeDegrees(degrees: number) {
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return value;
}

export function clampCircularPatternCount(count: number) {
  if (!Number.isFinite(count)) return CIRCULAR_PATTERN_DEFAULT_COUNT;
  return Math.max(CIRCULAR_PATTERN_MIN_COUNT, Math.min(CIRCULAR_PATTERN_MAX_COUNT, Math.round(count)));
}

export function clampCircularPatternRadius(radius: number) {
  if (!Number.isFinite(radius)) return CIRCULAR_PATTERN_MIN_RADIUS;
  return Math.max(CIRCULAR_PATTERN_MIN_RADIUS, Math.min(CIRCULAR_PATTERN_MAX_RADIUS, radius));
}

export function clampCircularPatternRotation(degrees: number): CircularPatternRotationStep {
  if (!Number.isFinite(degrees)) return 0;
  let value = ((degrees % 360) + 360) % 360;
  if (value > 315 || value <= 45) return 0;
  if (value <= 135) return 90;
  if (value <= 225) return 180;
  return 270;
}

/** Polar angle of a footprint point around `center` (θ=0 at +Z, increasing toward +X). */
export function patternPolarAngle(center: CircularPatternCenter, point: CircularPatternCenter) {
  return Math.atan2(point.x - center.x, point.z - center.z);
}

/**
 * Yaw (degrees) so local −Z faces the pattern center (Three.js Object3D default).
 * Equals the polar angle of the point around the center.
 */
export function patternYawDegrees(center: CircularPatternCenter, point: CircularPatternCenter) {
  return normalizeDegrees(
    (Math.atan2(point.x - center.x, point.z - center.z) * 180) / Math.PI,
  );
}

export function patternRadius(center: CircularPatternCenter, point: CircularPatternCenter) {
  return Math.hypot(point.x - center.x, point.z - center.z);
}

/** Elevation where a patterned shape’s bottom sits on the pivot’s top face. */
export function patternSeatElevationOnPivot(pivot: Pick<WorkplaneShape, "elevation" | "height">) {
  return clampElevation((pivot.elevation ?? 0) + Math.max(0, pivot.height));
}

function pointOnCircle(center: CircularPatternCenter, radius: number, angleRad: number): CircularPatternCenter {
  return {
    x: clampPosition(center.x + radius * Math.sin(angleRad)),
    z: clampPosition(center.z + radius * Math.cos(angleRad)),
  };
}

/** True when any instance would land outside the ±POSITION_LIMIT workplane box before clamping. */
export function circularPatternWouldClamp(
  center: CircularPatternCenter,
  radius: number,
  count: number,
  baseAngleRad = 0,
): boolean {
  const total = clampCircularPatternCount(count);
  const safeRadius = clampCircularPatternRadius(radius);
  const step = (Math.PI * 2) / total;
  for (let index = 0; index < total; index += 1) {
    const angle = baseAngleRad + step * index;
    const x = center.x + safeRadius * Math.sin(angle);
    const z = center.z + safeRadius * Math.cos(angle);
    if (Math.abs(x) > POSITION_LIMIT || Math.abs(z) > POSITION_LIMIT) return true;
  }
  return false;
}

/** Deep-clone a shape for pattern copies (includes nested groups / meshes). */
export function duplicateShapeForPattern(shape: WorkplaneShape, id: string): WorkplaneShape {
  const clone = cloneWorkplaneShapeSnapshot(shape);
  return { ...clone, id };
}

function placeInstance(
  source: WorkplaneShape,
  id: string,
  center: CircularPatternCenter,
  angleRad: number,
  radius: number,
  seatElevation: number | null,
  rotationOffset: CircularPatternRotationStep,
  _instanceIndex = 0,
): WorkplaneShape {
  const point = pointOnCircle(center, radius, angleRad);
  const base = id === source.id ? { ...source } : duplicateShapeForPattern(source, id);
  return {
    ...base,
    id,
    x: point.x,
    z: point.z,
    elevation: seatElevation === null ? (base.elevation ?? 0) : seatElevation,
    rotation: normalizeDegrees(patternYawDegrees(center, point) + rotationOffset),
  };
}

/** Stable id for a patterned copy (instance 0 keeps the source id). */
export function circularPatternCopyId(sourceId: string, index: number) {
  return `${sourceId}__circular_pattern__${index}`;
}

/**
 * Map a viewport pick (source or patterned copy) back to its source shape id.
 * Returns null when the pick is not part of the active pattern sources.
 */
export function resolveCircularPatternSourceId(
  pickId: string,
  session: { sourceIds: readonly string[]; count: number; preview: readonly WorkplaneShape[] | null },
): string | null {
  if (session.sourceIds.includes(pickId)) return pickId;
  const marker = "__circular_pattern__";
  const markerAt = pickId.indexOf(marker);
  if (markerAt > 0) {
    const sourceId = pickId.slice(0, markerAt);
    if (session.sourceIds.includes(sourceId)) return sourceId;
  }
  if (!session.preview?.length) return null;
  const total = clampCircularPatternCount(session.count);
  let offset = 0;
  for (const sourceId of session.sourceIds) {
    const slice = session.preview.slice(offset, offset + total);
    if (slice.some((shape) => shape.id === pickId)) return sourceId;
    offset += total;
  }
  return null;
}

/**
 * Build N total instances for each source around `center`.
 * Instance 0 keeps the source id; others get new ids.
 * Pass `options.radius` to force a shared orbit radius (slider-driven UI).
 * Pass `options.seatElevation` to seat instance bottoms (e.g. on the pivot top).
 */
export function circularPatternInstances(
  sources: readonly WorkplaneShape[],
  center: CircularPatternCenter,
  count: number,
  options: CircularPatternOptions = {},
): WorkplaneShape[] {
  const total = clampCircularPatternCount(count);
  const createId = options.createId ?? circularPatternCopyId;
  const forcedRadius = typeof options.radius === "number" ? clampCircularPatternRadius(options.radius) : null;
  const seatElevation = typeof options.seatElevation === "number"
    ? clampElevation(options.seatElevation)
    : null;
  const rotationOffset = clampCircularPatternRotation(options.rotationOffset ?? 0);
  const results: WorkplaneShape[] = [];

  for (const source of sources) {
    const naturalRadius = patternRadius(center, { x: source.x, z: source.z });
    const radius = forcedRadius ?? naturalRadius;
    if (radius < MIN_PATTERN_RADIUS) {
      results.push({
        ...source,
        elevation: seatElevation === null ? source.elevation : seatElevation,
        rotation: normalizeDegrees(patternYawDegrees(center, { x: source.x, z: source.z }) + rotationOffset),
      });
      continue;
    }

    const baseAngle = naturalRadius < MIN_PATTERN_RADIUS
      ? 0
      : patternPolarAngle(center, { x: source.x, z: source.z });
    const step = (Math.PI * 2) / total;
    for (let index = 0; index < total; index += 1) {
      const id = index === 0 ? source.id : createId(source.id, index);
      results.push(placeInstance(source, id, center, baseAngle + step * index, radius, seatElevation, rotationOffset, index));
    }
  }

  return results;
}

/** Orbit radius taken from a pivot shape’s footprint (half the longest width/depth). */
export function circularPatternRadiusFromShape(shape: Pick<WorkplaneShape, "width" | "depth" | "size" | "radius">) {
  const width = shape.width ?? shape.size ?? 0;
  const depth = shape.depth ?? shape.size ?? 0;
  const footprint = Math.max(width, depth) / 2;
  const explicit = typeof shape.radius === "number" && Number.isFinite(shape.radius) ? shape.radius : 0;
  return clampCircularPatternRadius(Math.max(footprint, explicit, CIRCULAR_PATTERN_MIN_RADIUS));
}

/** @deprecated Prefer circularPatternRadiusFromShape for pivot-based patterns. */
export function circularPatternSuggestedRadius(
  sources: readonly WorkplaneShape[],
  center: CircularPatternCenter,
) {
  if (!sources.length) return CIRCULAR_PATTERN_MIN_RADIUS * 10;
  let total = 0;
  let used = 0;
  for (const source of sources) {
    const radius = patternRadius(center, { x: source.x, z: source.z });
    if (radius >= MIN_PATTERN_RADIUS) {
      total += radius;
      used += 1;
    }
  }
  if (!used) return 20;
  return clampCircularPatternRadius(total / used);
}
