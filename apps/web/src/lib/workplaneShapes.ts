import type { WorkplaneShape } from "@/types/sketchforge";

import { hardwareProfile } from "@/lib/desktopHardware";

export const MAX_SHAPE_SIDES = hardwareProfile().maxShapeSides;

export function normalizeDegrees(value: number) {
  return ((value % 360) + 360) % 360;
}

export function cleanRotationDegrees(value: number, precision = 1) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const normalized = normalizeDegrees(value);
  const rounded = Number(normalized.toFixed(precision));
  const zeroThreshold = precision <= 1 ? 0.5 : 0.05;
  if (rounded < zeroThreshold || rounded >= 360 - zeroThreshold || Object.is(rounded, -0)) {
    return 0;
  }
  return rounded;
}

export function cleanNearZero(value: number, epsilon = 0.005) {
  return Math.abs(value) < epsilon ? 0 : value;
}

export function shapeWidth(shape: Pick<WorkplaneShape, "width" | "size">) {
  return shape.width ?? shape.size;
}

export function shapeDepth(shape: Pick<WorkplaneShape, "depth" | "size">) {
  return shape.depth ?? shape.size;
}

/** Cone base radius in model units (falls back to half the footprint width). */
export function coneBaseRadius(shape: Pick<WorkplaneShape, "baseRadius" | "width" | "size">) {
  return shape.baseRadius ?? shapeWidth(shape) / 2;
}

/** Cone top radius in model units (0 = pointy tip). */
export function coneTopRadius(shape: Pick<WorkplaneShape, "topRadius">) {
  return shape.topRadius ?? 0;
}

/** Larger of the two cone rings — drives the minimum overall footprint. */
export function coneMaxRadius(shape: Pick<WorkplaneShape, "baseRadius" | "topRadius" | "width" | "size">) {
  return Math.max(coneBaseRadius(shape), coneTopRadius(shape));
}

/**
 * Unit-frustum top scale for mesh/CSG: larger ring maps to 1, then width/depth
 * scale the overall footprint (same pattern as cylinders).
 */
export function coneUnitTopScale(shape: Pick<WorkplaneShape, "baseRadius" | "topRadius" | "width" | "size">) {
  const maxR = Math.max(0.001, coneMaxRadius(shape));
  return coneTopRadius(shape) / maxR;
}

export function coneUnitBaseScale(shape: Pick<WorkplaneShape, "baseRadius" | "topRadius" | "width" | "size">) {
  const maxR = Math.max(0.001, coneMaxRadius(shape));
  return coneBaseRadius(shape) / maxR;
}

/** @deprecated Width/depth are the overall footprint; prefer shapeWidth/shapeDepth halves. */
export function coneLocalHalfExtents(shape: Pick<WorkplaneShape, "baseRadius" | "topRadius" | "width" | "depth" | "size" | "height">) {
  return {
    x: shapeWidth(shape) / 2,
    y: shape.height / 2,
    z: shapeDepth(shape) / 2,
  };
}

/**
 * After editing top/base radii, set overall Length/Width to the circular
 * footprint of the larger ring. Use Length/Width controls to scale or squash.
 */
export function conePatchForRadii(
  _shape: Pick<WorkplaneShape, "baseRadius" | "topRadius" | "width" | "depth" | "size">,
  topRadius: number,
  baseRadius: number,
): Partial<WorkplaneShape> {
  const top = Math.max(0, topRadius);
  const base = Math.max(0.001, baseRadius);
  const footprint = Math.max(top, base) * 2;
  return {
    topRadius: top,
    baseRadius: base,
    width: footprint,
    depth: footprint,
    size: footprint,
  };
}

/**
 * Scale the whole cone when overall Length/Width change (workplane or properties).
 * Radii follow the dominant axis scale so Top/Base stay in sync with the solid.
 */
export function conePatchForFootprint(
  shape: Pick<WorkplaneShape, "baseRadius" | "topRadius" | "width" | "depth" | "size" | "height">,
  nextWidth: number,
  nextDepth: number,
): Partial<WorkplaneShape> {
  const oldW = Math.max(0.001, shapeWidth(shape));
  const oldD = Math.max(0.001, shapeDepth(shape));
  const width = Math.max(0.001, nextWidth);
  const depth = Math.max(0.001, nextDepth);
  const scaleW = width / oldW;
  const scaleD = depth / oldD;
  // Prefer the axis that actually changed (corner drags keep both equal).
  const scale = Math.abs(scaleW - 1) >= Math.abs(scaleD - 1) - 1e-12 ? scaleW : scaleD;
  return {
    width,
    depth,
    size: resizedShapeSize(width, depth),
    topRadius: coneTopRadius(shape) * scale,
    baseRadius: coneBaseRadius(shape) * scale,
  };
}

function edgeTreatmentPreserveZone(shape: WorkplaneShape): number {
  const own = Math.max(...(shape.edgeTreatments ?? []).map((feature) => feature.amount), 0);
  const child = Math.max(...(shape.groupedShapes ?? []).map(edgeTreatmentPreserveZone), 0);
  return Math.max(own, child);
}

export function preservesEdgeTreatmentSize(shape: WorkplaneShape) {
  return shape.edgeResizeMode === "preserve" && Boolean(shape.importedMesh && edgeTreatmentPreserveZone(shape) > 0);
}

function edgePreservedCoordinate(value: number, baseSize: number, targetSize: number, centered: boolean, requestedZone: number) {
  const oldMin = centered ? -baseSize / 2 : 0;
  const oldMax = oldMin + baseSize;
  const newMin = centered ? -targetSize / 2 : 0;
  const zone = Math.max(0, Math.min(requestedZone, baseSize / 2, targetSize / 2));
  if (zone <= 1e-6 || Math.abs(baseSize - targetSize) <= 1e-9) {
    return newMin + (value - oldMin) * targetSize / Math.max(0.001, baseSize);
  }
  const distanceFromMin = value - oldMin;
  const distanceFromMax = oldMax - value;
  if (distanceFromMin <= zone) return newMin + distanceFromMin;
  if (distanceFromMax <= zone) return newMin + targetSize - distanceFromMax;
  const oldInterior = Math.max(1e-6, baseSize - zone * 2);
  const newInterior = Math.max(0, targetSize - zone * 2);
  return newMin + zone + (distanceFromMin - zone) * newInterior / oldInterior;
}

export function resizedImportedCoordinates(shape: WorkplaneShape, sourcePositions: number[]) {
  const mesh = shape.importedMesh;
  if (!mesh) return [];
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  const preserve = preservesEdgeTreatmentSize(shape);
  const zone = preserve ? edgeTreatmentPreserveZone(shape) : 0;
  const positions = new Array<number>(sourcePositions.length);
  for (let index = 0; index + 2 < sourcePositions.length; index += 3) {
    if (preserve) {
      positions[index] = edgePreservedCoordinate(sourcePositions[index], mesh.baseWidth, width, true, zone);
      positions[index + 1] = edgePreservedCoordinate(sourcePositions[index + 1], mesh.baseHeight, height, false, zone);
      positions[index + 2] = edgePreservedCoordinate(sourcePositions[index + 2], mesh.baseDepth, depth, true, zone);
    } else {
      positions[index] = sourcePositions[index] * width / Math.max(0.001, mesh.baseWidth);
      positions[index + 1] = sourcePositions[index + 1] * height / Math.max(0.001, mesh.baseHeight);
      positions[index + 2] = sourcePositions[index + 2] * depth / Math.max(0.001, mesh.baseDepth);
    }
  }
  return positions;
}

export function resizedImportedMeshPositions(shape: WorkplaneShape) {
  return shape.importedMesh ? resizedImportedCoordinates(shape, shape.importedMesh.positions) : [];
}

export function resizedShapeSize(width: number, depth: number) {
  return Math.max(width, depth);
}

export function proportionalResizeScale(startWidth: number, startDepth: number, nextWidth: number, nextDepth: number) {
  const widthScale = nextWidth / Math.max(0.001, startWidth);
  const depthScale = nextDepth / Math.max(0.001, startDepth);
  if (!Number.isFinite(widthScale) || !Number.isFinite(depthScale)) {
    return 1;
  }
  return Math.abs(widthScale - 1) >= Math.abs(depthScale - 1) ? widthScale : depthScale;
}

export function fallbackSolidColor(shape: WorkplaneShape) {
  if (shape.kind === "cylinder" || shape.kind === "thread") return "#d97813";
  if (shape.kind === "sphere") return "#0098c7";
  if (shape.kind === "cone") return "#6e2786";
  if (shape.kind === "pyramid") return "#f2cf10";
  return "#d41721";
}

export function withHoleMode(shape: WorkplaneShape, hole: boolean, parentColor?: string): WorkplaneShape {
  const color = hole ? "#b8c2cc" : (parentColor ?? fallbackSolidColor(shape));
  // Boolean cut / union groups already encode solid vs hole roles on children.
  // Recursing would flip cutter children to solid (or solids to holes) and break re-cuts.
  const isBooleanGroup =
    Boolean(shape.groupedShapes?.length)
    && (
      shape.id.startsWith("grouped-manifold")
      || shape.id.startsWith("grouped-boolean")
      || shape.id.startsWith("grouped-cut")
      || Boolean(shape.importedMesh)
    );
  if (isBooleanGroup) {
    return { ...shape, hole, color };
  }
  return {
    ...shape,
    hole,
    color,
    groupedShapes: shape.groupedShapes?.map((child) => withHoleMode(child, hole, parentColor)),
  };
}

export function mirrorSign(value?: boolean) {
  return value ? -1 : 1;
}

export function mirroredAxisCount(shape: WorkplaneShape) {
  return [shape.mirrorX, shape.mirrorY, shape.mirrorZ].filter(Boolean).length;
}

export function canonicalizeShape(shape: WorkplaneShape): WorkplaneShape {
  const next: WorkplaneShape = {
    ...shape,
    rotation: cleanRotationDegrees(shape.rotation ?? 0),
    rotationX: cleanRotationDegrees(shape.rotationX ?? 0),
    rotationZ: cleanRotationDegrees(shape.rotationZ ?? 0),
    mirrorX: shape.mirrorX || undefined,
    mirrorY: shape.mirrorY || undefined,
    mirrorZ: shape.mirrorZ || undefined,
  };
  if (shape.kind === "cone") {
    // Ensure overall footprint can contain the larger ring (do not force square —
    // elliptical cones from Length/Width edits are preserved).
    const maxR = coneMaxRadius(next);
    const width = shapeWidth(next);
    const depth = shapeDepth(next);
    const minHalf = Math.min(width, depth) / 2;
    if (maxR > minHalf + 1e-6) {
      const grow = maxR / Math.max(0.001, minHalf);
      const nextWidth = width * grow;
      const nextDepth = depth * grow;
      next.width = nextWidth;
      next.depth = nextDepth;
      next.size = resizedShapeSize(nextWidth, nextDepth);
    }
  }
  if (shape.groupedShapes) {
    next.groupedShapes = shape.groupedShapes.map(canonicalizeShape);
  }
  if (shape.edgeTreatmentHistory) {
    next.edgeTreatmentHistory = shape.edgeTreatmentHistory.map((entry) => ({
      ...entry,
      before: canonicalizeShape(entry.before),
    }));
  }
  return next;
}

export function workplaneShapesEqual(a: WorkplaneShape, b: WorkplaneShape) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.color === b.color &&
    a.hole === b.hole &&
    a.x === b.x &&
    a.z === b.z &&
    a.elevation === b.elevation &&
    a.size === b.size &&
    a.width === b.width &&
    a.depth === b.depth &&
    a.height === b.height &&
    a.rotation === b.rotation &&
    a.rotationX === b.rotationX &&
    a.rotationZ === b.rotationZ &&
    a.mirrorX === b.mirrorX &&
    a.mirrorY === b.mirrorY &&
    a.mirrorZ === b.mirrorZ &&
    a.radius === b.radius &&
    a.steps === b.steps &&
    a.sides === b.sides &&
    a.bevel === b.bevel &&
    a.segments === b.segments &&
    a.topRadius === b.topRadius &&
    a.baseRadius === b.baseRadius &&
    a.leftAngle === b.leftAngle &&
    a.rightAngle === b.rightAngle &&
    a.text === b.text &&
    a.font === b.font &&
    a.importedMesh === b.importedMesh &&
    a.imagePlate === b.imagePlate &&
    a.sketchProfile === b.sketchProfile &&
    a.edgeTreatments === b.edgeTreatments &&
    a.edgeTreatmentHistory === b.edgeTreatmentHistory &&
    a.cadDisplayEdges === b.cadDisplayEdges &&
    a.cadDisplayEdgesVersion === b.cadDisplayEdgesVersion &&
    a.edgeResizeMode === b.edgeResizeMode &&
    a.cadBrep === b.cadBrep &&
    a.cadBrepFrame === b.cadBrepFrame &&
    a.cadPrimitiveFrame === b.cadPrimitiveFrame &&
    a.groupedShapes === b.groupedShapes &&
    a.groupedBaseWidth === b.groupedBaseWidth &&
    a.groupedBaseDepth === b.groupedBaseDepth &&
    a.groupedBaseHeight === b.groupedBaseHeight &&
    a.locked === b.locked &&
    a.hidden === b.hidden
  );
}

export function serializeShapesForSync(shapes: WorkplaneShape[]) {
  return JSON.stringify(shapes.map(canonicalizeShape));
}

