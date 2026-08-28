import * as THREE from "three";
import type { WorkplaneShape } from "@/types/sketchforge";
import { cleanNearZero, MAX_SHAPE_SIDES, resizedImportedMeshPositions } from "./workplaneShapes";

const REPEAT_NUMERIC_KEYS = [
  "x",
  "z",
  "elevation",
  "size",
  "width",
  "depth",
  "height",
  "rotation",
  "rotationX",
  "rotationZ",
  "radius",
  "topRadius",
  "baseRadius",
  "bevel",
  "segments",
  "steps",
  "sides",
] as const;

export type ShapeRepeatDelta = Partial<Pick<WorkplaneShape, (typeof REPEAT_NUMERIC_KEYS)[number]>>;

export type ShapeRepeatAction = {
  delta: ShapeRepeatDelta;
  before: WorkplaneShape;
};

/** When there is no prior transform to repeat, duplicate stays in place. */
export const DEFAULT_SHAPE_REPEAT_DELTA: ShapeRepeatDelta = {};

const POSITION_LIMIT = 110;
const MIN_ELEVATION = 0;
const MAX_ELEVATION = 180;
const MIN_DIMENSION = 0.01;
const MAX_DIMENSION = 220;

function readNumeric(shape: WorkplaneShape, key: (typeof REPEAT_NUMERIC_KEYS)[number]) {
  const value = shape[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clampPosition(value: number) {
  return Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, value));
}

function clampElevation(value: number) {
  return Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, value));
}

function clampDimension(value: number) {
  return Math.max(MIN_DIMENSION, Math.min(MAX_DIMENSION, value));
}

/** Facet counts are integers, not millimetres, so they need their own bounds. */
function clampFacetCount(value: number, minimum: number) {
  return Math.max(minimum, Math.min(MAX_SHAPE_SIDES, Math.round(value)));
}

function shortestAngleDelta(before: number, after: number) {
  let delta = after - before;
  while (delta > 180) {
    delta -= 360;
  }
  while (delta < -180) {
    delta += 360;
  }
  return delta;
}

function quaternionForShape(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shape.rotation),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
}

function rotationPatchFromQuaternion(quaternion: THREE.Quaternion): Pick<WorkplaneShape, "rotation" | "rotationX" | "rotationZ"> {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    rotationX: THREE.MathUtils.radToDeg(euler.x),
    rotation: THREE.MathUtils.radToDeg(euler.y),
    rotationZ: THREE.MathUtils.radToDeg(euler.z),
  };
}

function quaternionFromRotationDelta(delta: ShapeRepeatDelta) {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(delta.rotationX ?? 0),
    THREE.MathUtils.degToRad(delta.rotation ?? 0),
    THREE.MathUtils.degToRad(delta.rotationZ ?? 0),
    "XYZ",
  );
  return new THREE.Quaternion().setFromEuler(euler);
}

function hasRotationDelta(delta: ShapeRepeatDelta) {
  return (
    (typeof delta.rotation === "number" && Math.abs(delta.rotation) > 0.0005) ||
    (typeof delta.rotationX === "number" && Math.abs(delta.rotationX) > 0.0005) ||
    (typeof delta.rotationZ === "number" && Math.abs(delta.rotationZ) > 0.0005)
  );
}

function hasRotationFields(shape: WorkplaneShape) {
  return (
    Math.abs(shape.rotation ?? 0) > 0.0005 ||
    Math.abs(shape.rotationX ?? 0) > 0.0005 ||
    Math.abs(shape.rotationZ ?? 0) > 0.0005
  );
}

function targetRotationFromBefore(before: WorkplaneShape, delta: ShapeRepeatDelta) {
  return {
    rotation: readNumeric(before, "rotation") + (delta.rotation ?? 0),
    rotationX: readNumeric(before, "rotationX") + (delta.rotationX ?? 0),
    rotationZ: readNumeric(before, "rotationZ") + (delta.rotationZ ?? 0),
  };
}

function rotationFieldsMatch(shape: WorkplaneShape, target: { rotation: number; rotationX: number; rotationZ: number }) {
  return (
    Math.abs(readNumeric(shape, "rotation") - target.rotation) <= 0.0005 &&
    Math.abs(readNumeric(shape, "rotationX") - target.rotationX) <= 0.0005 &&
    Math.abs(readNumeric(shape, "rotationZ") - target.rotationZ) <= 0.0005
  );
}

function remapImportedMeshFromWorldPositions(shape: WorkplaneShape, worldPositions: number[]): WorkplaneShape {
  const mesh = shape.importedMesh;
  if (!mesh || worldPositions.length < 9) {
    return shape;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < worldPositions.length; index += 3) {
    const x = worldPositions[index];
    const y = worldPositions[index + 1];
    const z = worldPositions[index + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  const rawWidth = Math.max(MIN_DIMENSION, maxX - minX);
  const rawDepth = Math.max(MIN_DIMENSION, maxZ - minZ);
  const rawHeight = Math.max(MIN_DIMENSION, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const centered: number[] = [];

  for (let index = 0; index < worldPositions.length; index += 3) {
    centered.push(
      worldPositions[index] - centerX,
      worldPositions[index + 1] - minY,
      worldPositions[index + 2] - centerZ,
    );
  }

  return {
    ...shape,
    kind: "mesh",
    x: clampPosition(cleanNearZero(centerX, 0.0005)),
    z: clampPosition(cleanNearZero(centerZ, 0.0005)),
    elevation: clampElevation(cleanNearZero(minY, 0.0005)),
    // Not clamped to MAX_DIMENSION: these are the numerators of the width/baseWidth scale
    // factor the mesh renders through, so capping one side and not the other would shrink
    // the geometry (a rotated 200mm plate has a genuine 282mm diagonal). The MIN_DIMENSION
    // floor is already applied to the raw extents above.
    width: rawWidth,
    depth: rawDepth,
    height: rawHeight,
    size: Math.max(rawWidth, rawDepth),
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      ...mesh,
      positions: centered,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
    },
  };
}

function rotateImportedMeshVertices(shape: WorkplaneShape, orientationQuaternion: THREE.Quaternion): WorkplaneShape {
  const localPositions = resizedImportedMeshPositions(shape);
  if (localPositions.length < 9) {
    return shape;
  }

  const pivot = new THREE.Vector3(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z);
  const worldPositions: number[] = [];

  for (let index = 0; index < localPositions.length; index += 3) {
    const world = new THREE.Vector3(
      shape.x + localPositions[index],
      (shape.elevation ?? 0) + localPositions[index + 1],
      shape.z + localPositions[index + 2],
    );
    const rotated = pivot.clone().add(world.clone().sub(pivot).applyQuaternion(orientationQuaternion));
    worldPositions.push(rotated.x, rotated.y, rotated.z);
  }

  return remapImportedMeshFromWorldPositions(shape, worldPositions);
}

function consolidateRotationFieldsIntoImportedMesh(shape: WorkplaneShape): WorkplaneShape {
  if (!shape.importedMesh || !hasRotationFields(shape)) {
    return shape;
  }

  return rotateImportedMeshVertices(
    { ...shape, rotation: 0, rotationX: 0, rotationZ: 0 },
    quaternionForShape(shape),
  );
}

function applyRotationDeltaToImportedMesh(shape: WorkplaneShape, delta: ShapeRepeatDelta): WorkplaneShape {
  const prepared = consolidateRotationFieldsIntoImportedMesh(shape);
  return rotateImportedMeshVertices(prepared, quaternionFromRotationDelta(delta));
}

function applyRotationDeltaToPrimitive(shape: WorkplaneShape, delta: ShapeRepeatDelta): WorkplaneShape {
  const deltaQuaternion = quaternionFromRotationDelta(delta);
  const nextQuaternion = deltaQuaternion.clone().multiply(quaternionForShape(shape));
  return { ...shape, ...rotationPatchFromQuaternion(nextQuaternion) };
}

function applyRotationDeltaToShape(shape: WorkplaneShape, delta: ShapeRepeatDelta): WorkplaneShape {
  if (!hasRotationDelta(delta)) {
    return shape;
  }

  if (shape.importedMesh) {
    return applyRotationDeltaToImportedMesh(shape, delta);
  }

  return applyRotationDeltaToPrimitive(shape, delta);
}

function applyRotationFromBeforeState(shape: WorkplaneShape, before: WorkplaneShape, delta: ShapeRepeatDelta): WorkplaneShape {
  if (!hasRotationDelta(delta)) {
    return shape;
  }

  const target = targetRotationFromBefore(before, delta);

  if (shape.importedMesh && !hasRotationFields(shape)) {
    return shape;
  }

  if (rotationFieldsMatch(shape, target)) {
    return shape;
  }

  return {
    ...shape,
    rotation: target.rotation,
    rotationX: target.rotationX,
    rotationZ: target.rotationZ,
  };
}

export function hasShapeRepeatDelta(delta: ShapeRepeatDelta | null | undefined) {
  if (!delta) {
    return false;
  }
  return REPEAT_NUMERIC_KEYS.some((key) => {
    const value = delta[key];
    return typeof value === "number" && Math.abs(value) > 0.0005;
  });
}

export function computeShapeRepeatDelta(before: WorkplaneShape, after: WorkplaneShape): ShapeRepeatDelta {
  const delta: ShapeRepeatDelta = {};
  REPEAT_NUMERIC_KEYS.forEach((key) => {
    const change =
      key === "rotation" || key === "rotationX" || key === "rotationZ"
        ? shortestAngleDelta(readNumeric(before, key), readNumeric(after, key))
        : readNumeric(after, key) - readNumeric(before, key);
    if (Math.abs(change) > 0.0005) {
      delta[key] = change;
    }
  });
  return delta;
}

function applyNonRotationDelta(shape: WorkplaneShape, delta: ShapeRepeatDelta): WorkplaneShape {
  const next = { ...shape };
  REPEAT_NUMERIC_KEYS.forEach((key) => {
    const offset = delta[key];
    if (typeof offset !== "number" || Math.abs(offset) <= 0.0005) {
      return;
    }
    if (key === "rotation" || key === "rotationX" || key === "rotationZ") {
      return;
    }
    const current = readNumeric(shape, key);
    if (key === "x" || key === "z") {
      next[key] = clampPosition(current + offset);
      return;
    }
    if (key === "elevation") {
      next.elevation = clampElevation(current + offset);
      return;
    }
    if (key === "sides") {
      next.sides = clampFacetCount(current + offset, 3);
      return;
    }
    if (key === "steps" || key === "segments") {
      next[key] = clampFacetCount(current + offset, 1);
      return;
    }
    next[key] = clampDimension(current + offset);
  });
  return next;
}

export function createDuplicateForRepeat(shape: WorkplaneShape, id: string): WorkplaneShape {
  const duplicate: WorkplaneShape = {
    ...shape,
    id,
  };

  if (shape.importedMesh) {
    duplicate.importedMesh = {
      ...shape.importedMesh,
      positions: [...shape.importedMesh.positions],
      normals: shape.importedMesh.normals ? [...shape.importedMesh.normals] : undefined,
    };
  }

  return duplicate;
}

export function applyRepeatActionToDuplicate(
  duplicate: WorkplaneShape,
  delta: ShapeRepeatDelta,
  options?: { before?: WorkplaneShape; incremental?: boolean },
): WorkplaneShape {
  const incremental = options?.incremental ?? false;
  const before = options?.before;

  let next = duplicate;

  if (hasRotationDelta(delta)) {
    if (incremental) {
      next = applyRotationDeltaToShape(next, delta);
    } else if (before) {
      next = applyRotationFromBeforeState(next, before, delta);
    }
  }

  next = applyNonRotationDelta(next, delta);

  return next;
}

export function applyShapeRepeatDelta(shape: WorkplaneShape, delta: ShapeRepeatDelta): WorkplaneShape {
  return applyRepeatActionToDuplicate(shape, delta, { incremental: true });
}

export function snapshotShapesForRepeat(shapes: WorkplaneShape[]) {
  return Object.fromEntries(shapes.map((shape) => [shape.id, shape]));
}
