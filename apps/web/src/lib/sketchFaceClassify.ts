import * as THREE from "three";
import {
  barrelFaceLoop,
  barrelHighlightPositions,
  isCircularCylinderPrimitive,
  sketchPlaneFromCylinderHit,
} from "@/lib/sketchCylinder";
import { sketchPlaneFromFaceHit, type SketchVec3 } from "@/lib/sketchPlane";
import type { SketchFaceLoop } from "@/lib/sketchFaceReference";
import { shapeDepth, shapeWidth, coneBaseRadius, coneTopRadius } from "@/lib/workplaneShapes";
import type { SketchCylinderSurface, SketchPlane, WorkplaneShape } from "@/types/sketchforge";

const PLANAR_NORMAL_DOT = 0.92;
const CAP_Y_EPS = 0.06;
const BARREL_RADIAL_EPS = 0.08;
const MESH_NORMAL_SPREAD = 0.12;

export type SketchFaceKind = "planar" | "cylindrical" | "curved";

export type AnalyticDiscCap = {
  type: "disc-cap";
  origin: SketchVec3;
  normal: SketchVec3;
  radius: number;
};

export type AnalyticBarrel = {
  type: "barrel";
  surface: SketchCylinderSurface;
};

export type SketchFaceClassification = {
  kind: SketchFaceKind;
  /** Set when the face cannot host a sketch yet (sphere / cone side / etc.). */
  blockedReason?: string;
  analytic?: AnalyticDiscCap | AnalyticBarrel;
  /** Prefer this plane when analytic cap/barrel snaps to the true surface. */
  plane?: SketchPlane;
};

export { barrelFaceLoop, barrelHighlightPositions };

const ROUND_PRIMITIVE_KINDS = new Set([
  "cylinder",
  "cone",
  "sphere",
  "halfSphere",
  "tube",
  "ring",
  "torus",
]);

function shapeQuaternion(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shape.rotation ?? 0),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
}

/** Hit point in the shape's centered local frame (Y up along height, unit-ish for primitives). */
function worldPointToShapeLocal(shape: WorkplaneShape, world: SketchVec3): THREE.Vector3 {
  const center = new THREE.Vector3(
    shape.x,
    (shape.elevation ?? 0) + shape.height / 2,
    shape.z,
  );
  const local = new THREE.Vector3(world.x, world.y, world.z).sub(center);
  local.applyQuaternion(shapeQuaternion(shape).invert());
  const sx = Math.max(1e-6, shapeWidth(shape) / 2);
  const sy = Math.max(1e-6, shape.height / 2);
  const sz = Math.max(1e-6, shapeDepth(shape) / 2);
  // Undo mirror after rotation (mirrors are applied as scale on the group).
  local.x *= shape.mirrorX ? -1 : 1;
  local.y *= shape.mirrorY ? -1 : 1;
  local.z *= shape.mirrorZ ? -1 : 1;
  // Normalize into a unit cylinder/sphere box: |y|<=1, radial xz on unit circle for round prims.
  return new THREE.Vector3(local.x / sx, local.y / sy, local.z / sz);
}

function worldNormalToShapeLocal(shape: WorkplaneShape, worldNormal: SketchVec3): THREE.Vector3 {
  const n = new THREE.Vector3(worldNormal.x, worldNormal.y, worldNormal.z).normalize();
  n.applyQuaternion(shapeQuaternion(shape).invert());
  n.x *= shape.mirrorX ? -1 : 1;
  n.y *= shape.mirrorY ? -1 : 1;
  n.z *= shape.mirrorZ ? -1 : 1;
  return n.normalize();
}

function discCapClassification(
  shape: WorkplaneShape,
  localYSign: 1 | -1,
  hostShapeId: string,
): SketchFaceClassification {
  const halfH = shape.height / 2;
  const centerY = (shape.elevation ?? 0) + shape.height / 2;
  const localOrigin = new THREE.Vector3(0, localYSign * halfH, 0);
  const localNormal = new THREE.Vector3(0, localYSign, 0);
  const q = shapeQuaternion(shape);
  // Apply mirrors in local before rotating to world.
  localOrigin.x *= shape.mirrorX ? -1 : 1;
  localOrigin.y *= shape.mirrorY ? -1 : 1;
  localOrigin.z *= shape.mirrorZ ? -1 : 1;
  localNormal.x *= shape.mirrorX ? -1 : 1;
  localNormal.y *= shape.mirrorY ? -1 : 1;
  localNormal.z *= shape.mirrorZ ? -1 : 1;
  localOrigin.applyQuaternion(q);
  localNormal.applyQuaternion(q).normalize();
  const worldOrigin = new THREE.Vector3(shape.x, centerY, shape.z).add(localOrigin);
  const worldNormal = localNormal.clone().normalize();
  // Keep outward-ish normal (away from solid center along axis).
  const fromCenter = worldOrigin.clone().sub(new THREE.Vector3(shape.x, centerY, shape.z));
  if (fromCenter.lengthSq() > 1e-10 && worldNormal.dot(fromCenter) < 0) {
    worldNormal.negate();
  }
  const radius =
    shape.kind === "cone"
      ? localYSign > 0
        ? coneTopRadius(shape)
        : coneBaseRadius(shape)
      : Math.min(shapeWidth(shape), shapeDepth(shape)) / 2;
  const plane = sketchPlaneFromFaceHit(
    { x: worldOrigin.x, y: worldOrigin.y, z: worldOrigin.z },
    { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z },
    hostShapeId,
  );
  return {
    kind: "planar",
    analytic: {
      type: "disc-cap",
      origin: { x: worldOrigin.x, y: worldOrigin.y, z: worldOrigin.z },
      normal: { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z },
      radius,
    },
    plane,
  };
}

function classifyRoundPrimitive(
  shape: WorkplaneShape,
  hitPoint: SketchVec3,
  worldNormal: SketchVec3,
): SketchFaceClassification {
  const local = worldPointToShapeLocal(shape, hitPoint);
  const localN = worldNormalToShapeLocal(shape, worldNormal);
  const radial = Math.hypot(local.x, local.z);
  const axisAlign = Math.abs(localN.y);

  if (shape.kind === "sphere" || shape.kind === "torus") {
    return {
      kind: "curved",
      blockedReason: "Curved faces aren’t sketchable yet — click the workplane, or use a flat face on another part",
    };
  }

  if (shape.kind === "halfSphere") {
    // Flat cut is near y = -1 in unit frame (bottom of half-sphere).
    if (axisAlign >= PLANAR_NORMAL_DOT && local.y < -1 + CAP_Y_EPS * 2) {
      return discCapClassification(shape, -1, shape.id);
    }
    return {
      kind: "curved",
      blockedReason: "Sketch on the flat face of the half-sphere — curved sides aren’t supported yet",
    };
  }

  // Cylinder / cone / tube / ring: planar caps when normal ~ ±Y and hit near ±1 in y.
  const nearTop = local.y > 1 - CAP_Y_EPS;
  const nearBottom = local.y < -1 + CAP_Y_EPS;
  if (axisAlign >= PLANAR_NORMAL_DOT && (nearTop || nearBottom) && radial <= 1 + BARREL_RADIAL_EPS) {
    return discCapClassification(shape, nearTop ? 1 : -1, shape.id);
  }

  // Barrel / conical side.
  if (radial > 1 - BARREL_RADIAL_EPS * 2 && Math.abs(local.y) <= 1 + CAP_Y_EPS) {
    if (shape.kind === "cylinder" && isCircularCylinderPrimitive(shape)) {
      const plane = sketchPlaneFromCylinderHit(shape, hitPoint, worldNormal);
      if (plane?.surface) {
        return {
          kind: "cylindrical",
          analytic: { type: "barrel", surface: plane.surface },
          plane,
        };
      }
    }
    const label = shape.kind === "cone" ? "cone" : shape.kind === "tube" || shape.kind === "ring" ? "tube" : "cylinder";
    return {
      kind: "curved",
      blockedReason: shape.kind === "cylinder"
        ? "Barrel sketches need a circular cylinder — elliptical sides aren’t supported yet"
        : `Sketch on the flat end of the ${label} — curved sides aren’t supported yet`,
    };
  }

  // Fallback: trust normal alignment.
  if (axisAlign >= PLANAR_NORMAL_DOT) {
    return discCapClassification(shape, localN.y >= 0 ? 1 : -1, shape.id);
  }
  return {
    kind: "curved",
    blockedReason: "That face is curved — pick a flat end, another flat face, or the workplane",
  };
}

/**
 * Classify a mesh hit by normal coherence of nearby triangles.
 * Large normal spread ⇒ curved surface (tessellated barrel/sphere).
 */
export function classifyMeshNeighborhoodPlanarity(
  normals: Array<{ x: number; y: number; z: number }>,
): SketchFaceKind {
  if (normals.length < 2) return "planar";
  const ref = normals[0];
  const refLen = Math.hypot(ref.x, ref.y, ref.z) || 1;
  let maxSpread = 0;
  for (let i = 1; i < normals.length; i += 1) {
    const n = normals[i];
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    const dot = (ref.x * n.x + ref.y * n.y + ref.z * n.z) / (refLen * len);
    maxSpread = Math.max(maxSpread, 1 - Math.abs(dot));
  }
  return maxSpread > MESH_NORMAL_SPREAD ? "curved" : "planar";
}

/** Classify a sketch-face pick on any solid (primitive or mesh). */
export function classifySketchFaceHit(
  shape: WorkplaneShape,
  hitPoint: SketchVec3,
  worldNormal: SketchVec3,
  nearbyNormals?: Array<{ x: number; y: number; z: number }>,
): SketchFaceClassification {
  if (ROUND_PRIMITIVE_KINDS.has(shape.kind) && !shape.importedMesh) {
    return classifyRoundPrimitive(shape, hitPoint, worldNormal);
  }

  // Imported / boolean meshes: use neighborhood normal spread when available.
  if (nearbyNormals && nearbyNormals.length >= 3) {
    const kind = classifyMeshNeighborhoodPlanarity(nearbyNormals);
    if (kind === "curved") {
      return {
        kind: "curved",
        blockedReason: "That surface is curved — pick a flatter region, a flat end, or the workplane",
      };
    }
  }

  return { kind: "planar" };
}

/** UV circle loop for an analytic disc cap (centered on the sketch plane). */
export function discCapFaceLoop(radius: number, segments = 64): SketchFaceLoop {
  const loop: SketchFaceLoop = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    loop.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
  }
  return loop;
}

/** World-space triangle soup for highlighting a disc cap. */
export function discCapHighlightPositions(
  origin: SketchVec3,
  normal: SketchVec3,
  radius: number,
  segments = 48,
  offset = 0.18,
): Float32Array {
  const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  const center = new THREE.Vector3(origin.x, origin.y, origin.z).addScaledVector(n, offset);
  let u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(u)) > 0.9) u.set(0, 0, 1);
  u = u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  const verts: number[] = [];
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0 = center.clone()
      .addScaledVector(u, Math.cos(a0) * radius)
      .addScaledVector(v, Math.sin(a0) * radius);
    const p1 = center.clone()
      .addScaledVector(u, Math.cos(a1) * radius)
      .addScaledVector(v, Math.sin(a1) * radius);
    verts.push(center.x, center.y, center.z, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
  }
  return new Float32Array(verts);
}

/** Collect world normals for triangles near a hit (for mesh curvature tests). */
export function collectNearbyTriangleNormals(
  mesh: THREE.Mesh,
  hitPointWorld: THREE.Vector3,
  radius: number,
  maxSamples = 24,
): Array<{ x: number; y: number; z: number }> {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!position) return [];
  const index = geometry.getIndex();
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
  const localA = new THREE.Vector3();
  const localB = new THREE.Vector3();
  const localC = new THREE.Vector3();
  const worldA = new THREE.Vector3();
  const worldB = new THREE.Vector3();
  const worldC = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const edgeC = new THREE.Vector3();
  const triNormal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const radiusSq = radius * radius;
  const normals: Array<{ x: number; y: number; z: number }> = [];

  for (let t = 0; t < triangleCount && normals.length < maxSamples; t += 1) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    localA.fromBufferAttribute(position, ia);
    localB.fromBufferAttribute(position, ib);
    localC.fromBufferAttribute(position, ic);
    worldA.copy(localA).applyMatrix4(mesh.matrixWorld);
    worldB.copy(localB).applyMatrix4(mesh.matrixWorld);
    worldC.copy(localC).applyMatrix4(mesh.matrixWorld);
    centroid.copy(worldA).add(worldB).add(worldC).multiplyScalar(1 / 3);
    if (centroid.distanceToSquared(hitPointWorld) > radiusSq) continue;
    edgeB.copy(worldB).sub(worldA);
    edgeC.copy(worldC).sub(worldA);
    triNormal.copy(edgeB).cross(edgeC);
    if (triNormal.lengthSq() < 1e-12) continue;
    triNormal.normalize();
    normals.push({ x: triNormal.x, y: triNormal.y, z: triNormal.z });
  }
  return normals;
}
