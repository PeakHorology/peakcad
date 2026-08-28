import * as THREE from "three";
import type { SketchCylinderSurface, SketchPlane } from "@/types/sketchforge";

export type SketchVec3 = { x: number; y: number; z: number };

const EPS = 1e-8;

function vec(x: number, y: number, z: number): SketchVec3 {
  return { x, y, z };
}

function fromThree(v: THREE.Vector3): SketchVec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function toThree(v: SketchVec3) {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function normalizeVec(v: SketchVec3): SketchVec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < EPS) return vec(0, 1, 0);
  return vec(v.x / length, v.y / length, v.z / length);
}

function cross(a: SketchVec3, b: SketchVec3): SketchVec3 {
  return vec(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

function dot(a: SketchVec3, b: SketchVec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sub(a: SketchVec3, b: SketchVec3): SketchVec3 {
  return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Default global workplane: XZ plate, +Y up. */
export function defaultSketchPlane(hostShapeId?: string): SketchPlane {
  return {
    origin: vec(0, 0, 0),
    normal: vec(0, 1, 0),
    uAxis: vec(1, 0, 0),
    ...(hostShapeId ? { hostShapeId } : {}),
  };
}

export function sketchPlaneVAxis(plane: SketchPlane): SketchVec3 {
  return normalizeVec(cross(plane.normal, plane.uAxis));
}

/** True when this is (effectively) the default workplane orientation (+Y normal, +X u). Origin may sit on an elevated plate. */
export function isDefaultSketchPlane(plane: SketchPlane | null | undefined) {
  if (!plane) return true;
  if (plane.hostShapeId) return false;
  const n = normalizeVec(plane.normal);
  const u = normalizeVec(plane.uAxis);
  return (
    Math.abs(n.x) < 1e-4
    && Math.abs(n.y - 1) < 1e-4
    && Math.abs(n.z) < 1e-4
    && Math.abs(u.y) < 1e-4
    && Math.abs(u.x) > 0.9
  );
}

/**
 * True when the sketch was started on a body face (or still carries a host face outline).
 * Top faces of boxes share workplane orientation, so orientation alone is not enough —
 * `hostShapeId` / face reference loops are the durable signal.
 */
export function isFaceHostedSketch(
  plane: SketchPlane | null | undefined,
  faceReferenceLoops?: Array<Array<{ x: number; z: number }>> | null,
) {
  if (plane?.hostShapeId) return true;
  if (faceReferenceLoops && faceReferenceLoops.length > 0) return true;
  return Boolean(plane && !isDefaultSketchPlane(plane));
}

/** Merge plane fields, preferring non-empty hostShapeId from either side. */
export function mergeSketchPlanes(
  primary: SketchPlane | null | undefined,
  fallback: SketchPlane | null | undefined,
): SketchPlane {
  const a = primary ? resolveSketchPlane(primary) : null;
  const b = fallback ? resolveSketchPlane(fallback) : null;
  if (!a && !b) return defaultSketchPlane();
  if (!a) return cloneSketchPlane(b!);
  if (!b) return cloneSketchPlane(a);
  const hostShapeId = a.hostShapeId ?? b.hostShapeId;
  const surface = a.surface ?? b.surface;
  return cloneSketchPlane({
    ...a,
    ...(hostShapeId ? { hostShapeId } : {}),
    ...(surface ? { surface } : {}),
  });
}

/**
 * Build an orthonormal plane from a face hit.
 * Prefers world +X as U when the face is roughly horizontal.
 */
export function sketchPlaneFromFaceHit(
  point: SketchVec3,
  normalInput: SketchVec3,
  hostShapeId?: string,
): SketchPlane {
  const normal = normalizeVec(normalInput);
  let uAxis: SketchVec3;
  if (Math.abs(normal.y) > 0.9) {
    // Horizontal-ish: project world +X onto the plane; fall back to +Z.
    const xHint = vec(1, 0, 0);
    const xOntoPlane = sub(xHint, vec(normal.x * dot(xHint, normal), normal.y * dot(xHint, normal), normal.z * dot(xHint, normal)));
    if (Math.hypot(xOntoPlane.x, xOntoPlane.y, xOntoPlane.z) > EPS) {
      uAxis = normalizeVec(xOntoPlane);
    } else {
      const zHint = vec(0, 0, 1);
      uAxis = normalizeVec(sub(zHint, vec(normal.x * dot(zHint, normal), normal.y * dot(zHint, normal), normal.z * dot(zHint, normal))));
    }
  } else {
    // Vertical-ish face: keep U horizontal (world up × normal).
    uAxis = normalizeVec(cross(vec(0, 1, 0), normal));
    if (Math.hypot(uAxis.x, uAxis.y, uAxis.z) < EPS) {
      uAxis = vec(1, 0, 0);
    }
  }
  // Ensure right-handed: v = n × u, then u = v × n for stability.
  const vAxis = normalizeVec(cross(normal, uAxis));
  uAxis = normalizeVec(cross(vAxis, normal));
  return {
    origin: { ...point },
    normal,
    uAxis,
    ...(hostShapeId ? { hostShapeId } : {}),
  };
}

function cloneCylinderSurface(surface: SketchCylinderSurface): SketchCylinderSurface {
  return {
    kind: "cylinder",
    axisOrigin: { ...surface.axisOrigin },
    axisDir: { ...surface.axisDir },
    radial0: { ...surface.radial0 },
    radius: surface.radius,
    height: surface.height,
    theta0: surface.theta0,
  };
}

export function resolveSketchPlane(plane?: SketchPlane | null): SketchPlane {
  if (!plane) return defaultSketchPlane();
  const normal = normalizeVec(plane.normal);
  let uAxis = normalizeVec(plane.uAxis);
  // Re-orthonormalize against normal. Test the raw cross product, not the normalized one:
  // normalizeVec substitutes (0,1,0) for a zero vector, so a normalized vAxis is always
  // unit-length and this guard could never fire. A uAxis parallel to the normal then
  // survived as a degenerate basis and collapsed the sketch onto a line.
  const rawVAxis = cross(normal, uAxis);
  if (Math.hypot(rawVAxis.x, rawVAxis.y, rawVAxis.z) < EPS) {
    const rebuilt = sketchPlaneFromFaceHit(plane.origin, normal, plane.hostShapeId);
    return plane.surface ? { ...rebuilt, surface: cloneCylinderSurface(plane.surface) } : rebuilt;
  }
  const vAxis = normalizeVec(rawVAxis);
  uAxis = normalizeVec(cross(vAxis, normal));
  return {
    origin: { ...plane.origin },
    normal,
    uAxis,
    ...(plane.hostShapeId ? { hostShapeId: plane.hostShapeId } : {}),
    ...(plane.surface ? { surface: cloneCylinderSurface(plane.surface) } : {}),
  };
}

export function cloneSketchPlane(plane: SketchPlane): SketchPlane {
  return {
    origin: { ...plane.origin },
    normal: { ...plane.normal },
    uAxis: { ...plane.uAxis },
    ...(plane.hostShapeId ? { hostShapeId: plane.hostShapeId } : {}),
    ...(plane.surface ? { surface: cloneCylinderSurface(plane.surface) } : {}),
  };
}

export function worldToPlaneUV(plane: SketchPlane, world: SketchVec3): { u: number; v: number } {
  const resolved = resolveSketchPlane(plane);
  const delta = sub(world, resolved.origin);
  const vAxis = sketchPlaneVAxis(resolved);
  return { u: dot(delta, resolved.uAxis), v: dot(delta, vAxis) };
}

export function planeUVToWorld(plane: SketchPlane, u: number, v: number): SketchVec3 {
  const resolved = resolveSketchPlane(plane);
  const vAxis = sketchPlaneVAxis(resolved);
  return vec(
    resolved.origin.x + resolved.uAxis.x * u + vAxis.x * v,
    resolved.origin.y + resolved.uAxis.y * u + vAxis.y * v,
    resolved.origin.z + resolved.uAxis.z * u + vAxis.z * v,
  );
}

/**
 * Local sketch frame after ExtrudeGeometry + rotateX(-π/2):
 * +X = U, +Y = extrusion (normal), +Z = V.
 * Maps that local frame into world.
 *
 * Note: columns are U, N, (N×U). That matches sketch UV (V = N×U) but is a
 * left-handed basis, so callers must flip triangle winding after applyMatrix4
 * (see shapeFromSketchProfile) or FrontSide walls render invisible.
 */
export function sketchBasisMatrix(plane: SketchPlane): THREE.Matrix4 {
  const resolved = resolveSketchPlane(plane);
  const x = toThree(resolved.uAxis);
  const y = toThree(resolved.normal);
  const z = toThree(sketchPlaneVAxis(resolved));
  const origin = toThree(resolved.origin);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin);
}

export function sketchPlaneFromThreeVectors(
  origin: THREE.Vector3,
  normal: THREE.Vector3,
  hostShapeId?: string,
): SketchPlane {
  return sketchPlaneFromFaceHit(fromThree(origin), fromThree(normal), hostShapeId);
}
