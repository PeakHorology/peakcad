import {
  cloneSketchPlane,
  planeUVToWorld,
  resolveSketchPlane,
  worldToPlaneUV,
  type SketchVec3,
} from "@/lib/sketchPlane";
import type { SketchPlane } from "@/types/sketchforge";

export type SketchFaceLoop = Array<{ x: number; z: number }>;

export type WorldTriangle = [SketchVec3, SketchVec3, SketchVec3];

const NORMAL_DOT = 0.96;
const PLANE_EPS = 0.25;
const EDGE_KEY_DECIMALS = 3;

function edgeKey(a: SketchVec3, b: SketchVec3) {
  const aKey = `${a.x.toFixed(EDGE_KEY_DECIMALS)},${a.y.toFixed(EDGE_KEY_DECIMALS)},${a.z.toFixed(EDGE_KEY_DECIMALS)}`;
  const bKey = `${b.x.toFixed(EDGE_KEY_DECIMALS)},${b.y.toFixed(EDGE_KEY_DECIMALS)},${b.z.toFixed(EDGE_KEY_DECIMALS)}`;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function cross(
  a: SketchVec3,
  b: SketchVec3,
): SketchVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function sub(a: SketchVec3, b: SketchVec3): SketchVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function length(v: SketchVec3) {
  return Math.hypot(v.x, v.y, v.z);
}

function normalize(v: SketchVec3): SketchVec3 {
  const len = length(v);
  if (len < 1e-10) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot(a: SketchVec3, b: SketchVec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function pointKey(p: SketchVec3) {
  return `${p.x.toFixed(EDGE_KEY_DECIMALS)},${p.y.toFixed(EDGE_KEY_DECIMALS)},${p.z.toFixed(EDGE_KEY_DECIMALS)}`;
}

/** Build world triangles from a flat position buffer (xyz triplets per vertex, 9 floats per triangle). */
export function worldTrianglesFromPositions(positions: number[]): WorldTriangle[] {
  const triangles: WorldTriangle[] = [];
  for (let i = 0; i + 8 < positions.length; i += 9) {
    triangles.push([
      { x: positions[i], y: positions[i + 1], z: positions[i + 2] },
      { x: positions[i + 3], y: positions[i + 4], z: positions[i + 5] },
      { x: positions[i + 6], y: positions[i + 7], z: positions[i + 8] },
    ]);
  }
  return triangles;
}

export function worldTrianglesFromMeshData(
  vertices: Array<[number, number, number]>,
  faces: Array<[number, number, number]>,
): WorldTriangle[] {
  return faces.map(([a, b, c]) => {
    const va = vertices[a];
    const vb = vertices[b];
    const vc = vertices[c];
    return [
      { x: va[0], y: va[1], z: va[2] },
      { x: vb[0], y: vb[1], z: vb[2] },
      { x: vc[0], y: vc[1], z: vc[2] },
    ];
  });
}

const WELD_DECIMALS = 3;

/** Snap near-duplicate verts so coplanar boundary walks share edges. */
function weldWorldTriangles(triangles: WorldTriangle[]): WorldTriangle[] {
  const welded = new Map<string, SketchVec3>();
  const weld = (point: SketchVec3): SketchVec3 => {
    const key = `${point.x.toFixed(WELD_DECIMALS)},${point.y.toFixed(WELD_DECIMALS)},${point.z.toFixed(WELD_DECIMALS)}`;
    const existing = welded.get(key);
    if (existing) return existing;
    welded.set(key, point);
    return point;
  };
  return triangles.map(([a, b, c]) => [weld(a), weld(b), weld(c)]);
}

function filterCoplanarTriangles(plane: SketchPlane, triangles: WorldTriangle[]): WorldTriangle[] {
  const resolved = resolveSketchPlane(plane);
  const normal = resolved.normal;
  return weldWorldTriangles(triangles).filter(([a, b, c]) => {
    const triNormal = normalize(cross(sub(b, a), sub(c, a)));
    if (Math.abs(dot(triNormal, normal)) < NORMAL_DOT) return false;
    const centroid = {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
      z: (a.z + b.z + c.z) / 3,
    };
    return Math.abs(dot(sub(centroid, resolved.origin), normal)) <= PLANE_EPS;
  });
}

function boundaryLoopsFromTriangles(triangles: WorldTriangle[]): SketchVec3[][] {
  const edgeCount = new Map<string, { a: SketchVec3; b: SketchVec3; count: number }>();
  triangles.forEach(([a, b, c]) => {
    ([[a, b], [b, c], [c, a]] as const).forEach(([start, end]) => {
      const key = edgeKey(start, end);
      const existing = edgeCount.get(key);
      if (existing) existing.count += 1;
      else edgeCount.set(key, { a: start, b: end, count: 1 });
    });
  });

  const boundary = [...edgeCount.values()].filter((edge) => edge.count === 1);
  if (boundary.length < 3) return [];

  const adjacency = new Map<string, Array<{ to: SketchVec3; edgeId: string }>>();
  boundary.forEach((edge, index) => {
    const edgeId = `e${index}`;
    const aKey = pointKey(edge.a);
    const bKey = pointKey(edge.b);
    adjacency.set(aKey, [...(adjacency.get(aKey) ?? []), { to: edge.b, edgeId }]);
    adjacency.set(bKey, [...(adjacency.get(bKey) ?? []), { to: edge.a, edgeId }]);
  });

  const usedEdges = new Set<string>();
  const loops: SketchVec3[][] = [];

  for (let startIndex = 0; startIndex < boundary.length; startIndex += 1) {
    const startId = `e${startIndex}`;
    if (usedEdges.has(startId)) continue;
    const startEdge = boundary[startIndex];
    const loop: SketchVec3[] = [];
    let current = startEdge.a;
    let previousKey = "";
    let safety = 0;
    let closed = false;
    while (safety < boundary.length + 2) {
      safety += 1;
      loop.push(current);
      const currentKey = pointKey(current);
      const options = adjacency.get(currentKey) ?? [];
      const choice = options.find((candidate) => !usedEdges.has(candidate.edgeId) && pointKey(candidate.to) !== previousKey)
        ?? options.find((candidate) => !usedEdges.has(candidate.edgeId));
      if (!choice) break;
      usedEdges.add(choice.edgeId);
      previousKey = currentKey;
      current = choice.to;
      if (pointKey(current) === pointKey(loop[0]) && loop.length >= 3) {
        closed = true;
        break;
      }
    }
    // A walk that ran out of edges is an open chain, not a face boundary. Accepting it on point
    // count alone handed back a face reference whose outline never closed.
    if (closed && loop.length >= 3) loops.push(loop);
  }

  const unique: SketchVec3[][] = [];
  const signatures = new Set<string>();
  loops.forEach((loop) => {
    const keys = loop.map(pointKey);
    const rotated = keys
      .map((_, index) => [...keys.slice(index), ...keys.slice(0, index)].join(">"))
      .sort()[0];
    if (signatures.has(rotated)) return;
    signatures.add(rotated);
    unique.push(loop);
  });
  return unique;
}

/**
 * Project the coplanar face under `plane` into sketch UV loops, and recenter the
 * plane origin on the face so drawing happens on that face (not an arbitrary click).
 */
export function prepareFaceSketchReference(
  plane: SketchPlane,
  triangles: WorldTriangle[],
): { plane: SketchPlane; loops: SketchFaceLoop[] } {
  const resolved = resolveSketchPlane(plane);
  const coplanar = filterCoplanarTriangles(resolved, triangles);
  if (coplanar.length === 0) {
    return { plane: cloneSketchPlane(resolved), loops: [] };
  }

  // Sit on the outer envelope of the face (max along +normal), not a recessed
  // union scar / micro-step that the ray may have hit first.
  const normal = resolved.normal;
  let maxAlongNormal = 0;
  coplanar.forEach(([a, b, c]) => {
    for (const point of [a, b, c]) {
      maxAlongNormal = Math.max(maxAlongNormal, dot(sub(point, resolved.origin), normal));
    }
  });
  const faceOrigin = {
    x: resolved.origin.x + normal.x * maxAlongNormal,
    y: resolved.origin.y + normal.y * maxAlongNormal,
    z: resolved.origin.z + normal.z * maxAlongNormal,
  };
  const facePlane = cloneSketchPlane({ ...resolved, origin: faceOrigin });

  const worldLoops = boundaryLoopsFromTriangles(coplanar);
  const uvPoints = worldLoops.flatMap((loop) => loop.map((point) => worldToPlaneUV(facePlane, point)));
  if (uvPoints.length === 0) {
    // Fall back to triangle corners if boundary walk failed.
    coplanar.forEach(([a, b, c]) => {
      uvPoints.push(worldToPlaneUV(facePlane, a), worldToPlaneUV(facePlane, b), worldToPlaneUV(facePlane, c));
    });
  }

  const centerU = uvPoints.reduce((sum, point) => sum + point.u, 0) / uvPoints.length;
  const centerV = uvPoints.reduce((sum, point) => sum + point.v, 0) / uvPoints.length;
  const centeredOrigin = planeUVToWorld(facePlane, centerU, centerV);
  const centeredPlane = cloneSketchPlane({
    ...facePlane,
    origin: centeredOrigin,
  });

  const loops: SketchFaceLoop[] = worldLoops.length > 0
    ? worldLoops.map((loop) =>
      loop.map((point) => {
        const uv = worldToPlaneUV(centeredPlane, point);
        return { x: uv.u, z: uv.v };
      }))
    : [uvPoints.map((point) => ({ x: point.u - centerU, z: point.v - centerV }))];

  return { plane: centeredPlane, loops };
}

export function faceReferenceBounds(loops: SketchFaceLoop[]) {
  const points = loops.flat();
  if (points.length === 0) return null;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minZ = Math.min(...points.map((point) => point.z));
  const maxZ = Math.max(...points.map((point) => point.z));
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    width: Math.max(1, maxX - minX),
    depth: Math.max(1, maxZ - minZ),
  };
}
