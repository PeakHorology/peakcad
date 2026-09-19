import { duplicateShapeForPattern } from "@/lib/circularPattern";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export const LINEAR_PATTERN_MIN_COUNT = 1;
export const LINEAR_PATTERN_MAX_COUNT = 24;
export const LINEAR_PATTERN_DEFAULT_COUNT_X = 3;
export const LINEAR_PATTERN_DEFAULT_COUNT_Z = 1;
export const LINEAR_PATTERN_DEFAULT_COUNT_Y = 1;
export const LINEAR_PATTERN_MIN_SPACING = 0.1;
export const LINEAR_PATTERN_MAX_SPACING = 160;
export const LINEAR_PATTERN_POSITION_LIMIT = 110;
const MIN_ELEVATION = 0;
const MAX_ELEVATION = 180;

export type LinearPatternCounts = {
  countX: number;
  countZ: number;
  countY?: number;
};

export type LinearPatternSpacing = {
  spacingX: number;
  spacingZ: number;
  spacingY?: number;
};

export type LinearPatternOptions = {
  createId?: (sourceId: string, ix: number, iz: number, iy: number) => string;
};

function clampPosition(value: number) {
  return Math.max(-LINEAR_PATTERN_POSITION_LIMIT, Math.min(LINEAR_PATTERN_POSITION_LIMIT, value));
}

function clampElevation(value: number) {
  return Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, value));
}

function clean(value: number) {
  const rounded = Number(value.toFixed(4));
  return Math.abs(rounded) < 0.0005 ? 0 : rounded;
}

export function clampLinearPatternCount(count: number, fallback = LINEAR_PATTERN_DEFAULT_COUNT_X) {
  if (!Number.isFinite(count)) return fallback;
  return Math.max(LINEAR_PATTERN_MIN_COUNT, Math.min(LINEAR_PATTERN_MAX_COUNT, Math.round(count)));
}

export function clampLinearPatternSpacing(spacing: number, fallback = 20) {
  if (!Number.isFinite(spacing)) return fallback;
  const clamped = Math.max(-LINEAR_PATTERN_MAX_SPACING, Math.min(LINEAR_PATTERN_MAX_SPACING, spacing));
  if (Math.abs(clamped) < LINEAR_PATTERN_MIN_SPACING) {
    return 0;
  }
  return clamped;
}

export function linearPatternCopyId(sourceId: string, ix: number, iz: number, iy: number) {
  return `${sourceId}__linear_pattern__${ix}_${iz}_${iy}`;
}

export function resolveLinearPatternSourceId(
  pickId: string,
  session: { sourceIds: readonly string[] },
): string | null {
  if (session.sourceIds.includes(pickId)) return pickId;
  const marker = "__linear_pattern__";
  const markerAt = pickId.indexOf(marker);
  if (markerAt > 0) {
    const sourceId = pickId.slice(0, markerAt);
    if (session.sourceIds.includes(sourceId)) return sourceId;
  }
  return null;
}

export function linearPatternSuggestedSpacing(
  sources: readonly Pick<WorkplaneShape, "width" | "depth" | "size" | "height">[],
  axis: "x" | "z" | "y",
) {
  if (sources.length === 0) return 20;
  const gap = 2;
  if (axis === "x") return clampLinearPatternSpacing(Math.max(...sources.map((shape) => shapeWidth(shape))) + gap);
  if (axis === "z") return clampLinearPatternSpacing(Math.max(...sources.map((shape) => shapeDepth(shape))) + gap);
  return clampLinearPatternSpacing(Math.max(...sources.map((shape) => shape.height)) + gap);
}

export function linearPatternInstanceCount(counts: LinearPatternCounts) {
  const countX = clampLinearPatternCount(counts.countX, LINEAR_PATTERN_DEFAULT_COUNT_X);
  const countZ = clampLinearPatternCount(counts.countZ ?? 1, LINEAR_PATTERN_DEFAULT_COUNT_Z);
  const countY = clampLinearPatternCount(counts.countY ?? 1, LINEAR_PATTERN_DEFAULT_COUNT_Y);
  return countX * countZ * countY;
}

export function linearPatternWouldClamp(
  sources: readonly Pick<WorkplaneShape, "x" | "z">[],
  counts: LinearPatternCounts,
  spacing: LinearPatternSpacing,
) {
  const countX = clampLinearPatternCount(counts.countX, LINEAR_PATTERN_DEFAULT_COUNT_X);
  const countZ = clampLinearPatternCount(counts.countZ ?? 1, LINEAR_PATTERN_DEFAULT_COUNT_Z);
  const spacingX = clampLinearPatternSpacing(spacing.spacingX);
  const spacingZ = clampLinearPatternSpacing(spacing.spacingZ);
  return sources.some((source) => {
    for (let ix = 0; ix < countX; ix += 1) {
      for (let iz = 0; iz < countZ; iz += 1) {
        const x = source.x + ix * spacingX;
        const z = source.z + iz * spacingZ;
        if (Math.abs(x) > LINEAR_PATTERN_POSITION_LIMIT || Math.abs(z) > LINEAR_PATTERN_POSITION_LIMIT) {
          return true;
        }
      }
    }
    return false;
  });
}

/**
 * Build a rectangular / linear array. Instance (0,0,0) keeps the source id.
 * Offsets are applied in workplane X/Z and optional elevation Y.
 */
export function linearPatternInstances(
  sources: readonly WorkplaneShape[],
  counts: LinearPatternCounts,
  spacing: LinearPatternSpacing,
  options: LinearPatternOptions = {},
): WorkplaneShape[] {
  const countX = clampLinearPatternCount(counts.countX, LINEAR_PATTERN_DEFAULT_COUNT_X);
  const countZ = clampLinearPatternCount(counts.countZ ?? 1, LINEAR_PATTERN_DEFAULT_COUNT_Z);
  const countY = clampLinearPatternCount(counts.countY ?? 1, LINEAR_PATTERN_DEFAULT_COUNT_Y);
  const spacingX = clampLinearPatternSpacing(spacing.spacingX);
  const spacingZ = clampLinearPatternSpacing(spacing.spacingZ);
  const spacingY = clampLinearPatternSpacing(spacing.spacingY ?? linearPatternSuggestedSpacing(sources, "y"));
  const createId = options.createId ?? linearPatternCopyId;
  const results: WorkplaneShape[] = [];

  for (const source of sources) {
    for (let iy = 0; iy < countY; iy += 1) {
      for (let iz = 0; iz < countZ; iz += 1) {
        for (let ix = 0; ix < countX; ix += 1) {
          const keep = ix === 0 && iz === 0 && iy === 0;
          const id = keep ? source.id : createId(source.id, ix, iz, iy);
          const base = keep ? { ...source } : duplicateShapeForPattern(source, id);
          results.push({
            ...base,
            id,
            x: clampPosition(clean(source.x + ix * spacingX)),
            z: clampPosition(clean(source.z + iz * spacingZ)),
            elevation: clampElevation(clean((source.elevation ?? 0) + iy * spacingY)),
          });
        }
      }
    }
  }

  return results;
}
