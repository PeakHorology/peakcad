import type { ManifoldToplevel } from "manifold-3d";
import { ADDITION, Brush, Evaluator, HOLLOW_INTERSECTION, INTERSECTION, SUBTRACTION, type CSGOperation } from "three-bvh-csg";
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getManifoldRuntime } from "@/lib/manifoldRuntime";
import {
  resolveHollowCylinderSegments,
  resolveIcosahedronDetail,
  resolveShapeSides,
  resolveShapeSteps,
  setActiveDisplayQuality,
} from "@/lib/displayTessellation";
import {
  canonicalizeShape,
  cleanNearZero,
  cleanRotationDegrees,
  coneUnitBaseScale,
  coneUnitTopScale,
  fallbackSolidColor,
  mirroredAxisCount,
  mirrorSign,
  normalizeDegrees,
  preservesEdgeTreatmentSize,
  shapeDepth,
  shapeWidth,
  withHoleMode,
} from "@/lib/workplaneShapes";
import {
  type BooleanCleanupOptions,
  bumpCsgVersion,
  cleanupBooleanPositions,
  csgTreeContainsId,
  expandBooleanOperands,
  faceHoleCutDepthMm,
  faceHoleOvershootMm,
  filterCoplanarDisplayEdges,
  inferCsgOp,
  markCsgClean,
  replaceLeafInCsgTree,
  withCsgMeta,
} from "@/lib/csgTree";
import type { CsgOp } from "@/types/sketchforge";
import { bakeCadMetadataForShapeTransform, cadBrepTransformForShape } from "@/lib/cadBakeMetadata";
import { hardwareProfile } from "@/lib/desktopHardware";
import { meshDataToTransfer, runManifoldBooleanInWorker } from "@/lib/manifoldBooleanClient";
import { createLocalId } from "@/lib/localIds";
import { aabbsOverlap, shapeYawDegrees, worldAabb } from "@/lib/shapeBounds";
import { isFaceHostedSketch, resolveSketchPlane } from "@/lib/sketchPlane";
import { barrelHoleCutDepthMm } from "@/lib/sketchCylinder";
import { sphereTessellation } from "@/lib/sphereTessellation";
import { occtMeshFallbackNotice, selectionSupportsOcctCsg } from "@/lib/stepQuality";
import { axisAlignedRectFromClosedPath, circleFromClosedPath, orderedSketchPaths, shapeFromSketchProfile } from "@/lib/sketchProfileShape";
import { cloneAsGroupChild, groupedShape } from "@/lib/editorGroup";
import {
  type Cuboid,
  type MeshData,
  type Vec3,
  appendMeshData,
  boundsForCuboids,
  boundsForShapes,
  meshAabb,
  meshForShape,
  shapeAabb,
} from "@/lib/editorShapeMesh";
import { MIN_SHAPE_DIMENSION, cleanModelDimension } from "@/lib/modelDimension";
import { canSeparateThreadScrew, separateThreadScrewParts } from "@/lib/threadShape";
import type { AlignAxis, AlignHandleStatus, AlignTarget, SketchPlane, SketchProfile, WorkplaneShape } from "@/types/sketchforge";
import type { GroupBuildResult, IntersectionAttempt, IntersectionBuildResult, ManifoldSolid, ShapeUpdatePatch } from "@/components/SketchForgeEditor";

/** Face-hole cutters overshoot along the cut normal only (not XY grow). */
const POINT_TOLERANCE = 0.0001;
/** Residual-inside test inset — never baked into cutter geometry. */
const CUTTER_RESIDUAL_INSET = 0.01;
const IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT = hardwareProfile().booleanTriangleLimit;
const COPLANAR_BOOLEAN_RESCUE_DEGREES = 0.02;
const SEPARATE_PARTS_VERTEX_TOLERANCE = 0.0005;

export const ALIGN_EPSILON = 0.0005;
export const ALIGN_AXES: AlignAxis[] = ["x", "y", "z"];
export const ALIGN_TARGETS: AlignTarget[] = ["min", "center", "max"];

export function alignCoordinate(bounds: Cuboid, axis: AlignAxis, target: AlignTarget) {
  const min = axis === "x" ? bounds.minX : axis === "y" ? bounds.minY : bounds.minZ;
  const max = axis === "x" ? bounds.maxX : axis === "y" ? bounds.maxY : bounds.maxZ;
  if (target === "min") {
    return min;
  }
  if (target === "max") {
    return max;
  }
  return (min + max) / 2;
}

/** Design pivot — axis center for cones/frustums, not mesh-AABB midpoint. */
export function shapeAlignCenter(shape: WorkplaneShape, axis: AlignAxis) {
  if (axis === "x") {
    return shape.x;
  }
  if (axis === "z") {
    return shape.z;
  }
  return (shape.elevation ?? 0) + shape.height / 2;
}

export function alignCoordinateForShape(shape: WorkplaneShape, bounds: Cuboid, axis: AlignAxis, target: AlignTarget) {
  if (target === "center") {
    return shapeAlignCenter(shape, axis);
  }
  return alignCoordinate(bounds, axis, target);
}

export function referenceAlignCoordinate(
  shapes: WorkplaneShape[],
  boundsById: Map<string, Cuboid>,
  anchorId: string | null,
  axis: AlignAxis,
  target: AlignTarget,
) {
  if (target === "center") {
    if (anchorId) {
      const anchor = shapes.find((shape) => shape.id === anchorId);
      if (anchor) {
        return shapeAlignCenter(anchor, axis);
      }
    }
    if (shapes.length === 0) {
      return 0;
    }
    return shapes.reduce((sum, shape) => sum + shapeAlignCenter(shape, axis), 0) / shapes.length;
  }
  const anchorBounds = anchorId ? boundsById.get(anchorId) ?? null : null;
  const referenceBounds = anchorBounds ?? boundsForCuboids(Array.from(boundsById.values()));
  return alignCoordinate(referenceBounds, axis, target);
}

export function alignmentLabel(axis: AlignAxis, target: AlignTarget) {
  if (axis === "x") {
    return target === "min" ? "left" : target === "max" ? "right" : "center";
  }
  if (axis === "z") {
    return target === "min" ? "front" : target === "max" ? "back" : "middle";
  }
  return target === "min" ? "bottom" : target === "max" ? "top" : "middle";
}

export function alignmentStatuses(selection: WorkplaneShape[], anchorId: string | null): AlignHandleStatus[] {
  if (selection.length < 2) {
    return [];
  }

  const boundsById = new Map(selection.map((shape) => [shape.id, meshAabb(shape)]));

  return ALIGN_AXES.flatMap((axis) =>
    ALIGN_TARGETS.map((target) => {
      const targetValue = referenceAlignCoordinate(selection, boundsById, anchorId, axis, target);
      const aligned = selection.every((shape) => {
        const bounds = boundsById.get(shape.id);
        return bounds ? Math.abs(alignCoordinateForShape(shape, bounds, axis, target) - targetValue) <= ALIGN_EPSILON : true;
      });
      const wouldMove = selection.some((shape) => {
        if (shape.locked || shape.id === anchorId) {
          return false;
        }
        const bounds = boundsById.get(shape.id);
        return bounds ? Math.abs(alignCoordinateForShape(shape, bounds, axis, target) - targetValue) > ALIGN_EPSILON : false;
      });
      const label = alignmentLabel(axis, target);
      return {
        axis,
        target,
        aligned,
        disabled: !wouldMove,
        title: aligned ? `Already aligned ${label}` : `Align ${label}`,
      };
    }),
  );
}

export function alignedShapesForSelection(
  shapes: WorkplaneShape[],
  selectedIds: string[],
  selectedShapes: WorkplaneShape[],
  anchorId: string | null,
  axis: AlignAxis,
  target: AlignTarget,
) {
  const selected = new Set(selectedIds);
  const boundsById = new Map(selectedShapes.map((shape) => [shape.id, meshAabb(shape)]));
  const targetValue = referenceAlignCoordinate(selectedShapes, boundsById, anchorId, axis, target);
  let moved = 0;

  const nextShapes = shapes.map((shape) => {
    if (!selected.has(shape.id) || shape.locked || shape.id === anchorId) {
      return shape;
    }
    const bounds = boundsById.get(shape.id);
    if (!bounds) {
      return shape;
    }
    const delta = targetValue - alignCoordinateForShape(shape, bounds, axis, target);
    if (Math.abs(delta) <= ALIGN_EPSILON) {
      return shape;
    }
    moved += 1;
    if (axis === "x") {
      return { ...shape, x: cleanNearZero(Number((shape.x + delta).toFixed(4)), ALIGN_EPSILON) };
    }
    if (axis === "z") {
      return { ...shape, z: cleanNearZero(Number((shape.z + delta).toFixed(4)), ALIGN_EPSILON) };
    }
    return { ...shape, elevation: cleanNearZero(Number(((shape.elevation ?? 0) + delta).toFixed(4)), ALIGN_EPSILON) };
  });

  return { nextShapes, moved };
}

export function effectiveAlignmentAnchorId(selection: WorkplaneShape[], requestedAnchorId: string | null) {
  return selection.find((shape) => shape.locked)?.id
    ?? (requestedAnchorId && selection.some((shape) => shape.id === requestedAnchorId) ? requestedAnchorId : null);
}

export function mirrorAxisLabel(axis: AlignAxis) {
  return axis === "x" ? "left-right" : axis === "z" ? "front-back" : "top-bottom";
}

export function mirrorFlagPatch(shape: WorkplaneShape, axis: AlignAxis) {
  if (axis === "x") {
    return { mirrorX: !shape.mirrorX };
  }
  if (axis === "z") {
    return { mirrorZ: !shape.mirrorZ };
  }
  return { mirrorY: !shape.mirrorY };
}

export function reflectionMatrixForAxis(axis: AlignAxis) {
  return new THREE.Matrix4().makeScale(axis === "x" ? -1 : 1, axis === "y" ? -1 : 1, axis === "z" ? -1 : 1);
}

export function mirroredShapePatch(shape: WorkplaneShape, axis: AlignAxis, pivot: number): Partial<WorkplaneShape> {
  const centerY = (shape.elevation ?? 0) + shape.height / 2;
  const nextCenter = axis === "x" ? 2 * pivot - shape.x : axis === "z" ? 2 * pivot - shape.z : 2 * pivot - centerY;
  const worldReflection = reflectionMatrixForAxis(axis);
  const localReflection = reflectionMatrixForAxis(axis);
  const currentRotation = new THREE.Matrix4().makeRotationFromQuaternion(quaternionForShape(shape));
  const nextRotationMatrix = worldReflection.multiply(currentRotation).multiply(localReflection);
  const nextQuaternion = new THREE.Quaternion().setFromRotationMatrix(nextRotationMatrix);
  const rotationPatch = rotationFromQuaternion(nextQuaternion);
  const positionPatch =
    axis === "x"
      ? { x: cleanNearZero(Number(nextCenter.toFixed(4)), ALIGN_EPSILON) }
      : axis === "z"
        ? { z: cleanNearZero(Number(nextCenter.toFixed(4)), ALIGN_EPSILON) }
        : { elevation: cleanNearZero(Number((nextCenter - shape.height / 2).toFixed(4)), ALIGN_EPSILON) };

  return {
    ...shape,
    ...positionPatch,
    ...rotationPatch,
    ...mirrorFlagPatch(shape, axis),
  };
}

export function mirroredShapesForSelection(shapes: WorkplaneShape[], selectedIds: string[], selectedShapes: WorkplaneShape[], axis: AlignAxis) {
  if (selectedShapes.length === 0) {
    return { nextShapes: shapes, moved: 0 };
  }

  const selected = new Set(selectedIds);
  const selectionBounds = boundsForShapes(selectedShapes);
  const pivot = axis === "x" ? (selectionBounds.minX + selectionBounds.maxX) / 2 : axis === "z" ? (selectionBounds.minZ + selectionBounds.maxZ) / 2 : (selectionBounds.minY + selectionBounds.maxY) / 2;
  let moved = 0;
  const nextShapes = shapes.map((shape) => {
    if (!selected.has(shape.id) || shape.locked) {
      return shape;
    }
    moved += 1;
    return {
      ...shape,
      ...mirroredShapePatch(shape, axis, pivot),
    };
  });

  return { nextShapes, moved };
}

export function geometryFromMeshData(mesh: MeshData) {
  const positions: number[] = [];
  mesh.faces.forEach(([ai, bi, ci]) => {
    [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x, y, z);
    });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function positionsFromGeometryDrawRange(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  if (!position) {
    return [];
  }

  const positions: number[] = [];
  const drawStart = Math.max(0, Math.floor(geometry.drawRange.start || 0));
  if (geometry.index) {
    const index = geometry.index;
    const drawCount = Number.isFinite(geometry.drawRange.count) ? Math.max(0, Math.floor(geometry.drawRange.count)) : index.count - drawStart;
    const end = Math.min(index.count, drawStart + drawCount);
    for (let i = drawStart; i + 2 < end; i += 3) {
      for (let offset = 0; offset < 3; offset += 1) {
        const vertexIndex = index.getX(i + offset);
        positions.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
      }
    }
    return positions;
  }

  const drawCount = Number.isFinite(geometry.drawRange.count) ? Math.max(0, Math.floor(geometry.drawRange.count)) : position.count - drawStart;
  const end = Math.min(position.count, drawStart + drawCount);
  for (let i = drawStart; i + 2 < end; i += 3) {
    positions.push(
      position.getX(i),
      position.getY(i),
      position.getZ(i),
      position.getX(i + 1),
      position.getY(i + 1),
      position.getZ(i + 1),
      position.getX(i + 2),
      position.getY(i + 2),
      position.getZ(i + 2),
    );
  }
  return positions;
}

export function boundsForPositions(positions: number[]): Cuboid | null {
  if (positions.length < 9) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  return [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) ? { minX, maxX, minY, maxY, minZ, maxZ } : null;
}

export function quantizedPointKey([x, y, z]: Vec3, tolerance: number) {
  return [x, y, z].map((value) => Math.round(value / tolerance)).join(",");
}

export function triangleSignature(points: Vec3[], tolerance: number) {
  return points.map((point) => quantizedPointKey(point, tolerance)).sort().join("|");
}

export function addSignature(signatures: Map<string, number>, signature: string) {
  signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
}

export function meshSignatureMap(mesh: MeshData, tolerance: number) {
  const signatures = new Map<string, number>();
  mesh.faces.forEach(([ai, bi, ci]) => {
    addSignature(signatures, triangleSignature([mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]], tolerance));
  });
  return signatures;
}

export function positionsSignatureMap(positions: number[], tolerance: number) {
  const signatures = new Map<string, number>();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    addSignature(
      signatures,
      triangleSignature(
        [
          [positions[i], positions[i + 1], positions[i + 2]],
          [positions[i + 3], positions[i + 4], positions[i + 5]],
          [positions[i + 6], positions[i + 7], positions[i + 8]],
        ],
        tolerance,
      ),
    );
  }
  return signatures;
}

export function signatureMapsDiffer(a: Map<string, number>, b: Map<string, number>) {
  if (a.size !== b.size) {
    return true;
  }
  for (const [signature, count] of a) {
    if (b.get(signature) !== count) {
      return true;
    }
  }
  return false;
}

export function positionsDifferFromMeshData(positions: number[], mesh: MeshData, tolerance = 0.0005) {
  if (Math.floor(positions.length / 9) !== mesh.faces.length) {
    return true;
  }
  return signatureMapsDiffer(positionsSignatureMap(positions, tolerance), meshSignatureMap(mesh, tolerance));
}

export function geometryDiffersFromMeshData(geometry: THREE.BufferGeometry, mesh: MeshData, tolerance = 0.0005) {
  return positionsDifferFromMeshData(positionsFromGeometryDrawRange(geometry), mesh, tolerance);
}

export function sortedEdgeKey(a: Vec3, b: Vec3, tolerance: number) {
  const ak = quantizedPointKey(a, tolerance);
  const bk = quantizedPointKey(b, tolerance);
  return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}

export function edgeMidpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

export function addBoundaryEdge(edges: Map<string, { count: number; midpoint: Vec3 }>, a: Vec3, b: Vec3, tolerance: number) {
  const key = sortedEdgeKey(a, b, tolerance);
  const existing = edges.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    edges.set(key, { count: 1, midpoint: edgeMidpoint(a, b) });
  }
}

export function positionsBoundaryEdges(positions: number[], tolerance = 0.0005) {
  const edges = new Map<string, { count: number; midpoint: Vec3 }>();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a: Vec3 = [positions[i], positions[i + 1], positions[i + 2]];
    const b: Vec3 = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const c: Vec3 = [positions[i + 6], positions[i + 7], positions[i + 8]];
    addBoundaryEdge(edges, a, b, tolerance);
    addBoundaryEdge(edges, b, c, tolerance);
    addBoundaryEdge(edges, c, a, tolerance);
  }
  return Array.from(edges.values()).filter((edge) => edge.count === 1);
}

export function meshDataPositions(mesh: MeshData) {
  const positions: number[] = [];
  mesh.faces.forEach(([ai, bi, ci]) => {
    [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x, y, z);
    });
  });
  return positions;
}

export function meshFaceComponents(mesh: MeshData, tolerance = SEPARATE_PARTS_VERTEX_TOLERANCE) {
  if (mesh.faces.length === 0) return [];
  const keysByFace = mesh.faces.map((face) => face.map((vertexIndex) => quantizedPointKey(mesh.vertices[vertexIndex], tolerance)));
  const facesByVertex = new Map<string, number[]>();
  keysByFace.forEach((keys, faceIndex) => {
    keys.forEach((key) => {
      const current = facesByVertex.get(key);
      if (current) {
        current.push(faceIndex);
      } else {
        facesByVertex.set(key, [faceIndex]);
      }
    });
  });

  const visited = new Uint8Array(mesh.faces.length);
  const components: number[][] = [];
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex += 1) {
    if (visited[faceIndex]) continue;
    const component: number[] = [];
    const queue = [faceIndex];
    visited[faceIndex] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      component.push(current);
      keysByFace[current].forEach((key) => {
        const neighbors = facesByVertex.get(key);
        if (!neighbors) return;
        facesByVertex.delete(key);
        neighbors.forEach((neighbor) => {
          if (visited[neighbor]) return;
          visited[neighbor] = 1;
          queue.push(neighbor);
        });
      });
    }
    components.push(component);
  }
  return components;
}

export function meshComponentShape(source: WorkplaneShape, mesh: MeshData, faceIndices: number[], partIndex: number, totalParts: number): WorkplaneShape | null {
  const worldPositions: number[] = [];
  faceIndices.forEach((faceIndex) => {
    const face = mesh.faces[faceIndex];
    if (!face) return;
    face.forEach((vertexIndex) => {
      const vertex = mesh.vertices[vertexIndex];
      if (vertex) worldPositions.push(vertex[0], vertex[1], vertex[2]);
    });
  });

  const bounds = boundsForPositions(worldPositions);
  if (!bounds) return null;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, bounds.maxX - bounds.minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, bounds.maxY - bounds.minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, bounds.maxZ - bounds.minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions = worldPositions.map((value, index) => {
    if (index % 3 === 0) return value - centerX;
    if (index % 3 === 1) return value - bounds.minY;
    return value - centerZ;
  });

  return canonicalizeShape({
    id: createLocalId(`${source.id}-part`),
    name: totalParts > 1 ? `${source.name} Part ${partIndex + 1}` : source.name,
    kind: "mesh",
    color: source.color,
    hole: source.hole || undefined,
    x: cleanNearZero(centerX, 0.0005),
    z: cleanNearZero(centerZ, 0.0005),
    elevation: cleanNearZero(bounds.minY, 0.0005),
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    locked: false,
    hidden: source.hidden,
  });
}

export function separateMeshParts(shape: WorkplaneShape) {
  const mesh = meshForShape(shape);
  const components = meshFaceComponents(mesh).filter((component) => component.length > 0);
  if (components.length <= 1) return [];
  return components
    .map((component, index) => meshComponentShape(shape, mesh, component, index, components.length))
    .filter((part): part is WorkplaneShape => Boolean(part));
}

export function separablePartCount(shape: WorkplaneShape) {
  if (shape.locked || shape.hole) return 0;
  if (canSeparateThreadScrew(shape)) return 2;
  if (shape.groupedShapes?.length && !shape.importedMesh) return shape.groupedShapes.length;
  const mesh = meshForShape(shape);
  return meshFaceComponents(mesh).length;
}

export function separateShapeParts(shape: WorkplaneShape) {
  if (shape.locked || shape.hole) return [];
  if (canSeparateThreadScrew(shape)) {
    return separateThreadScrewParts(shape);
  }
  if (shape.groupedShapes?.length && !shape.importedMesh) {
    const restored = restoreGroupedChildren(shape);
    return restored.length > 1 ? restored : [];
  }
  return separateMeshParts(shape);
}

export function cutBoundaryEdgeCount(positions: number[], cutters: WorkplaneShape[]) {
  if (cutters.length === 0) {
    return 0;
  }
  return positionsBoundaryEdges(positions).filter((edge) => cutters.some((cutter) => pointInsideHoleShape(edge.midpoint, cutter))).length;
}

export function introducesOpenCutBoundary(resultPositions: number[], sourceMesh: MeshData, cutters: WorkplaneShape[]) {
  const resultCutBoundaries = cutBoundaryEdgeCount(resultPositions, cutters);
  if (resultCutBoundaries === 0) {
    return false;
  }

  const sourceCutBoundaries = cutBoundaryEdgeCount(meshDataPositions(sourceMesh), cutters);
  return resultCutBoundaries > sourceCutBoundaries + Math.max(4, Math.floor(sourceCutBoundaries * 0.25));
}

export function cuboidFromBox3(box: THREE.Box3): Cuboid {
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
}

export function paddedCutterShape(shape: WorkplaneShape): WorkplaneShape {
  // Exact user dimensions (matches STEP export). Face-hosted sketch holes overshoot
  // along the cut normal at bake time via faceHoleOvershootMm — never grow XY.
  return shape;
}

export function brushFromShape(shape: WorkplaneShape, cutter = false) {
  const brush = new Brush(geometryFromMeshData(meshForShape(cutter ? paddedCutterShape(shape) : shape)));
  brush.updateMatrixWorld(true);
  return brush;
}

export function disposeBrush(brush: Brush | null | undefined) {
  try {
    brush?.geometry?.dispose();
  } catch {
    // Geometry may already be disposed by the evaluator.
  }
}

/** Evaluate CSG and dispose both input brushes (three-bvh-csg returns a new brush). */
export function evaluateBrushDisposing(evaluator: Evaluator, a: Brush, b: Brush, operation: CSGOperation) {
  try {
    return evaluator.evaluate(a, b, operation);
  } finally {
    disposeBrush(a);
    disposeBrush(b);
  }
}

export function positiveCuboid(cuboid: Cuboid) {
  return cuboid.maxX - cuboid.minX > 0.01 && cuboid.maxY - cuboid.minY > 0.01 && cuboid.maxZ - cuboid.minZ > 0.01;
}

export function subtractCuboid(source: Cuboid, cutter: Cuboid): Cuboid[] {
  const overlap = {
    minX: Math.max(source.minX, cutter.minX),
    maxX: Math.min(source.maxX, cutter.maxX),
    minY: Math.max(source.minY, cutter.minY),
    maxY: Math.min(source.maxY, cutter.maxY),
    minZ: Math.max(source.minZ, cutter.minZ),
    maxZ: Math.min(source.maxZ, cutter.maxZ),
  };

  if (!positiveCuboid(overlap)) {
    return [source];
  }

  return [
    { ...source, maxX: overlap.minX },
    { ...source, minX: overlap.maxX },
    { minX: overlap.minX, maxX: overlap.maxX, minY: source.minY, maxY: source.maxY, minZ: source.minZ, maxZ: overlap.minZ },
    { minX: overlap.minX, maxX: overlap.maxX, minY: source.minY, maxY: source.maxY, minZ: overlap.maxZ, maxZ: source.maxZ },
    { minX: overlap.minX, maxX: overlap.maxX, minY: source.minY, maxY: overlap.minY, minZ: overlap.minZ, maxZ: overlap.maxZ },
    { minX: overlap.minX, maxX: overlap.maxX, minY: overlap.maxY, maxY: source.maxY, minZ: overlap.minZ, maxZ: overlap.maxZ },
  ].filter(positiveCuboid);
}

export function cuboidsOverlap(a: Cuboid, b: Cuboid) {
  return (
    Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 0.01 &&
    Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > 0.01 &&
    Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 0.01
  );
}

export function hasSolidHoleOverlap(solids: WorkplaneShape[], holes: WorkplaneShape[]) {
  const solidBounds = solids.map(meshAabb);
  const holeBounds = holes.map((hole) => meshAabb(paddedCutterShape(hole)));
  return solidBounds.some((solid) => holeBounds.some((hole) => cuboidsOverlap(solid, hole)));
}

/** Host extent along a unit-ish face normal (AABB slab) — used for through-cut defaults. */
export function shapeThicknessAlongNormal(
  shape: WorkplaneShape,
  normal: { x: number; y: number; z: number },
) {
  const bounds = meshAabb(shape);
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const nx = normal.x / length;
  const ny = normal.y / length;
  const nz = normal.z / length;
  // True slab thickness: project all AABB corners onto the normal.
  let minDot = Number.POSITIVE_INFINITY;
  let maxDot = Number.NEGATIVE_INFINITY;
  const xs = [bounds.minX, bounds.maxX];
  const ys = [bounds.minY, bounds.maxY];
  const zs = [bounds.minZ, bounds.maxZ];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const d = x * nx + y * ny + z * nz;
        minDot = Math.min(minDot, d);
        maxDot = Math.max(maxDot, d);
      }
    }
  }
  return Math.max(0.5, Number((maxDot - minDot).toFixed(2)));
}

/**
 * Distance from a face origin into the solid along -normal (outward normal).
 * Prefer this over full AABB thickness when the sketch plane sits on one skin —
 * avoids half-depth cuts when origin is near mid-slab after a bad recenter.
 */
export function shapeThicknessInwardFromFace(
  shape: WorkplaneShape,
  origin: { x: number; y: number; z: number },
  outwardNormal: { x: number; y: number; z: number },
) {
  const bounds = meshAabb(shape);
  const length = Math.hypot(outwardNormal.x, outwardNormal.y, outwardNormal.z) || 1;
  const nx = outwardNormal.x / length;
  const ny = outwardNormal.y / length;
  const nz = outwardNormal.z / length;
  let minDot = Number.POSITIVE_INFINITY;
  let maxDot = Number.NEGATIVE_INFINITY;
  const xs = [bounds.minX, bounds.maxX];
  const ys = [bounds.minY, bounds.maxY];
  const zs = [bounds.minZ, bounds.maxZ];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const d = x * nx + y * ny + z * nz;
        minDot = Math.min(minDot, d);
        maxDot = Math.max(maxDot, d);
      }
    }
  }
  const originDot = origin.x * nx + origin.y * ny + origin.z * nz;
  const slab = maxDot - minDot;
  // Outward face ≈ maxDot; inward distance from the sketch origin to the back skin.
  const inward = originDot - minDot;
  const outward = maxDot - originDot;
  // If the origin sits on the outer skin, inward ≈ full slab. If it's slightly
  // inside, still use the remaining solid behind the face.
  const thickness = Math.max(inward, outward) > slab * 0.1
    ? Math.max(inward, 0)
    : slab;
  return Math.max(0.5, Number(Math.min(slab, thickness || slab).toFixed(2)));
}

export function overlapVolume(a: Cuboid, b: Cuboid) {
  const dx = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const dy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  const dz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (dx <= 0 || dy <= 0 || dz <= 0) return 0;
  return dx * dy * dz;
}

/** Pick the best overlapping non-hole solid for a sketch cutter when hostShapeId is missing/stale. */
export function findOverlappingHostForHole(
  hole: WorkplaneShape,
  shapes: WorkplaneShape[],
  preferredId?: string | null,
): WorkplaneShape | null {
  const candidates = shapes.filter(
    (shape) => shape.id !== hole.id && !shape.hole && !shape.locked && !shape.hidden,
  );
  // Face-host links target body ids — prefer them even when AABB overlap is thin.
  if (preferredId) {
    const preferred = candidates.find((shape) => shape.id === preferredId);
    if (preferred) return preferred;
  }
  const holeBounds = meshAabb(paddedCutterShape(hole));
  let best: WorkplaneShape | null = null;
  let bestVolume = 0;
  for (const solid of candidates) {
    const volume = overlapVolume(meshAabb(solid), holeBounds);
    if (volume > bestVolume) {
      best = solid;
      bestVolume = volume;
    }
  }
  return bestVolume > 0.01 ? best : null;
}

/** Keep sketch→host links valid after Group mints new child ids / a new group id. */
export function rewriteSketchHostIds(shape: WorkplaneShape, fromHostId: string, toHostId: string): WorkplaneShape {
  const rewritePlane = (plane?: SketchPlane | null) => {
    if (!plane?.hostShapeId || plane.hostShapeId !== fromHostId) return plane ?? undefined;
    return { ...plane, hostShapeId: toHostId };
  };
  const next: WorkplaneShape = {
    ...shape,
    sketchPlane: rewritePlane(shape.sketchPlane),
    sketchProfile: shape.sketchProfile
      ? {
          ...shape.sketchProfile,
          sketchPlane: rewritePlane(shape.sketchProfile.sketchPlane),
        }
      : shape.sketchProfile,
    sketchDoc: shape.sketchDoc
      ? {
          ...shape.sketchDoc,
          plane: rewritePlane(shape.sketchDoc.plane) ?? shape.sketchDoc.plane,
        }
      : shape.sketchDoc,
    groupedShapes: shape.groupedShapes?.map((child) => rewriteSketchHostIds(child, fromHostId, toHostId)),
  };
  return next;
}

export function pointInsideCuboid(point: Vec3, cuboid: Cuboid, inset = -POINT_TOLERANCE) {
  const minX = cuboid.minX + inset;
  const maxX = cuboid.maxX - inset;
  const minY = cuboid.minY + inset;
  const maxY = cuboid.maxY - inset;
  const minZ = cuboid.minZ + inset;
  const maxZ = cuboid.maxZ - inset;
  return (
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ &&
    point[0] >= minX &&
    point[0] <= maxX &&
    point[1] >= minY &&
    point[1] <= maxY &&
    point[2] >= minZ &&
    point[2] <= maxZ
  );
}

export function pointInsideHoleShape(point: Vec3, shape: WorkplaneShape, strictInterior = false) {
  if (shape.importedMesh || shape.groupedShapes?.length) {
    return pointInsideCuboid(point, meshAabb(shape), strictInterior ? CUTTER_RESIDUAL_INSET : -POINT_TOLERANCE);
  }

  const centerY = shape.height / 2;
  const inverse = new THREE.Matrix4()
    .makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(shape.rotationX ?? 0),
        THREE.MathUtils.degToRad(shape.rotation),
        THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
        "XYZ",
      ),
    )
    .invert();
  const local = new THREE.Vector3(point[0] - shape.x, point[1] - (shape.elevation ?? 0) - centerY, point[2] - shape.z).applyMatrix4(inverse);
  const localY = local.y + centerY;
  const halfWidth = shapeWidth(shape) / 2;
  const halfDepth = shapeDepth(shape) / 2;
  if (strictInterior) {
    const yInset = Math.min(CUTTER_RESIDUAL_INSET, shape.height * 0.25);
    const xInset = Math.min(CUTTER_RESIDUAL_INSET, halfWidth * 0.25);
    const zInset = Math.min(CUTTER_RESIDUAL_INSET, halfDepth * 0.25);
    const innerHalfWidth = halfWidth - xInset;
    const innerHalfDepth = halfDepth - zInset;
    if (innerHalfWidth <= 0 || innerHalfDepth <= 0 || localY <= yInset || localY >= shape.height - yInset) {
      return false;
    }

    if (shape.kind === "cylinder" || shape.kind === "sphere" || shape.kind === "halfSphere" || shape.kind === "cone" || shape.kind === "torus" || shape.kind === "tube" || shape.kind === "ring") {
      const nx = local.x / Math.max(POINT_TOLERANCE, innerHalfWidth);
      const nz = local.z / Math.max(POINT_TOLERANCE, innerHalfDepth);
      return nx * nx + nz * nz < 1;
    }

    return Math.abs(local.x) < innerHalfWidth && Math.abs(local.z) < innerHalfDepth;
  }

  const insideHeight = localY >= -POINT_TOLERANCE && localY <= shape.height + POINT_TOLERANCE;
  if (!insideHeight) {
    return false;
  }

  if (shape.kind === "cylinder" || shape.kind === "sphere" || shape.kind === "halfSphere" || shape.kind === "cone" || shape.kind === "torus" || shape.kind === "tube" || shape.kind === "ring") {
    const nx = local.x / Math.max(POINT_TOLERANCE, halfWidth);
    const nz = local.z / Math.max(POINT_TOLERANCE, halfDepth);
    return nx * nx + nz * nz <= 1.0001;
  }

  return Math.abs(local.x) <= halfWidth + POINT_TOLERANCE && Math.abs(local.z) <= halfDepth + POINT_TOLERANCE;
}

export function triangleCentroid([a, b, c]: Vec3[]): Vec3 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

export function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

export function triangleAabb([a, b, c]: Vec3[]): Cuboid {
  return {
    minX: Math.min(a[0], b[0], c[0]),
    maxX: Math.max(a[0], b[0], c[0]),
    minY: Math.min(a[1], b[1], c[1]),
    maxY: Math.max(a[1], b[1], c[1]),
    minZ: Math.min(a[2], b[2], c[2]),
    maxZ: Math.max(a[2], b[2], c[2]),
  };
}

export function polygonAabb(points: Vec3[]): Cuboid {
  return points.reduce<Cuboid>(
    (bounds, [x, y, z]) => ({
      minX: Math.min(bounds.minX, x),
      maxX: Math.max(bounds.maxX, x),
      minY: Math.min(bounds.minY, y),
      maxY: Math.max(bounds.maxY, y),
      minZ: Math.min(bounds.minZ, z),
      maxZ: Math.max(bounds.maxZ, z),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );
}

export function cuboidsTouch(a: Cuboid, b: Cuboid, tolerance = 0.0001) {
  return (
    Math.min(a.maxX, b.maxX) + tolerance >= Math.max(a.minX, b.minX) &&
    Math.min(a.maxY, b.maxY) + tolerance >= Math.max(a.minY, b.minY) &&
    Math.min(a.maxZ, b.maxZ) + tolerance >= Math.max(a.minZ, b.minZ)
  );
}

export function triangleTouchesHoleShape(triangle: Vec3[], hole: WorkplaneShape, holeBounds: Cuboid) {
  const bounds = triangleAabb(triangle);
  if (!cuboidsTouch(bounds, holeBounds)) {
    return false;
  }

  const [a, b, c] = triangle;
  const samples = [a, b, c, triangleCentroid(triangle), midpoint(a, b), midpoint(b, c), midpoint(c, a)];
  if (samples.some((point) => pointInsideHoleShape(point, hole))) {
    return true;
  }

  // Imported STLs are often open triangle soups. A cutter can cross a small triangle
  // without catching any sampled point, so tiny overlapping triangles are clipped too.
  const triangleSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  const cutterSpan = Math.max(holeBounds.maxX - holeBounds.minX, holeBounds.maxY - holeBounds.minY, holeBounds.maxZ - holeBounds.minZ);
  return triangleSpan <= cutterSpan * 0.35;
}

export function cutterTouchedTriangleCount(mesh: MeshData, cutters: WorkplaneShape[]) {
  const cutterInfo = cutters.map((cutter) => ({ shape: cutter, bounds: meshAabb(cutter) }));
  return mesh.faces.reduce((total, [ai, bi, ci]) => {
    const triangle = [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]];
    return total + (cutterInfo.some((cutter) => triangleTouchesHoleShape(triangle, cutter.shape, cutter.bounds)) ? 1 : 0);
  }, 0);
}

export function isAxisAlignedBoxCutter(shape: WorkplaneShape) {
  const rotation = Math.abs(normalizeDegrees(shape.rotation));
  const rotationX = Math.abs(normalizeDegrees(shape.rotationX ?? 0));
  const rotationZ = Math.abs(normalizeDegrees(shape.rotationZ ?? 0));
  const straightY = rotation < 0.001 || Math.abs(rotation - 180) < 0.001 || Math.abs(rotation - 360) < 0.001;
  const straightX = rotationX < 0.001 || Math.abs(rotationX - 180) < 0.001 || Math.abs(rotationX - 360) < 0.001;
  const straightZ = rotationZ < 0.001 || Math.abs(rotationZ - 180) < 0.001 || Math.abs(rotationZ - 360) < 0.001;
  return shape.kind === "box" && straightX && straightY && straightZ;
}

export type ClipPlane = { axis: 0 | 1 | 2; value: number; keepGreater: boolean };

export function clipDistance(point: Vec3, plane: ClipPlane) {
  return plane.keepGreater ? point[plane.axis] - plane.value : plane.value - point[plane.axis];
}

export function interpolateVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function clipPolygonByPlane(polygon: Vec3[], plane: ClipPlane, keepInside: boolean) {
  if (polygon.length < 3) {
    return [];
  }

  const clipped: Vec3[] = [];
  const isKept = (distance: number) => (keepInside ? distance >= -0.0001 : distance <= 0.0001);

  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const currentDistance = clipDistance(current, plane);
    const nextDistance = clipDistance(next, plane);
    const currentKept = isKept(currentDistance);
    const nextKept = isKept(nextDistance);

    if (currentKept) {
      clipped.push(current);
    }

    if (currentKept !== nextKept) {
      const denom = currentDistance - nextDistance;
      const t = Math.abs(denom) > 0.000001 ? currentDistance / denom : 0;
      clipped.push(interpolateVec3(current, next, t));
    }
  }

  return clipped;
}

export function subtractCuboidFromPolygon(polygon: Vec3[], cuboid: Cuboid) {
  const planes: ClipPlane[] = [
    { axis: 0, value: cuboid.minX, keepGreater: true },
    { axis: 0, value: cuboid.maxX, keepGreater: false },
    { axis: 1, value: cuboid.minY, keepGreater: true },
    { axis: 1, value: cuboid.maxY, keepGreater: false },
    { axis: 2, value: cuboid.minZ, keepGreater: true },
    { axis: 2, value: cuboid.maxZ, keepGreater: false },
  ];
  let pending = [polygon];
  const outsidePieces: Vec3[][] = [];

  for (const plane of planes) {
    const nextPending: Vec3[][] = [];
    pending.forEach((piece) => {
      const outside = clipPolygonByPlane(piece, plane, false);
      if (outside.length >= 3) {
        outsidePieces.push(outside);
      }

      const inside = clipPolygonByPlane(piece, plane, true);
      if (inside.length >= 3) {
        nextPending.push(inside);
      }
    });
    pending = nextPending;
    if (pending.length === 0) {
      break;
    }
  }

  return outsidePieces;
}

export function triangulatePolygonToPositions(polygon: Vec3[], positions: number[]) {
  if (polygon.length < 3) {
    return;
  }

  const first = polygon[0];
  for (let i = 1; i < polygon.length - 1; i += 1) {
    const b = polygon[i];
    const c = polygon[i + 1];
    positions.push(first[0], first[1], first[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
}

export function addQuadToPositions(positions: number[], a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  positions.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
}

export type HoleWallSide = "minX" | "maxX" | "minZ" | "maxZ";
export type HoleWallSegment = { a: Vec3; b: Vec3; minCross: number; maxCross: number; avgY: number; key: string };

export function localCutWallBaseY(segments: HoleWallSegment[], minY: number, maxY: number) {
  const ys = segments
    .flatMap((segment) => [segment.a[1], segment.b[1], segment.avgY])
    .filter((value) => value >= minY - 0.001 && value <= maxY + 0.001)
    .sort((a, b) => a - b);
  if (ys.length < 2) {
    return minY;
  }

  let largestGap = 0;
  let gapIndex = -1;
  const minimumGap = Math.max(0.25, (maxY - minY) * 0.08);
  for (let i = 1; i < ys.length; i += 1) {
    const gap = ys[i] - ys[i - 1];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = i;
    }
  }

  if (gapIndex > 0 && largestGap > minimumGap) {
    return ys[gapIndex - 1];
  }

  return ys[Math.max(0, Math.floor(ys.length * 0.12))];
}

export function clipSegmentToRect(a: Vec3, b: Vec3, crossAxis: 0 | 1 | 2, crossMin: number, crossMax: number, minY: number, maxY: number): [Vec3, Vec3] | null {
  let t0 = 0;
  let t1 = 1;
  const clipRange = (start: number, end: number, min: number, max: number) => {
    const delta = end - start;
    if (Math.abs(delta) < 0.000001) {
      return start >= min - 0.0001 && start <= max + 0.0001;
    }
    const ta = (min - start) / delta;
    const tb = (max - start) / delta;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
    return t0 <= t1 + 0.0001;
  };

  if (!clipRange(a[crossAxis], b[crossAxis], crossMin, crossMax) || !clipRange(a[1], b[1], minY, maxY)) {
    return null;
  }

  const start = interpolateVec3(a, b, Math.max(0, Math.min(1, t0)));
  const end = interpolateVec3(a, b, Math.max(0, Math.min(1, t1)));
  return Math.hypot(start[0] - end[0], start[1] - end[1], start[2] - end[2]) > 0.01 ? [start, end] : null;
}

export function trianglePlaneSegment(triangle: Vec3[], axis: 0 | 1 | 2, plane: number): [Vec3, Vec3] | null {
  const points: Vec3[] = [];
  const addPoint = (point: Vec3) => {
    if (!points.some((existing) => Math.hypot(existing[0] - point[0], existing[1] - point[1], existing[2] - point[2]) < 0.0001)) {
      points.push(point);
    }
  };

  for (let i = 0; i < 3; i += 1) {
    const a = triangle[i];
    const b = triangle[(i + 1) % 3];
    const da = a[axis] - plane;
    const db = b[axis] - plane;

    if (Math.abs(da) <= 0.0001) {
      addPoint(a);
    }
    if (Math.abs(db) <= 0.0001) {
      addPoint(b);
    }
    if (da * db < -0.00000001) {
      addPoint(interpolateVec3(a, b, da / (da - db)));
    }
  }

  if (points.length < 2) {
    return null;
  }

  let best: [Vec3, Vec3] = [points[0], points[1]];
  let bestDistance = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const distance = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = [points[i], points[j]];
      }
    }
  }

  return bestDistance > 0.01 ? best : null;
}

export function addLocalHoleWallSegments(positions: number[], sourceMesh: MeshData, hole: Cuboid, solidBounds: Cuboid, side: HoleWallSide) {
  const axis = side === "minX" || side === "maxX" ? 0 : 2;
  const crossAxis = axis === 0 ? 2 : 0;
  const plane =
    side === "minX"
      ? Math.max(hole.minX, solidBounds.minX)
      : side === "maxX"
        ? Math.min(hole.maxX, solidBounds.maxX)
        : side === "minZ"
          ? Math.max(hole.minZ, solidBounds.minZ)
          : Math.min(hole.maxZ, solidBounds.maxZ);
  const crossMin = axis === 0 ? Math.max(hole.minZ, solidBounds.minZ) : Math.max(hole.minX, solidBounds.minX);
  const crossMax = axis === 0 ? Math.min(hole.maxZ, solidBounds.maxZ) : Math.min(hole.maxX, solidBounds.maxX);
  const minY = Math.max(hole.minY, solidBounds.minY);
  const maxY = Math.min(hole.maxY, solidBounds.maxY);
  const crossLength = crossMax - crossMin;
  if (crossLength <= 0.01 || maxY - minY <= 0.01) {
    return;
  }

  const sideTolerance = Math.max(0.0001, Math.min(hole.maxX - hole.minX, hole.maxZ - hole.minZ) * 0.0001);
  const seen = new Set<string>();
  const segmentKey = (a: Vec3, b: Vec3) => {
    const toKey = (point: Vec3) => `${Math.round(point[0] * 1000)},${Math.round(point[1] * 1000)},${Math.round(point[2] * 1000)}`;
    const ak = toKey(a);
    const bk = toKey(b);
    return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
  };
  const segments: HoleWallSegment[] = [];

  sourceMesh.faces.forEach(([ai, bi, ci]) => {
    const triangle = [sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]];
    const bounds = polygonAabb(triangle);
    const minSide = axis === 0 ? bounds.minX : bounds.minZ;
    const maxSide = axis === 0 ? bounds.maxX : bounds.maxZ;
    const minCross = crossAxis === 0 ? bounds.minX : bounds.minZ;
    const maxCross = crossAxis === 0 ? bounds.maxX : bounds.maxZ;
    if (maxSide < plane - sideTolerance || minSide > plane + sideTolerance || maxCross < crossMin || minCross > crossMax || bounds.maxY < hole.minY || bounds.minY > hole.maxY) {
      return;
    }

    const rawSegment = trianglePlaneSegment(triangle, axis, plane);
    if (!rawSegment) {
      return;
    }
    const clipped = clipSegmentToRect(rawSegment[0], rawSegment[1], crossAxis, crossMin, crossMax, minY, maxY);
    if (!clipped) {
      return;
    }
    const [a, b] = clipped;
    if (Math.max(a[1], b[1]) <= minY + 0.01) {
      return;
    }
    const key = segmentKey(a, b);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    segments.push({
      a,
      b,
      minCross: Math.min(a[crossAxis], b[crossAxis]),
      maxCross: Math.max(a[crossAxis], b[crossAxis]),
      avgY: (a[1] + b[1]) / 2,
      key,
    });
  });

  const yTolerance = Math.max(0.03, (maxY - minY) * 0.01);
  const baseY = Math.max(minY, Math.min(maxY, localCutWallBaseY(segments, minY, maxY)));
  const minimumCrossSpan = Math.max(0.04, crossLength * 0.002);

  segments.forEach((segment) => {
    if (segment.maxCross - segment.minCross < minimumCrossSpan || Math.max(segment.a[1], segment.b[1]) - baseY <= yTolerance) {
      return;
    }
    const baseA: Vec3 = [segment.a[0], baseY, segment.a[2]];
    const baseB: Vec3 = [segment.b[0], baseY, segment.b[2]];
    addQuadToPositions(positions, segment.a, segment.b, baseB, baseA);
  });
}

export function addBoxHoleInteriorFaces(positions: number[], hole: Cuboid, sourceMesh: MeshData, solidBounds: Cuboid) {
  const x0 = Math.max(hole.minX, solidBounds.minX);
  const x1 = Math.min(hole.maxX, solidBounds.maxX);
  const z0 = Math.max(hole.minZ, solidBounds.minZ);
  const z1 = Math.min(hole.maxZ, solidBounds.maxZ);
  if (x1 - x0 <= 0.01 || z1 - z0 <= 0.01) {
    return;
  }

  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "minX");
  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "maxX");
  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "minZ");
  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "maxZ");
}

export function cuboidsToMesh(name: string, cuboids: Cuboid[], centerX: number, centerZ: number, baseY = 0): MeshData {
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];

  const uniqueSorted = (values: number[]) =>
    values
      .slice()
      .sort((a, b) => a - b)
      .filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]) > 0.0001);

  const xs = uniqueSorted(cuboids.flatMap((cuboid) => [cuboid.minX, cuboid.maxX]));
  const ys = uniqueSorted(cuboids.flatMap((cuboid) => [cuboid.minY, cuboid.maxY]));
  const zs = uniqueSorted(cuboids.flatMap((cuboid) => [cuboid.minZ, cuboid.maxZ]));
  const filled = new Set<string>();
  const cellKey = (x: number, y: number, z: number) => `${x}:${y}:${z}`;

  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      for (let zi = 0; zi < zs.length - 1; zi += 1) {
        const cx = (xs[xi] + xs[xi + 1]) / 2;
        const cy = (ys[yi] + ys[yi + 1]) / 2;
        const cz = (zs[zi] + zs[zi + 1]) / 2;
        const inside = cuboids.some(
          (cuboid) =>
            cx > cuboid.minX + 0.0001 &&
            cx < cuboid.maxX - 0.0001 &&
            cy > cuboid.minY + 0.0001 &&
            cy < cuboid.maxY - 0.0001 &&
            cz > cuboid.minZ + 0.0001 &&
            cz < cuboid.maxZ - 0.0001,
        );
        if (inside) {
          filled.add(cellKey(xi, yi, zi));
        }
      }
    }
  }

  const isFilled = (x: number, y: number, z: number) => filled.has(cellKey(x, y, z));
  const addQuad = (points: Vec3[]) => {
    const offset = vertices.length;
    vertices.push(...points);
    faces.push([offset, offset + 1, offset + 2], [offset, offset + 2, offset + 3]);
  };

  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      for (let zi = 0; zi < zs.length - 1; zi += 1) {
        if (!isFilled(xi, yi, zi)) {
          continue;
        }

        const x0 = xs[xi] - centerX;
        const x1 = xs[xi + 1] - centerX;
        const y0 = ys[yi] - baseY;
        const y1 = ys[yi + 1] - baseY;
        const z0 = zs[zi] - centerZ;
        const z1 = zs[zi + 1] - centerZ;

        if (!isFilled(xi - 1, yi, zi)) addQuad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
        if (!isFilled(xi + 1, yi, zi)) addQuad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
        if (!isFilled(xi, yi - 1, zi)) addQuad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
        if (!isFilled(xi, yi + 1, zi)) addQuad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]);
        if (!isFilled(xi, yi, zi - 1)) addQuad([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]);
        if (!isFilled(xi, yi, zi + 1)) addQuad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
      }
    }
  }

  return { name, vertices, faces };
}

export function shapeIsSketchOperand(shape: WorkplaneShape) {
  return Boolean(shape.sketchFinish || shape.sketchProfile);
}

export function shapeIsSketchHoleMesh(shape: WorkplaneShape) {
  return Boolean(
    shape.hole
    && (
      shapeIsSketchOperand(shape)
      || (shape.kind === "mesh" && shape.importedMesh && (shape.sketchFinish || shape.sketchDoc || shape.sketchPlane))
    ),
  );
}

export function booleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const sourceTriangleCount = solids.reduce((total, solid) => total + meshForShape(solid).faces.length, 0);
  const sourceMesh = mergedSolidMeshData(solids);
  // Solid SUBTRACTION only — never HOLLOW_SUBTRACTION (face-punch → fractured "crazy" meshes).
  const operations: CSGOperation[] = [SUBTRACTION];

  for (const operation of operations) {
    let result: Brush | null = null;
    try {
      const evaluator = new Evaluator();
      evaluator.useGroups = false;
      evaluator.attributes = ["position", "normal"];
      (evaluator as Evaluator & { useCDTClipping?: boolean }).useCDTClipping = true;
      result = brushFromShape(solids[0]);
      result.updateMatrixWorld(true);

      solids.slice(1).forEach((solid) => {
        result = evaluateBrushDisposing(evaluator, result!, brushFromShape(solid), ADDITION);
        result.updateMatrixWorld(true);
      });

      holes.forEach((hole) => {
        result = evaluateBrushDisposing(evaluator, result!, brushFromShape(hole, true), operation);
        result.updateMatrixWorld(true);
      });

      const group = resultGeometryToMeshShape(selection, solids, result.geometry, "grouped-boolean");
      if (!group?.importedMesh) {
        continue;
      }
      // Prefer volume/bounds signals over triangle-count ±1 (tiny valid cuts are real).
      if (looksLikeUnchangedBooleanResult(group, sourceTriangleCount, true)) {
        continue;
      }
      const resultPositions = positionsFromGeometryDrawRange(result.geometry);
      if (introducesOpenCutBoundary(resultPositions, sourceMesh, holes.map(paddedCutterShape))) {
        continue;
      }
      if (!isUsableBooleanGroup(group, sourceTriangleCount, false)) {
        continue;
      }
      return group;
    } catch {
      // Try the next CSG operation.
    } finally {
      disposeBrush(result);
    }
  }

  return null;
}

export function resultGeometryToMeshShape(
  selection: WorkplaneShape[],
  solids: WorkplaneShape[],
  geometry: THREE.BufferGeometry,
  idPrefix: string,
): WorkplaneShape | null {
  const resultPositions = cleanupBooleanPositions(positionsFromGeometryDrawRange(geometry));
  const groupBounds = boundsForPositions(resultPositions);
  if (!groupBounds) {
    return null;
  }

  const centerX = (groupBounds.minX + groupBounds.maxX) / 2;
  const centerZ = (groupBounds.minZ + groupBounds.maxZ) / 2;
  const minY = groupBounds.minY;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxX - groupBounds.minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxY - groupBounds.minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxZ - groupBounds.minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions: number[] = [];

  for (let i = 0; i < resultPositions.length; i += 3) {
    positions.push(resultPositions[i] - centerX, resultPositions[i + 1] - minY, resultPositions[i + 2] - centerZ);
  }

  const firstSolid = solids[0];
  const hasHole = selection.some((shape) => shape.hole);
  const csgOp: CsgOp = hasHole
    ? "subtract"
    : idPrefix.includes("intersection")
      ? "intersect"
      : "union";

  return withCsgMeta({
    id: createLocalId(idPrefix),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  }, csgOp, 1, false);
}

export function isUsableBooleanGroup(group: WorkplaneShape | null, sourceTriangleCount = 0, enforceMinimumTriangles = true) {
  if (!group?.importedMesh) {
    return false;
  }

  const positions = group.importedMesh.positions;
  const triangleCount = group.importedMesh.triangleCount;
  const dimensions = [group.width, group.height, group.depth, group.size, group.x, group.z, group.elevation ?? 0];
  if (positions.length < 9 || triangleCount < 1 || positions.some((value) => !Number.isFinite(value)) || dimensions.some((value) => !Number.isFinite(value))) {
    return false;
  }

  const minTriangles = enforceMinimumTriangles && sourceTriangleCount > 0 ? Math.max(2, Math.min(48, Math.floor(sourceTriangleCount * 0.004))) : 2;
  return triangleCount >= minTriangles && group.width > 0.01 && group.height > 0.01 && group.depth > 0.01;
}

export function looksLikeUnchangedBooleanResult(group: WorkplaneShape | null, sourceTriangleCount: number, requireChanged = true) {
  if (!group?.importedMesh) {
    return true;
  }

  if (!requireChanged) {
    return false;
  }

  // Only treat exact same triangle count as a no-op. A ±1 change is often a real micro-cut.
  return group.importedMesh.triangleCount === sourceTriangleCount;
}

export function shapeContainsImportedMesh(shape: WorkplaneShape): boolean {
  return Boolean(shape.importedMesh) || Boolean(shape.groupedShapes?.some(shapeContainsImportedMesh));
}

export function shapeIsImportedHole(shape: WorkplaneShape): boolean {
  return Boolean(shape.hole) && shapeContainsImportedMesh(shape);
}

export function coplanarRescueCutterShape(shape: WorkplaneShape): WorkplaneShape {
  if (!shapeIsImportedHole(shape) || hasNonZeroRotation(shape)) {
    return shape;
  }
  return {
    ...shape,
    rotation: shape.rotation + COPLANAR_BOOLEAN_RESCUE_DEGREES,
    rotationZ: (shape.rotationZ ?? 0) + COPLANAR_BOOLEAN_RESCUE_DEGREES,
  };
}


export function mergedSolidMeshData(solids: WorkplaneShape[]) {
  const mergedSolidMesh: MeshData = { name: "ImportedBooleanSource", vertices: [], faces: [] };

  solids.forEach((solid) => {
    appendMeshData(mergedSolidMesh.vertices, mergedSolidMesh.faces, meshForShape(solid));
  });

  return mergedSolidMesh;
}

export function meshDataToManifoldMesh(runtime: ManifoldToplevel, mesh: MeshData) {
  const vertProperties = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach(([x, y, z], index) => {
    vertProperties[index * 3] = x;
    vertProperties[index * 3 + 1] = y;
    vertProperties[index * 3 + 2] = z;
  });

  const triVerts = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach(([a, b, c], index) => {
    triVerts[index * 3] = a;
    triVerts[index * 3 + 1] = b;
    triVerts[index * 3 + 2] = c;
  });

  const manifoldMesh = new runtime.Mesh({
    numProp: 3,
    vertProperties,
    triVerts,
    tolerance: 0.001,
  });
  manifoldMesh.merge();
  return manifoldMesh;
}

export function boxBoundsToManifold(runtime: ManifoldToplevel, bounds: Cuboid, created: ManifoldSolid[]) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const depth = bounds.maxZ - bounds.minZ;
  if (width <= 0.0001 || height <= 0.0001 || depth <= 0.0001) {
    return null;
  }

  const box = runtime.Manifold.cube([width, height, depth]);
  created.push(box);
  const moved = box.translate([bounds.minX, bounds.minY, bounds.minZ]);
  if (moved !== box && moved) {
    created.push(moved);
  }
  return moved;
}

export function trackManifold<T extends ManifoldSolid | null>(created: ManifoldSolid[], value: T): T {
  if (value) {
    created.push(value);
  }
  return value;
}

export function manifoldTransformFromMatrix(matrix: THREE.Matrix4) {
  return matrix.elements as unknown as Parameters<ManifoldSolid["transform"]>[0];
}

export function shapeRotationQuaternion(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shapeYawDegrees(shape)),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
}

export function primitiveTransformMatrix(shape: WorkplaneShape, scale: THREE.Vector3, alignRotation?: THREE.Euler) {
  const center = new THREE.Vector3(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z);
  const matrix = new THREE.Matrix4().compose(center, shapeRotationQuaternion(shape), new THREE.Vector3(1, 1, 1));
  if (alignRotation) {
    matrix.multiply(new THREE.Matrix4().makeRotationFromEuler(alignRotation));
  }
  matrix.multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
  return matrix;
}

export function transformedPrimitiveManifold(runtime: ManifoldToplevel, primitive: ManifoldSolid, matrix: THREE.Matrix4, created: ManifoldSolid[]) {
  trackManifold(created, primitive);
  return trackManifold(created, primitive.transform(manifoldTransformFromMatrix(matrix)));
}

export function primitiveManifoldForShape(runtime: ManifoldToplevel, shape: WorkplaneShape, created: ManifoldSolid[]) {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  if (width <= 0.0001 || depth <= 0.0001 || height <= 0.0001) {
    return null;
  }

  if (shape.kind === "box") {
    return transformedPrimitiveManifold(runtime, runtime.Manifold.cube(1, true), primitiveTransformMatrix(shape, new THREE.Vector3(width, height, depth)), created);
  }

  if (shape.kind === "sphere") {
    const { widthSegments } = sphereTessellation(resolveShapeSteps(shape.kind, shape.steps));
    return transformedPrimitiveManifold(
      runtime,
      runtime.Manifold.sphere(1, widthSegments),
      primitiveTransformMatrix(shape, new THREE.Vector3(width / 2, height / 2, depth / 2)),
      created,
    );
  }

  if (shape.kind === "cylinder" || shape.kind === "cone") {
    const sides = resolveShapeSides(shape.kind, shape.sides) ?? 192;
    const radiusLow = shape.kind === "cone" ? coneUnitBaseScale(shape) : 1;
    const radiusHigh = shape.kind === "cone" ? coneUnitTopScale(shape) : 1;
    return transformedPrimitiveManifold(
      runtime,
      runtime.Manifold.cylinder(1, radiusLow, radiusHigh, sides, true),
      primitiveTransformMatrix(shape, new THREE.Vector3(width / 2, depth / 2, height), new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ")),
      created,
    );
  }

  return null;
}

export function shapeToManifoldSolid(runtime: ManifoldToplevel, shape: WorkplaneShape, created: ManifoldSolid[], useBoxPrimitive = false) {
  if (useBoxPrimitive && isAxisAlignedBoxCutter(shape)) {
    return primitiveManifoldForShape(runtime, shape, created) ?? boxBoundsToManifold(runtime, meshAabb(shape), created);
  }

  const primitive = primitiveManifoldForShape(runtime, shape, created);
  if (primitive) {
    return primitive;
  }

  const mesh = meshDataToManifoldMesh(runtime, meshForShape(shape));
  try {
    return runtime.Manifold.ofMesh(mesh);
  } finally {
    disposeManifold(mesh);
  }
}

export function shapesToManifoldUnion(runtime: ManifoldToplevel, shapes: WorkplaneShape[], created: ManifoldSolid[], useBoxPrimitive = false) {
  const parts: ManifoldSolid[] = [];
  for (const shape of shapes) {
    const part = shapeToManifoldSolid(runtime, shape, created, useBoxPrimitive);
    if (!part || part.status() !== "NoError" || part.numTri() < 1) {
      disposeManifold(part);
      return null;
    }
    parts.push(part);
    created.push(part);
  }

  if (parts.length === 0) {
    return null;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  // Pairwise / tree union reduces coplanar scars on dense hubs (radial patterns).
  let level = parts;
  while (level.length > 1) {
    const next: ManifoldSolid[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const merged = runtime.Manifold.union([level[i], level[i + 1]]);
      created.push(merged);
      if (merged.status() !== "NoError" || merged.numTri() < 1) {
        return null;
      }
      next.push(merged);
    }
    level = next;
  }
  return level[0];
}

export function manifoldMeshToPositions(mesh: InstanceType<ManifoldToplevel["Mesh"]>) {
  const positions: number[] = [];
  const numProp = mesh.numProp;
  for (let i = 0; i < mesh.triVerts.length; i += 1) {
    const vertexIndex = mesh.triVerts[i];
    const offset = vertexIndex * numProp;
    positions.push(mesh.vertProperties[offset], mesh.vertProperties[offset + 1], mesh.vertProperties[offset + 2]);
  }
  return positions;
}

export function positionsInteriorTriangleCount(positions: number[], cutters: WorkplaneShape[], strictInterior = false) {
  let count = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const centroid: Vec3 = [
      (positions[i] + positions[i + 3] + positions[i + 6]) / 3,
      (positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3,
      (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3,
    ];
    if (cutters.some((cutter) => pointInsideHoleShape(centroid, cutter, strictInterior))) {
      count += 1;
    }
  }
  return count;
}

export function meshPositionsToGroupShape(
  selection: WorkplaneShape[],
  solids: WorkplaneShape[],
  positions: number[],
  idPrefix: string,
  cleanup?: BooleanCleanupOptions,
): WorkplaneShape | null {
  const cleaned = cleanupBooleanPositions(positions, undefined, cleanup);
  if (cleaned.length < 9) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < cleaned.length; i += 3) {
    const x = cleaned[i];
    const y = cleaned[i + 1];
    const z = cleaned[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return null;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const normalizedPositions: number[] = [];
  for (let i = 0; i < cleaned.length; i += 3) {
    normalizedPositions.push(cleaned[i] - centerX, cleaned[i + 1] - minY, cleaned[i + 2] - centerZ);
  }

  const firstSolid = solids[0];
  const hasHole = selection.some((shape) => shape.hole);
  const csgOp: CsgOp = hasHole ? "subtract" : idPrefix.includes("intersection") ? "intersect" : "union";
  return withCsgMeta({
    id: createLocalId(idPrefix),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions: normalizedPositions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(normalizedPositions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  }, csgOp, 1, false);
}

export function refineBooleanManifoldSolid(
  runtime: ManifoldToplevel,
  solid: ManifoldSolid,
  created: ManifoldSolid[],
): ManifoldSolid {
  // Collapse near-coplanar surfaces left by dense unions (radial hub creases).
  const candidate = solid as ManifoldSolid & {
    simplify?: (tolerance?: number) => ManifoldSolid;
    setTolerance?: (tolerance: number) => ManifoldSolid;
  };
  let current = solid;
  try {
    if (typeof candidate.setTolerance === "function") {
      const loosened = candidate.setTolerance(0.01);
      if (loosened && loosened !== current) {
        created.push(loosened);
        if (loosened.status() === "NoError" && loosened.numTri() > 0) {
          current = loosened;
        }
      }
    }
  } catch {
    // Ignore.
  }
  try {
    const simplify = (current as ManifoldSolid & { simplify?: (tolerance?: number) => ManifoldSolid }).simplify;
    if (typeof simplify === "function") {
      const simplified = simplify.call(current, 0.01);
      if (simplified && simplified !== current) {
        created.push(simplified);
        if (simplified.status() === "NoError" && simplified.numTri() > 0) {
          return simplified;
        }
      }
    }
  } catch {
    // Older Manifold builds may not expose simplify.
  }
  void runtime;
  return current;
}

export function disposeManifold(value: unknown) {
  (value as { delete?: () => void } | null)?.delete?.();
}

export async function manifoldBooleanMeshShape(selection: WorkplaneShape[], options: { requireImported?: boolean; idPrefix?: string } = {}): Promise<WorkplaneShape | null> {
  // GROUPING SAFETY NOTE FOR FUTURE AGENTS:
  // Imported STL + hole grouping stays on exact boolean first. Rotated cutters
  // are validated against their real oriented volume, not their broad AABB.
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0 || (options.requireImported !== false && !selection.some((shape) => Boolean(shape.importedMesh)))) {
    return null;
  }

  const sourceMesh = mergedSolidMeshData(solids);
  const cutterTriangleCount = holes.reduce((total, hole) => total + meshForShape(hole).faces.length, 0);
  if (sourceMesh.faces.length + cutterTriangleCount > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return null;
  }
  const cutterShapes = holes.map(paddedCutterShape);
  const residualValidationShapes = holes;
  const sourceInteriorTriangles = cutterInteriorTriangleCount(sourceMesh, cutterShapes);
  const sourceTouchedTriangles = cutterTouchedTriangleCount(sourceMesh, cutterShapes);
  const sourceCutTriangles = Math.max(sourceInteriorTriangles, sourceTouchedTriangles);

  const finishFromPositions = (positions: number[]) => {
    const resultChanged = positionsDifferFromMeshData(positions, sourceMesh);
    if (!resultChanged) {
      return null;
    }
    const hasImportedOperand = selection.some((shape) => Boolean(shape.importedMesh));
    const canUseResidualInteriorValidation =
      !hasImportedOperand && holes.every((hole) => hole.kind === "box" && !hole.importedMesh && !hole.groupedShapes?.length);
    if (canUseResidualInteriorValidation) {
      const remainingInteriorTriangles = positionsInteriorTriangleCount(positions, residualValidationShapes, true);
      if (sourceCutTriangles > 0 && remainingInteriorTriangles > Math.max(12, Math.floor(sourceCutTriangles * 0.35))) {
        return null;
      }
    }

    const group = meshPositionsToGroupShape(selection, solids, positions, options.idPrefix ?? "grouped-manifold-cut");
    const usable = isUsableBooleanGroup(group, sourceMesh.faces.length);
    const changedEnough = sourceCutTriangles > 0 || !looksLikeUnchangedBooleanResult(group, sourceMesh.faces.length, true);
    if (!usable || !changedEnough) {
      return null;
    }
    return group;
  };

  try {
    const outcome = await runManifoldBooleanInWorker({
      op: "subtract",
      solids: solids.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
      cutters: cutterShapes.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
    });
    if (outcome.status === "ok") {
      return finishFromPositions(Array.from(outcome.positions));
    }
    if (outcome.status === "superseded") {
      // A newer boolean owns the result; recomputing here would overwrite it with stale geometry.
      return null;
    }
  } catch {
    // Fall through to main-thread Manifold.
  }

  const created: ManifoldSolid[] = [];
  let result: ManifoldSolid | null = null;

  try {
    const runtime = await getManifoldRuntime();
    const solid = shapesToManifoldUnion(runtime, solids, created, true);
    const cutterSolid = shapesToManifoldUnion(runtime, holes.map(paddedCutterShape), created, true);
    if (!solid || !cutterSolid) {
      return null;
    }

    result = solid.subtract(cutterSolid);
    created.push(result);
    if (result.status() !== "NoError" || result.numTri() < 1) {
      return null;
    }
    result = refineBooleanManifoldSolid(runtime, result, created);

    const outputMesh = result.getMesh();
    const positions = manifoldMeshToPositions(outputMesh);
    return finishFromPositions(positions);
  } catch {
    return null;
  } finally {
    Array.from(new Set(created)).forEach(disposeManifold);
  }
}

export async function manifoldUnionMeshShape(selection: WorkplaneShape[]): Promise<WorkplaneShape | null> {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  // Live CSG: union any 2+ solids (primitives included) — not only selections that already have importedMesh.
  if (solids.length < 2) {
    return null;
  }

  // Tiny elevation break helps Manifold resolve dense radial overlaps; planarizeThinSolidPositions
  // collapses it again so the baked top stays a single flat face (no mid-hub ridge).
  // Skip stagger for small N, and for already-baked Groups — stacking those and
  // staggering would shift whole knurls, then the thin-solid planarize can squash them.
  const needsCoplanarBreak = solids.length >= 4 && solids.every((shape) => !shape.importedMesh);
  const solidsForUnion = needsCoplanarBreak
    ? solids.map((shape, index) => ({
      ...shape,
      elevation: (shape.elevation ?? 0) + (index % 2) * 0.01,
    }))
    : solids;
  // Only a staggered union needs the scar-removal cleanup, which moves real vertices.
  const unionCleanup: BooleanCleanupOptions = {
    staggeredUnion: solidsForUnion !== solids,
    unifyCoplanar: true,
  };

  const mergedSourceMesh = mergedSolidMeshData(solidsForUnion);
  if (mergedSourceMesh.faces.length > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return null;
  }

  try {
    const outcome = await runManifoldBooleanInWorker({
      op: "union",
      solids: solidsForUnion.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
    });
    if (outcome.status === "ok") {
      const group = meshPositionsToGroupShape(selection, solids, Array.from(outcome.positions), "grouped-manifold-union", unionCleanup);
      return isUsableBooleanGroup(group, mergedSourceMesh.faces.length, false) ? group : null;
    }
    if (outcome.status === "superseded") {
      // A newer boolean owns the result; recomputing here would overwrite it with stale geometry.
      return null;
    }
  } catch {
    // Fall through to main-thread Manifold.
  }

  const created: ManifoldSolid[] = [];
  let result: ManifoldSolid | null = null;
  try {
    const runtime = await getManifoldRuntime();
    result = shapesToManifoldUnion(runtime, solidsForUnion, created, true);
    if (!result) {
      return null;
    }
    if (result.status() !== "NoError" || result.numTri() < 1) {
      return null;
    }
    result = refineBooleanManifoldSolid(runtime, result, created);

    const outputMesh = result.getMesh();
    const positions = manifoldMeshToPositions(outputMesh);
    const group = meshPositionsToGroupShape(selection, solids, positions, "grouped-manifold-union", unionCleanup);
    return isUsableBooleanGroup(group, mergedSourceMesh.faces.length, false) ? group : null;
  } catch {
    return null;
  } finally {
    Array.from(new Set(created)).forEach(disposeManifold);
  }
}

export function asIntersectionGroup(group: WorkplaneShape): WorkplaneShape {
  return {
    ...group,
    name: "Intersection",
    hole: false,
  };
}

export async function manifoldIntersectionMeshShape(selection: WorkplaneShape[]): Promise<IntersectionAttempt> {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole && !shape.locked);
  if (solids.length === 0 || holes.length === 0) {
    return { status: "unsupported" };
  }

  const sourceTriangleCount = selection.reduce((total, shape) => total + meshForShape(shape).faces.length, 0);
  if (sourceTriangleCount > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return { status: "unsupported" };
  }

  const finishIntersection = (positions: number[]): IntersectionAttempt => {
    if (positions.length < 9) {
      return { status: "empty" };
    }
    const group = meshPositionsToGroupShape(selection, solids, positions, "grouped-manifold-intersection");
    return group && isUsableBooleanGroup(group, sourceTriangleCount, false)
      ? { status: "success", group: asIntersectionGroup(group) }
      : { status: "unsupported" };
  };

  try {
    const outcome = await runManifoldBooleanInWorker({
      op: "intersect",
      solids: solids.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
      cutters: holes.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
    });
    if (outcome.status === "ok") {
      return finishIntersection(Array.from(outcome.positions));
    }
    if (outcome.status === "superseded") {
      // A newer boolean owns the result; recomputing here would overwrite it with stale geometry.
      return { status: "unsupported" };
    }
  } catch {
    // Fall through to main-thread Manifold.
  }

  const created: ManifoldSolid[] = [];
  try {
    const runtime = await getManifoldRuntime();
    const solid = shapesToManifoldUnion(runtime, solids, created, true);
    const hole = shapesToManifoldUnion(runtime, holes, created, true);
    if (!solid || !hole) {
      return { status: "unsupported" };
    }

    const result = solid.intersect(hole);
    created.push(result);
    if (result.status() !== "NoError") {
      return { status: "unsupported" };
    }
    if (result.numTri() < 1) {
      return { status: "empty" };
    }

    const outputMesh = result.getMesh();
    const positions = manifoldMeshToPositions(outputMesh);
    return finishIntersection(positions);
  } catch {
    return { status: "unsupported" };
  } finally {
    Array.from(new Set(created)).forEach(disposeManifold);
  }
}

export function bvhIntersectionMeshShape(selection: WorkplaneShape[], operation: CSGOperation, idPrefix: string): IntersectionAttempt {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole && !shape.locked);
  if (solids.length === 0 || holes.length === 0) {
    return { status: "unsupported" };
  }

  let solidResult: Brush | null = null;
  let holeResult: Brush | null = null;
  let result: Brush | null = null;
  try {
    const evaluator = new Evaluator();
    evaluator.useGroups = false;
    evaluator.attributes = ["position", "normal"];
    (evaluator as Evaluator & { useCDTClipping: boolean }).useCDTClipping = true;

    solidResult = brushFromShape(solids[0]);
    solids.slice(1).forEach((solid) => {
      solidResult = evaluateBrushDisposing(evaluator, solidResult!, brushFromShape(solid), ADDITION);
      solidResult.updateMatrixWorld(true);
    });

    holeResult = brushFromShape(holes[0]);
    holes.slice(1).forEach((hole) => {
      holeResult = evaluateBrushDisposing(evaluator, holeResult!, brushFromShape(hole), ADDITION);
      holeResult.updateMatrixWorld(true);
    });

    result = evaluateBrushDisposing(evaluator, solidResult, holeResult, operation);
    solidResult = null;
    holeResult = null;
    result.updateMatrixWorld(true);
    if (positionsFromGeometryDrawRange(result.geometry).length < 9) {
      return { status: "empty" };
    }

    const sourceTriangleCount = solids.reduce((total, solid) => total + meshForShape(solid).faces.length, 0);
    const group = resultGeometryToMeshShape(selection, solids, result.geometry, idPrefix);
    return group && isUsableBooleanGroup(group, sourceTriangleCount, false)
      ? { status: "success", group: asIntersectionGroup(group) }
      : { status: "unsupported" };
  } catch {
    return { status: "unsupported" };
  } finally {
    disposeBrush(solidResult);
    disposeBrush(holeResult);
    disposeBrush(result);
  }
}

export async function buildIntersectionShapeFromSelection(groupable: WorkplaneShape[]): Promise<IntersectionBuildResult> {
  const booleanSelection = expandGroupsForBoolean(groupable);
  const solids = booleanSelection.filter((shape) => !shape.hole && !shape.locked);
  const holes = booleanSelection.filter((shape) => shape.hole && !shape.locked);
  if (solids.length === 0 || holes.length === 0) {
    return {
      group: null,
      empty: false,
      failureNotice: "Select at least one solid and one hole for Intersection",
    };
  }

  if (!hasSolidHoleOverlap(solids, holes)) {
    return { group: null, empty: true, failureNotice: "" };
  }

  const manifoldAttempt = await manifoldIntersectionMeshShape(booleanSelection);
  if (manifoldAttempt.status === "success") {
    return { group: manifoldAttempt.group, empty: false, failureNotice: "" };
  }
  if (manifoldAttempt.status === "empty") {
    return { group: null, empty: true, failureNotice: "" };
  }

  const exactAttempt = bvhIntersectionMeshShape(booleanSelection, INTERSECTION, "grouped-intersection");
  if (exactAttempt.status === "success") {
    return { group: exactAttempt.group, empty: false, failureNotice: "" };
  }
  const hasImportedMesh = booleanSelection.some((shape) => Boolean(shape.importedMesh));
  if (exactAttempt.status === "empty" && !hasImportedMesh) {
    return { group: null, empty: true, failureNotice: "" };
  }

  const hollowAttempt = bvhIntersectionMeshShape(booleanSelection, HOLLOW_INTERSECTION, "grouped-hollow-intersection");
  if (hollowAttempt.status === "success") {
    return { group: hollowAttempt.group, empty: false, failureNotice: "" };
  }
  if (hollowAttempt.status === "empty" || exactAttempt.status === "empty") {
    return { group: null, empty: true, failureNotice: "" };
  }

  return {
    group: null,
    empty: false,
    failureNotice: "Could not calculate this Intersection cleanly",
  };
}

export function cutterInteriorTriangleCount(mesh: MeshData, cutters: WorkplaneShape[]) {
  return mesh.faces.reduce((total, [ai, bi, ci]) => {
    const centroid = triangleCentroid([mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]]);
    return total + (cutters.some((cutter) => pointInsideHoleShape(centroid, cutter)) ? 1 : 0);
  }, 0);
}

export function geometryInteriorTriangleCount(geometry: THREE.BufferGeometry, cutters: WorkplaneShape[], strictInterior = false) {
  const positions = positionsFromGeometryDrawRange(geometry);
  let count = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const centroid: Vec3 = [
      (positions[i] + positions[i + 3] + positions[i + 6]) / 3,
      (positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3,
      (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3,
    ];
    if (cutters.some((cutter) => pointInsideHoleShape(centroid, cutter, strictInterior))) {
      count += 1;
    }
  }
  return count;
}

export function clearsImportedCutVolume(geometry: THREE.BufferGeometry, sourceInteriorTriangles: number, cutters: WorkplaneShape[]) {
  if (sourceInteriorTriangles <= 0 || cutters.length === 0) {
    return true;
  }

  const remainingInteriorTriangles = geometryInteriorTriangleCount(geometry, cutters, true);
  return remainingInteriorTriangles <= Math.max(4, Math.floor(sourceInteriorTriangles * 0.05));
}

export function importedBooleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0 || !selection.some((shape) => Boolean(shape.importedMesh))) {
    return null;
  }

  const mergedSolidMesh = mergedSolidMeshData(solids);
  const sourceTriangleCount = mergedSolidMesh.faces.length;
  const cutterTriangleCount = holes.reduce((total, hole) => total + meshForShape(hole).faces.length, 0);
  if (sourceTriangleCount + cutterTriangleCount > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return null;
  }

  const cutterShapes = holes.map(paddedCutterShape);
  const hasSketchOperand = selection.some(shapeIsSketchOperand) || holes.some(shapeIsSketchHoleMesh);
  // Sketch extrusions bake orientation into mesh positions with zero Euler — don't treat them
  // as axis-aligned STL cutters (coplanar-rescue rotations break those meshes).
  const hasStraightImportedHole = holes.some(
    (hole) => shapeIsImportedHole(hole) && !hasNonZeroRotation(hole) && !shapeIsSketchOperand(hole) && !shapeIsSketchHoleMesh(hole),
  );
  const sourceInteriorTriangles = cutterInteriorTriangleCount(mergedSolidMesh, cutterShapes);
  const sourceTouchedTriangles = cutterTouchedTriangleCount(mergedSolidMesh, cutterShapes);
  const sourceCutTriangles = Math.max(sourceInteriorTriangles, sourceTouchedTriangles);
  // Solid SUBTRACTION only — never HOLLOW_SUBTRACTION (fail closed instead of face-punch meshes).
  const baseAttempts: Array<{ operation: CSGOperation; idPrefix: string; rescueCoplanar?: boolean }> = [
    { operation: SUBTRACTION, idPrefix: "grouped-import-cut" },
  ];
  const attempts = hasStraightImportedHole
    ? [
        ...baseAttempts,
        { operation: SUBTRACTION, idPrefix: "grouped-import-rescue-cut", rescueCoplanar: true },
      ]
    : baseAttempts;

  for (const attempt of attempts) {
    let result: Brush | null = null;
    try {
      const evaluator = new Evaluator();
      evaluator.useGroups = false;
      evaluator.attributes = ["position", "normal"];
      (evaluator as Evaluator & { useCDTClipping: boolean }).useCDTClipping = true;
      result = new Brush(geometryFromMeshData(mergedSolidMesh));
      result.updateMatrixWorld(true);

      const operationHoles = attempt.rescueCoplanar ? holes.map(coplanarRescueCutterShape) : holes;
      operationHoles.forEach((hole) => {
        result = evaluateBrushDisposing(evaluator, result!, brushFromShape(hole, true), attempt.operation);
        result.updateMatrixWorld(true);
      });

      const group = resultGeometryToMeshShape(selection, solids, result.geometry, attempt.idPrefix);
      const resultPositions = positionsFromGeometryDrawRange(result.geometry);
      const resultChanged = geometryDiffersFromMeshData(result.geometry, mergedSolidMesh);
      // Face-punch / open-shell cuts look like a hole outline with diagonal fans — reject them.
      const hasOpenCutBoundary = introducesOpenCutBoundary(
        resultPositions,
        mergedSolidMesh,
        operationHoles.map(paddedCutterShape),
      );
      const volumeCleared = hasSketchOperand || clearsImportedCutVolume(result.geometry, sourceCutTriangles, operationHoles);
      if (
        isUsableBooleanGroup(group, sourceTriangleCount, !hasSketchOperand) &&
        (sourceCutTriangles > 0 ? resultChanged : !looksLikeUnchangedBooleanResult(group, sourceTriangleCount, true)) &&
        !hasOpenCutBoundary &&
        volumeCleared
      ) {
        return group;
      }
    } catch {
      // Try the next boolean operation before giving up.
    } finally {
      disposeBrush(result);
    }
  }

  return null;
}

export function boxedBooleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && shape.kind === "box" && !shape.locked);
  const holes = selection.filter((shape) => shape.hole && shape.kind === "box");
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const cutters = holes.map((hole) => shapeAabb(paddedCutterShape(hole)));
  const cuboids = solids.flatMap((solid) => cutters.reduce<Cuboid[]>((parts, cutter) => parts.flatMap((part) => subtractCuboid(part, cutter)), [shapeAabb(solid)]));
  if (cuboids.length === 0) {
    return null;
  }

  const groupBounds = boundsForCuboids(cuboids);
  const centerX = (groupBounds.minX + groupBounds.maxX) / 2;
  const centerZ = (groupBounds.minZ + groupBounds.maxZ) / 2;
  const width = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxX - groupBounds.minX);
  const minY = groupBounds.minY;
  const height = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxY - groupBounds.minY);
  const depth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxZ - groupBounds.minZ);
  const mesh = cuboidsToMesh("Group", cuboids, centerX, centerZ, minY);
  const positions = cleanupBooleanPositions(
    mesh.faces.flatMap(([ai, bi, ci]) => [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]]).flat(),
  );
  const firstSolid = solids[0];

  return withCsgMeta({
    id: createLocalId("grouped-boolean"),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  }, "subtract", 1, false);
}

export function aabbBooleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const solidBounds = solids.map(meshAabb);
  const cutterBounds = holes.map((hole) => meshAabb(paddedCutterShape(hole)));
  const cuboids = solidBounds.flatMap((solid) => cutterBounds.reduce<Cuboid[]>((parts, cutter) => parts.flatMap((part) => subtractCuboid(part, cutter)), [solid]));
  if (cuboids.length === 0) {
    return null;
  }

  const groupBounds = boundsForCuboids(cuboids);
  const centerX = (groupBounds.minX + groupBounds.maxX) / 2;
  const centerZ = (groupBounds.minZ + groupBounds.maxZ) / 2;
  const width = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxX - groupBounds.minX);
  const minY = groupBounds.minY;
  const height = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxY - groupBounds.minY);
  const depth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxZ - groupBounds.minZ);
  const mesh = cuboidsToMesh("Group", cuboids, centerX, centerZ, minY);
  const positions = mesh.faces.flatMap(([ai, bi, ci]) => [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]]).flat();
  const firstSolid = solids[0];

  return {
    id: createLocalId("grouped-boolean"),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  };
}

export function hollowClipMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection
    .filter((shape) => shape.hole)
    .map(paddedCutterShape)
    .map((shape) => ({ shape, bounds: meshAabb(shape) }));
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const sourceMesh = mergedSolidMeshData(solids);
  const sourceBounds = boundsForCuboids(solids.map(meshAabb));
  const canPlaneClip = holes.every((hole) => isAxisAlignedBoxCutter(hole.shape));
  const positions: number[] = [];
  let removedTriangles = 0;

  if (canPlaneClip) {
    sourceMesh.faces.forEach(([ai, bi, ci]) => {
      let fragments: Vec3[][] = [[sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]]];
      holes.forEach((hole) => {
        const nextFragments: Vec3[][] = [];
        fragments.forEach((fragment) => {
          if (!cuboidsTouch(polygonAabb(fragment), hole.bounds)) {
            nextFragments.push(fragment);
            return;
          }

          const clipped = subtractCuboidFromPolygon(fragment, hole.bounds);
          if (
            clipped.length !== 1 ||
            clipped[0].length !== fragment.length ||
            clipped[0].some((point, index) => point.some((value, axis) => Math.abs(value - fragment[index][axis]) > 0.0001))
          ) {
            removedTriangles += 1;
          }
          clipped.forEach((piece) => nextFragments.push(piece));
        });
        fragments = nextFragments;
      });

      fragments.forEach((fragment) => triangulatePolygonToPositions(fragment, positions));
    });

    holes.forEach((hole) => addBoxHoleInteriorFaces(positions, hole.bounds, sourceMesh, sourceBounds));
  } else {
    sourceMesh.faces.forEach(([ai, bi, ci]) => {
      const triangle = [sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]];

      if (holes.some((hole) => triangleTouchesHoleShape(triangle, hole.shape, hole.bounds))) {
        removedTriangles += 1;
        return;
      }

      triangle.forEach(([x, y, z]) => {
        positions.push(x, y, z);
      });
    });
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (removedTriangles === 0 || positions.length < 9 || ![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return null;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const normalizedPositions: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    normalizedPositions.push(positions[i] - centerX, positions[i + 1] - minY, positions[i + 2] - centerZ);
  }

  const firstSolid = solids[0];
  return {
    id: createLocalId("grouped-import-clip"),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions: normalizedPositions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(normalizedPositions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  };
}

export function cutFullyConsumesSolids(selection: WorkplaneShape[]) {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole).map(paddedCutterShape);
  if (solids.length === 0 || holes.length === 0) {
    return false;
  }

  const sourceMesh = mergedSolidMeshData(solids);
  if (sourceMesh.faces.length === 0 || !hasSolidHoleOverlap(solids, holes)) {
    return false;
  }

  return sourceMesh.faces.every(([ai, bi, ci]) => {
    const triangle = [sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]];
    const centroid: Vec3 = [
      (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
      (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3,
      (triangle[0][2] + triangle[1][2] + triangle[2][2]) / 3,
    ];
    return holes.some((hole) => pointInsideHoleShape(centroid, hole));
  });
}

export function importedSolidsOverlap(selection: WorkplaneShape[]) {
  const boxes = selection.map(worldAabb);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (aabbsOverlap(boxes[i], boxes[j])) return true;
    }
  }
  return false;
}

export function concatenatedImportedMeshShape(selection: WorkplaneShape[]) {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  if (solids.length < 2 || !solids.every((shape) => Boolean(shape.importedMesh))) return null;
  if (importedSolidsOverlap(solids)) return null;
  return mergedMeshShape(solids);
}

export function mergedMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const groupable = selection.filter((shape) => !shape.locked);
  if (groupable.length < 2) {
    return null;
  }

  // Keep imported STL/SVG groups as a baked mesh. The viewport child-group path rescales children to a wrapper box.
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];
  groupable.map(meshForShape).forEach((mesh) => {
    appendMeshData(vertices, faces, mesh);
  });

  if (vertices.length < 3 || faces.length < 1) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  vertices.forEach(([x, y, z]) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  });

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return null;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions: number[] = [];

  faces.forEach(([ai, bi, ci]) => {
    [vertices[ai], vertices[bi], vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x - centerX, y - minY, z - centerZ);
    });
  });

  const firstSolid = groupable.find((shape) => !shape.hole) ?? groupable[0];
  const holeOnly = groupable.every((shape) => shape.hole);

  return {
    id: createLocalId("grouped-mesh"),
    name: "Group",
    kind: "mesh",
    color: holeOnly ? "#b8c2cc" : firstSolid.color,
    hole: holeOnly,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: faces.length,
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: groupable.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  };
}


export function localGroupBounds(children: WorkplaneShape[]): Cuboid {
  return boundsForShapes(children);
}

export function quaternionForShape(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shape.rotation),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
}

export function rotationFromQuaternion(quaternion: THREE.Quaternion) {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    rotationX: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.x)),
    rotation: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.y)),
    rotationZ: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.z)),
  };
}

export function cleanShapePatch(patch: ShapeUpdatePatch): Partial<WorkplaneShape> {
  const { bakeTransform: _bakeTransform, repeatDeltaBefore: _repeatDeltaBefore, ...rest } = patch;
  const next = { ...rest };
  if (typeof next.rotation === "number") {
    next.rotation = cleanRotationDegrees(next.rotation, 1);
  }
  if (typeof next.rotationX === "number") {
    next.rotationX = cleanRotationDegrees(next.rotationX, 1);
  }
  if (typeof next.rotationZ === "number") {
    next.rotationZ = cleanRotationDegrees(next.rotationZ, 1);
  }
  return next;
}

export function restoreGroupedChildren(group: WorkplaneShape, options?: { preserveIds?: boolean }): WorkplaneShape[] {
  const children = group.groupedShapes ?? [];
  if (children.length === 0) {
    return [];
  }

  const bounds = localGroupBounds(children);
  const baseWidth = group.groupedBaseWidth ?? Math.max(0.001, bounds.maxX - bounds.minX);
  const baseHeight = group.groupedBaseHeight ?? Math.max(0.001, bounds.maxY - bounds.minY);
  const baseDepth = group.groupedBaseDepth ?? Math.max(0.001, bounds.maxZ - bounds.minZ);
  const sx = shapeWidth(group) / Math.max(0.001, baseWidth);
  const sy = group.height / Math.max(0.001, baseHeight);
  const sz = shapeDepth(group) / Math.max(0.001, baseDepth);
  const groupQuaternion = quaternionForShape(group);
  const groupReflection = new THREE.Matrix4().makeScale(mirrorSign(group.mirrorX), mirrorSign(group.mirrorY), mirrorSign(group.mirrorZ));
  const groupCenter = new THREE.Vector3(group.x, (group.elevation ?? 0) + group.height / 2, group.z);

  return children.map((child) => {
    const width = shapeWidth(child) * sx;
    const depth = shapeDepth(child) * sz;
    const height = child.height * sy;
    const localCenter = new THREE.Vector3(
      child.x * sx * mirrorSign(group.mirrorX),
      (((child.elevation ?? 0) + child.height / 2) * sy - group.height / 2) * mirrorSign(group.mirrorY),
      child.z * sz * mirrorSign(group.mirrorZ),
    ).applyQuaternion(groupQuaternion);
    const worldCenter = groupCenter.clone().add(localCenter);
    const childRotationMatrix = new THREE.Matrix4()
      .makeRotationFromQuaternion(groupQuaternion)
      .multiply(groupReflection)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternionForShape(child)))
      .multiply(groupReflection);
    const childRotation = rotationFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(childRotationMatrix));
    const restored: WorkplaneShape = {
      ...child,
      id: options?.preserveIds ? child.id : createLocalId(`${child.id}-ungroup`),
      x: worldCenter.x,
      z: worldCenter.z,
      elevation: worldCenter.y - height / 2,
      width,
      depth,
      height,
      size: (width + depth) / 2,
      rotation: childRotation.rotation,
      rotationX: childRotation.rotationX,
      rotationZ: childRotation.rotationZ,
      mirrorX: Boolean(child.mirrorX) !== Boolean(group.mirrorX) || undefined,
      mirrorY: Boolean(child.mirrorY) !== Boolean(group.mirrorY) || undefined,
      mirrorZ: Boolean(child.mirrorZ) !== Boolean(group.mirrorZ) || undefined,
      hidden: group.hidden ? true : child.hidden,
    };
    // Preserve each child's own solid/hole role. Applying the parent group's hole
    // flag would turn every restored solid into a hole after Hole → Group → Ungroup.
    return canonicalizeShape(restored);
  });
}

export function expandGroupsForBoolean(selection: WorkplaneShape[]): WorkplaneShape[] {
  return expandBooleanOperands(selection, (shape) => (
    restoreGroupedChildren(shape).filter((child) => !child.suppressed && !child.csg?.suppressed)
  ));
}

/** Bake one world-space solid into a group-style mesh cache (suppress → single remaining feature). */
export function bakeSolidAsGroupMesh(solid: WorkplaneShape): WorkplaneShape | null {
  const mesh = meshForShape(solid);
  if (!mesh.faces.length) return null;
  const positions: number[] = [];
  for (const face of mesh.faces) {
    const a = mesh.vertices[face[0]];
    const b = mesh.vertices[face[1]];
    const c = mesh.vertices[face[2]];
    if (!a || !b || !c) continue;
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  return meshPositionsToGroupShape([solid], [solid], positions, "grouped-single-feature");
}

/**
 * Evaluate a single CSG op on world-space operands without flattening nested bodies.
 * Nested evaluated children must already carry a fresh mesh cache.
 */
export async function evaluateCsgOpOnOperands(
  operands: WorkplaneShape[],
  op: CsgOp,
  options?: { skipOcct?: boolean },
): Promise<WorkplaneShape | null> {
  const selection = operands
    .filter((shape) => !shape.suppressed && !shape.csg?.suppressed && !shape.locked)
    .map((shape) => (shape.hole ? rebuildSketchHoleCutterIfPossible(shape) : shape));
  if (selection.length === 0) return null;
  const skipOcct = Boolean(options?.skipOcct);

  if (op === "subtract") {
    const hasSolid = selection.some((shape) => !shape.hole);
    const hasHole = selection.some((shape) => shape.hole);
    if (!hasSolid || !hasHole) {
      // Suppressing all holes (or all solids) should leave the remaining active solids.
      const solids = selection.filter((shape) => !shape.hole);
      if (solids.length === 1) return bakeSolidAsGroupMesh(solids[0]);
      if (solids.length >= 2) {
        return (
          (skipOcct ? null : await occtBooleanMeshShape(solids, "union"))
          ?? await manifoldUnionMeshShape(solids)
          ?? concatenatedImportedMeshShape(solids)
          ?? bakeSolidAsGroupMesh(solids[0])
        );
      }
      return null;
    }
    return (
      (skipOcct ? null : await occtBooleanMeshShape(selection, "subtract"))
      ?? await manifoldBooleanMeshShape(selection, { requireImported: false })
      ?? (canUseBoxBoolean(selection) ? boxedBooleanMeshShape(selection) : null)
      ?? booleanMeshShape(selection)
    );
  }

  if (op === "union") {
    const solids = selection.filter((shape) => !shape.hole);
    if (solids.length < 2) {
      return solids[0] ? bakeSolidAsGroupMesh(solids[0]) : null;
    }
    return (
      (skipOcct ? null : await occtBooleanMeshShape(solids, "union"))
      ?? await manifoldUnionMeshShape(solids)
      ?? concatenatedImportedMeshShape(solids)
      ?? bakeSolidAsGroupMesh(solids[0])
    );
  }

  if (op === "intersect") {
    if (!skipOcct) {
      const occt = await occtBooleanMeshShape(selection, "intersect");
      if (occt) return occt;
    }
    const attempt = await manifoldIntersectionMeshShape(selection);
    if (attempt.status === "success") return attempt.group;
    return null;
  }

  return null;
}

/** Exact OCCT boolean when every operand has B-Rep; Manifold remains the progressive fallback. */
export async function occtBooleanMeshShape(
  selection: WorkplaneShape[],
  op: "subtract" | "union" | "intersect",
): Promise<WorkplaneShape | null> {
  if (!selectionSupportsOcctCsg(selection)) return null;
  try {
    const { booleanResultLooksExploded, evaluateOcctBooleanOnWorldShapes } = await import("@/lib/stepExport");
    const result = await evaluateOcctBooleanOnWorldShapes(selection, op);
    if (!result) return null;
    const solids = selection.filter((shape) => !shape.hole);
    if (solids.length === 0) return null;
    const group = meshPositionsToGroupShape(
      selection,
      solids,
      result.positions,
      `occt-${op}`,
      op === "union" ? { unifyCoplanar: true } : undefined,
    );
    if (!group?.importedMesh) return null;
    const expected = boundsForShapes(selection);
    if (booleanResultLooksExploded(
      {
        width: expected.maxX - expected.minX,
        height: expected.maxY - expected.minY,
        depth: expected.maxZ - expected.minZ,
      },
      { width: group.width, height: group.height, depth: group.depth },
    )) {
      return null;
    }
    const origin = { x: group.x, y: group.elevation ?? 0, z: group.z };
    const cadDisplayEdges = filterCoplanarDisplayEdges(
      (result.displayEdges ?? [])
        .map((edge) => ({
          points: edge.points.map((value, index) => {
            if (index % 3 === 0) return value - origin.x;
            if (index % 3 === 1) return value - origin.y;
            return value - origin.z;
          }),
        }))
        .filter((edge) => edge.points.length >= 6),
      group.importedMesh.positions,
    );
    return {
      ...group,
      cadDisplayEdges: cadDisplayEdges.length > 0 ? cadDisplayEdges : undefined,
      cadDisplayEdgesVersion: cadDisplayEdges.length > 0 ? 2 : undefined,
      importedMesh: {
        ...group.importedMesh,
        brepStep: result.brepStep,
        sourceFormat: "step",
      },
    };
  } catch {
    return null;
  }
}

export function expandGroupsForBoxBoolean(selection: WorkplaneShape[]): WorkplaneShape[] {
  return expandBooleanOperands(selection, (shape) => (
    restoreGroupedChildren(shape).filter((child) => !child.suppressed && !child.csg?.suppressed)
  ));
}

/** Re-bake simple rect/circle sketch holes so Group uses CylinderGeometry/BoxGeometry cutters
 *  even when the live shape still has an older ExtrudeGeometry soup. */
export function rebuildSketchHoleCutterIfPossible(shape: WorkplaneShape): WorkplaneShape {
  if (!shape.hole || !shape.sketchProfile) {
    return shape;
  }
  const closedPaths = orderedSketchPaths(shape.sketchProfile).filter((path) => path.closed);
  if (closedPaths.length !== 1) {
    return shape;
  }
  if (!axisAlignedRectFromClosedPath(closedPaths[0]) && !circleFromClosedPath(closedPaths[0])) {
    return shape;
  }
  const plane = resolveSketchPlane(shape.sketchPlane ?? shape.sketchProfile.sketchPlane);
  const originalBounds = meshAabb(shape);
  const normal = plane.normal;
  const extentAlongNormal =
    Math.abs(normal.x) * (originalBounds.maxX - originalBounds.minX)
    + Math.abs(normal.y) * (originalBounds.maxY - originalBounds.minY)
    + Math.abs(normal.z) * (originalBounds.maxZ - originalBounds.minZ);
  const faceHosted = isFaceHostedSketch(plane, shape.sketchProfile.faceReferenceLoops);
  const hasMeshExtent = Boolean(shape.importedMesh && shape.importedMesh.positions.length >= 9);
  // Face-hole `height` / mesh extent is already the full through-all cutter length
  // (host thickness + overshoot past BOTH skins). Do not subtract overshoot again —
  // that shortened remesh/redo cutters to a coplanar far face (blind-looking holes).
  const extrudeHeight = Math.max(
    0.5,
    shape.height,
    hasMeshExtent ? extentAlongNormal : 0,
  );
  const rebuilt = shapeFromSketchProfile(
    {
      ...shape.sketchProfile,
      sketchPlane: plane,
      faceReferenceLoops: shape.sketchProfile.faceReferenceLoops,
    },
    extrudeHeight,
    {
      ...shape,
      hole: true,
      sketchPlane: plane,
    },
    { cutIntoFace: faceHosted },
  );
  if (!rebuilt) {
    return shape;
  }
  // Never teleport a face-hole cutter onto the workplane — that makes Group "succeed"
  // with an uncut solid (no AABB overlap → boolean no-op).
  if (!cuboidsOverlap(originalBounds, meshAabb(rebuilt))) {
    return shape;
  }
  return rebuilt;
}

export function canUseBoxBoolean(selection: WorkplaneShape[]) {
  return selection.every(isAxisAlignedBoxCutter);
}

export function hasNonZeroRotation(shape: WorkplaneShape) {
  const rotation = Math.abs(normalizeDegrees(shape.rotation));
  const rotationX = Math.abs(normalizeDegrees(shape.rotationX ?? 0));
  const rotationZ = Math.abs(normalizeDegrees(shape.rotationZ ?? 0));
  return [rotation, rotationX, rotationZ].some((value) => value > 0.001 && Math.abs(value - 360) > 0.001);
}

export async function buildGroupedShapeFromSelection(groupable: WorkplaneShape[]): Promise<GroupBuildResult> {
  const booleanSelection = expandGroupsForBoolean(groupable).map((shape) => (
    shape.hole ? rebuildSketchHoleCutterIfPossible(shape) : shape
  ));
  const hasSolid = booleanSelection.some((shape) => !shape.hole);
  const hasHole = booleanSelection.some((shape) => shape.hole);
  const hasImportedMesh = booleanSelection.some((shape) => Boolean(shape.importedMesh));
  const boxBooleanSelection = hasSolid && hasHole
    ? expandGroupsForBoxBoolean(groupable).map((shape) => (shape.hole ? rebuildSketchHoleCutterIfPossible(shape) : shape))
    : [];
  // Mesh boolean while editing. Exact fuse is rebuilt from the recipe at STEP export.
  const occtEligible = false;
  const occtGroup = null;
  const manifoldCutGroup = !occtGroup && hasSolid && hasHole
    ? await manifoldBooleanMeshShape(booleanSelection, { requireImported: false })
    : null;
  const cleanBoxGroup = !occtGroup && !manifoldCutGroup && canUseBoxBoolean(boxBooleanSelection)
    ? boxedBooleanMeshShape(boxBooleanSelection)
    : null;
  const manifoldUnionGroup = !occtGroup && hasSolid && !hasHole
    && booleanSelection.filter((shape) => !shape.hole && !shape.locked).length >= 2
    ? await manifoldUnionMeshShape(booleanSelection)
    : null;
  const exactImportedGroup = !occtGroup && hasImportedMesh && hasSolid && hasHole
    ? manifoldCutGroup ?? importedBooleanMeshShape(booleanSelection)
    : null;
  const bvhCutGroup = hasSolid && hasHole && !occtGroup && !manifoldCutGroup && !cleanBoxGroup
    ? booleanMeshShape(booleanSelection)
    : null;
  const cutGroup = exactImportedGroup ?? bvhCutGroup;
  const group = occtGroup ?? (hasSolid && hasHole
    ? manifoldCutGroup ??
      cleanBoxGroup ??
      cutGroup
    : manifoldUnionGroup ??
      concatenatedImportedMeshShape(booleanSelection) ??
      groupedShape(groupable));
  // Keep the user's selected operands as the CSG tree, not flattened boolean
  // leaves, so Ungroup peels one Group at a time.
  const nestedOperands = groupable.filter((shape) => !shape.locked);
  const nestedGroup = group && nestedOperands.length >= 2
    ? {
        ...group,
        groupedShapes: nestedOperands.map((shape) => cloneAsGroupChild(shape, group.x, group.z, group.elevation ?? 0)),
      }
    : group;
  const withMeta = nestedGroup
    ? markCsgClean(withCsgMeta(
      nestedGroup,
      nestedGroup.csg?.op ?? inferCsgOp(nestedGroup) ?? (hasHole ? "subtract" : hasSolid ? "union" : "assemble"),
      nestedGroup.csg?.version ?? 1,
      false,
    ))
    : null;
  const consumed = !withMeta && hasSolid && hasHole && cutFullyConsumesSolids(booleanSelection);
  const usedMeshFallback = Boolean(withMeta && occtEligible && !occtGroup);
  return {
    group: withMeta,
    booleanSelection,
    hasSolid,
    hasHole,
    hasImportedMesh,
    consumed,
    failureNotice: hasSolid && hasHole
      ? (hasImportedMesh ? "Could not cut with this hole mesh" : "Could not cut this selection")
      : "Could not group this selection",
    qualityNotice: occtMeshFallbackNotice({
      occtEligible: usedMeshFallback,
      resultHasExactBrep: false,
    }),
  };
}

/** Re-evaluate a CSG body from world-space children; preserves body + child ids. */
export async function remeshCsgGroupFromWorldChildren(
  body: WorkplaneShape,
  worldChildren: WorkplaneShape[],
  options?: { skipOcct?: boolean },
): Promise<WorkplaneShape | null> {
  if (worldChildren.length === 0) return null;
  const op = body.csg?.op ?? inferCsgOp(body);
  if (!op) return body;

  // Feature tree keeps suppressed children; only active ones feed the boolean/display mesh.
  const activeChildren = worldChildren.filter(
    (child) => !child.suppressed && !child.csg?.suppressed && !child.locked,
  );

  if (op === "assemble") {
    // No boolean cache — viewport renders live children and already skips suppressed ones.
    return markCsgClean({
      ...body,
      importedMesh: undefined,
      groupedShapes: body.groupedShapes,
      csg: {
        op: "assemble",
        version: (body.csg?.version ?? 0) + 1,
        suppressed: body.csg?.suppressed,
      },
    });
  }

  if (activeChildren.length === 0) {
    return markCsgClean({
      ...body,
      importedMesh: undefined,
      groupedShapes: body.groupedShapes,
      csg: {
        op,
        version: (body.csg?.version ?? 0) + 1,
        suppressed: body.csg?.suppressed,
      },
    });
  }

  // A body with only hole features left has nothing to display.
  if (activeChildren.every((child) => child.hole)) {
    return markCsgClean({
      ...body,
      importedMesh: undefined,
      groupedShapes: body.groupedShapes,
      csg: {
        op,
        version: (body.csg?.version ?? 0) + 1,
        suppressed: body.csg?.suppressed,
      },
    });
  }

  // Mesh operands only. STEP export fuses the recipe; do not bake B-Rep into the edit session.
  const bakedChildren = activeChildren;
  let result = await evaluateCsgOpOnOperands(bakedChildren, op, { ...options, skipOcct: true });
  if (!result?.importedMesh) {
    const flat = await buildGroupedShapeFromSelection(bakedChildren);
    result = flat.group;
  }
  if (!result?.importedMesh) {
    const sole = bakedChildren.find((child) => !child.hole) ?? bakedChildren[0];
    result = bakeSolidAsGroupMesh(sole);
  }
  if (!result?.importedMesh) return null;

  const g = result;
  return markCsgClean({
    ...g,
    id: body.id,
    name: body.name,
    color: body.color,
    locked: body.locked,
    hidden: body.hidden,
    // Keep recipes so the editor can re-apply fillet/chamfer after remesh.
    // Geometry (cadBrep / display edges) is invalid until re-applied.
    edgeTreatments: body.edgeTreatments,
    edgeTreatmentHistory: body.edgeTreatmentHistory,
    edgeResizeMode: body.edgeResizeMode,
    cadBrep: undefined,
    cadBrepFrame: undefined,
    cadDisplayEdges: undefined,
    cadDisplayEdgesVersion: undefined,
    // Keep suppressed features in the tree even though they were not remeshed in.
    groupedShapes: worldChildren.map((child) =>
      cloneAsGroupChild(child, g.x, g.z, g.elevation ?? 0, true),
    ),
    csg: {
      op: g.csg?.op ?? op,
      version: (body.csg?.version ?? 0) + 1,
      suppressed: body.csg?.suppressed,
    },
  });
}

/**
 * Bottom-up remesh: nested evaluated children first, then this node.
 * Preserves nested op structure (no flatten).
 */
export async function remeshCsgGroup(group: WorkplaneShape, options?: { skipOcct?: boolean }): Promise<WorkplaneShape | null> {
  if (!group.groupedShapes?.length) return null;
  if (group.csg?.suppressed) return group;
  const op = group.csg?.op ?? inferCsgOp(group);
  if (!op) return group;

  const nextChildren: WorkplaneShape[] = [];
  for (const child of group.groupedShapes) {
    if (child.suppressed || child.csg?.suppressed) {
      nextChildren.push(child);
      continue;
    }
    const childOp = child.csg?.op ?? inferCsgOp(child);
    if (child.groupedShapes?.length && childOp && childOp !== "assemble") {
      const remeshedChild = await remeshCsgGroup(child, options);
      nextChildren.push(remeshedChild ?? child);
    } else {
      nextChildren.push(child);
    }
  }

  const withChildren = { ...group, groupedShapes: nextChildren };
  const worldChildren = restoreGroupedChildren(withChildren, { preserveIds: true });
  return remeshCsgGroupFromWorldChildren(withChildren, worldChildren, options);
}

/** Replace a leaf (world pose) under a CSG body and remesh; fail closed keeps last good mesh. */
export async function updateCsgLeafAndRemesh(
  body: WorkplaneShape,
  leafId: string,
  nextLeafWorld: WorkplaneShape,
): Promise<{ body: WorkplaneShape; remeshed: boolean }> {
  const worldChildren = restoreGroupedChildren(body, { preserveIds: true });
  let found = false;
  const nextChildren: WorkplaneShape[] = [];
  for (const child of worldChildren) {
    if (child.id === leafId) {
      found = true;
      nextChildren.push({ ...nextLeafWorld, id: leafId });
      continue;
    }
    if (child.groupedShapes?.length && csgTreeContainsId(child, leafId)) {
      const nested = await updateCsgLeafAndRemesh(child, leafId, nextLeafWorld);
      nextChildren.push(nested.body);
      found = true;
      continue;
    }
    nextChildren.push(child);
  }
  if (!found) {
    const dirty = replaceLeafInCsgTree(
      body,
      leafId,
      cloneAsGroupChild({ ...nextLeafWorld, id: leafId }, body.x, body.z, body.elevation ?? 0, true),
    );
    const remeshed = await remeshCsgGroup(dirty);
    if (!remeshed) {
      return {
        body: {
          ...dirty,
          importedMesh: body.importedMesh,
          csg: { ...(dirty.csg ?? { op: inferCsgOp(dirty) ?? "union", version: 1 }), dirty: true },
        },
        remeshed: false,
      };
    }
    return { body: remeshed, remeshed: true };
  }
  const remeshed = await remeshCsgGroupFromWorldChildren(body, nextChildren);
  if (!remeshed) {
    const dirtyChildren = nextChildren.map((child) =>
      cloneAsGroupChild(child, body.x, body.z, body.elevation ?? 0, true),
    );
    return {
      body: {
        ...body,
        groupedShapes: dirtyChildren,
        csg: {
          ...(body.csg ?? { op: inferCsgOp(body) ?? "union", version: 1 }),
          dirty: true,
          version: (body.csg?.version ?? 0) + 1,
        },
      },
      remeshed: false,
    };
  }
  return { body: remeshed, remeshed: true };
}
