import { MeshoptSimplifier } from "meshoptimizer";
import { meshForShape, type MeshData } from "@/lib/editorShapeMesh";
import type { WorkplaneShape } from "@/types/sketchforge";

const KEEP_MIN = 0.1;
const KEEP_MAX = 1;
/** Just above the ~6° step used to tessellate a STEP solid, so a real rim is a crease and a smooth curve is not. */
const CREASE_DOT = Math.cos((8 * Math.PI) / 180);

type MeshBuffers = { positions: number[]; indices: number[]; normals: number[] };
type IndexedPart = { positions: Float32Array; indices: Uint32Array };

/**
 * Quadric edge collapse for a crystal-laser file. Big faces become large
 * triangles. Small parts get a tighter budget. Sharp corners stay put.
 */
function maxDeviationMm(keepFraction: number): number {
  const removed = 1 - keepFraction;
  return 0.005 + removed * removed * 0.12;
}

function weldSoup(soup: number[]): IndexedPart | null {
  const map = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const keyOf = (x: number, y: number, z: number) => `${Math.round(x * 1e3)}:${Math.round(y * 1e3)}:${Math.round(z * 1e3)}`;
  for (let i = 0; i + 2 < soup.length; i += 3) {
    const x = soup[i];
    const y = soup[i + 1];
    const z = soup[i + 2];
    const key = keyOf(x, y, z);
    let index = map.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      map.set(key, index);
      positions.push(x, y, z);
    }
    indices.push(index);
  }
  if (indices.length < 3 || positions.length < 9) return null;
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function soupFromMesh(mesh: MeshData): number[] {
  const positions: number[] = [];
  for (const [a, b, c] of mesh.faces) {
    for (const index of [a, b, c]) {
      const vertex = mesh.vertices[index];
      if (!vertex) continue;
      positions.push(vertex[0], vertex[1], vertex[2]);
    }
  }
  return positions;
}

function localTriangleSoup(shape: WorkplaneShape): number[] {
  const mesh = shape.importedMesh;
  if (!mesh) return [];
  if (mesh.indices && mesh.indices.length >= 3) {
    const soup: number[] = [];
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      for (const index of [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]]) {
        const vertex = index * 3;
        soup.push(mesh.positions[vertex] ?? 0, mesh.positions[vertex + 1] ?? 0, mesh.positions[vertex + 2] ?? 0);
      }
    }
    return soup;
  }
  return mesh.positions.slice();
}

function extentMm(positions: ArrayLike<number>): number {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return 0;
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}

function componentTriangleLists(vertexCount: number, indices: Uint32Array): number[][] {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (index: number) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const unite = (a: number, b: number) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[left] = right;
  };
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    unite(indices[triangle], indices[triangle + 1]);
    unite(indices[triangle + 1], indices[triangle + 2]);
  }
  const groups = new Map<number, number[]>();
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const root = find(indices[triangle]);
    const list = groups.get(root);
    if (list) list.push(triangle);
    else groups.set(root, [triangle]);
  }
  return [...groups.values()];
}

function extractPart(positions: Float32Array, indices: Uint32Array, triangleStarts: number[]): IndexedPart {
  const map = new Map<number, number>();
  const nextPositions: number[] = [];
  const nextIndices: number[] = [];
  const add = (vertex: number) => {
    let id = map.get(vertex);
    if (id === undefined) {
      id = nextPositions.length / 3;
      map.set(vertex, id);
      nextPositions.push(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
    }
    return id;
  };
  for (const triangle of triangleStarts) {
    nextIndices.push(add(indices[triangle]), add(indices[triangle + 1]), add(indices[triangle + 2]));
  }
  return { positions: new Float32Array(nextPositions), indices: new Uint32Array(nextIndices) };
}

function faceNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(indices.length);
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const a = indices[triangle] * 3;
    const b = indices[triangle + 1] * 3;
    const c = indices[triangle + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-12) {
      nx /= length;
      ny /= length;
      nz /= length;
    } else {
      nx = 0;
      ny = 0;
      nz = 0;
    }
    normals[triangle] = nx;
    normals[triangle + 1] = ny;
    normals[triangle + 2] = nz;
  }
  return normals;
}

/** 0 = free, 1 = frozen corner or border, 2 = may slide along a straight crease. */
function featureVertexLocks(positions: Float32Array, indices: Uint32Array, normals: Float32Array): Uint8Array {
  const lock = new Uint8Array(positions.length / 3);
  const edges = new Map<string, number>();
  const creases: Array<[number, number]> = [];
  const consider = (u: number, v: number, face: number) => {
    const key = u < v ? `${u},${v}` : `${v},${u}`;
    const previous = edges.get(key);
    if (previous === undefined) {
      edges.set(key, face);
      return;
    }
    if (previous < 0) return;
    const dot = normals[previous] * normals[face] + normals[previous + 1] * normals[face + 1] + normals[previous + 2] * normals[face + 2];
    edges.set(key, -1);
    if (dot < CREASE_DOT) creases.push([u, v]);
  };
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    consider(indices[triangle], indices[triangle + 1], triangle);
    consider(indices[triangle + 1], indices[triangle + 2], triangle);
    consider(indices[triangle + 2], indices[triangle], triangle);
  }
  for (const [key, face] of edges) {
    if (face < 0) continue;
    const comma = key.indexOf(",");
    lock[Number(key.slice(0, comma))] = 1;
    lock[Number(key.slice(comma + 1))] = 1;
  }

  const neighbors = new Map<number, number[]>();
  for (const [u, v] of creases) {
    const left = neighbors.get(u);
    if (left) left.push(v);
    else neighbors.set(u, [v]);
    const right = neighbors.get(v);
    if (right) right.push(u);
    else neighbors.set(v, [u]);
  }
  for (const [vertex, adjacent] of neighbors) {
    if (lock[vertex] === 1) continue;
    if (adjacent.length !== 2 || adjacent[0] === adjacent[1]) {
      lock[vertex] = 1;
      continue;
    }
    const origin = vertex * 3;
    const ux = positions[adjacent[0] * 3] - positions[origin];
    const uy = positions[adjacent[0] * 3 + 1] - positions[origin + 1];
    const uz = positions[adjacent[0] * 3 + 2] - positions[origin + 2];
    const vx = positions[adjacent[1] * 3] - positions[origin];
    const vy = positions[adjacent[1] * 3 + 1] - positions[origin + 1];
    const vz = positions[adjacent[1] * 3 + 2] - positions[origin + 2];
    const ul = Math.hypot(ux, uy, uz) || 1;
    const vl = Math.hypot(vx, vy, vz) || 1;
    const dot = (ux / ul) * (vx / vl) + (uy / ul) * (vy / vl) + (uz / ul) * (vz / vl);
    lock[vertex] = dot < -0.965 ? 2 : 1;
  }
  return lock;
}

function splitCreaseMesh(part: IndexedPart): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; lock: Uint8Array } | null {
  const normals = faceNormals(part.positions, part.indices);
  const sourceLock = featureVertexLocks(part.positions, part.indices, normals);
  const faceCount = part.indices.length / 3;
  const vertexCount = part.positions.length / 3;
  const incident: number[][] = new Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) incident[vertex] = [];
  const smoothAdj: number[][] = new Array(faceCount);
  for (let face = 0; face < faceCount; face += 1) smoothAdj[face] = [];

  const edges = new Map<string, number>();
  const linkSmooth = (u: number, v: number, face: number) => {
    const key = u < v ? `${u},${v}` : `${v},${u}`;
    const previous = edges.get(key);
    if (previous === undefined) {
      edges.set(key, face);
      return;
    }
    if (previous < 0) return;
    const dot = normals[previous * 3] * normals[face * 3] + normals[previous * 3 + 1] * normals[face * 3 + 1] + normals[previous * 3 + 2] * normals[face * 3 + 2];
    edges.set(key, -1);
    if (dot >= CREASE_DOT) {
      smoothAdj[previous].push(face);
      smoothAdj[face].push(previous);
    }
  };
  for (let face = 0; face < faceCount; face += 1) {
    const triangle = face * 3;
    const a = part.indices[triangle];
    const b = part.indices[triangle + 1];
    const c = part.indices[triangle + 2];
    incident[a].push(face);
    incident[b].push(face);
    incident[c].push(face);
    linkSmooth(a, b, face);
    linkSmooth(b, c, face);
    linkSmooth(c, a, face);
  }

  const cornerVertex = new Int32Array(part.indices.length);
  cornerVertex.fill(-1);
  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outLock: number[] = [];
  const seen = new Int32Array(faceCount);
  let stamp = 1;

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const faces = incident[vertex];
    if (faces.length === 0) continue;
    stamp += 1;
    for (const face of faces) seen[face] = stamp;
    for (const start of faces) {
      if (seen[start] !== stamp) continue;
      seen[start] = 0;
      const group: number[] = [];
      const stack = [start];
      while (stack.length > 0) {
        const face = stack.pop() as number;
        group.push(face);
        for (const next of smoothAdj[face]) {
          if (seen[next] !== stamp) continue;
          seen[next] = 0;
          stack.push(next);
        }
      }
      const id = outPositions.length / 3;
      outPositions.push(part.positions[vertex * 3], part.positions[vertex * 3 + 1], part.positions[vertex * 3 + 2]);
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const face of group) {
        nx += normals[face * 3];
        ny += normals[face * 3 + 1];
        nz += normals[face * 3 + 2];
        const triangle = face * 3;
        for (let slot = 0; slot < 3; slot += 1) {
          if (part.indices[triangle + slot] === vertex) cornerVertex[triangle + slot] = id;
        }
      }
      const length = Math.hypot(nx, ny, nz) || 1;
      outNormals.push(nx / length, ny / length, nz / length);
      outLock.push(sourceLock[vertex] ?? 0);
    }
  }

  for (let i = 0; i < cornerVertex.length; i += 1) {
    if (cornerVertex[i] < 0) return null;
  }
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    indices: Uint32Array.from(cornerVertex),
    lock: Uint8Array.from(outLock),
  };
}

function buffersFromArrays(positions: Float32Array, indices: Uint32Array, normals: Float32Array): MeshBuffers {
  const out: MeshBuffers = { positions: [], indices: [], normals: [] };
  for (let i = 0; i < positions.length; i += 1) out.positions.push(positions[i]);
  for (let i = 0; i < indices.length; i += 1) out.indices.push(indices[i]);
  for (let i = 0; i < normals.length; i += 1) out.normals.push(normals[i]);
  return out;
}

function compactChosen(chosen: Uint32Array, positions: Float32Array, normals: Float32Array): MeshBuffers | null {
  const used = new Map<number, number>();
  const out: MeshBuffers = { positions: [], indices: [], normals: [] };
  for (let i = 0; i < chosen.length; i += 1) {
    const source = chosen[i];
    const vertex = source * 3;
    if (vertex + 2 >= positions.length || vertex + 2 >= normals.length) return null;
    let compact = used.get(source);
    if (compact === undefined) {
      const x = positions[vertex];
      const y = positions[vertex + 1];
      const z = positions[vertex + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      compact = out.positions.length / 3;
      used.set(source, compact);
      out.positions.push(x, y, z);
      const nx = normals[vertex];
      const ny = normals[vertex + 1];
      const nz = normals[vertex + 2];
      const length = Math.hypot(nx, ny, nz) || 1;
      out.normals.push(nx / length, ny / length, nz / length);
    }
    out.indices.push(compact);
  }
  if (out.positions.length < 9 || out.indices.length < 12) return null;
  return out;
}

function simplifyComponent(part: IndexedPart, keepFraction: number, extent: number, reference: number): MeshBuffers | null {
  const split = splitCreaseMesh(part);
  if (!split) return null;
  const sourceTriangles = part.indices.length / 3;
  const target = Math.max(12, Math.round(sourceTriangles * keepFraction));
  const unchanged = buffersFromArrays(split.positions, split.indices, split.normals);
  if (target >= sourceTriangles) return unchanged;

  const scale = reference > 1e-6 ? Math.min(1, Math.max(1 / 3, extent / reference)) : 1;
  const errorMm = maxDeviationMm(keepFraction) * scale;
  try {
    const [simplified] = MeshoptSimplifier.simplifyWithAttributes(
      split.indices,
      split.positions,
      3,
      split.normals,
      3,
      [1, 1, 1],
      split.lock,
      target * 3,
      errorMm,
      ["LockBorder", "ErrorAbsolute", "PreserveFolds"],
    );
    if (simplified.length / 3 >= sourceTriangles || simplified.length < 12) return unchanged;
    return compactChosen(simplified, split.positions, split.normals) ?? unchanged;
  } catch (caught) {
    console.error("Mesh simplify failed", caught);
    return unchanged;
  }
}

function appendBuffers(dst: MeshBuffers, src: MeshBuffers) {
  const offset = dst.positions.length / 3;
  for (let i = 0; i < src.positions.length; i += 1) dst.positions.push(src.positions[i]);
  for (let i = 0; i < src.normals.length; i += 1) dst.normals.push(src.normals[i]);
  for (let i = 0; i < src.indices.length; i += 1) dst.indices.push(src.indices[i] + offset);
}

async function quadricSimplify(soup: number[], keepFraction: number, referenceExtent?: number): Promise<MeshBuffers | null> {
  const welded = weldSoup(soup);
  if (!welded) return null;
  await MeshoptSimplifier.ready;
  const lists = componentTriangleLists(welded.positions.length / 3, welded.indices);
  const parts = lists.map((list) => extractPart(welded.positions, welded.indices, list));
  const extents = parts.map((part) => extentMm(part.positions));
  const reference = referenceExtent ?? extents.reduce((max, extent) => Math.max(max, extent), 0);
  const out: MeshBuffers = { positions: [], indices: [], normals: [] };
  for (let i = 0; i < parts.length; i += 1) {
    const piece = simplifyComponent(parts[i], keepFraction, extents[i], reference);
    if (!piece) return null;
    appendBuffers(out, piece);
  }
  if (out.positions.length < 9 || out.normals.length !== out.positions.length) return null;
  return out;
}

function fallbackSoup(soup: number[]): MeshBuffers {
  const positions = soup.slice();
  const indices: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i + 8 < positions.length; i += 9) {
    indices.push(i / 3, i / 3 + 1, i / 3 + 2);
    const abx = positions[i + 3] - positions[i];
    const aby = positions[i + 4] - positions[i + 1];
    const abz = positions[i + 5] - positions[i + 2];
    const acx = positions[i + 6] - positions[i];
    const acy = positions[i + 7] - positions[i + 1];
    const acz = positions[i + 8] - positions[i + 2];
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }
  return { positions, indices, normals };
}

function patchFromLocalPositions(shape: WorkplaneShape, mesh: MeshBuffers): Partial<WorkplaneShape> | null {
  const triangles = Math.floor(mesh.indices.length / 3);
  if (triangles < 4 || mesh.positions.length < 9 || mesh.normals.length !== mesh.positions.length || !shape.importedMesh) return null;
  return {
    importedMesh: {
      ...shape.importedMesh,
      positions: mesh.positions,
      indices: mesh.indices,
      normals: mesh.normals,
      triangleCount: triangles,
    },
  };
}

/**
 * Lighten an imported mesh by collapsing edges, part by part when the selection
 * is a group. Exact STEP text already stored on the body is left in place.
 */
export async function simplifiedImportedShapePatch(
  shape: WorkplaneShape,
  keepFraction: number,
): Promise<Partial<WorkplaneShape> | null> {
  if (!shape.importedMesh || shape.importedMesh.positions.length < 9) return null;
  const fraction = Math.min(KEEP_MAX, Math.max(KEEP_MIN, keepFraction));
  const children = (shape.groupedShapes ?? []).filter((child) => !child.hidden && !child.hole && !child.suppressed && !child.csg?.suppressed);

  if (children.length >= 2) {
    const jobs: Array<{ soup: number[]; extent: number }> = [];
    for (const child of children) {
      let mesh: MeshData;
      try {
        mesh = meshForShape(child);
      } catch {
        continue;
      }
      const soup = soupFromMesh(mesh);
      if (soup.length < 9) continue;
      jobs.push({ soup, extent: extentMm(soup) });
    }
    const reference = jobs.reduce((max, job) => Math.max(max, job.extent), 0);
    const combined: MeshBuffers = { positions: [], indices: [], normals: [] };
    let before = 0;
    for (const job of jobs) {
      before += Math.floor(job.soup.length / 9);
      const simplified = await quadricSimplify(job.soup, fraction, reference);
      appendBuffers(combined, simplified ?? fallbackSoup(job.soup));
    }
    const nextCount = Math.floor(combined.indices.length / 3);
    if (combined.positions.length < 9 || nextCount < 4 || nextCount >= before) return null;
    return patchFromLocalPositions(shape, combined);
  }

  const soup = localTriangleSoup(shape);
  const before = Math.floor(soup.length / 9);
  const simplified = await quadricSimplify(soup, fraction);
  if (!simplified || simplified.indices.length / 3 >= before) return null;
  return patchFromLocalPositions(shape, simplified);
}
