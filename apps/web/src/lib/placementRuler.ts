import type { WorkplaneShape } from "@/types/sketchforge";

export type PlacementOrigin = { x: number; y: number; z: number };

export type PlacementOffsets = {
  x: number;
  y: number;
  z: number;
};

export type PlacementRulerScreenAxis = {
  axis: keyof PlacementOffsets;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
};

const LABEL_PERP_OFFSET = 28;
const LABEL_MIN_SEGMENT = 20;
const LABEL_MIN_SEPARATION = 74;
const LABEL_FALLBACK: Record<keyof PlacementOffsets, { x: number; y: number }> = {
  x: { x: -46, y: 28 },
  y: { x: 10, y: 52 },
  z: { x: 34, y: -46 },
};

function hypot(x: number, y: number) {
  return Math.sqrt(x * x + y * y);
}

function labelBesideSegment(
  axis: keyof PlacementOffsets,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { labelX: number; labelY: number } {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = hypot(dx, dy);
  if (length < LABEL_MIN_SEGMENT) {
    const fallback = LABEL_FALLBACK[axis];
    return { labelX: midX + fallback.x, labelY: midY + fallback.y };
  }
  return {
    labelX: midX + (-dy / length) * LABEL_PERP_OFFSET,
    labelY: midY + (dx / length) * LABEL_PERP_OFFSET,
  };
}

/** Nudge screen labels off their guides and apart when two axes collapse onto the same pixel. */
export function placePlacementRulerLabels(
  axes: ReadonlyArray<Pick<PlacementRulerScreenAxis, "axis" | "x1" | "y1" | "x2" | "y2">>,
): PlacementRulerScreenAxis[] {
  const placed = axes.map((axis) => ({
    ...axis,
    ...labelBesideSegment(axis.axis, axis.x1, axis.y1, axis.x2, axis.y2),
  }));

  for (let pass = 0; pass < 3; pass += 1) {
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const left = placed[i];
        const right = placed[j];
        const dx = right.labelX - left.labelX;
        const dy = right.labelY - left.labelY;
        const distance = hypot(dx, dy);
        if (distance >= LABEL_MIN_SEPARATION) continue;
        const fallback = LABEL_FALLBACK[right.axis];
        const dirX = distance < 1 ? fallback.x : dx;
        const dirY = distance < 1 ? fallback.y : dy;
        const dirLength = hypot(dirX, dirY) || 1;
        const push = (LABEL_MIN_SEPARATION - Math.max(distance, 1)) / 2;
        const nx = dirX / dirLength;
        const ny = dirY / dirLength;
        left.labelX -= nx * push;
        left.labelY -= ny * push;
        right.labelX += nx * push;
        right.labelY += ny * push;
      }
    }
  }

  return placed;
}

function clean(value: number) {
  const rounded = Number(value.toFixed(4));
  return Math.abs(rounded) < 0.0005 ? 0 : rounded;
}

/** Workplane pose used as the 0,0,0 start for a placement-ruler move. */
export type PlacementBaseline = {
  x: number;
  z: number;
  elevation: number;
};

export function placementPoseOf(shape: Pick<WorkplaneShape, "x" | "z" | "elevation">): PlacementBaseline {
  return { x: shape.x, z: shape.z, elevation: shape.elevation ?? 0 };
}

/**
 * After undo/redo the shape is back at a previous pose. Re-capture 0,0,0 from that
 * restored pose so typed X/Y/Z deltas are not measured from the pre-history location.
 */
export function recapturePlacementBaseline(
  shapes: readonly Pick<WorkplaneShape, "id" | "x" | "z" | "elevation">[],
  selectedIds: readonly string[],
  previousBaselineId?: string | null,
): { baseline: PlacementBaseline | null; baselineId: string | null } {
  const id = selectedIds[0] ?? previousBaselineId ?? null;
  if (!id) return { baseline: null, baselineId: null };
  const shape = shapes.find((entry) => entry.id === id);
  if (!shape) return { baseline: null, baselineId: null };
  return { baseline: placementPoseOf(shape), baselineId: shape.id };
}

/**
 * How far the shape has moved from the pose when the ruler started.
 * X is workplane X, Y is workplane depth, Z is up.
 */
export function placementOffsetsFromBaseline(
  shape: Pick<WorkplaneShape, "x" | "z" | "elevation">,
  baseline: PlacementBaseline,
): PlacementOffsets {
  return {
    x: clean(shape.x - baseline.x),
    y: clean(shape.z - baseline.z),
    z: clean((shape.elevation ?? 0) - baseline.elevation),
  };
}

export function applyPlacementOffset(
  baseline: PlacementBaseline,
  axis: keyof PlacementOffsets,
  value: number,
): Partial<WorkplaneShape> {
  const next = Number.isFinite(value) ? value : 0;
  if (axis === "x") return { x: clean(baseline.x + next) };
  if (axis === "y") return { z: clean(baseline.z + next) };
  return { elevation: clean(baseline.elevation + next) };
}

export function applyPlacementOffsetsToSelection(
  shapes: readonly WorkplaneShape[],
  selectedIds: readonly string[],
  baseline: PlacementBaseline,
  axis: keyof PlacementOffsets,
  value: number,
): WorkplaneShape[] {
  const selected = new Set(selectedIds);
  const unlocked = shapes.filter((shape) => selected.has(shape.id) && !shape.locked);
  if (unlocked.length === 0) return [...shapes];

  const primary = unlocked[0];
  const primaryPatch = applyPlacementOffset(baseline, axis, value);
  const deltaX = (primaryPatch.x ?? primary.x) - primary.x;
  const deltaZ = (primaryPatch.z ?? primary.z) - primary.z;
  const deltaElevation = (primaryPatch.elevation ?? primary.elevation ?? 0) - (primary.elevation ?? 0);

  return shapes.map((shape) => {
    if (!selected.has(shape.id) || shape.locked) return shape;
    return {
      ...shape,
      x: clean(shape.x + deltaX),
      z: clean(shape.z + deltaZ),
      elevation: clean((shape.elevation ?? 0) + deltaElevation),
    };
  });
}
