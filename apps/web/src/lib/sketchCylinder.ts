import * as THREE from "three";
import { faceHoleOvershootMm } from "@/lib/csgTree";
import { getActiveDisplayQuality, resolveHoleRadialSegments } from "@/lib/displayTessellation";
import type { SketchFaceLoop } from "@/lib/sketchFaceReference";
import type { SketchVec3 } from "@/lib/sketchPlane";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import type { SketchCylinderSurface, SketchPlane, WorkplaneShape } from "@/types/sketchforge";

const CIRCULAR_EPS = 0.05;
const EPS = 1e-8;

function vec(x: number, y: number, z: number): SketchVec3 {
  return { x, y, z };
}

function toThree(v: SketchVec3) {
  return new THREE.Vector3(v.x, v.y, v.z);
}

function fromThree(v: THREE.Vector3): SketchVec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function normalize(v: SketchVec3): SketchVec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < EPS) return vec(0, 1, 0);
  return vec(v.x / len, v.y / len, v.z / len);
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

/** True for native circular cylinders (barrel unwrap is developable). */
export function isCircularCylinderPrimitive(shape: WorkplaneShape) {
  if (shape.kind !== "cylinder" || shape.importedMesh) return false;
  return Math.abs(shapeWidth(shape) - shapeDepth(shape)) <= CIRCULAR_EPS;
}

export function cylinderAxisFrame(shape: WorkplaneShape): {
  axisOrigin: SketchVec3;
  axisDir: SketchVec3;
  radius: number;
  height: number;
} {
  const q = shapeQuaternion(shape);
  const axisDir = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
  if (shape.mirrorY) axisDir.negate();
  const centerY = (shape.elevation ?? 0) + shape.height / 2;
  return {
    axisOrigin: vec(shape.x, centerY, shape.z),
    axisDir: fromThree(axisDir),
    radius: Math.min(shapeWidth(shape), shapeDepth(shape)) / 2,
    height: shape.height,
  };
}

/** Circumferential / axial basis with radial0 pointed at the hit. */
export function cylinderSurfaceFromHit(
  shape: WorkplaneShape,
  hitPoint: SketchVec3,
): SketchCylinderSurface | null {
  if (!isCircularCylinderPrimitive(shape)) return null;
  const { axisOrigin, axisDir, radius, height } = cylinderAxisFrame(shape);
  const axis = toThree(axisDir);
  const origin = toThree(axisOrigin);
  const hit = toThree(hitPoint);
  const fromAxis = hit.clone().sub(origin);
  const v = fromAxis.dot(axis);
  const radial = fromAxis.clone().addScaledVector(axis, -v);
  if (radial.lengthSq() < EPS) {
    // Degenerate (on axis): pick a stable circumferential zero.
    let hint = new THREE.Vector3(1, 0, 0);
    if (Math.abs(axis.dot(hint)) > 0.9) hint = new THREE.Vector3(0, 0, 1);
    radial.copy(hint).addScaledVector(axis, -hint.dot(axis)).normalize();
  } else {
    radial.normalize();
  }
  return {
    kind: "cylinder",
    axisOrigin,
    axisDir: normalize(axisDir),
    radial0: fromThree(radial),
    radius,
    height,
    theta0: 0,
  };
}

export function cloneCylinderSurface(surface: SketchCylinderSurface): SketchCylinderSurface {
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

export function isCylinderSketchPlane(plane: SketchPlane | null | undefined): plane is SketchPlane & {
  surface: SketchCylinderSurface;
} {
  return plane?.surface?.kind === "cylinder";
}

/** Circumferential +U basis: right-hand rotation around +axis from radial0. */
export function cylinderRadial90(surface: SketchCylinderSurface): SketchVec3 {
  return normalize(cross(surface.radial0, surface.axisDir));
}

/**
 * UV in mm: U = R·θ (from radial0), V = height on the sketch plate.
 * V is negated vs the cylinder axis so sketch +Z (SVG down) maps to the
 * cylinder bottom — matching other face sketches and keeping a standing
 * cylinder upright on the 2D plate (top of part = top of screen).
 */
export function worldToCylinderUV(surface: SketchCylinderSurface, world: SketchVec3): { u: number; v: number } {
  const axis = toThree(surface.axisDir);
  const origin = toThree(surface.axisOrigin);
  const radial0 = toThree(surface.radial0);
  const radial90 = toThree(cylinderRadial90(surface));
  const local = toThree(world).sub(origin);
  const alongAxis = local.dot(axis);
  const radial = local.clone().addScaledVector(axis, -alongAxis);
  const x = radial.dot(radial0);
  const z = radial.dot(radial90);
  const theta = Math.atan2(z, x) - surface.theta0;
  return { u: surface.radius * theta, v: -alongAxis };
}

export function cylinderUVToWorld(
  surface: SketchCylinderSurface,
  u: number,
  v: number,
  radius = surface.radius,
): SketchVec3 {
  const theta = u / Math.max(EPS, surface.radius) + surface.theta0;
  const radial0 = toThree(surface.radial0);
  const radial90 = toThree(cylinderRadial90(surface));
  const axis = toThree(surface.axisDir);
  const point = toThree(surface.axisOrigin)
    .addScaledVector(axis, -v)
    .addScaledVector(radial0, Math.cos(theta) * radius)
    .addScaledVector(radial90, Math.sin(theta) * radius);
  return fromThree(point);
}

export function cylinderOutwardNormalAtUV(surface: SketchCylinderSurface, u: number): SketchVec3 {
  const theta = u / Math.max(EPS, surface.radius) + surface.theta0;
  const radial0 = toThree(surface.radial0);
  const radial90 = toThree(cylinderRadial90(surface));
  return fromThree(
    radial0.clone().multiplyScalar(Math.cos(theta)).addScaledVector(radial90, Math.sin(theta)).normalize(),
  );
}

/**
 * Sketch plane tangent frame at the pick, with cylindrical surface attached.
 * Frame matches unwrap UV: +U = around the barrel, +V = toward the cylinder
 * bottom on the 2D plate (screen-down), so a standing cylinder stays upright.
 */
export function sketchPlaneFromCylinderHit(
  shape: WorkplaneShape,
  hitPoint: SketchVec3,
  worldNormal: SketchVec3,
): SketchPlane | null {
  const surface = cylinderSurfaceFromHit(shape, hitPoint);
  if (!surface) return null;
  const uv = worldToCylinderUV(surface, hitPoint);
  // Snap origin onto the analytic barrel (not a tessellated facet).
  const origin = cylinderUVToWorld(surface, uv.u, uv.v);
  let normal = cylinderOutwardNormalAtUV(surface, uv.u);
  // Prefer classified radial; flip if the ray hit the inward side.
  if (dot(normal, worldNormal) < 0) {
    normal = vec(-normal.x, -normal.y, -normal.z);
  }
  // Choose U so sketch V = N×U points toward cylinder bottom (-axis), matching UV.
  // U = (-axis) × N  ⇒  N × U = N × ((-axis) × N) = -axis.
  const downAxis = vec(-surface.axisDir.x, -surface.axisDir.y, -surface.axisDir.z);
  const uAxis = normalize(cross(downAxis, normal));
  return {
    origin,
    normal: normalize(normal),
    uAxis,
    hostShapeId: shape.id,
    surface: cloneCylinderSurface(surface),
  };
}

/** Unwrapped barrel rectangle in UV mm (seam at ±πR). */
export function barrelFaceLoop(radius: number, height: number): SketchFaceLoop {
  const halfU = Math.PI * radius;
  const halfV = height / 2;
  return [
    { x: -halfU, z: -halfV },
    { x: halfU, z: -halfV },
    { x: halfU, z: halfV },
    { x: -halfU, z: halfV },
  ];
}

function barrelHighlightSegmentsU() {
  const quality = getActiveDisplayQuality();
  if (quality === "draft") return 48;
  if (quality === "smooth") return 96;
  return 72;
}

/** World-space highlight soup for the full barrel side. */
export function barrelHighlightPositions(
  surface: SketchCylinderSurface,
  segmentsU = barrelHighlightSegmentsU(),
  segmentsV = 12,
  offset = 0.18,
): Float32Array {
  const verts: number[] = [];
  const halfV = surface.height / 2;
  for (let iu = 0; iu < segmentsU; iu += 1) {
    const u0 = (-Math.PI + (iu / segmentsU) * Math.PI * 2) * surface.radius;
    const u1 = (-Math.PI + ((iu + 1) / segmentsU) * Math.PI * 2) * surface.radius;
    for (let iv = 0; iv < segmentsV; iv += 1) {
      const v0 = -halfV + (iv / segmentsV) * surface.height;
      const v1 = -halfV + ((iv + 1) / segmentsV) * surface.height;
      const r = surface.radius + offset;
      const p00 = cylinderUVToWorld(surface, u0, v0, r);
      const p10 = cylinderUVToWorld(surface, u1, v0, r);
      const p11 = cylinderUVToWorld(surface, u1, v1, r);
      const p01 = cylinderUVToWorld(surface, u0, v1, r);
      verts.push(
        p00.x, p00.y, p00.z, p10.x, p10.y, p10.z, p11.x, p11.y, p11.z,
        p00.x, p00.y, p00.z, p11.x, p11.y, p11.z, p01.x, p01.y, p01.z,
      );
    }
  }
  return new Float32Array(verts);
}

/** Through-diameter depth for a radial barrel hole (host diameter). */
export function barrelThroughDepthMm(surface: SketchCylinderSurface) {
  return Math.max(0.5, surface.radius * 2);
}

export function barrelHoleCutDepthMm(surface: SketchCylinderSurface) {
  return barrelThroughDepthMm(surface) + 2 * faceHoleOvershootMm(barrelThroughDepthMm(surface));
}

export type BarrelUvPoint = { x: number; z: number };

function normalizeUvLoop(loop: BarrelUvPoint[]): BarrelUvPoint[] | null {
  const pts = [...loop];
  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first.x - last.x, first.z - last.z) < 1e-6) pts.pop();
  return pts.length >= 3 ? pts : null;
}

/**
 * Wrap a closed UV polyline into a radial prism (optional nested hole loops).
 * Hole: spans from +(R+os) through to -(R+os).
 * Boss: spans from R out to R+depth.
 * Nested holes become annular cutters / bosses (outer − inners).
 */
export function wrapUvLoopRadialPrism(
  loop: BarrelUvPoint[],
  surface: SketchCylinderSurface,
  depth: number,
  cutIntoFace: boolean,
  holeLoops: BarrelUvPoint[][] = [],
): THREE.BufferGeometry | null {
  const pts = normalizeUvLoop(loop);
  if (!pts) return null;
  const holes = holeLoops
    .map(normalizeUvLoop)
    .filter((hole): hole is BarrelUvPoint[] => Boolean(hole));

  const safeDepth = Math.max(0.01, depth);
  const os = faceHoleOvershootMm(surface.radius * 2);
  const outerR = cutIntoFace ? surface.radius + os : surface.radius + safeDepth;
  const innerR = cutIntoFace ? -(surface.radius + os) : surface.radius;

  const outer: THREE.Vector3[] = [];
  const inner: THREE.Vector3[] = [];
  for (const point of pts) {
    outer.push(toThree(cylinderUVToWorld(surface, point.x, point.z, outerR)));
    inner.push(toThree(cylinderUVToWorld(surface, point.x, point.z, innerR)));
  }

  const holeOuterRings: THREE.Vector3[][] = [];
  const holeInnerRings: THREE.Vector3[][] = [];
  for (const hole of holes) {
    const holeOuter: THREE.Vector3[] = [];
    const holeInner: THREE.Vector3[] = [];
    for (const point of hole) {
      holeOuter.push(toThree(cylinderUVToWorld(surface, point.x, point.z, outerR)));
      holeInner.push(toThree(cylinderUVToWorld(surface, point.x, point.z, innerR)));
    }
    holeOuterRings.push(holeOuter);
    holeInnerRings.push(holeInner);
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    const base = positions.length / 3;
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    indices.push(base, base + 1, base + 2);
  };

  const pushRingWalls = (ringOuter: THREE.Vector3[], ringInner: THREE.Vector3[], reverse = false) => {
    const n = ringOuter.length;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      if (reverse) {
        pushTri(ringOuter[i], ringInner[j], ringOuter[j]);
        pushTri(ringOuter[i], ringInner[i], ringInner[j]);
      } else {
        pushTri(ringOuter[i], ringOuter[j], ringInner[j]);
        pushTri(ringOuter[i], ringInner[j], ringInner[i]);
      }
    }
  };

  pushRingWalls(outer, inner, false);
  for (let h = 0; h < holeOuterRings.length; h += 1) {
    // Inner hole walls use reversed winding so the cavity faces outward correctly.
    pushRingWalls(holeOuterRings[h], holeInnerRings[h], true);
  }

  // Caps: triangulate outer − holes in UV (supports nested barrel profiles).
  const uvContour = pts.map((point) => new THREE.Vector2(point.x, point.z));
  const uvHoles = holes.map((hole) => hole.map((point) => new THREE.Vector2(point.x, point.z)));
  // Flatten vertex list for cap index remap: outer verts, then each hole.
  const capOuter = outer;
  const capInner = inner;
  const allOuterVerts = [...capOuter, ...holeOuterRings.flat()];
  const allInnerVerts = [...capInner, ...holeInnerRings.flat()];
  let capTris: number[][] = [];
  try {
    capTris = THREE.ShapeUtils.triangulateShape(uvContour, uvHoles);
  } catch {
    capTris = [];
  }
  if (capTris.length === 0 && holes.length === 0) {
    for (let i = 1; i < outer.length - 1; i += 1) {
      capTris.push([0, i, i + 1]);
    }
  }
  for (const tri of capTris) {
    const [a, b, c] = tri;
    if (a == null || b == null || c == null) continue;
    if (!allOuterVerts[a] || !allOuterVerts[b] || !allOuterVerts[c]) continue;
    pushTri(allOuterVerts[a], allOuterVerts[c], allOuterVerts[b]);
    pushTri(allInnerVerts[a], allInnerVerts[b], allInnerVerts[c]);
  }

  if (positions.length < 9) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Fast path: circular UV profile → radial CylinderGeometry through/out of the barrel.
 */
export function wrapCircleRadialCylinder(
  centerU: number,
  centerV: number,
  holeRadius: number,
  surface: SketchCylinderSurface,
  depth: number,
  cutIntoFace: boolean,
): THREE.BufferGeometry | null {
  const r = Math.max(0.01, holeRadius);
  const safeDepth = Math.max(0.01, depth);
  const os = faceHoleOvershootMm(surface.radius * 2);
  const length = cutIntoFace ? Math.max(safeDepth, barrelHoleCutDepthMm(surface)) : safeDepth;
  const radialSegments = resolveHoleRadialSegments(r);
  const geometry = new THREE.CylinderGeometry(r, r, length, radialSegments, 1, false);

  const normal = toThree(cylinderOutwardNormalAtUV(surface, centerU));
  const axis = toThree(surface.axisDir);
  // Align cylinder +Y with outward radial.
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().normalize());
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quat));

  // Sketch V is negated vs +axis (see worldToCylinderUV).
  const onAxis = toThree(surface.axisOrigin).addScaledVector(axis, -centerV);
  if (cutIntoFace) {
    // Center on the axis so the cutter spans both skins symmetrically.
    geometry.translate(onAxis.x, onAxis.y, onAxis.z);
  } else {
    const center = onAxis.clone().addScaledVector(normal, surface.radius + length / 2);
    geometry.translate(center.x, center.y, center.z);
  }
  // Keep a slight rotational reference using axial for stability (no-op visually for circular).
  void axis;
  return geometry;
}
