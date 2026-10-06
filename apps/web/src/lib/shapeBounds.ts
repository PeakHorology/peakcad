import * as THREE from "three";
import type { WorkplaneShape } from "@/types/sketchforge";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";

/**
 * World placement maths shared by the STEP writer and the export preflight.
 *
 * These live apart from `stepExport` so the inspector can reason about which cutters reach which
 * parts without pulling the OCCT kernel into the render path.
 */

const SIZE_EPS = 0.0005;

// SketchForge composes rotation as a THREE Euler in "XYZ" order, so the world
// matrix is Rx·Ry·Rz. Re-applying the same rotations about world axes through
// the origin (Z, then Y, then X) reproduces that product before the shape is
// translated off-origin. Circular cylinders/cones ignore yaw, matching the
// editor's meshYawDegrees so the exported diameter is invariant.
export function shapeYawDegrees(shape: WorkplaneShape): number {
  // "polygon" is deliberately absent: an n-gon prism is not invariant around Y, so zeroing
  // its yaw exported a hex standoff flat-to-flat when the viewport showed it point-to-point.
  const round =
    shape.kind === "cylinder"
    || shape.kind === "cone"
    || shape.kind === "tube"
    || shape.kind === "ring"
    || shape.kind === "torus"
    || shape.kind === "halfSphere";
  const circular = Math.abs(shapeWidth(shape) - shapeDepth(shape)) < SIZE_EPS;
  return round && circular ? 0 : shape.rotation;
}

export type Aabb = { min: [number, number, number]; max: [number, number, number] };

/**
 * Axis-aligned bounds of the width × height × depth box the viewport draws.
 * A stretched cylinder, sphere, cone, or polygon uses this same box as a rectangle,
 * including yaw once the footprint is no longer circular.
 */
export function worldAabb(shape: WorkplaneShape): Aabb {
  const hx = shapeWidth(shape) / 2;
  const hy = shape.height / 2;
  const hz = shapeDepth(shape) / 2;
  const center = new THREE.Vector3(shape.x, (shape.elevation ?? 0) + hy, shape.z);
  const yaw = shapeYawDegrees(shape);
  const tiltX = shape.rotationX ?? 0;
  const tiltZ = shape.rotationZ ?? 0;
  if (yaw === 0 && tiltX === 0 && tiltZ === 0) {
    return {
      min: [center.x - hx, center.y - hy, center.z - hz],
      max: [center.x + hx, center.y + hy, center.z + hz],
    };
  }
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(tiltX),
    THREE.MathUtils.degToRad(yaw),
    THREE.MathUtils.degToRad(tiltZ),
    "XYZ",
  ));
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const point = new THREE.Vector3(sx * hx, sy * hy, sz * hz).applyQuaternion(quaternion).add(center);
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.z < minZ) minZ = point.z;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
        if (point.z > maxZ) maxZ = point.z;
      }
    }
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function aabbsOverlap(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}
