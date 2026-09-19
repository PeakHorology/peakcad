import type {
  CircularPatternFeatureParams,
  LinearPatternFeatureParams,
  PatternFeature,
  WorkplaneShape,
} from "@/types/sketchforge";
import { circularPatternInstances, type CircularPatternRotationStep } from "@/lib/circularPattern";
import { linearPatternCopyId, linearPatternInstances } from "@/lib/linearPattern";

export type { CircularPatternFeatureParams, LinearPatternFeatureParams, PatternFeature };

export function patternFeatureId() {
  return `pattern-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isPatternSource(shape: Pick<WorkplaneShape, "patternFeature">) {
  return shape.patternFeature?.role === "source";
}

export function isPatternInstance(shape: Pick<WorkplaneShape, "patternFeature">) {
  return shape.patternFeature?.role === "instance";
}

export function patternMemberIds(shapes: readonly WorkplaneShape[], featureId: string) {
  return shapes.filter((shape) => shape.patternFeature?.id === featureId).map((shape) => shape.id);
}

export function findPatternSource(shapes: readonly WorkplaneShape[], shape: WorkplaneShape | null | undefined) {
  const feature = shape?.patternFeature;
  if (!feature) return null;
  return shapes.find((entry) => entry.id === feature.sourceId && entry.patternFeature?.id === feature.id) ?? null;
}

export function patternFeatureLabel(feature: PatternFeature) {
  if (feature.kind === "linear") {
    const count = Math.max(1, (feature.linear?.countX ?? 1) * (feature.linear?.countZ ?? 1) * (feature.linear?.countY ?? 1));
    return `Linear pattern ×${count}`;
  }
  return `Circular pattern ×${Math.max(2, feature.circular?.count ?? 2)}`;
}

function withPatternTag(
  shape: WorkplaneShape,
  feature: Omit<PatternFeature, "role" | "sourceId" | "instanceIndex">,
  role: PatternFeature["role"],
  sourceId: string,
  instanceIndex: number,
): WorkplaneShape {
  return {
    ...shape,
    patternFeature: {
      ...feature,
      role,
      sourceId,
      instanceIndex,
    },
  };
}

export function tagLinearPatternInstances(
  instances: readonly WorkplaneShape[],
  source: WorkplaneShape,
  params: LinearPatternFeatureParams,
  featureId: string,
): WorkplaneShape[] {
  return instances.map((shape, index) => {
    const keep = shape.id === source.id;
    return withPatternTag(
      shape,
      { id: featureId, kind: "linear", linear: params },
      keep ? "source" : "instance",
      source.id,
      index,
    );
  });
}

export function tagCircularPatternInstances(
  instances: readonly WorkplaneShape[],
  source: WorkplaneShape,
  params: CircularPatternFeatureParams,
  featureId: string,
): WorkplaneShape[] {
  return instances.map((shape, index) => {
    const keep = shape.id === source.id;
    return withPatternTag(
      shape,
      { id: featureId, kind: "circular", circular: { ...params, rotationOffset: params.rotationOffset } },
      keep ? "source" : "instance",
      source.id,
      index,
    );
  });
}
export function rebuildLinearPatternFeature(
  source: WorkplaneShape,
  params: LinearPatternFeatureParams,
  featureId: string,
): WorkplaneShape[] {
  const instances = linearPatternInstances([source], params, params, {
    createId: (sourceId, ix, iz, iy) => linearPatternCopyId(sourceId, ix, iz, iy),
  });
  return tagLinearPatternInstances(instances, source, params, featureId);
}

export function rebuildCircularPatternFeature(
  source: WorkplaneShape,
  params: CircularPatternFeatureParams,
  featureId: string,
): WorkplaneShape[] {
  const instances = circularPatternInstances([source], params.center, params.count, {
    radius: params.radius,
    rotationOffset: params.rotationOffset as CircularPatternRotationStep,
    seatElevation: params.seatElevation,
  });
  return tagCircularPatternInstances(instances, source, params, featureId);
}

/**
 * Drop previous instances for a feature, then insert the rebuilt set.
 * Source keeps its current geometry; copies are regenerated.
 */
export function replacePatternFeature(
  shapes: readonly WorkplaneShape[],
  rebuilt: readonly WorkplaneShape[],
  featureId: string,
): WorkplaneShape[] {
  const rebuiltIds = new Set(rebuilt.map((shape) => shape.id));
  const keptBefore: WorkplaneShape[] = [];
  const keptAfter: WorkplaneShape[] = [];
  let passedSource = false;
  for (const shape of shapes) {
    if (shape.patternFeature?.id === featureId) {
      passedSource = true;
      continue;
    }
    if (rebuiltIds.has(shape.id)) continue;
    if (!passedSource) keptBefore.push(shape);
    else keptAfter.push(shape);
  }
  return [...keptBefore, ...rebuilt, ...keptAfter];
}

export function dissolvePatternFeature(shapes: readonly WorkplaneShape[], featureId: string): WorkplaneShape[] {
  return shapes.map((shape) => {
    if (shape.patternFeature?.id !== featureId) return shape;
    const { patternFeature: _removed, ...rest } = shape;
    return rest;
  });
}

export function removePatternFeature(shapes: readonly WorkplaneShape[], featureId: string, keepSource: boolean) {
  return shapes.filter((shape) => {
    if (shape.patternFeature?.id !== featureId) return true;
    if (keepSource && shape.patternFeature.role === "source") {
      return true;
    }
    return false;
  }).map((shape) => {
    if (shape.patternFeature?.id !== featureId) return shape;
    const { patternFeature: _removed, ...rest } = shape;
    return rest;
  });
}

export function patternPoseKey(shape: Pick<WorkplaneShape, "x" | "z" | "elevation" | "width" | "depth" | "height" | "rotation" | "rotationX" | "rotationZ" | "size">) {
  return [
    shape.x,
    shape.z,
    shape.elevation ?? 0,
    shape.width,
    shape.depth,
    shape.height,
    shape.size,
    shape.rotation ?? 0,
    shape.rotationX ?? 0,
    shape.rotationZ ?? 0,
  ].join(":");
}

function patternMembersMatch(existing: readonly WorkplaneShape[], rebuilt: readonly WorkplaneShape[]) {
  if (existing.length !== rebuilt.length) return false;
  return existing.every((shape, index) => {
    const next = rebuilt[index];
    return next && shape.id === next.id && patternPoseKey(shape) === patternPoseKey(next);
  });
}

/** Regenerate linked copies from each pattern source. Returns the same array when nothing moved. */
export function syncLinkedPatternShapes(shapes: readonly WorkplaneShape[]): WorkplaneShape[] {
  let next = shapes as WorkplaneShape[];
  let changed = false;
  for (const source of shapes) {
    const feature = source.patternFeature;
    if (!feature || feature.role !== "source") continue;
    const rebuilt = feature.kind === "linear" && feature.linear
      ? rebuildLinearPatternFeature(source, feature.linear, feature.id)
      : feature.kind === "circular" && feature.circular
        ? rebuildCircularPatternFeature(source, feature.circular, feature.id)
        : null;
    if (!rebuilt) continue;
    const existing = next.filter((shape) => shape.patternFeature?.id === feature.id);
    if (patternMembersMatch(existing, rebuilt)) continue;
    next = replacePatternFeature(next, rebuilt, feature.id);
    changed = true;
  }
  return changed ? next : shapes as WorkplaneShape[];
}
