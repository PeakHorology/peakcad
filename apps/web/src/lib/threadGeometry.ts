import type { CadModifierQuality } from "@/lib/cadModifierTypes";
import type { ResolvedThreadParams, ThreadSide } from "@/lib/metricThreads";

export type Vec3 = { x: number; y: number; z: number };

export type ThreadGrooveMesh = {
  positions: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
};

export type ThreadAxisFrame = {
  origin: Vec3;
  axis: Vec3;
  radius: number;
  height: number;
};

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function orthonormalBasis(axis: Vec3) {
  const a = normalize(axis);
  const helper = Math.abs(a.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize(cross(helper, a));
  const v = cross(a, u);
  return { axis: a, u, v };
}

function sectionsPerTurnForQuality(quality: CadModifierQuality) {
  if (quality === "draft") return 12;
  if (quality === "fine") return 28;
  return 20;
}

/**
 * Build a helical V-groove cutter solid that can be boolean-cut from a body.
 * External: cutter sits just outside the major radius and bites inward.
 * Internal: cutter sits just inside the bore and bites outward into the wall.
 */
export function buildThreadGrooveCutterMesh(
  frame: ThreadAxisFrame,
  params: ResolvedThreadParams,
  quality: CadModifierQuality = "standard",
): ThreadGrooveMesh {
  const { axis, u, v } = orthonormalBasis(frame.axis);
  const pitch = params.pitch;
  const depth = params.depth;
  const length = Math.min(params.length, frame.height);
  const turns = Math.max(1, length / pitch);
  const sectionsPerTurn = sectionsPerTurnForQuality(quality);
  const sectionCount = Math.max(8, Math.ceil(turns * sectionsPerTurn));
  const lefthand = params.handedness === "left" ? -1 : 1;
  const majorR = params.majorDiameter / 2;
  const faceR = frame.radius;

  // Prefer the selected face radius when it is close to the nominal major radius.
  const nominalR = Math.abs(faceR - majorR) / Math.max(majorR, 1e-6) < 0.35 ? faceR : majorR;

  const side: ThreadSide = params.side;
  const rootR = side === "external" ? nominalR - depth : nominalR;
  const crestR = side === "external" ? nominalR + depth * 0.15 : nominalR + depth;
  const halfWidth = pitch * 0.42;

  const positions: number[] = [];
  const indices: number[] = [];

  const pointAt = (radius: number, angle: number, axial: number): Vec3 => {
    const radial = add(scale(u, Math.cos(angle) * radius), scale(v, Math.sin(angle) * radius));
    return add(frame.origin, add(scale(axis, axial), radial));
  };

  const pushVertex = (point: Vec3) => {
    positions.push(point.x, point.y, point.z);
    return positions.length / 3 - 1;
  };

  for (let i = 0; i <= sectionCount; i += 1) {
    const t = i / sectionCount;
    const axial = t * length;
    const angle = lefthand * ((axial / pitch) * Math.PI * 2);
    const mid = pushVertex(pointAt((rootR + crestR) / 2, angle, axial));
    const crest = pushVertex(pointAt(crestR, angle, axial));
    const rootA = pushVertex(pointAt(rootR, angle, axial - halfWidth));
    const rootB = pushVertex(pointAt(rootR, angle, axial + halfWidth));

    if (i === 0) continue;
    const prev = (i - 1) * 4;
    const curr = i * 4;
    // Quad strips between consecutive tooth sections (two triangles each).
    const quads: Array<[number, number, number, number]> = [
      [prev + 1, curr + 1, curr + 2, prev + 2],
      [prev + 1, curr + 1, curr + 3, prev + 3],
      [prev + 2, curr + 2, curr + 3, prev + 3],
      [prev, curr, curr + 1, prev + 1],
    ];
    for (const [a, b, c, d] of quads) {
      indices.push(a, b, c, a, c, d);
    }
    void mid;
    void crest;
    void rootA;
    void rootB;
  }

  // Cap ends with fans so the cutter is a closed-ish volume for STL import.
  const start = 0;
  indices.push(start, start + 2, start + 1, start, start + 1, start + 3, start, start + 3, start + 2);
  const end = sectionCount * 4;
  indices.push(end, end + 1, end + 2, end, end + 3, end + 1, end, end + 2, end + 3);

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
  };
}

export function threadGrooveMeshBounds(mesh: ThreadGrooveMesh) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i]);
    maxX = Math.max(maxX, mesh.positions[i]);
    minY = Math.min(minY, mesh.positions[i + 1]);
    maxY = Math.max(maxY, mesh.positions[i + 1]);
    minZ = Math.min(minZ, mesh.positions[i + 2]);
    maxZ = Math.max(maxZ, mesh.positions[i + 2]);
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ,
  };
}

export function threadMeshToAsciiStl(mesh: ThreadGrooveMesh, name = "thread-cutter") {
  const lines = new Array<string>(mesh.triangleCount + 2);
  lines[0] = `solid ${name}`;
  const { positions, indices } = mesh;
  for (let offset = 0, face = 1; offset + 2 < indices.length; offset += 3, face += 1) {
    const ai = indices[offset] * 3;
    const bi = indices[offset + 1] * 3;
    const ci = indices[offset + 2] * 3;
    const ax = positions[ai];
    const ay = positions[ai + 1];
    const az = positions[ai + 2];
    const bx = positions[bi];
    const by = positions[bi + 1];
    const bz = positions[bi + 2];
    const cx = positions[ci];
    const cy = positions[ci + 1];
    const cz = positions[ci + 2];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    lines[face] = `facet normal ${nx} ${ny} ${nz}\n outer loop\n  vertex ${ax} ${ay} ${az}\n  vertex ${bx} ${by} ${bz}\n  vertex ${cx} ${cy} ${cz}\n endloop\nendfacet`;
  }
  lines[lines.length - 1] = `endsolid ${name}`;
  return lines.join("\n");
}
