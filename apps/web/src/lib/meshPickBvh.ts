export type PickTriangle = {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
};

export type PickHit = {
  t: number;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
};

export type PickBvh = {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  triangles?: PickTriangle[];
  left?: PickBvh;
  right?: PickBvh;
};

const LEAF_SIZE = 8;

function boundsOf(triangles: PickTriangle[]) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const tri of triangles) {
    for (const [x, y, z] of [
      [tri.ax, tri.ay, tri.az],
      [tri.bx, tri.by, tri.bz],
      [tri.cx, tri.cy, tri.cz],
    ]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function splitPickTriangles(triangles: PickTriangle[]): PickBvh {
  const bounds = boundsOf(triangles);
  if (triangles.length <= LEAF_SIZE) return { ...bounds, triangles };
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const spanZ = bounds.maxZ - bounds.minZ;
  const axis: "x" | "y" | "z" = spanX >= spanY && spanX >= spanZ ? "x" : spanY >= spanZ ? "y" : "z";
  const centroid = (tri: PickTriangle) => {
    if (axis === "x") return (tri.ax + tri.bx + tri.cx) / 3;
    if (axis === "y") return (tri.ay + tri.by + tri.cy) / 3;
    return (tri.az + tri.bz + tri.cz) / 3;
  };
  const ordered = triangles.slice().sort((left, right) => centroid(left) - centroid(right));
  const mid = Math.max(1, Math.floor(ordered.length / 2));
  return {
    ...bounds,
    left: splitPickTriangles(ordered.slice(0, mid)),
    right: splitPickTriangles(ordered.slice(mid)),
  };
}

export function buildPickBvh(triangles: PickTriangle[]): PickBvh | null {
  if (triangles.length === 0) return null;
  return splitPickTriangles(triangles);
}

function rayHitsBox(
  originX: number, originY: number, originZ: number,
  dirX: number, dirY: number, dirZ: number,
  invX: number, invY: number, invZ: number,
  node: PickBvh,
  maxT: number,
) {
  const tx1 = (node.minX - originX) * invX;
  const tx2 = (node.maxX - originX) * invX;
  const ty1 = (node.minY - originY) * invY;
  const ty2 = (node.maxY - originY) * invY;
  const tz1 = (node.minZ - originZ) * invZ;
  const tz2 = (node.maxZ - originZ) * invZ;
  const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
  const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
  return tmax >= Math.max(tmin, 0) && tmin <= maxT;
}

function intersectTriangle(
  originX: number, originY: number, originZ: number,
  dirX: number, dirY: number, dirZ: number,
  tri: PickTriangle,
  doubleSided: boolean,
  maxT: number,
): PickHit | null {
  const edge1x = tri.bx - tri.ax;
  const edge1y = tri.by - tri.ay;
  const edge1z = tri.bz - tri.az;
  const edge2x = tri.cx - tri.ax;
  const edge2y = tri.cy - tri.ay;
  const edge2z = tri.cz - tri.az;
  const px = dirY * edge2z - dirZ * edge2y;
  const py = dirZ * edge2x - dirX * edge2z;
  const pz = dirX * edge2y - dirY * edge2x;
  const det = edge1x * px + edge1y * py + edge1z * pz;
  if (!doubleSided && det < 1e-8) return null;
  if (doubleSided && Math.abs(det) < 1e-8) return null;
  const invDet = 1 / det;
  const sx = originX - tri.ax;
  const sy = originY - tri.ay;
  const sz = originZ - tri.az;
  const u = (sx * px + sy * py + sz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = sy * edge1z - sz * edge1y;
  const qy = sz * edge1x - sx * edge1z;
  const qz = sx * edge1y - sy * edge1x;
  const v = (dirX * qx + dirY * qy + dirZ * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const t = (edge2x * qx + edge2y * qy + edge2z * qz) * invDet;
  if (t < 1e-6 || t > maxT) return null;
  const nx = edge1y * edge2z - edge1z * edge2y;
  const ny = edge1z * edge2x - edge1x * edge2z;
  const nz = edge1x * edge2y - edge1y * edge2x;
  const length = Math.hypot(nx, ny, nz) || 1;
  return {
    t,
    x: originX + dirX * t,
    y: originY + dirY * t,
    z: originZ + dirZ * t,
    nx: nx / length,
    ny: ny / length,
    nz: nz / length,
  };
}

export function raycastPickBvh(
  root: PickBvh,
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  doubleSided = false,
  maxT = Infinity,
): PickHit | null {
  const invX = 1 / (direction.x === 0 ? 1e-12 : direction.x);
  const invY = 1 / (direction.y === 0 ? 1e-12 : direction.y);
  const invZ = 1 / (direction.z === 0 ? 1e-12 : direction.z);
  const best = { hit: null as PickHit | null, maxT };
  const visit = (node: PickBvh) => {
    if (!rayHitsBox(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, invX, invY, invZ, node, best.maxT)) return;
    if (node.triangles) {
      for (const tri of node.triangles) {
        const hit = intersectTriangle(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, tri, doubleSided, best.maxT);
        if (!hit) continue;
        best.hit = hit;
        best.maxT = hit.t;
      }
      return;
    }
    if (node.left) visit(node.left);
    if (node.right) visit(node.right);
  };
  visit(root);
  return best.hit;
}
