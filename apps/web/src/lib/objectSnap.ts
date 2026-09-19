import { worldAabb } from "@/lib/shapeBounds";
import type { WorkplaneShape } from "@/types/sketchforge";

export const OBJECT_SNAP_DEFAULT_TOLERANCE = 1.5;

export type SnapAabb = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type ObjectSnapKind = "face" | "edge" | "mid";

export type ObjectSnapGuide = {
  kind: ObjectSnapKind;
  axis: "x" | "z" | "xz";
  start: { x: number; y: number; z: number };
  end: { x: number; y: number; z: number };
};

export type ObjectSnapResult = {
  deltaX: number;
  deltaZ: number;
  kind: ObjectSnapKind;
  guides: ObjectSnapGuide[];
};

type AxisCandidate = {
  kind: "face" | "mid";
  axis: "x" | "z";
  delta: number;
  error: number;
  line: number;
  moving: SnapAabb;
  target: SnapAabb;
};

function clean(value: number) {
  const rounded = Number(value.toFixed(6));
  return Math.abs(rounded) < 1e-6 ? 0 : rounded;
}

export function snapAabbFromShape(shape: WorkplaneShape): SnapAabb {
  const box = worldAabb(shape);
  return {
    minX: box.min[0],
    maxX: box.max[0],
    minY: box.min[1],
    maxY: box.max[1],
    minZ: box.min[2],
    maxZ: box.max[2],
  };
}

export function unionSnapAabbs(boxes: readonly SnapAabb[]): SnapAabb | null {
  if (boxes.length === 0) return null;
  return boxes.reduce((bounds, box) => ({
    minX: Math.min(bounds.minX, box.minX),
    maxX: Math.max(bounds.maxX, box.maxX),
    minY: Math.min(bounds.minY, box.minY),
    maxY: Math.max(bounds.maxY, box.maxY),
    minZ: Math.min(bounds.minZ, box.minZ),
    maxZ: Math.max(bounds.maxZ, box.maxZ),
  }));
}

export function translateSnapAabb(box: SnapAabb, deltaX: number, deltaZ: number): SnapAabb {
  return {
    ...box,
    minX: box.minX + deltaX,
    maxX: box.maxX + deltaX,
    minZ: box.minZ + deltaZ,
    maxZ: box.maxZ + deltaZ,
  };
}

function axisPairs(moving: SnapAabb, target: SnapAabb, axis: "x" | "z"): Array<{ kind: "face" | "mid"; moving: number; target: number }> {
  const mMin = axis === "x" ? moving.minX : moving.minZ;
  const mMax = axis === "x" ? moving.maxX : moving.maxZ;
  const tMin = axis === "x" ? target.minX : target.minZ;
  const tMax = axis === "x" ? target.maxX : target.maxZ;
  return [
    { kind: "face", moving: mMax, target: tMin },
    { kind: "face", moving: mMin, target: tMax },
    { kind: "face", moving: mMin, target: tMin },
    { kind: "face", moving: mMax, target: tMax },
    { kind: "mid", moving: (mMin + mMax) / 2, target: (tMin + tMax) / 2 },
  ];
}

function pickAxisCandidate(
  moving: SnapAabb,
  targets: readonly SnapAabb[],
  axis: "x" | "z",
  proposedDelta: number,
  tolerance: number,
): AxisCandidate | null {
  let best: AxisCandidate | null = null;
  for (const target of targets) {
    for (const pair of axisPairs(moving, target, axis)) {
      const delta = pair.target - pair.moving;
      const error = Math.abs(delta - proposedDelta);
      if (error > tolerance + 1e-6) continue;
      const rank = pair.kind === "face" ? 0 : 1;
      const bestRank = best?.kind === "face" ? 0 : 1;
      if (!best || rank < bestRank || (rank === bestRank && error < best.error - 1e-9)) {
        best = {
          kind: pair.kind,
          axis,
          delta,
          error,
          line: pair.target,
          moving,
          target,
        };
      }
    }
  }
  return best;
}

function guideForCandidate(candidate: AxisCandidate, moved: SnapAabb): ObjectSnapGuide {
  const y = Math.max(moved.minY, candidate.target.minY);
  const top = Math.min(moved.maxY, candidate.target.maxY);
  const midY = (y + top) / 2;
  if (candidate.axis === "x") {
    const z0 = Math.min(moved.minZ, candidate.target.minZ);
    const z1 = Math.max(moved.maxZ, candidate.target.maxZ);
    return {
      kind: candidate.kind,
      axis: "x",
      start: { x: candidate.line, y: midY, z: z0 },
      end: { x: candidate.line, y: midY, z: z1 },
    };
  }
  const x0 = Math.min(moved.minX, candidate.target.minX);
  const x1 = Math.max(moved.maxX, candidate.target.maxX);
  return {
    kind: candidate.kind,
    axis: "z",
    start: { x: x0, y: midY, z: candidate.line },
    end: { x: x1, y: midY, z: candidate.line },
  };
}

/**
 * Snap a moving AABB against other shapes on X/Z: face-to-face, flush, or midpoint.
 * `proposedDelta` is the unconstrained drag delta from the start pose.
 */
export function snapMovingAabb(
  moving: SnapAabb,
  targets: readonly SnapAabb[],
  proposedDelta: { x: number; z: number },
  tolerance = OBJECT_SNAP_DEFAULT_TOLERANCE,
): ObjectSnapResult | null {
  if (targets.length === 0 || !(tolerance > 0)) return null;
  const xHit = pickAxisCandidate(moving, targets, "x", proposedDelta.x, tolerance);
  const zHit = pickAxisCandidate(moving, targets, "z", proposedDelta.z, tolerance);
  const xChanged = Boolean(xHit && Math.abs(xHit.delta - proposedDelta.x) > 1e-6);
  const zChanged = Boolean(zHit && Math.abs(zHit.delta - proposedDelta.z) > 1e-6);
  if (!xChanged && !zChanged) return null;

  const deltaX = clean(xHit?.delta ?? proposedDelta.x);
  const deltaZ = clean(zHit?.delta ?? proposedDelta.z);
  const moved = translateSnapAabb(moving, deltaX, deltaZ);
  const guides: ObjectSnapGuide[] = [];
  if (xHit) guides.push(guideForCandidate(xHit, moved));
  if (zHit) guides.push(guideForCandidate(zHit, moved));

  const kind: ObjectSnapKind = xHit && zHit ? "edge" : (xHit?.kind === "mid" || zHit?.kind === "mid") ? "mid" : "face";
  return { deltaX, deltaZ, kind, guides };
}

export function objectSnapTolerance(gridStep: number) {
  return Math.max(OBJECT_SNAP_DEFAULT_TOLERANCE, gridStep > 0 ? gridStep : 0);
}
