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

export function worldAabb(shape: WorkplaneShape): Aabb {
  const w = shapeWidth(shape);
  const d = shapeDepth(shape);
  const h = shape.height;
  const cx = shape.x;
  const cy = (shape.elevation ?? 0) + h / 2;
  const cz = shape.z;
  const rotated = (shape.rotationX ?? 0) !== 0 || (shape.rotationZ ?? 0) !== 0 || shapeYawDegrees(shape) !== 0;
  const [hx, hy, hz] = rotated
    ? (() => {
        const r = 0.5 * Math.sqrt(w * w + h * h + d * d);
        return [r, r, r];
      })()
    : [w / 2, h / 2, d / 2];
  return { min: [cx - hx, cy - hy, cz - hz], max: [cx + hx, cy + hy, cz + hz] };
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
