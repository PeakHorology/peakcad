import { cloneWorkplaneShapeSnapshot, compactEdgeTreatmentHistory, edgeTreatmentAppliedFrame } from "@/lib/edgeTreatmentHistory";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import type { ThreadFeature, ThreadHistoryEntry, WorkplaneShape } from "@/types/sketchforge";

export function threadAppliedFrame(shape: WorkplaneShape) {
  return edgeTreatmentAppliedFrame(shape);
}

export function compactThreadHistory(history: ThreadHistoryEntry[] | undefined): ThreadHistoryEntry[] {
  return (history ?? []).map((entry) => ({
    ...entry,
    feature: { ...entry.feature },
    before: cloneWorkplaneShapeSnapshot(entry.before),
  }));
}

export function shapeWithThreadRecord(
  baked: WorkplaneShape,
  before: WorkplaneShape,
  feature: ThreadFeature,
  createdAt = Date.now(),
): WorkplaneShape {
  const historyEntry: ThreadHistoryEntry = {
    id: `thread-${createdAt}-${feature.faceId}`,
    createdAt,
    feature: { ...feature },
    before: cloneWorkplaneShapeSnapshot(before),
    appliedFrame: threadAppliedFrame(before),
  };
  return canonicalizeShape({
    ...baked,
    id: before.id,
    name: before.name,
    color: before.color,
    hole: before.hole,
    locked: before.locked,
    hidden: before.hidden,
    threadFeatures: [...(before.threadFeatures ?? []), feature],
    threadHistory: [...compactThreadHistory(before.threadHistory), historyEntry],
    edgeTreatmentHistory: compactEdgeTreatmentHistory(baked.edgeTreatmentHistory ?? before.edgeTreatmentHistory),
  });
}

export function restoreShapeBeforeThread(shape: WorkplaneShape, entry: ThreadHistoryEntry) {
  const before = cloneWorkplaneShapeSnapshot(entry.before);
  const entryIndex = (shape.threadHistory ?? []).findIndex((candidate) => candidate.id === entry.id);
  const earlierHistory = entryIndex > 0 ? compactThreadHistory(shape.threadHistory?.slice(0, entryIndex)) : undefined;
  const applied = entry.appliedFrame;
  const width = applied ? before.width * shape.width / Math.max(0.001, applied.width) : before.width;
  const depth = applied ? before.depth * shape.depth / Math.max(0.001, applied.depth) : before.depth;
  const height = applied ? before.height * shape.height / Math.max(0.001, applied.height) : before.height;
  const toggleMirror = (beforeValue: boolean | undefined, currentValue: boolean | undefined, appliedValue: boolean | undefined) => (
    Boolean(beforeValue) !== (Boolean(currentValue) !== Boolean(appliedValue))
  ) || undefined;
  return canonicalizeShape({
    ...before,
    id: shape.id,
    name: shape.name,
    color: shape.color,
    hole: shape.hole || undefined,
    locked: shape.locked,
    hidden: shape.hidden,
    x: applied ? before.x + shape.x - applied.x : before.x,
    z: applied ? before.z + shape.z - applied.z : before.z,
    elevation: applied ? (before.elevation ?? 0) + (shape.elevation ?? 0) - applied.elevation : before.elevation,
    width,
    depth,
    height,
    size: Math.max(width, depth),
    rotation: applied ? (before.rotation ?? 0) + (shape.rotation ?? 0) - applied.rotation : before.rotation,
    rotationX: applied ? (before.rotationX ?? 0) + (shape.rotationX ?? 0) - applied.rotationX : before.rotationX,
    rotationZ: applied ? (before.rotationZ ?? 0) + (shape.rotationZ ?? 0) - applied.rotationZ : before.rotationZ,
    mirrorX: applied ? toggleMirror(before.mirrorX, shape.mirrorX, applied.mirrorX) : before.mirrorX,
    mirrorY: applied ? toggleMirror(before.mirrorY, shape.mirrorY, applied.mirrorY) : before.mirrorY,
    mirrorZ: applied ? toggleMirror(before.mirrorZ, shape.mirrorZ, applied.mirrorZ) : before.mirrorZ,
    threadHistory: earlierHistory?.length ? earlierHistory : undefined,
  });
}
