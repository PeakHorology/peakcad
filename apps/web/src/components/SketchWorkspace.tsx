"use client";

import { ChevronUp, CornerDownRight, Home, Link, Link2Off, Minus, Plus, Ruler, Split, Trash2, Waves } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { SnapGridControl } from "@/components/workplane/ShapeInspector";
import { InlineValueDialog } from "@/components/workplane/InlineValueDialog";
import { SketchSnapGlyph } from "@/components/workplane/SketchSnapGlyph";
import { PeakTipButton } from "@/components/workplane/ToolNameTooltip";
import { isDefaultSketchPlane } from "@/lib/sketchPlane";
import { faceReferenceBounds } from "@/lib/sketchFaceReference";
import { closedProfilesFromLegacy, CONSTRAINT_LABELS, snapSketchPoint, type SketchConstraint, type SketchDefinitionStatus, type SketchDimension, type SketchEntity, type SketchSnapResult } from "@/lib/sketch";
import { TOOL_DESCRIPTIONS } from "@/lib/toolDescriptions";
import { mirrorSign, resizedImportedMeshPositions } from "@/lib/workplaneShapes";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE, normalizeSnapGrid, normalizeWorkspaceSettings } from "@/lib/workplaneSettings";
import type { GridSize, SketchImage, SketchPoint, SketchProfile, SketchSegment, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export type SketchTool =
  | "line"
  | "bezier"
  | "smooth"
  | "circle"
  | "ellipse"
  | "square"
  | "rectangle"
  | "roundRect"
  | "slot"
  | "triangle"
  | "polygon"
  | "star"
  | "arc"
  | "offset"
  | "select"
  | "refine"
  | "erase"
  | "measure"
  | "dimension"
  | "trim"
  | "fillet"
  | "chamfer"
  | "mirror"
  | "pattern"
  | "constrain-h"
  | "constrain-v"
  | "constrain-equal"
  | "constrain-parallel"
  | "constrain-perp"
  | "constrain-tangent"
  | "constrain-symmetry";
export type SketchSelection =
  | { kind: "point"; id: string }
  | { kind: "segment"; id: string }
  | { kind: "image"; id: string }
  | { kind: "multiple"; pointIds: string[]; segmentIds: string[]; imageIds?: string[] }
  | null;
export type SketchMeasurement = { start: SketchPoint; end: SketchPoint } | null;

type SketchWorkspaceProps = {
  profile: SketchProfile;
  referenceShapes: WorkplaneShape[];
  tool: SketchTool;
  activePointId: string | null;
  selected: SketchSelection;
  measurement: SketchMeasurement;
  pendingMeasurementStart: SketchPoint | null;
  initialSnap?: GridSize;
  initialWorkspace?: WorkplaneWorkspaceSettings;
  /** Keep project/3D snap in sync when the sketch Snap Grid control changes. */
  onSnapChange?: (snap: GridSize) => void;
  selectedProfileIds?: string[];
  activeSnap?: SketchSnapResult | null;
  showDimensions?: boolean;
  dimensions?: SketchDimension[];
  showConstraints?: boolean;
  constraints?: SketchConstraint[];
  constraintEntities?: SketchEntity[];
  constraintConflicts?: string[];
  solveStatus?: SketchDefinitionStatus;
  solveDof?: number;
  onPlanePoint: (point: { x: number; z: number }, handles?: { handleIn: { x: number; z: number }; handleOut: { x: number; z: number } }) => void;
  onDrawCircle: (center: { x: number; z: number }, radius: number) => void;
  onDrawEllipse: (origin: { x: number; z: number }, corner: { x: number; z: number }) => void;
  onDrawSquare: (origin: { x: number; z: number }, corner: { x: number; z: number }) => void;
  onDrawRectangle: (origin: { x: number; z: number }, corner: { x: number; z: number }) => void;
  onDrawRoundRect: (origin: { x: number; z: number }, corner: { x: number; z: number }) => void;
  onDrawSlot: (origin: { x: number; z: number }, corner: { x: number; z: number }) => void;
  onDrawTriangle: (center: { x: number; z: number }, vertex: { x: number; z: number }) => void;
  onDrawPolygon: (center: { x: number; z: number }, vertex: { x: number; z: number }) => void;
  onDrawStar: (center: { x: number; z: number }, tip: { x: number; z: number }) => void;
  onDrawArc: (start: { x: number; z: number }, end: { x: number; z: number }, through: { x: number; z: number }) => void;
  onOffsetSegment: (segmentId: string, toward: { x: number; z: number }) => void;
  polygonSides?: number;
  onPointPress: (id: string) => void;
  onSelectSegment: (id: string) => void;
  onSelectMany: (pointIds: string[], segmentIds: string[], imageIds: string[]) => void;
  onSelectImage: (id: string) => void;
  onUpdateImage: (id: string, patch: Partial<SketchImage>, message?: string) => void;
  onDeleteImage: (id: string) => void;
  onDeletePoint: (id: string) => void;
  onDeleteSegment: (id: string) => void;
  onEraseEntities: (pointIds: string[], segmentIds: string[]) => void;
  onMovePoint: (id: string, point: { x: number; z: number }) => void;
  onMoveHandle: (id: string, handle: "in" | "out", point: { x: number; z: number }) => void;
  onInsertPoint: (segmentId: string, point: { x: number; z: number }) => void;
  onSetPointMode: (id: string, mode: "corner" | "smooth" | "split") => void;
  onClearMeasurement: () => void;
  onSelectProfile?: (profileId: string) => void;
  onEditDimension?: (dimensionId: string, value: number) => void;
  onSnapResolved?: (snap: SketchSnapResult | null) => void;
  /** Activate/deactivate the measure tool (lives on the view controls, like 3D ruler). */
  onToolChange?: (tool: SketchTool) => void;
  /** Optional toast/notice for empty-tool feedback (e.g. dimension on empty plate). */
  onNotice?: (message: string) => void;
};

type PathStep = { segment: SketchSegment; from: SketchPoint; to: SketchPoint };
type DisplayPath = { id: string; points: SketchPoint[]; steps: PathStep[]; closed: boolean };
type SketchReferenceFootprint = { fillD: string | null; outlineD: string | null };
type PointerAction =
  | { kind: "bezier"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "circle"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "ellipse"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "square"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "rectangle"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "roundRect"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "slot"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "triangle"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "polygon"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "star"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "offset"; pointerId: number; segmentId: string; current: { x: number; z: number } }
  | { kind: "erase"; pointerId: number; current: { x: number; z: number } }
  | { kind: "move-point"; pointerId: number; pointId: string; current: { x: number; z: number } }
  | { kind: "move-handle"; pointerId: number; pointId: string; handle: "in" | "out"; current: { x: number; z: number } }
  | { kind: "pan"; pointerId: number; clientX: number; clientY: number }
  | { kind: "marquee"; pointerId: number; origin: { x: number; z: number }; current: { x: number; z: number } }
  | { kind: "move-image"; pointerId: number; imageId: string; origin: { x: number; z: number }; current: { x: number; z: number }; start: SketchImage }
  | { kind: "resize-image"; pointerId: number; imageId: string; handle: ResizeHandle; current: { x: number; z: number }; start: SketchImage };

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

function snapStep(size: GridSize) {
  if (size === "Off") return 0;
  if (size === "Brick") return 8;
  return Number.parseFloat(size) || 1;
}

function snapValue(value: number, step: number) {
  return step > 0 ? Math.round(value / step) * step : value;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function resizeSketchImage(start: SketchImage, handle: ResizeHandle, point: { x: number; z: number }): Partial<SketchImage> {
  const minimum = 0.5;
  const startsWest = handle.includes("w");
  const startsEast = handle.includes("e");
  const startsNorth = handle.includes("n");
  const startsSouth = handle.includes("s");
  const minX = start.x - start.width / 2;
  const maxX = start.x + start.width / 2;
  const minZ = start.z - start.depth / 2;
  const maxZ = start.z + start.depth / 2;
  const aspect = start.width / Math.max(minimum, start.depth);

  if (start.lockAspect !== false) {
    if ((startsWest || startsEast) && (startsNorth || startsSouth)) {
      const fixedX = startsWest ? maxX : minX;
      const fixedZ = startsNorth ? maxZ : minZ;
      const widthScale = Math.abs(point.x - fixedX) / Math.max(minimum, start.width);
      const depthScale = Math.abs(point.z - fixedZ) / Math.max(minimum, start.depth);
      const scale = Math.max(minimum / Math.min(start.width, start.depth), widthScale, depthScale);
      const width = Math.max(minimum, start.width * scale);
      const depth = Math.max(minimum, start.depth * scale);
      const xDirection = startsWest ? -1 : 1;
      const zDirection = startsNorth ? -1 : 1;
      return { width, depth, x: fixedX + xDirection * width / 2, z: fixedZ + zDirection * depth / 2 };
    }
    if (startsWest || startsEast) {
      const fixedX = startsWest ? maxX : minX;
      const width = Math.max(minimum, Math.abs(point.x - fixedX));
      return { width, depth: Math.max(minimum, width / aspect), x: fixedX + (startsWest ? -1 : 1) * width / 2 };
    }
    const fixedZ = startsNorth ? maxZ : minZ;
    const depth = Math.max(minimum, Math.abs(point.z - fixedZ));
    return { depth, width: Math.max(minimum, depth * aspect), z: fixedZ + (startsNorth ? -1 : 1) * depth / 2 };
  }

  let nextMinX = minX;
  let nextMaxX = maxX;
  let nextMinZ = minZ;
  let nextMaxZ = maxZ;
  if (startsWest) nextMinX = Math.min(point.x, maxX - minimum);
  if (startsEast) nextMaxX = Math.max(point.x, minX + minimum);
  if (startsNorth) nextMinZ = Math.min(point.z, maxZ - minimum);
  if (startsSouth) nextMaxZ = Math.max(point.z, minZ + minimum);
  return {
    x: (nextMinX + nextMaxX) / 2,
    z: (nextMinZ + nextMaxZ) / 2,
    width: nextMaxX - nextMinX,
    depth: nextMaxZ - nextMinZ,
  };
}

function formatDimension(value: number, accuracy: 1 | 2 | 3) {
  const threshold = 0.5 * 10 ** -accuracy;
  return (Math.abs(value) < threshold ? 0 : value).toFixed(accuracy);
}

const CONSTRAINT_GLYPH: Record<SketchConstraint["kind"], string> = {
  horizontal: "H",
  vertical: "V",
  coincident: "●",
  midpoint: "M",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  concentric: "◎",
  tangent: "T",
  symmetry: "⇄",
  fix: "🔒",
};

function sketchEntityPointIds(entity: SketchEntity): string[] {
  switch (entity.kind) {
    case "point":
      return [entity.id];
    case "line":
    case "bezier":
    case "smooth":
      return [entity.startId, entity.endId];
    case "arc":
      return [entity.centerId, entity.startId, entity.endId];
    case "circle":
      return [entity.centerId];
    default:
      return [];
  }
}

function constraintGlyphAnchor(
  constraint: SketchConstraint,
  entities: SketchEntity[],
  pointById: Map<string, SketchPoint>,
): { x: number; z: number } | null {
  const centers: Array<{ x: number; z: number }> = [];
  for (const pointId of constraint.pointIds ?? []) {
    const point = pointById.get(pointId);
    if (point) centers.push({ x: point.x, z: point.z });
  }
  for (const entityId of constraint.entityIds) {
    const entity = entities.find((item) => item.id === entityId);
    if (!entity) continue;
    if (entity.kind === "point") {
      centers.push({ x: entity.x, z: entity.z });
      continue;
    }
    const pts = sketchEntityPointIds(entity)
      .map((id) => pointById.get(id))
      .filter((item): item is SketchPoint => Boolean(item));
    if (!pts.length) continue;
    centers.push({
      x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
      z: pts.reduce((sum, p) => sum + p.z, 0) / pts.length,
    });
  }
  if (!centers.length) return null;
  return {
    x: centers.reduce((sum, p) => sum + p.x, 0) / centers.length,
    z: centers.reduce((sum, p) => sum + p.z, 0) / centers.length,
  };
}

function dimensionPillSize(label: string, screenUnit: number, extra = 24) {
  return {
    width: Math.max(48, label.length * 7.5 + extra) * screenUnit,
    height: 26 * screenUnit,
    radius: 5 * screenUnit,
  };
}

function cubicPoint(start: SketchPoint, first: { x: number; z: number }, second: { x: number; z: number }, end: SketchPoint, amount: number) {
  const inverse = 1 - amount;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * amount * first.x + 3 * inverse * amount ** 2 * second.x + amount ** 3 * end.x,
    z: inverse ** 3 * start.z + 3 * inverse ** 2 * amount * first.z + 3 * inverse * amount ** 2 * second.z + amount ** 3 * end.z,
  };
}

function distancePointToSegment(point: { x: number; z: number }, start: { x: number; z: number }, end: { x: number; z: number }) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 1e-12) return Math.hypot(point.x - start.x, point.z - start.z);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq));
  return Math.hypot(point.x - (start.x + dx * t), point.z - (start.z + dz * t));
}

function distanceToSketchSegment(
  point: { x: number; z: number },
  segment: SketchSegment,
  pointById: Map<string, SketchPoint>,
) {
  const start = pointById.get(segment.startId);
  const end = pointById.get(segment.endId);
  if (!start || !end) return Number.POSITIVE_INFINITY;
  const first = start.handleOut;
  const second = end.handleIn;
  if (segment.kind === "line" || !first || !second) {
    return distancePointToSegment(point, start, end);
  }
  let nearest = Number.POSITIVE_INFINITY;
  let previous = start;
  for (let index = 1; index <= 24; index += 1) {
    const sample = cubicPoint(start, first, second, end, index / 24);
    nearest = Math.min(nearest, distancePointToSegment(point, previous, sample));
    previous = sample as SketchPoint;
  }
  return nearest;
}

function collectEraseHits(
  tip: { x: number; z: number },
  radius: number,
  profile: SketchProfile,
  pointById: Map<string, SketchPoint>,
  pointIds: Set<string>,
  segmentIds: Set<string>,
) {
  let changed = false;
  for (const point of profile.points) {
    if (pointIds.has(point.id)) continue;
    if (Math.hypot(point.x - tip.x, point.z - tip.z) <= radius) {
      pointIds.add(point.id);
      changed = true;
      for (const segment of profile.segments) {
        if (segment.startId === point.id || segment.endId === point.id) {
          if (!segmentIds.has(segment.id)) {
            segmentIds.add(segment.id);
          }
        }
      }
    }
  }
  for (const segment of profile.segments) {
    if (segmentIds.has(segment.id)) continue;
    if (distanceToSketchSegment(tip, segment, pointById) <= radius) {
      segmentIds.add(segment.id);
      changed = true;
    }
  }
  return changed;
}

function sampleEraseStroke(from: { x: number; z: number }, to: { x: number; z: number }, step: number) {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  if (distance < 1e-6) return [to];
  const count = Math.max(1, Math.ceil(distance / Math.max(step, 0.05)));
  const samples: Array<{ x: number; z: number }> = [];
  for (let index = 1; index <= count; index += 1) {
    const t = index / count;
    samples.push({
      x: from.x + (to.x - from.x) * t,
      z: from.z + (to.z - from.z) * t,
    });
  }
  return samples;
}

function segmentDimension(segment: SketchSegment, pointById: Map<string, SketchPoint>) {
  const start = pointById.get(segment.startId);
  const end = pointById.get(segment.endId);
  if (!start || !end) return null;
  const first = start.handleOut;
  const second = end.handleIn;
  if (segment.kind === "line" || !first || !second) {
    return {
      length: Math.hypot(end.x - start.x, end.z - start.z),
      midpoint: { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 },
    };
  }
  let length = 0;
  let previous = start;
  for (let index = 1; index <= 32; index += 1) {
    const point = cubicPoint(start, first, second, end, index / 32);
    length += Math.hypot(point.x - previous.x, point.z - previous.z);
    previous = { ...point, id: "curve-sample" };
  }
  return { length, midpoint: cubicPoint(start, first, second, end, 0.5) };
}

function orderedPaths(profile: SketchProfile): DisplayPath[] {
  const pointById = new Map(profile.points.map((point) => [point.id, point]));
  const adjacency = new Map<string, Array<{ pointId: string; segment: SketchSegment }>>();
  profile.points.forEach((point) => adjacency.set(point.id, []));
  const valid = profile.segments.filter((segment) => {
    if (!pointById.has(segment.startId) || !pointById.has(segment.endId)) return false;
    adjacency.get(segment.startId)?.push({ pointId: segment.endId, segment });
    adjacency.get(segment.endId)?.push({ pointId: segment.startId, segment });
    return true;
  });
  const unvisited = new Set(valid.map((segment) => segment.id));
  const paths: DisplayPath[] = [];
  while (unvisited.size > 0) {
    const seedId = unvisited.values().next().value as string;
    const seed = valid.find((segment) => segment.id === seedId);
    if (!seed) break;
    const component = new Set<string>();
    const queue = [seed.startId, seed.endId];
    while (queue.length) {
      const id = queue.pop();
      if (!id || component.has(id)) continue;
      component.add(id);
      adjacency.get(id)?.forEach((edge) => queue.push(edge.pointId));
    }
    const startId = [...component].find((id) => (adjacency.get(id)?.filter((edge) => unvisited.has(edge.segment.id)).length ?? 0) === 1) ?? seed.startId;
    const first = pointById.get(startId);
    if (!first) break;
    const points = [first];
    const steps: PathStep[] = [];
    let currentId = startId;
    for (let guard = 0; guard <= valid.length; guard += 1) {
      const edge = adjacency.get(currentId)?.find((candidate) => unvisited.has(candidate.segment.id));
      if (!edge) break;
      const from = pointById.get(currentId);
      const to = pointById.get(edge.pointId);
      if (!from || !to) break;
      unvisited.delete(edge.segment.id);
      steps.push({ segment: edge.segment, from, to });
      currentId = to.id;
      if (currentId === startId) break;
      points.push(to);
    }
    paths.push({ id: seed.id, points, steps, closed: currentId === startId && steps.length >= 3 });
  }
  return paths;
}

function curveControls(step: PathStep) {
  const forward = step.segment.startId === step.from.id;
  return {
    first: forward ? step.from.handleOut : step.from.handleIn,
    second: forward ? step.to.handleIn : step.to.handleOut,
  };
}

function pathData(path: DisplayPath) {
  const first = path.points[0];
  if (!first) return "";
  const commands = [`M ${first.x} ${first.z}`];
  path.steps.forEach((step) => {
    const controls = curveControls(step);
    if (step.segment.kind !== "line" && controls.first && controls.second) {
      commands.push(`C ${controls.first.x} ${controls.first.z} ${controls.second.x} ${controls.second.z} ${step.to.x} ${step.to.z}`);
    } else {
      commands.push(`L ${step.to.x} ${step.to.z}`);
    }
  });
  if (path.closed) commands.push("Z");
  return commands.join(" ");
}

function segmentData(segment: SketchSegment, pointById: Map<string, SketchPoint>) {
  const from = pointById.get(segment.startId);
  const to = pointById.get(segment.endId);
  if (!from || !to) return "";
  const step = { segment, from, to };
  const controls = curveControls(step);
  return segment.kind !== "line" && controls.first && controls.second
    ? `M ${from.x} ${from.z} C ${controls.first.x} ${controls.first.z} ${controls.second.x} ${controls.second.z} ${to.x} ${to.z}`
    : `M ${from.x} ${from.z} L ${to.x} ${to.z}`;
}

function isRoundReference(shape: WorkplaneShape) {
  return ["cylinder", "sphere", "cone", "torus", "tube", "ring", "halfSphere"].includes(shape.kind);
}

function sketchReferencePoint(shape: WorkplaneShape, x: number, z: number) {
  return {
    x: shape.x + x * mirrorSign(shape.mirrorX),
    z: shape.z + z * mirrorSign(shape.mirrorZ),
  };
}

function pointKey(point: { x: number; z: number }, tolerance: number) {
  return `${Math.round(point.x / tolerance)},${Math.round(point.z / tolerance)}`;
}

function triangleArea2d(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }) {
  return Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
}

function trianglePath(points: Array<{ x: number; z: number }>) {
  return `M ${points[0].x} ${points[0].z} L ${points[1].x} ${points[1].z} L ${points[2].x} ${points[2].z} Z`;
}

function convexHull(points: Array<{ x: number; z: number }>) {
  const unique = new Map<string, { x: number; z: number }>();
  points.forEach((point) => unique.set(pointKey(point, 0.001), point));
  const sorted = [...unique.values()].sort((a, b) => a.x === b.x ? a.z - b.z : a.x - b.x);
  if (sorted.length <= 2) return sorted;
  const cross = (origin: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) =>
    (a.x - origin.x) * (b.z - origin.z) - (a.z - origin.z) * (b.x - origin.x);
  const lower: Array<{ x: number; z: number }> = [];
  sorted.forEach((point) => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  });
  const upper: Array<{ x: number; z: number }> = [];
  [...sorted].reverse().forEach((point) => {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  });
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function boundaryPath(points: Array<{ x: number; z: number }>, triangles: number[][], tolerance: number) {
  const pointByKey = new Map<string, { x: number; z: number }>();
  const edgeCounts = new Map<string, { count: number; a: string; b: string }>();
  const addEdge = (aIndex: number, bIndex: number) => {
    const a = points[aIndex];
    const b = points[bIndex];
    const aKey = pointKey(a, tolerance);
    const bKey = pointKey(b, tolerance);
    pointByKey.set(aKey, a);
    pointByKey.set(bKey, b);
    const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
    const current = edgeCounts.get(key);
    edgeCounts.set(key, current ? { ...current, count: current.count + 1 } : { count: 1, a: aKey, b: bKey });
  };
  triangles.forEach(([a, b, c]) => {
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  });

  const boundaryEdges = [...edgeCounts.values()].filter((edge) => edge.count === 1);
  if (boundaryEdges.length === 0) return null;
  const adjacency = new Map<string, string[]>();
  boundaryEdges.forEach(({ a, b }) => {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  });
  const unused = new Set(boundaryEdges.map(({ a, b }) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  const takeEdge = (a: string, b: string) => unused.delete(a < b ? `${a}|${b}` : `${b}|${a}`);
  const hasEdge = (a: string, b: string) => unused.has(a < b ? `${a}|${b}` : `${b}|${a}`);
  const commands: string[] = [];

  while (unused.size > 0) {
    const firstKey = unused.values().next().value as string;
    const [start, firstNext] = firstKey.split("|");
    const chain = [start, firstNext];
    takeEdge(start, firstNext);
    while (chain.length <= boundaryEdges.length + 1) {
      const current = chain[chain.length - 1];
      const previous = chain[chain.length - 2];
      const next = (adjacency.get(current) ?? []).find((candidate) => candidate !== previous && hasEdge(current, candidate))
        ?? (adjacency.get(current) ?? []).find((candidate) => hasEdge(current, candidate));
      if (!next) break;
      takeEdge(current, next);
      chain.push(next);
      if (next === start) break;
    }
    const startPoint = pointByKey.get(chain[0]);
    if (!startPoint) continue;
    const pointsD = chain
      .slice(1)
      .map((key) => pointByKey.get(key))
      .filter((point): point is { x: number; z: number } => Boolean(point))
      .map((point) => `L ${point.x} ${point.z}`);
    commands.push(`M ${startPoint.x} ${startPoint.z} ${pointsD.join(" ")}${chain[chain.length - 1] === chain[0] ? " Z" : ""}`);
  }

  return commands.join(" ");
}

function importedMeshFootprint(shape: WorkplaneShape): SketchReferenceFootprint | null {
  if (!shape.importedMesh) return null;
  const positions = resizedImportedMeshPositions(shape);
  if (positions.length < 9) return null;
  let minY = Number.POSITIVE_INFINITY;
  for (let index = 1; index < positions.length; index += 3) {
    minY = Math.min(minY, positions[index]);
  }
  if (!Number.isFinite(minY)) return null;

  const tolerance = Math.max(0.001, Math.max(shape.width, shape.depth, shape.height) / 100000);
  const bottomTolerance = Math.max(0.025, shape.height * 0.003);
  const points: Array<{ x: number; z: number }> = [];
  const triangles: number[][] = [];
  const allProjected: Array<{ x: number; z: number }> = [];

  for (let index = 0; index + 8 < positions.length; index += 9) {
    const ys = [positions[index + 1], positions[index + 4], positions[index + 7]];
    const projected = [
      sketchReferencePoint(shape, positions[index], positions[index + 2]),
      sketchReferencePoint(shape, positions[index + 3], positions[index + 5]),
      sketchReferencePoint(shape, positions[index + 6], positions[index + 8]),
    ];
    allProjected.push(...projected);
    if (!ys.every((value) => value <= minY + bottomTolerance) || triangleArea2d(projected[0], projected[1], projected[2]) <= tolerance) {
      continue;
    }
    const offset = points.length;
    points.push(...projected);
    triangles.push([offset, offset + 1, offset + 2]);
  }

  if (triangles.length > 0) {
    return {
      fillD: triangles.length <= 5000 ? triangles.map((triangle) => trianglePath(triangle.map((index) => points[index]))).join(" ") : null,
      outlineD: boundaryPath(points, triangles, tolerance),
    };
  }

  const hull = convexHull(allProjected);
  if (hull.length < 3) return null;
  const d = `M ${hull[0].x} ${hull[0].z} ${hull.slice(1).map((point) => `L ${point.x} ${point.z}`).join(" ")} Z`;
  return { fillD: d, outlineD: d };
}

export function SketchWorkspace({
  profile,
  referenceShapes,
  tool,
  activePointId,
  selected,
  measurement,
  pendingMeasurementStart,
  initialSnap,
  initialWorkspace,
  onSnapChange,
  selectedProfileIds = [],
  activeSnap = null,
  showDimensions = true,
  dimensions = [],
  showConstraints = true,
  constraints = [],
  constraintEntities = [],
  constraintConflicts = [],
  solveStatus = "empty",
  solveDof = 0,
  onPlanePoint,
  onDrawCircle,
  onDrawEllipse,
  onDrawSquare,
  onDrawRectangle,
  onDrawRoundRect,
  onDrawSlot,
  onDrawTriangle,
  onDrawPolygon,
  onDrawStar,
  onDrawArc,
  onOffsetSegment,
  polygonSides = 6,
  onPointPress,
  onSelectSegment,
  onSelectMany,
  onSelectImage,
  onUpdateImage,
  onDeleteImage,
  onDeletePoint,
  onDeleteSegment,
  onEraseEntities,
  onMovePoint,
  onMoveHandle,
  onInsertPoint,
  onSetPointMode,
  onClearMeasurement,
  onSelectProfile,
  onEditDimension,
  onSnapResolved,
  onToolChange,
  onNotice,
}: SketchWorkspaceProps) {
  const workspace = useMemo(() => normalizeWorkspaceSettings(initialWorkspace, DEFAULT_WORKPLANE_WORKSPACE), [initialWorkspace]);
  const [snap, setSnap] = useState<GridSize>(() => normalizeSnapGrid(initialSnap, DEFAULT_SNAP_GRID));
  const [snapOpen, setSnapOpen] = useState(false);
  const [dimensionDialog, setDimensionDialog] = useState<{ id: string; value: number } | null>(null);

  // Stay aligned with the live 3D workplane Snap Grid / workspace settings.
  useEffect(() => {
    setSnap(normalizeSnapGrid(initialSnap, DEFAULT_SNAP_GRID));
  }, [initialSnap]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, z: 0 });
  const faceFitKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const loops = profile.faceReferenceLoops ?? [];
    if (loops.length === 0) {
      faceFitKeyRef.current = null;
      return;
    }
    const key = JSON.stringify(loops);
    if (faceFitKeyRef.current === key) return;
    faceFitKeyRef.current = key;
    const bounds = faceReferenceBounds(loops);
    if (!bounds) return;
    setPan({ x: bounds.centerX, z: bounds.centerZ });
    const plate = Math.max(workspace.width, workspace.depth);
    const span = Math.max(bounds.width, bounds.depth, 8);
    setZoom(clamp(plate / (span * 1.6), 0.75, 6));
  }, [profile.faceReferenceLoops, workspace.depth, workspace.width]);
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  const [pointerAction, setPointerAction] = useState<PointerAction | null>(null);
  const [arcDraft, setArcDraft] = useState<Array<{ x: number; z: number }>>([]);
  const [erasePreview, setErasePreview] = useState<{ pointIds: string[]; segmentIds: string[] } | null>(null);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const eraseStrokeRef = useRef<{ pointIds: Set<string>; segmentIds: Set<string> } | null>(null);
  const width = workspace.width / zoom;
  const depth = workspace.depth / zoom;
  const screenUnit = useMemo(() => {
    const fittedScale = Math.min(
      svgSize.width > 0 ? svgSize.width / width : 0,
      svgSize.height > 0 ? svgSize.height / depth : 0,
    );
    return fittedScale > 0 ? 1 / fittedScale : Math.max(width, depth) / 720;
  }, [depth, svgSize.height, svgSize.width, width]);
  const displayProfile = useMemo(() => {
    if (pointerAction?.kind === "move-point") {
      const source = profile.points.find((point) => point.id === pointerAction.pointId);
      if (!source) return profile;
      const deltaX = pointerAction.current.x - source.x;
      const deltaZ = pointerAction.current.z - source.z;
      return {
        ...profile,
        points: profile.points.map((point) => point.id === source.id ? {
          ...point,
          ...pointerAction.current,
          handleIn: point.handleIn ? { x: point.handleIn.x + deltaX, z: point.handleIn.z + deltaZ } : undefined,
          handleOut: point.handleOut ? { x: point.handleOut.x + deltaX, z: point.handleOut.z + deltaZ } : undefined,
        } : point),
      };
    }
    if (pointerAction?.kind === "move-handle") {
      return {
        ...profile,
        points: profile.points.map((point) => {
          if (point.id !== pointerAction.pointId) return point;
          const next = { ...point, handleIn: point.handleIn ? { ...point.handleIn } : undefined, handleOut: point.handleOut ? { ...point.handleOut } : undefined };
          if (pointerAction.handle === "in") next.handleIn = { ...pointerAction.current };
          else next.handleOut = { ...pointerAction.current };
          if (point.mode === "smooth") {
            const opposite = { x: point.x * 2 - pointerAction.current.x, z: point.z * 2 - pointerAction.current.z };
            if (pointerAction.handle === "in") next.handleOut = opposite;
            else next.handleIn = opposite;
          }
          return next;
        }),
      };
    }
    if (erasePreview && (erasePreview.pointIds.length || erasePreview.segmentIds.length)) {
      const removedPoints = new Set(erasePreview.pointIds);
      const removedSegments = new Set(erasePreview.segmentIds);
      return {
        ...profile,
        points: profile.points.filter((point) => !removedPoints.has(point.id)),
        segments: profile.segments.filter(
          (segment) =>
            !removedSegments.has(segment.id)
            && !removedPoints.has(segment.startId)
            && !removedPoints.has(segment.endId),
        ),
      };
    }
    return profile;
  }, [erasePreview, pointerAction, profile]);
  const displayImages = useMemo(() => {
    const images = profile.images ?? [];
    if (pointerAction?.kind === "move-image") {
      const deltaX = pointerAction.current.x - pointerAction.origin.x;
      const deltaZ = pointerAction.current.z - pointerAction.origin.z;
      return images.map((image) => image.id === pointerAction.imageId ? { ...image, x: pointerAction.start.x + deltaX, z: pointerAction.start.z + deltaZ } : image);
    }
    if (pointerAction?.kind === "resize-image") {
      return images.map((image) => image.id === pointerAction.imageId ? { ...image, ...resizeSketchImage(pointerAction.start, pointerAction.handle, pointerAction.current) } : image);
    }
    return images;
  }, [pointerAction, profile.images]);
  const pointById = useMemo(() => new Map(displayProfile.points.map((point) => [point.id, point])), [displayProfile.points]);
  const paths = useMemo(() => orderedPaths(displayProfile), [displayProfile]);
  const activePoint = activePointId ? pointById.get(activePointId) ?? null : null;
  const selectedPoint = selected?.kind === "point" ? pointById.get(selected.id) ?? null : null;
  const selectedImage = selected?.kind === "image" ? displayImages.find((image) => image.id === selected.id) ?? null : null;
  const isPointSelected = (id: string) => selected?.kind === "point" ? selected.id === id : selected?.kind === "multiple" ? selected.pointIds.includes(id) : false;
  const isSegmentSelected = (id: string) => selected?.kind === "segment" ? selected.id === id : selected?.kind === "multiple" ? selected.segmentIds.includes(id) : false;
  // Prefer Snap Grid spacing when active so the drawn plate matches 3D snap divisions;
  // otherwise fall back to the workplane grid block size.
  const snapGridStep = snapStep(snap);
  const gridStep = snapGridStep > 0
    ? clamp(snapGridStep, 0.1, 200)
    : clamp(workspace.gridBlockSize, 1, 200);
  const majorEvery = snapGridStep > 0
    ? Math.max(1, Math.round(workspace.gridBlockSize / snapGridStep) || 1)
    : 4;
  const verticalLines = useMemo(() => {
    const lines: number[] = [];
    const start = Math.ceil((-workspace.width / 2) / gridStep) * gridStep;
    for (let x = start; x <= workspace.width / 2 + 0.0001; x += gridStep) lines.push(Number(x.toFixed(6)));
    return lines;
  }, [gridStep, workspace.width]);
  const horizontalLines = useMemo(() => {
    const lines: number[] = [];
    const start = Math.ceil((-workspace.depth / 2) / gridStep) * gridStep;
    for (let z = start; z <= workspace.depth / 2 + 0.0001; z += gridStep) lines.push(Number(z.toFixed(6)));
    return lines;
  }, [gridStep, workspace.depth]);

  const pointFromEvent = (
    event: { clientX: number; clientY: number },
    from?: { x: number; z: number } | null,
    options?: { snap?: boolean; excludePointIds?: readonly string[] },
  ) => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return null;
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = event.clientX;
    screenPoint.y = event.clientY;
    const local = screenPoint.matrixTransform(matrix.inverse());
    const step = snapStep(snap);
    const raw = {
      x: clamp(local.x, -workspace.width / 2, workspace.width / 2),
      z: clamp(local.y, -workspace.depth / 2, workspace.depth / 2),
    };
    if (options?.snap === false) {
      onSnapResolved?.(null);
      return raw;
    }
    const activePoint = activePointId ? profile.points.find((point) => point.id === activePointId) : null;
    const snapResult = snapSketchPoint(profile, {
      cursor: raw,
      from: from ?? (activePoint ? { x: activePoint.x, z: activePoint.z } : null),
      screenUnit,
      gridStep: step > 0 ? step : undefined,
      excludePointIds: options?.excludePointIds,
    });
    onSnapResolved?.(snapResult);
    return {
      x: clamp(snapResult.x, -workspace.width / 2, workspace.width / 2),
      z: clamp(snapResult.z, -workspace.depth / 2, workspace.depth / 2),
    };
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const updateSize = () => {
      const bounds = svg.getBoundingClientRect();
      setSvgSize({ width: bounds.width, height: bounds.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const beginPan = (event: ReactPointerEvent<SVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    svgRef.current?.setPointerCapture(event.pointerId);
    setPointerAction({ kind: "pan", pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
  };

  useEffect(() => {
    if (tool !== "arc") {
      setArcDraft([]);
    }
  }, [tool]);

  useEffect(() => {
    if (tool !== "erase") {
      eraseStrokeRef.current = null;
      setErasePreview(null);
    }
  }, [tool]);

  const eraseBrushRadius = Math.max(1.25, 12 * screenUnit);

  const applyEraseTip = (tip: { x: number; z: number }, stroke = eraseStrokeRef.current) => {
    if (!stroke) return;
    const hitMap = new Map(profile.points.map((point) => [point.id, point]));
    const changed = collectEraseHits(tip, eraseBrushRadius, profile, hitMap, stroke.pointIds, stroke.segmentIds);
    if (changed) {
      setErasePreview({
        pointIds: [...stroke.pointIds],
        segmentIds: [...stroke.segmentIds],
      });
    }
  };

  const beginEraseStroke = (event: ReactPointerEvent<Element>, tip: { x: number; z: number }) => {
    event.preventDefault();
    event.stopPropagation();
    svgRef.current?.setPointerCapture(event.pointerId);
    const stroke = { pointIds: new Set<string>(), segmentIds: new Set<string>() };
    eraseStrokeRef.current = stroke;
    applyEraseTip(tip, stroke);
    setPointerAction({ kind: "erase", pointerId: event.pointerId, current: tip });
    setHover(tip);
  };

  const finishEraseStroke = () => {
    const stroke = eraseStrokeRef.current;
    eraseStrokeRef.current = null;
    setErasePreview(null);
    setPointerAction(null);
    if (!stroke) return;
    if (stroke.pointIds.size || stroke.segmentIds.size) {
      onEraseEntities([...stroke.pointIds], [...stroke.segmentIds]);
    }
  };

  const handlePlanePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 1) {
      beginPan(event);
      return;
    }
    if (event.button !== 0 || (event.target !== event.currentTarget && (event.target as Element).closest("[data-sketch-entity]"))) return;
    const point = pointFromEvent(event, null, tool === "select" || tool === "dimension" ? { snap: false } : undefined);
    if (!point) return;
    event.preventDefault();
    if (tool === "erase") {
      beginEraseStroke(event, point);
      return;
    }
    if (tool === "bezier") {
      event.currentTarget.setPointerCapture(event.pointerId);
      setPointerAction({ kind: "bezier", pointerId: event.pointerId, origin: point, current: point });
    } else if (
      tool === "circle"
      || tool === "ellipse"
      || tool === "triangle"
      || tool === "polygon"
      || tool === "star"
      || tool === "square"
      || tool === "rectangle"
      || tool === "roundRect"
      || tool === "slot"
    ) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setPointerAction({ kind: tool, pointerId: event.pointerId, origin: point, current: point });
    } else if (tool === "arc") {
      const nextDraft = [...arcDraft, point];
      if (nextDraft.length >= 3) {
        onDrawArc(nextDraft[0], nextDraft[1], nextDraft[2]);
        setArcDraft([]);
      } else {
        setArcDraft(nextDraft);
      }
    } else if (tool === "select") {
      event.currentTarget.setPointerCapture(event.pointerId);
      setPointerAction({ kind: "marquee", pointerId: event.pointerId, origin: point, current: point });
    } else if (tool === "dimension") {
      onNotice?.("Select a segment to add a dimension");
    } else if (tool === "line" || tool === "smooth" || tool === "measure") {
      onPlanePoint(point);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (pointerAction?.kind === "pan") {
      const matrix = svgRef.current?.getScreenCTM();
      const scaleX = matrix ? Math.max(0.0001, Math.hypot(matrix.a, matrix.b)) : 1;
      const scaleY = matrix ? Math.max(0.0001, Math.hypot(matrix.c, matrix.d)) : 1;
      const deltaX = event.clientX - pointerAction.clientX;
      const deltaY = event.clientY - pointerAction.clientY;
      setPan((current) => ({
        x: clamp(current.x - deltaX / scaleX, -workspace.width / 2, workspace.width / 2),
        z: clamp(current.z - deltaY / scaleY, -workspace.depth / 2, workspace.depth / 2),
      }));
      setPointerAction({ ...pointerAction, clientX: event.clientX, clientY: event.clientY });
      return;
    }
    const moveOptions =
      pointerAction?.kind === "marquee"
        ? { snap: false as const }
        : pointerAction?.kind === "move-point"
          ? { excludePointIds: [pointerAction.pointId] }
          : undefined;
    const point = pointFromEvent(event, null, moveOptions);
    setHover(point);
    if (!point || !pointerAction) return;
    if (pointerAction.kind === "erase") {
      const samples = sampleEraseStroke(pointerAction.current, point, eraseBrushRadius * 0.55);
      for (const sample of samples) applyEraseTip(sample);
      setPointerAction({ ...pointerAction, current: point });
      return;
    }
    setPointerAction({ ...pointerAction, current: point });
  };

  const finishPointerAction = (event: ReactPointerEvent<SVGSVGElement>) => {
    const action = pointerAction;
    if (!action || action.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (action.kind === "pan") {
      setPointerAction(null);
      return;
    }
    if (action.kind === "erase") {
      finishEraseStroke();
      return;
    }
    if (action.kind === "marquee") {
      const minX = Math.min(action.origin.x, action.current.x);
      const maxX = Math.max(action.origin.x, action.current.x);
      const minZ = Math.min(action.origin.z, action.current.z);
      const maxZ = Math.max(action.origin.z, action.current.z);
      const contains = (point: { x: number; z: number }) => point.x >= minX && point.x <= maxX && point.z >= minZ && point.z <= maxZ;
      const pointIds = profile.points.filter(contains).map((point) => point.id);
      const segmentIds = profile.segments.filter((segment) => {
        const start = pointById.get(segment.startId);
        const end = pointById.get(segment.endId);
        return Boolean(start && end && (contains(start) || contains(end) || contains({ x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 })));
      }).map((segment) => segment.id);
      const imageIds = (profile.images ?? []).filter((image) => {
        const imageMinX = image.x - image.width / 2;
        const imageMaxX = image.x + image.width / 2;
        const imageMinZ = image.z - image.depth / 2;
        const imageMaxZ = image.z + image.depth / 2;
        return imageMaxX >= minX && imageMinX <= maxX && imageMaxZ >= minZ && imageMinZ <= maxZ;
      }).map((image) => image.id);
      onSelectMany(pointIds, segmentIds, imageIds);
      setPointerAction(null);
      return;
    }
    if (action.kind === "bezier") {
      const dx = action.current.x - action.origin.x;
      const dz = action.current.z - action.origin.z;
      onPlanePoint(action.origin, {
        handleIn: { x: action.origin.x - dx, z: action.origin.z - dz },
        handleOut: { x: action.origin.x + dx, z: action.origin.z + dz },
      });
    } else if (action.kind === "circle") {
      const radius = Math.hypot(action.current.x - action.origin.x, action.current.z - action.origin.z);
      if (radius >= 0.25) {
        onDrawCircle(action.origin, radius);
      }
    } else if (action.kind === "ellipse") {
      onDrawEllipse(action.origin, action.current);
    } else if (action.kind === "square") {
      onDrawSquare(action.origin, action.current);
    } else if (action.kind === "rectangle" || action.kind === "roundRect" || action.kind === "slot") {
      if (action.kind === "rectangle") onDrawRectangle(action.origin, action.current);
      else if (action.kind === "roundRect") onDrawRoundRect(action.origin, action.current);
      else onDrawSlot(action.origin, action.current);
    } else if (action.kind === "triangle") {
      onDrawTriangle(action.origin, action.current);
    } else if (action.kind === "polygon") {
      onDrawPolygon(action.origin, action.current);
    } else if (action.kind === "star") {
      onDrawStar(action.origin, action.current);
    } else if (action.kind === "offset") {
      onOffsetSegment(action.segmentId, action.current);
    } else if (action.kind === "move-point") {
      onMovePoint(action.pointId, action.current);
    } else if (action.kind === "move-handle") {
      onMoveHandle(action.pointId, action.handle, action.current);
    } else if (action.kind === "move-image") {
      onUpdateImage(action.imageId, {
        x: action.start.x + action.current.x - action.origin.x,
        z: action.start.z + action.current.z - action.origin.z,
      }, "Sketch image moved");
    } else if (action.kind === "resize-image") {
      onUpdateImage(action.imageId, resizeSketchImage(action.start, action.handle, action.current), "Sketch image resized");
    }
    setPointerAction(null);
  };

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setZoom((current) => clamp(current * (event.deltaY > 0 ? 0.88 : 1.14), 0.75, 6));
  };

  const beginEntityDrag = (event: ReactPointerEvent<SVGElement>, action: PointerAction) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    svgRef.current?.setPointerCapture(event.pointerId);
    setPointerAction(action);
  };

  const measurementLength = measurement ? Math.hypot(measurement.end.x - measurement.start.x, measurement.end.z - measurement.start.z) : 0;
  const measurementLabel = formatDimension(measurementLength, workspace.accuracy);
  const previewLength = activePoint && hover ? Math.hypot(hover.x - activePoint.x, hover.z - activePoint.z) : 0;
  const previewLabel = formatDimension(previewLength, workspace.accuracy);
  const circlePreviewRadius =
    pointerAction?.kind === "circle"
      ? Math.hypot(pointerAction.current.x - pointerAction.origin.x, pointerAction.current.z - pointerAction.origin.z)
      : 0;
  const circlePreviewLabel = formatDimension(circlePreviewRadius, workspace.accuracy);
  const radialPreview =
    pointerAction && (pointerAction.kind === "triangle" || pointerAction.kind === "polygon" || pointerAction.kind === "star")
      ? (() => {
          const radius = Math.hypot(pointerAction.current.x - pointerAction.origin.x, pointerAction.current.z - pointerAction.origin.z);
          if (radius < 0.01) return null;
          const startAngle = Math.atan2(pointerAction.current.z - pointerAction.origin.z, pointerAction.current.x - pointerAction.origin.x);
          let pts: Array<{ x: number; z: number }>;
          if (pointerAction.kind === "star") {
            const tips = 5;
            const inner = radius * 0.382;
            pts = Array.from({ length: tips * 2 }, (_, index) => {
              const r = index % 2 === 0 ? radius : inner;
              const angle = startAngle + (index * Math.PI) / tips;
              return {
                x: pointerAction.origin.x + Math.cos(angle) * r,
                z: pointerAction.origin.z + Math.sin(angle) * r,
              };
            });
          } else {
            const sides = pointerAction.kind === "triangle" ? 3 : polygonSides;
            pts = Array.from({ length: sides }, (_, index) => {
              const angle = startAngle + (index * 2 * Math.PI) / sides;
              return {
                x: pointerAction.origin.x + Math.cos(angle) * radius,
                z: pointerAction.origin.z + Math.sin(angle) * radius,
              };
            });
          }
          return {
            radius,
            label: formatDimension(radius, workspace.accuracy),
            d: `${pts.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.z}`).join(" ")} Z`,
          };
        })()
      : null;
  const squarePreview =
    pointerAction?.kind === "square"
      ? (() => {
          const dx = pointerAction.current.x - pointerAction.origin.x;
          const dz = pointerAction.current.z - pointerAction.origin.z;
          const side = Math.max(Math.abs(dx), Math.abs(dz));
          if (side < 0.01) return null;
          const sx = Math.sign(dx) || 1;
          const sz = Math.sign(dz) || 1;
          const x = Math.min(pointerAction.origin.x, pointerAction.origin.x + sx * side);
          const z = Math.min(pointerAction.origin.z, pointerAction.origin.z + sz * side);
          return { x, z, side, label: formatDimension(side, workspace.accuracy) };
        })()
      : null;
  const boxPreview =
    pointerAction && (pointerAction.kind === "ellipse" || pointerAction.kind === "rectangle" || pointerAction.kind === "roundRect" || pointerAction.kind === "slot")
      ? (() => {
          const width = Math.abs(pointerAction.current.x - pointerAction.origin.x);
          const height = Math.abs(pointerAction.current.z - pointerAction.origin.z);
          if (width < 0.01 || height < 0.01) return null;
          const x = Math.min(pointerAction.origin.x, pointerAction.current.x);
          const z = Math.min(pointerAction.origin.z, pointerAction.current.z);
          const rx = pointerAction.kind === "roundRect" ? Math.min(width, height) * 0.22 : pointerAction.kind === "slot" ? Math.min(width, height) / 2 : 0;
          return {
            kind: pointerAction.kind,
            x,
            z,
            width,
            height,
            rx,
            label: `${formatDimension(width, workspace.accuracy)} × ${formatDimension(height, workspace.accuracy)}`,
          };
        })()
      : null;
  const offsetPreview =
    pointerAction?.kind === "offset"
      ? (() => {
          const segment = profile.segments.find((entry) => entry.id === pointerAction.segmentId);
          const start = segment ? pointById.get(segment.startId) : null;
          const end = segment ? pointById.get(segment.endId) : null;
          if (!start || !end) return null;
          const dx = end.x - start.x;
          const dz = end.z - start.z;
          const length = Math.hypot(dx, dz);
          if (length < 0.01) return null;
          const nx = -dz / length;
          const nz = dx / length;
          const mid = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
          const side = (pointerAction.current.x - mid.x) * nx + (pointerAction.current.z - mid.z) * nz;
          const distance = Math.abs(side);
          const ox = nx * Math.sign(side || 1) * distance;
          const oz = nz * Math.sign(side || 1) * distance;
          return {
            x1: start.x + ox,
            z1: start.z + oz,
            x2: end.x + ox,
            z2: end.z + oz,
            label: formatDimension(distance, workspace.accuracy),
            midX: mid.x + ox,
            midZ: mid.z + oz,
          };
        })()
      : null;
  const labelOffset = 22 * screenUnit;
  const pointRadius = 5 * screenUnit;
  const controlPointRadius = 6 * screenUnit;
  const hoverPointRadius = 5 * screenUnit;
  const handleSize = 12 * screenUnit;
  const handleRadius = 2 * screenUnit;
  const selectedImageBounds = selectedImage ? {
    minX: selectedImage.x - selectedImage.width / 2,
    maxX: selectedImage.x + selectedImage.width / 2,
    minZ: selectedImage.z - selectedImage.depth / 2,
    maxZ: selectedImage.z + selectedImage.depth / 2,
  } : null;
  const imageResizeHandles: Array<{ id: ResizeHandle; x: number; z: number }> = selectedImage && selectedImageBounds ? [
    { id: "nw", x: selectedImageBounds.minX, z: selectedImageBounds.minZ },
    { id: "n", x: selectedImage.x, z: selectedImageBounds.minZ },
    { id: "ne", x: selectedImageBounds.maxX, z: selectedImageBounds.minZ },
    { id: "e", x: selectedImageBounds.maxX, z: selectedImage.z },
    { id: "se", x: selectedImageBounds.maxX, z: selectedImageBounds.maxZ },
    { id: "s", x: selectedImage.x, z: selectedImageBounds.maxZ },
    { id: "sw", x: selectedImageBounds.minX, z: selectedImageBounds.maxZ },
    { id: "w", x: selectedImageBounds.minX, z: selectedImage.z },
  ] : [];
  const referenceFootprints = useMemo(
    () => new Map(referenceShapes.map((shape) => [shape.id, importedMeshFootprint(shape)])),
    [referenceShapes],
  );
  const showReferenceFootprints = isDefaultSketchPlane(profile.sketchPlane);
  const faceReferenceLoops = profile.faceReferenceLoops ?? [];
  const hostShapeName = profile.sketchPlane?.hostShapeId
    ? referenceShapes.find((shape) => shape.id === profile.sketchPlane?.hostShapeId)?.name
    : null;
  const barrelSketch = profile.sketchPlane?.surface?.kind === "cylinder";
  const planeBanner = hostShapeName
    ? barrelSketch
      ? `Unwrapped ${hostShapeName} — up/down = height, left/right = around`
      : `Sketching on ${hostShapeName} face`
    : profile.sketchPlane && !isDefaultSketchPlane(profile.sketchPlane)
      ? barrelSketch
        ? "Unwrapped barrel — up/down = height, left/right = around"
        : "Sketching on selected face"
      : null;

  return (
    <main className="sketch-workspace-stage">
      <div className="sketch-mode-badge">Sketch view</div>
      {solveStatus !== "empty" ? (
        <div
          className={`sketch-solve-strip status-${solveStatus}${constraintConflicts.length ? " has-conflicts" : ""}`}
          aria-live="polite"
        >
          <span className="sketch-solve-status">
            {solveStatus === "fully-defined"
              ? "Fully defined"
              : solveStatus === "over-constrained"
                ? "Over-constrained"
                : solveStatus === "unsolved"
                  ? "Not solved"
                  : "Under-defined"}
          </span>
          <span className="sketch-solve-dof">DOF {solveDof}</span>
          {constraintConflicts.length > 0 ? (
            <span className="sketch-solve-conflicts">{constraintConflicts.length} conflict{constraintConflicts.length === 1 ? "" : "s"}</span>
          ) : null}
        </div>
      ) : null}
      {planeBanner ? <div className="sketch-plane-banner">{planeBanner}</div> : null}
      <div className="camera-controls sketch-camera-controls" aria-label="Sketch view controls">
        <button aria-label="Reset sketch view" onClick={() => { setZoom(1); setPan({ x: 0, z: 0 }); }}><Home size={28} /></button>
        <button aria-label="Zoom in" onClick={() => setZoom((value) => clamp(value * 1.25, 0.75, 6))}><Plus size={33} /></button>
        <button aria-label="Zoom out" onClick={() => setZoom((value) => clamp(value / 1.25, 0.75, 6))}><Minus size={33} /></button>
        <div className="ruler-control-group">
          <PeakTipButton
            className={tool === "measure" ? "active" : ""}
            label="Measure"
            description={TOOL_DESCRIPTIONS.measure}
            aria-pressed={tool === "measure"}
            onClick={() => {
              if (!onToolChange) return;
              if (tool === "measure") {
                onToolChange("select");
                onClearMeasurement();
                return;
              }
              onToolChange("measure");
            }}
          >
            <Ruler size={26} strokeWidth={2.2} aria-hidden="true" />
          </PeakTipButton>
        </div>
      </div>
      <section className="sketch-plate-wrap" aria-label="2D sketch plate">
        <svg
          ref={svgRef}
          className={`sketch-plate tool-${tool} ${pointerAction?.kind === "pan" ? "panning" : ""}`}
          viewBox={`${pan.x - width / 2} ${pan.z - depth / 2} ${width} ${depth}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={handlePlanePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerAction}
          onPointerCancel={(event) => {
            if (pointerAction?.kind === "erase" && pointerAction.pointerId === event.pointerId) {
              finishEraseStroke();
              return;
            }
            setPointerAction(null);
          }}
          onPointerLeave={() => !pointerAction && setHover(null)}
          onWheel={handleWheel}
        >
          <rect className="sketch-plate-background" x={-workspace.width / 2} y={-workspace.depth / 2} width={workspace.width} height={workspace.depth} />
          {workspace.showGrid ? (
            <g className="sketch-grid" pointerEvents="none">
              {verticalLines.map((x) => {
                const atOrigin = Math.abs(x) < 0.0001;
                const major = !atOrigin && Math.round(Math.abs(x) / gridStep) % majorEvery === 0;
                return <line className={atOrigin ? "axis" : major ? "major" : "minor"} key={`x-${x}`} x1={x} y1={-workspace.depth / 2} x2={x} y2={workspace.depth / 2} />;
              })}
              {horizontalLines.map((z) => {
                const atOrigin = Math.abs(z) < 0.0001;
                const major = !atOrigin && Math.round(Math.abs(z) / gridStep) % majorEvery === 0;
                return <line className={atOrigin ? "axis" : major ? "major" : "minor"} key={`z-${z}`} x1={-workspace.width / 2} y1={z} x2={workspace.width / 2} y2={z} />;
              })}
            </g>
          ) : null}
          <g className="sketch-reference-images">
            {displayImages.map((image) => (
              <image
                key={image.id}
                data-sketch-entity="image"
                aria-label={image.name}
                href={image.dataUrl}
                x={image.x - image.width / 2}
                y={image.z - image.depth / 2}
                width={image.width}
                height={image.depth}
                opacity={image.opacity ?? 0.55}
                preserveAspectRatio="none"
                pointerEvents={tool === "select" ? "auto" : "none"}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.button === 1) {
                    beginPan(event);
                    return;
                  }
                  if (event.button !== 0 || tool !== "select") return;
                  const point = pointFromEvent(event);
                  if (!point) return;
                  onSelectImage(image.id);
                  beginEntityDrag(event, {
                    kind: "move-image",
                    pointerId: event.pointerId,
                    imageId: image.id,
                    origin: point,
                    current: point,
                    start: { ...image },
                  });
                }}
              />
            ))}
          </g>
          <g className="sketch-reference-shapes" pointerEvents="none">
            {showReferenceFootprints
              ? referenceShapes.filter((shape) => !shape.hidden).map((shape) => {
                  const footprint = referenceFootprints.get(shape.id);
                  return (
                    <g key={shape.id} transform={`rotate(${shape.rotation ?? 0} ${shape.x} ${shape.z})`}>
                      {footprint?.fillD || footprint?.outlineD ? (
                        <>
                          {footprint.fillD ? <path className="sketch-reference-mesh-face" d={footprint.fillD} /> : null}
                          {footprint.outlineD ? <path className="sketch-reference-mesh-outline" d={footprint.outlineD} /> : null}
                        </>
                      ) : isRoundReference(shape) ? (
                        <ellipse cx={shape.x} cy={shape.z} rx={shape.width / 2} ry={shape.depth / 2} />
                      ) : (
                        <rect x={shape.x - shape.width / 2} y={shape.z - shape.depth / 2} width={shape.width} height={shape.depth} />
                      )}
                    </g>
                  );
                })
              : null}
          </g>
          {faceReferenceLoops.length > 0 ? (
            <g className="sketch-face-reference" pointerEvents="none">
              {faceReferenceLoops.map((loop, index) => {
                if (loop.length < 2) return null;
                const d = `M ${loop.map((point) => `${point.x} ${point.z}`).join(" L ")} Z`;
                return <path key={`face-ref-${index}`} className="sketch-face-reference-loop" d={d} />;
              })}
              {barrelSketch && faceReferenceLoops[0]?.length >= 4 ? (() => {
                const xs = faceReferenceLoops[0].map((point) => point.x);
                const zs = faceReferenceLoops[0].map((point) => point.z);
                const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
                const midZ = (Math.min(...zs) + Math.max(...zs)) / 2;
                const topZ = Math.min(...zs);
                const rightX = Math.max(...xs);
                const labelSize = Math.max(2.2, Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 0.06);
                return (
                  <g className="sketch-barrel-axis-labels" fontSize={labelSize}>
                    <text x={midX} y={topZ - labelSize * 0.35} textAnchor="middle">height</text>
                    <text x={rightX + labelSize * 0.35} y={midZ} textAnchor="start" dominantBaseline="middle">around</text>
                  </g>
                );
              })() : null}
            </g>
          ) : null}
          <rect className="sketch-plate-border" x={-workspace.width / 2} y={-workspace.depth / 2} width={workspace.width} height={workspace.depth} pointerEvents="none" />
          {pointerAction?.kind === "marquee" ? (
            <rect
              className="sketch-selection-marquee"
              x={Math.min(pointerAction.origin.x, pointerAction.current.x)}
              y={Math.min(pointerAction.origin.z, pointerAction.current.z)}
              width={Math.abs(pointerAction.current.x - pointerAction.origin.x)}
              height={Math.abs(pointerAction.current.z - pointerAction.origin.z)}
              pointerEvents="none"
            />
          ) : null}
          <g className="sketch-profile-fills">
            {closedProfilesFromLegacy(displayProfile).map((closedProfile) => {
              const path = paths.find((entry) => entry.closed && entry.points.some((point) => point.id === closedProfile.pointIds[0]));
              if (!path) return null;
              const selected = selectedProfileIds.includes(closedProfile.id);
              return (
                <path
                  key={closedProfile.id}
                  className={selected ? "selected-profile" : ""}
                  d={pathData(path)}
                  pointerEvents="auto"
                  onPointerDown={(event) => {
                    if (event.button !== 0 || tool !== "select" || !onSelectProfile) return;
                    event.preventDefault();
                    event.stopPropagation();
                    onSelectProfile(closedProfile.id);
                  }}
                />
              );
            })}
          </g>
          <g className="sketch-segments">
            {displayProfile.segments.map((segment) => (
              <path
                data-sketch-entity="segment"
                className={isSegmentSelected(segment.id) ? "selected" : ""}
                key={segment.id}
                d={segmentData(segment, pointById)}
                onPointerDown={(event) => {
                  const point = pointFromEvent(event);
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.button === 1) beginPan(event);
                  else if (event.button === 0 && tool === "erase" && point) beginEraseStroke(event, point);
                  else if (event.button === 0 && tool === "refine" && point) onInsertPoint(segment.id, point);
                  else if (event.button === 0 && tool === "offset" && point) {
                    svgRef.current?.setPointerCapture(event.pointerId);
                    setPointerAction({ kind: "offset", pointerId: event.pointerId, segmentId: segment.id, current: point });
                  } else if (event.button === 0) onSelectSegment(segment.id);
                }}
              />
            ))}
          </g>
          <g className="sketch-segment-dimensions" pointerEvents="none">
            {displayProfile.segments.map((segment) => {
              const dimension = segmentDimension(segment, pointById);
              if (!dimension) return null;
              const label = formatDimension(dimension.length, workspace.accuracy);
              const pill = dimensionPillSize(label, screenUnit, 18);
              return (
                <g key={`dimension-${segment.id}`} transform={`translate(${dimension.midpoint.x} ${dimension.midpoint.z - labelOffset})`}>
                  <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                  <text y={5 * screenUnit} fontSize={13 * screenUnit}>{label}</text>
                </g>
              );
            })}
          </g>
          {activePoint && hover && ["line", "bezier", "smooth"].includes(tool) ? <line className="sketch-preview-line" x1={activePoint.x} y1={activePoint.z} x2={hover.x} y2={hover.z} pointerEvents="none" /> : null}
          {activePoint && hover && ["line", "bezier", "smooth"].includes(tool) ? (
            <g className="sketch-segment-dimensions preview" pointerEvents="none" transform={`translate(${(activePoint.x + hover.x) / 2} ${(activePoint.z + hover.z) / 2 - labelOffset})`}>
              {(() => {
                const pill = dimensionPillSize(previewLabel, screenUnit, 18);
                return (
                  <>
                    <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                    <text y={5 * screenUnit} fontSize={13 * screenUnit}>{previewLabel}</text>
                  </>
                );
              })()}
            </g>
          ) : null}
          {pointerAction?.kind === "bezier" ? (
            <g className="sketch-drag-handles" pointerEvents="none">
              <line x1={pointerAction.origin.x * 2 - pointerAction.current.x} y1={pointerAction.origin.z * 2 - pointerAction.current.z} x2={pointerAction.current.x} y2={pointerAction.current.z} />
              <circle cx={pointerAction.origin.x} cy={pointerAction.origin.z} r={controlPointRadius} />
            </g>
          ) : null}
          {pointerAction?.kind === "circle" && circlePreviewRadius > 0 ? (
            <g className="sketch-circle-preview" pointerEvents="none">
              <line
                className="sketch-preview-line"
                x1={pointerAction.origin.x}
                y1={pointerAction.origin.z}
                x2={pointerAction.current.x}
                y2={pointerAction.current.z}
              />
              <circle
                className="sketch-preview-circle"
                cx={pointerAction.origin.x}
                cy={pointerAction.origin.z}
                r={circlePreviewRadius}
              />
              <circle cx={pointerAction.origin.x} cy={pointerAction.origin.z} r={controlPointRadius} className="sketch-cursor-point" />
              <g
                className="sketch-segment-dimensions preview"
                transform={`translate(${(pointerAction.origin.x + pointerAction.current.x) / 2} ${(pointerAction.origin.z + pointerAction.current.z) / 2 - labelOffset})`}
              >
                {(() => {
                  const pill = dimensionPillSize(circlePreviewLabel, screenUnit, 18);
                  return (
                    <>
                      <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                      <text y={5 * screenUnit} fontSize={13 * screenUnit}>{circlePreviewLabel}</text>
                    </>
                  );
                })()}
              </g>
            </g>
          ) : null}
          {squarePreview ? (
            <g className="sketch-shape-preview" pointerEvents="none">
              <rect className="sketch-preview-circle" x={squarePreview.x} y={squarePreview.z} width={squarePreview.side} height={squarePreview.side} />
              <g className="sketch-segment-dimensions preview" transform={`translate(${squarePreview.x + squarePreview.side / 2} ${squarePreview.z - labelOffset})`}>
                {(() => {
                  const pill = dimensionPillSize(squarePreview.label, screenUnit, 18);
                  return (
                    <>
                      <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                      <text y={5 * screenUnit} fontSize={13 * screenUnit}>{squarePreview.label}</text>
                    </>
                  );
                })()}
              </g>
            </g>
          ) : null}
          {boxPreview ? (
            <g className="sketch-shape-preview" pointerEvents="none">
              {boxPreview.kind === "ellipse" ? (
                <ellipse
                  className="sketch-preview-circle"
                  cx={boxPreview.x + boxPreview.width / 2}
                  cy={boxPreview.z + boxPreview.height / 2}
                  rx={boxPreview.width / 2}
                  ry={boxPreview.height / 2}
                />
              ) : (
                <rect
                  className="sketch-preview-circle"
                  x={boxPreview.x}
                  y={boxPreview.z}
                  width={boxPreview.width}
                  height={boxPreview.height}
                  rx={boxPreview.rx}
                  ry={boxPreview.rx}
                />
              )}
              <g
                className="sketch-segment-dimensions preview"
                transform={`translate(${boxPreview.x + boxPreview.width / 2} ${boxPreview.z - labelOffset})`}
              >
                {(() => {
                  const pill = dimensionPillSize(boxPreview.label, screenUnit, 18);
                  return (
                    <>
                      <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                      <text y={5 * screenUnit} fontSize={13 * screenUnit}>{boxPreview.label}</text>
                    </>
                  );
                })()}
              </g>
            </g>
          ) : null}
          {radialPreview && pointerAction && (pointerAction.kind === "triangle" || pointerAction.kind === "polygon" || pointerAction.kind === "star") ? (
            <g className="sketch-shape-preview" pointerEvents="none">
              <line className="sketch-preview-line" x1={pointerAction.origin.x} y1={pointerAction.origin.z} x2={pointerAction.current.x} y2={pointerAction.current.z} />
              <path className="sketch-preview-circle" d={radialPreview.d} />
              <g
                className="sketch-segment-dimensions preview"
                transform={`translate(${(pointerAction.origin.x + pointerAction.current.x) / 2} ${(pointerAction.origin.z + pointerAction.current.z) / 2 - labelOffset})`}
              >
                {(() => {
                  const pill = dimensionPillSize(radialPreview.label, screenUnit, 18);
                  return (
                    <>
                      <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                      <text y={5 * screenUnit} fontSize={13 * screenUnit}>{radialPreview.label}</text>
                    </>
                  );
                })()}
              </g>
            </g>
          ) : null}
          {offsetPreview ? (
            <g className="sketch-shape-preview" pointerEvents="none">
              <line className="sketch-preview-line" x1={offsetPreview.x1} y1={offsetPreview.z1} x2={offsetPreview.x2} y2={offsetPreview.z2} />
              <g className="sketch-segment-dimensions preview" transform={`translate(${offsetPreview.midX} ${offsetPreview.midZ - labelOffset})`}>
                {(() => {
                  const pill = dimensionPillSize(offsetPreview.label, screenUnit, 18);
                  return (
                    <>
                      <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                      <text y={5 * screenUnit} fontSize={13 * screenUnit}>{offsetPreview.label}</text>
                    </>
                  );
                })()}
              </g>
            </g>
          ) : null}
          {arcDraft.length > 0 ? (
            <g className="sketch-shape-preview" pointerEvents="none">
              {arcDraft.map((point, index) => (
                <circle key={`arc-draft-${index}`} className="sketch-cursor-point" cx={point.x} cy={point.z} r={controlPointRadius} />
              ))}
              {arcDraft.length === 1 && hover ? (
                <line className="sketch-preview-line" x1={arcDraft[0].x} y1={arcDraft[0].z} x2={hover.x} y2={hover.z} />
              ) : null}
              {arcDraft.length === 2 ? (
                <>
                  <line className="sketch-preview-line" x1={arcDraft[0].x} y1={arcDraft[0].z} x2={arcDraft[1].x} y2={arcDraft[1].z} />
                  {hover ? <circle className="sketch-preview-circle" cx={hover.x} cy={hover.z} r={hoverPointRadius} /> : null}
                </>
              ) : null}
            </g>
          ) : null}
          {measurement ? (
            <g className="sketch-measurement">
              <line x1={measurement.start.x} y1={measurement.start.z} x2={measurement.end.x} y2={measurement.end.z} />
              <circle className="sketch-measurement-point" cx={measurement.start.x} cy={measurement.start.z} r={pointRadius} pointerEvents="none" />
              <circle className="sketch-measurement-point" cx={measurement.end.x} cy={measurement.end.z} r={pointRadius} pointerEvents="none" />
              <g
                className="sketch-measurement-pill"
                role="button"
                tabIndex={0}
                aria-label="Remove measurement"
                transform={`translate(${(measurement.start.x + measurement.end.x) / 2} ${(measurement.start.z + measurement.end.z) / 2 - labelOffset})`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onClearMeasurement();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " " || event.key === "Escape" || event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault();
                    event.stopPropagation();
                    onClearMeasurement();
                  }
                }}
              >
                <rect x={-dimensionPillSize(measurementLabel, screenUnit, 30).width / 2} y={-dimensionPillSize(measurementLabel, screenUnit, 30).height / 2} width={dimensionPillSize(measurementLabel, screenUnit, 30).width} height={dimensionPillSize(measurementLabel, screenUnit, 30).height} rx={dimensionPillSize(measurementLabel, screenUnit, 30).radius} />
                <text x={-5 * screenUnit} y={5 * screenUnit} fontSize={13 * screenUnit}>{measurementLabel}</text>
                <text className="remove" x={dimensionPillSize(measurementLabel, screenUnit, 30).width / 2 - 8 * screenUnit} y={5 * screenUnit} fontSize={14 * screenUnit}>x</text>
              </g>
            </g>
          ) : null}
          {pendingMeasurementStart ? (
            <g className="sketch-measurement pending" pointerEvents="none">
              {hover ? <line x1={pendingMeasurementStart.x} y1={pendingMeasurementStart.z} x2={hover.x} y2={hover.z} /> : null}
              <circle className="sketch-measurement-point pending" cx={pendingMeasurementStart.x} cy={pendingMeasurementStart.z} r={pointRadius} />
              {hover ? <circle className="sketch-measurement-point hover" cx={hover.x} cy={hover.z} r={pointRadius} /> : null}
            </g>
          ) : null}
          {selectedPoint && tool === "select" ? (
            <g className="sketch-curve-handles">
              {selectedPoint.handleIn ? <><line x1={selectedPoint.x} y1={selectedPoint.z} x2={selectedPoint.handleIn.x} y2={selectedPoint.handleIn.z} /><circle data-sketch-entity="handle" cx={selectedPoint.handleIn.x} cy={selectedPoint.handleIn.z} r={controlPointRadius} onPointerDown={(event) => event.button === 1 ? beginPan(event) : beginEntityDrag(event, { kind: "move-handle", pointerId: event.pointerId, pointId: selectedPoint.id, handle: "in", current: selectedPoint.handleIn! })} /></> : null}
              {selectedPoint.handleOut ? <><line x1={selectedPoint.x} y1={selectedPoint.z} x2={selectedPoint.handleOut.x} y2={selectedPoint.handleOut.z} /><circle data-sketch-entity="handle" cx={selectedPoint.handleOut.x} cy={selectedPoint.handleOut.z} r={controlPointRadius} onPointerDown={(event) => event.button === 1 ? beginPan(event) : beginEntityDrag(event, { kind: "move-handle", pointerId: event.pointerId, pointId: selectedPoint.id, handle: "out", current: selectedPoint.handleOut! })} /></> : null}
            </g>
          ) : null}
          <g className="sketch-points">
            {displayProfile.points.map((point) => (
              <circle
                data-sketch-entity="point"
                className={`${isPointSelected(point.id) ? "selected" : ""} ${activePointId === point.id ? "active" : ""}`}
                key={point.id}
                cx={point.x}
                cy={point.z}
                r={pointRadius}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.button === 1) {
                    beginPan(event);
                  } else if (event.button === 0 && tool === "erase") {
                    beginEraseStroke(event, { x: point.x, z: point.z });
                  } else if (tool === "refine") {
                    onDeletePoint(point.id);
                  } else if (event.button === 0 && tool === "select") {
                    onPointPress(point.id);
                    beginEntityDrag(event, { kind: "move-point", pointerId: event.pointerId, pointId: point.id, current: { x: point.x, z: point.z } });
                  } else if (event.button === 0) {
                    onPointPress(point.id);
                  }
                }}
              />
            ))}
          </g>
          {selectedImage && selectedImageBounds && tool === "select" ? (
            <g className="sketch-image-selection">
              <rect
                className="sketch-image-selection-box"
                x={selectedImageBounds.minX}
                y={selectedImageBounds.minZ}
                width={selectedImage.width}
                height={selectedImage.depth}
                pointerEvents="none"
              />
              <g className="sketch-image-dimension width" pointerEvents="none" transform={`translate(${selectedImage.x} ${selectedImageBounds.minZ - labelOffset})`}>
                {(() => {
                  const label = formatDimension(selectedImage.width, workspace.accuracy);
                  const pill = dimensionPillSize(label, screenUnit, 18);
                  return (
                    <>
                      <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                      <text y={5 * screenUnit} fontSize={13 * screenUnit}>{label}</text>
                    </>
                  );
                })()}
              </g>
              <g className="sketch-image-dimension depth" pointerEvents="none" transform={`translate(${selectedImageBounds.maxX + 34 * screenUnit} ${selectedImage.z})`}>
                {(() => {
                  const label = formatDimension(selectedImage.depth, workspace.accuracy);
                  const pill = dimensionPillSize(label, screenUnit, 18);
                  return (
                    <>
                      <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                      <text y={5 * screenUnit} fontSize={13 * screenUnit}>{label}</text>
                    </>
                  );
                })()}
              </g>
              {imageResizeHandles.map((handle) => (
                <rect
                  key={handle.id}
                  data-sketch-entity="image-handle"
                  className={`sketch-image-resize-handle handle-${handle.id}`}
                  x={handle.x - handleSize / 2}
                  y={handle.z - handleSize / 2}
                  width={handleSize}
                  height={handleSize}
                  rx={handleRadius}
                  onPointerDown={(event) => {
                    if (event.button === 1) {
                      beginPan(event);
                      return;
                    }
                    if (event.button !== 0) return;
                    const point = pointFromEvent(event);
                    if (!point) return;
                    beginEntityDrag(event, {
                      kind: "resize-image",
                      pointerId: event.pointerId,
                      imageId: selectedImage.id,
                      handle: handle.id,
                      current: point,
                      start: { ...selectedImage },
                    });
                  }}
                />
              ))}
            </g>
          ) : null}
          {hover && ["line", "bezier", "smooth", "circle", "square", "triangle", "polygon", "arc", "measure"].includes(tool) ? (
            <circle className="sketch-cursor-point" cx={hover.x} cy={hover.z} r={hoverPointRadius} pointerEvents="none" />
          ) : null}
          {tool === "erase" && (hover || (pointerAction?.kind === "erase" ? pointerAction.current : null)) ? (
            (() => {
              const tip = hover ?? (pointerAction?.kind === "erase" ? pointerAction.current : null);
              if (!tip) return null;
              return (
                <g className="sketch-eraser-tip" pointerEvents="none">
                  <circle className="sketch-eraser-brush" cx={tip.x} cy={tip.z} r={eraseBrushRadius} />
                  <g transform={`translate(${tip.x + eraseBrushRadius * 0.35} ${tip.z - eraseBrushRadius * 1.15}) scale(${screenUnit * 1.15})`}>
                    <path
                      className="sketch-eraser-glyph"
                      d="M2 18 L14 6 L20 12 L8 24 Z M14 6 L17 3 L23 9 L20 12 Z"
                    />
                  </g>
                </g>
              );
            })()
          ) : null}
          {activeSnap && activeSnap.kind !== "grid" ? (
            <SketchSnapGlyph
              kind={activeSnap.kind}
              x={activeSnap.x}
              z={activeSnap.z}
              screenUnit={screenUnit}
            />
          ) : null}
          {showDimensions && dimensions.length > 0 ? (
            <g className="sketch-driving-dimensions">
              {dimensions.map((dimension) => {
                const label = `${dimension.value.toFixed(2)}`;
                const pill = dimensionPillSize(label, screenUnit, 18);
                let x = dimension.labelOffset?.x ?? 0;
                let z = dimension.labelOffset?.z ?? 0;
                if (dimension.entityIds[0]) {
                  const segment = displayProfile.segments.find((entry) => entry.id === dimension.entityIds[0]);
                  const dim = segment ? segmentDimension(segment, pointById) : null;
                  if (dim) {
                    x = dim.midpoint.x;
                    z = dim.midpoint.z - labelOffset;
                  }
                }
                if (dimension.pointIds && dimension.pointIds.length >= 2) {
                  const a = pointById.get(dimension.pointIds[0]);
                  const b = pointById.get(dimension.pointIds[1]);
                  if (a && b) {
                    x = (a.x + b.x) / 2;
                    z = (a.z + b.z) / 2 - labelOffset;
                  }
                }
                return (
                  <g
                    key={dimension.id}
                    className={dimension.driving ? "driving" : "driven"}
                    transform={`translate(${x} ${z})`}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!onEditDimension || !dimension.driving) return;
                      setDimensionDialog({ id: dimension.id, value: dimension.value });
                    }}
                  >
                    <rect x={-pill.width / 2} y={-pill.height / 2} width={pill.width} height={pill.height} rx={pill.radius} />
                    <text y={5 * screenUnit} fontSize={13 * screenUnit}>{label}</text>
                  </g>
                );
              })}
            </g>
          ) : null}
          {showConstraints && constraints.length > 0 ? (
            <g className="sketch-constraint-glyphs" pointerEvents="none">
              {constraints.filter((constraint) => !constraint.suppressed).map((constraint, index) => {
                const anchor = constraintGlyphAnchor(constraint, constraintEntities, pointById);
                if (!anchor) return null;
                const glyph = CONSTRAINT_GLYPH[constraint.kind] ?? CONSTRAINT_LABELS[constraint.kind]?.[0] ?? "?";
                const conflict = constraintConflicts.includes(constraint.id);
                const size = 16 * screenUnit;
                // Fan overlapping glyphs slightly so stacked constraints stay readable.
                const offsetX = (index % 3) * 4 * screenUnit;
                const offsetZ = -18 * screenUnit - Math.floor(index / 3) * 4 * screenUnit;
                return (
                  <g
                    key={constraint.id}
                    className={`sketch-constraint-glyph${conflict ? " conflict" : ""}`}
                    transform={`translate(${anchor.x + offsetX} ${anchor.z + offsetZ})`}
                  >
                    <title>{CONSTRAINT_LABELS[constraint.kind]}{conflict ? " (conflict)" : ""}</title>
                    <circle r={size * 0.55} />
                    <text y={4 * screenUnit} fontSize={11 * screenUnit}>{glyph}</text>
                  </g>
                );
              })}
            </g>
          ) : null}
        </svg>
      </section>
      {selectedImage && tool === "select" ? (
        <SketchImageInspector
          image={selectedImage}
          accuracy={workspace.accuracy}
          onClose={() => onSelectMany([], [], [])}
          onUpdate={(patch, message) => onUpdateImage(selectedImage.id, patch, message)}
          onDelete={() => onDeleteImage(selectedImage.id)}
        />
      ) : null}
      {selectedPoint && tool === "select" ? (
        <div className="sketch-point-actions" aria-label="Point actions">
          <button type="button" onClick={() => onSetPointMode(selectedPoint.id, "corner")}><CornerDownRight /><span>Corner</span></button>
          <button type="button" onClick={() => onSetPointMode(selectedPoint.id, "smooth")}><Waves /><span>Smooth</span></button>
          <button type="button" onClick={() => onSetPointMode(selectedPoint.id, "split")}><Split /><span>Split</span></button>
        </div>
      ) : null}
      <div className="grid-settings sketch-grid-settings">
        <SnapGridControl
          snap={snap}
          snapOpen={snapOpen}
          onSnapChange={(next) => {
            setSnap(next);
            onSnapChange?.(typeof next === "function" ? next(snap) : next);
          }}
          onSnapOpenChange={setSnapOpen}
        />
      </div>
      {dimensionDialog ? (
        <InlineValueDialog
          title="Edit dimension"
          fields={[{ key: "value", label: "Dimension value", value: String(dimensionDialog.value), unit: "mm", min: 0 }]}
          confirmLabel="Apply"
          onCancel={() => setDimensionDialog(null)}
          onConfirm={(values) => {
            const value = Number.parseFloat(values.value ?? "");
            const { id } = dimensionDialog;
            setDimensionDialog(null);
            if (Number.isFinite(value) && value > 0) onEditDimension?.(id, value);
          }}
        />
      ) : null}
    </main>
  );
}

function SketchImageInspector({
  image,
  accuracy,
  onClose,
  onUpdate,
  onDelete,
}: {
  image: SketchImage;
  accuracy: 1 | 2 | 3;
  onClose: () => void;
  onUpdate: (patch: Partial<SketchImage>, message?: string) => void;
  onDelete: () => void;
}) {
  const aspect = image.width / Math.max(0.5, image.depth);
  const updateWidth = (width: number) => onUpdate({
    width,
    ...(image.lockAspect !== false ? { depth: Math.max(0.5, width / aspect) } : {}),
  }, "Sketch image width updated");
  const updateDepth = (depth: number) => onUpdate({
    depth,
    ...(image.lockAspect !== false ? { width: Math.max(0.5, depth * aspect) } : {}),
  }, "Sketch image height updated");

  return (
    <aside className="shape-inspector sketch-image-inspector" aria-label={`${image.name} image settings`} onPointerDown={(event) => event.stopPropagation()}>
      <div className="shape-inspector-header">
        <PeakTipButton className="inspector-header-icon" label="Close image settings" onClick={onClose}>
          <ChevronUp size={26} strokeWidth={2.8} />
        </PeakTipButton>
        <strong>{image.name}</strong>
        <div className="inspector-header-actions">
          <PeakTipButton className="inspector-header-icon danger" label="Delete image" onClick={onDelete}>
            <Trash2 size={25} strokeWidth={2.2} />
          </PeakTipButton>
        </div>
      </div>
      <div className="sketch-image-preview-card">
        <img src={image.dataUrl} alt="" />
        <span>{image.pixelWidth} × {image.pixelHeight} px</span>
      </div>
      <div className="property-card">
        <div className="property-card-header static"><span>Properties</span></div>
        <div className="property-list">
          <SketchImageRange label="Width" value={image.width} min={0.5} max={200} accuracy={accuracy} onChange={updateWidth} />
          <SketchImageRange label="Height" value={image.depth} min={0.5} max={200} accuracy={accuracy} onChange={updateDepth} />
          <SketchImageRange label="Opacity" value={(image.opacity ?? 0.55) * 100} min={5} max={100} accuracy={1} suffix="%" onChange={(opacity) => onUpdate({ opacity: opacity / 100 }, "Sketch image opacity updated")} />
          <SketchImagePosition
            label="Position X"
            value={image.x}
            accuracy={accuracy}
            onCommit={(x) => onUpdate({ x }, "Sketch image moved")}
          />
          <SketchImagePosition
            label="Position Y"
            value={image.z}
            accuracy={accuracy}
            onCommit={(z) => onUpdate({ z }, "Sketch image moved")}
          />
          <button className={`sketch-image-aspect-toggle ${image.lockAspect !== false ? "active" : ""}`} type="button" onClick={() => onUpdate({ lockAspect: image.lockAspect === false }, "Image aspect ratio setting updated")}>
            {image.lockAspect !== false ? <Link size={17} /> : <Link2Off size={17} />}
            <span>{image.lockAspect !== false ? "Aspect ratio locked" : "Aspect ratio unlocked"}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

/**
 * Position entry that commits on blur rather than on every keystroke.
 *
 * Writing straight through on change meant a half-typed value was parsed and echoed back: a leading
 * minus or a trailing decimal point evaluated to NaN or a truncated number, so the field snapped
 * back and negative and sub-accuracy positions could not be typed at all.
 */
function SketchImagePosition({
  label,
  value,
  accuracy,
  onCommit,
}: {
  label: string;
  value: number;
  accuracy: 1 | 2 | 3;
  onCommit: (value: number) => void;
}) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const [draft, setDraft] = useState(formatDimension(safeValue, accuracy));
  useEffect(() => setDraft(formatDimension(safeValue, accuracy)), [accuracy, safeValue]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() !== "" && Number.isFinite(parsed)) onCommit(parsed);
    else setDraft(formatDimension(safeValue, accuracy));
  };
  return (
    <label className="sketch-image-position-field">
      <span>{label}</span>
      <input
        type="number"
        step={accuracy === 1 ? 0.1 : 0.01}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(formatDimension(safeValue, accuracy));
        }}
      />
    </label>
  );
}

function SketchImageRange({
  label,
  value,
  min,
  max,
  accuracy,
  suffix = "mm",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  accuracy: 1 | 2 | 3;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const safeValue = clamp(Number.isFinite(value) ? value : min, min, max);
  const [draft, setDraft] = useState(formatDimension(safeValue, accuracy));
  useEffect(() => setDraft(formatDimension(safeValue, accuracy)), [accuracy, safeValue]);
  const commit = () => {
    const parsed = Number(draft);
    onChange(clamp(Number.isFinite(parsed) ? parsed : safeValue, min, max));
  };
  const position = ((safeValue - min) / Math.max(0.001, max - min)) * 100;
  return (
    <label className="range-property sketch-image-range" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span>{label}</span>
      <div className="sketch-image-range-row">
        <input
          className="sketch-image-number-input"
          type="number"
          min={min}
          max={max}
          step={accuracy === 1 ? 0.1 : 0.01}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
        <span>{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={accuracy === 1 ? 0.1 : 0.01} value={safeValue} onChange={(event) => onChange(Number(event.currentTarget.value))} />
    </label>
  );
}
