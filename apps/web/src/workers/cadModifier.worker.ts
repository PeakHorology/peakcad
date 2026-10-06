/// <reference lib="webworker" />

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type {
  CadCylindricalFace,
  CadModifierComponentMesh,
  CadModifierDisplayEdge,
  CadModifierEdge,
  CadModifierKind,
  CadModifierMeshPart,
  CadModifierPrimitivePart,
  CadModifierQuality,
  CadModifierWorkerRequest,
  CadModifierWorkerResponse,
} from "@/lib/cadModifierTypes";
import {
  isDisplayCadEdge,
  isModifierDisplayCadEdge,
  isSelectableModifierEdge,
  recoveredHoleRimClassification,
  treatmentDetailFaceAreaLimit,
} from "@/lib/cadModifierEdges";
import { inferThreadSideFromFace, resolveThreadParams, type ResolvedThreadParams } from "@/lib/metricThreads";

const HASH_UPPER_BOUND = 2_147_483_647;
const CAD_EDGE_WIREFRAME_DEFLECTION = 0.035;
/**
 * Staged public OCCT runtime. Keep this constant local so the worker never imports
 * `@/lib/cadModifierRuntime` (that module evaluates hardwareProfile at load time and
 * can crash Worker startup via `process` / window assumptions).
 */
const CAD_MODIFIER_RUNTIME_BASE = "/occt";
/** Typed as string so the dynamic import is runtime-resolved (same pattern as brepKernel). */
const OCCT_INDEX_URL: string = `${CAD_MODIFIER_RUNTIME_BASE}/index.js`;
const OCCT_WASM_URL = `${CAD_MODIFIER_RUNTIME_BASE}/occt-wasm.wasm`;
let kernelPromise: Promise<OcctKernel> | null = null;
let baseShape: ShapeHandle | null = null;
let baseSolids: ShapeHandle[] = [];
let edgeHandles: ShapeHandle[] = [];
let edgeOwners: number[] = [];
let cylindricalFaceHandles: ShapeHandle[] = [];
let cylindricalFaces: CadCylindricalFace[] = [];
let sourcePartCount = 0;
let accumulatedShape: ShapeHandle | null = null;
let accumulatedEdgeIds: number[] = [];
let accumulatedKind: CadModifierKind | null = null;
let accumulatedAmount = Number.NaN;
let accumulatedChamferAngle = Number.NaN;

type CollectedCadEdgeGeometry = Omit<CadModifierEdge, "display" | "selectable"> & {
  curveType: string;
  surfaceTypes: string[];
  faceAreas: number[];
};
type CollectedCadEdge = CollectedCadEdgeGeometry & Pick<CadModifierEdge, "display" | "selectable">;

function post(message: CadModifierWorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

/**
 * Load OCCT from the staged public/occt copy — never from the webpack worker chunk.
 * Bundling occt-wasm into the worker made OcctKernel.init()'s relative
 * `import("./occt-wasm.js")` resolve under `/_next/static/chunks/` (404), which
 * killed fillet/chamfer. Match the STEP exporter path instead.
 */
function kernel() {
  kernelPromise ??= (async () => {
    const occt = (await import(/* webpackIgnore: true */ OCCT_INDEX_URL)) as {
      OcctKernel: { init: (options?: { wasm?: string }) => Promise<OcctKernel> };
    };
    return occt.OcctKernel.init({ wasm: OCCT_WASM_URL });
  })().catch((error) => {
    kernelPromise = null;
    throw error;
  });
  return kernelPromise;
}

function releaseSession(cad: OcctKernel) {
  try {
    cad.releaseAll();
  } catch {
    // The arena may already be empty after an operation failure.
  }
  baseShape = null;
  baseSolids = [];
  edgeHandles = [];
  edgeOwners = [];
  cylindricalFaceHandles = [];
  cylindricalFaces = [];
  sourcePartCount = 0;
  accumulatedShape = null;
  accumulatedEdgeIds = [];
  accumulatedKind = null;
  accumulatedAmount = Number.NaN;
  accumulatedChamferAngle = Number.NaN;
}

function cadShapeIsValid(cad: OcctKernel, shape: ShapeHandle) {
  const validator = (cad as { isValid?: unknown }).isValid;
  if (typeof validator !== "function") throw new Error("isValid is not a function");
  try {
    return Boolean(validator.call(cad, shape));
  } catch {
    return false;
  }
}

function orientedFaceNormal(cad: OcctKernel, face: ShapeHandle, point: { x: number; y: number; z: number }) {
  const uv = cad.uvFromPoint(face, point);
  const normal = cad.surfaceNormal(face, uv.u, uv.v);
  if (cad.shapeOrientation(face) === "reversed") {
    normal.x *= -1;
    normal.y *= -1;
    normal.z *= -1;
  }
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
}

function parseEdgeFaceMap(values: number[]) {
  const map = new Map<number, number[]>();
  for (let index = 0; index + 1 < values.length; ) {
    const edgeHash = values[index++];
    const count = values[index++];
    const faces = values.slice(index, index + count);
    index += count;
    const current = map.get(edgeHash) ?? [];
    faces.forEach((hash) => {
      if (!current.includes(hash)) current.push(hash);
    });
    map.set(edgeHash, current);
  }
  return map;
}

function edgeAngleSampleOffsets(pointCount: number) {
  const vertexCount = Math.floor(pointCount / 3);
  if (vertexCount <= 0) return [];
  const sampleCount = Math.min(8, vertexCount);
  const offsets: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const vertex = Math.min(vertexCount - 1, Math.floor(((index + 0.5) / sampleCount) * vertexCount));
    offsets.push(vertex * 3);
  }
  return [...new Set(offsets)];
}

function dihedralAngle(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  const rawAngle = (Math.acos(dot) * 180) / Math.PI;
  return Math.min(rawAngle, 180 - rawAngle);
}

function planarFaceNormal(cad: OcctKernel, face: ShapeHandle) {
  if (cad.surfaceType(face) !== "plane") return null;
  const bounds = cad.uvBounds(face);
  const normal = cad.surfaceNormal(face, (bounds.uMin + bounds.uMax) / 2, (bounds.vMin + bounds.vMax) / 2);
  if (cad.shapeOrientation(face) === "reversed") {
    normal.x *= -1;
    normal.y *= -1;
    normal.z *= -1;
  }
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
}

function edgeAngle(cad: OcctKernel, points: number[], faceHashes: number[], faceByHash: Map<number, ShapeHandle>, planarNormals?: Map<number, { x: number; y: number; z: number } | null>) {
  if (faceHashes.length !== 2 || points.length < 6) return { angle: 0, boundary: faceHashes.length < 2, manifold: false };
  const faceA = faceByHash.get(faceHashes[0]);
  const faceB = faceByHash.get(faceHashes[1]);
  if (faceA === undefined || faceB === undefined) return { angle: 0, boundary: false, manifold: false };
  const planarNormal = (hash: number, face: ShapeHandle) => {
    if (planarNormals?.has(hash)) return planarNormals.get(hash) ?? null;
    let normal: { x: number; y: number; z: number } | null = null;
    try {
      normal = planarFaceNormal(cad, face);
    } catch {
      normal = null;
    }
    planarNormals?.set(hash, normal);
    return normal;
  };
  // Flat faces have one angle. Reading it once per face is much faster than
  // sampling every tessellation edge on an imported mesh.
  const planarA = planarNormal(faceHashes[0], faceA);
  const planarB = planarNormal(faceHashes[1], faceB);
  if (planarA && planarB) return { angle: dihedralAngle(planarA, planarB), boundary: false, manifold: true };
  for (const offset of edgeAngleSampleOffsets(points.length)) {
    const point = { x: points[offset], y: points[offset + 1], z: points[offset + 2] };
    try {
      const a = orientedFaceNormal(cad, faceA, point);
      const b = orientedFaceNormal(cad, faceB, point);
      return { angle: dihedralAngle(a, b), boundary: false, manifold: true };
    } catch {
      // Wireframe samples often miss a face at a seam or a vertex. Try the next one.
    }
  }
  return { angle: 0, boundary: false, manifold: false };
}

function weldMeshCoordinate(value: number) {
  return Math.round(value * 1000) / 1000;
}

function meshPartToAsciiStl(part: CadModifierMeshPart) {
  if (!part.positions || !part.indices) throw new Error("The selected object has no mesh data");
  const lines = ["solid sketchforge"];
  const { positions, indices } = part;
  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const ai = indices[offset] * 3;
    const bi = indices[offset + 1] * 3;
    const ci = indices[offset + 2] * 3;
    const ax = weldMeshCoordinate(positions[ai]);
    const ay = weldMeshCoordinate(positions[ai + 1]);
    const az = weldMeshCoordinate(positions[ai + 2]);
    const bx = weldMeshCoordinate(positions[bi]);
    const by = weldMeshCoordinate(positions[bi + 1]);
    const bz = weldMeshCoordinate(positions[bi + 2]);
    const cx = weldMeshCoordinate(positions[ci]);
    const cy = weldMeshCoordinate(positions[ci + 1]);
    const cz = weldMeshCoordinate(positions[ci + 2]);
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-8) continue;
    nx /= length;
    ny /= length;
    nz /= length;
    lines.push(`facet normal ${nx} ${ny} ${nz}\n outer loop\n  vertex ${ax} ${ay} ${az}\n  vertex ${bx} ${by} ${bz}\n  vertex ${cx} ${cy} ${cz}\n endloop\nendfacet`);
  }
  if (lines.length < 2) throw new Error("The selected mesh has no solid faces");
  lines.push("endsolid sketchforge");
  return lines.join("\n");
}

function isCadTransform(transform: number[] | undefined): transform is number[] {
  return Boolean(transform?.length === 12 && transform.every(Number.isFinite));
}

function isIdentityCadTransform(transform: number[]) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  return transform.every((value, index) => Math.abs(value - identity[index]) < 1e-9);
}

function applyCadTransform(cad: OcctKernel, shape: ShapeHandle, transform: number[] | undefined) {
  if (!isCadTransform(transform) || isIdentityCadTransform(transform)) return shape;
  try {
    return cad.transform(shape, transform);
  } catch {
    return cad.generalTransform(shape, transform);
  }
}

function reconstructPrimitiveSolid(cad: OcctKernel, primitive: CadModifierPrimitivePart) {
  if (primitive.kind === "cylinder") {
    const radius = primitive.radius;
    const height = primitive.height;
    if (![radius, height].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("The selected cylinder has invalid dimensions");
    }
    // OCCT cylinders are Z-up from z=0..height; rotate −90° about X into SketchForge Y-up.
    let solid = cad.makeCylinder(radius, height);
    solid = cad.rotate(solid, { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, -Math.PI / 2);
    const transformed = applyCadTransform(cad, solid, primitive.transform);
    if (!cad.isSolid(transformed) || !cadShapeIsValid(cad, transformed)) {
      throw new Error("The selected cylinder could not be prepared as a valid CAD solid");
    }
    return transformed;
  }
  if (primitive.kind !== "box") {
    throw new Error(`Unsupported CAD primitive: ${(primitive as { kind: string }).kind}`);
  }
  const width = primitive.width;
  const depth = primitive.depth;
  const height = primitive.height;
  if (![width, depth, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("The selected primitive has invalid dimensions");
  }
  const solid = cad.makeBoxFromCorners(
    { x: -width / 2, y: 0, z: -depth / 2 },
    { x: width / 2, y: height, z: depth / 2 },
  );
  const transformed = applyCadTransform(cad, solid, primitive.transform);
  if (!cad.isSolid(transformed) || !cadShapeIsValid(cad, transformed)) {
    throw new Error("The selected primitive could not be prepared as a valid CAD solid");
  }
  return transformed;
}

function splitClosedMeshShells(part: CadModifierMeshPart): CadModifierMeshPart[] {
  if (!part.positions || part.positions.length < 9) return [part];
  const positions = part.positions;
  const indices = part.indices;
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
  if (triCount < 2) return [part];
  const keyAt = (corner: number) => {
    const vertex = indices ? indices[corner] : corner;
    const offset = vertex * 3;
    return `${weldMeshCoordinate(positions[offset])},${weldMeshCoordinate(positions[offset + 1])},${weldMeshCoordinate(positions[offset + 2])}`;
  };
  const parent = Array.from({ length: triCount }, (_, index) => index);
  const find = (index: number) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a: number, b: number) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[right] = left;
  };
  const owner = new Map<string, number>();
  for (let triangle = 0; triangle < triCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const key = keyAt(triangle * 3 + corner);
      const prior = owner.get(key);
      if (prior === undefined) owner.set(key, triangle);
      else union(prior, triangle);
    }
  }
  const groups = new Map<number, number[]>();
  for (let triangle = 0; triangle < triCount; triangle += 1) {
    const root = find(triangle);
    const list = groups.get(root) ?? [];
    list.push(triangle);
    groups.set(root, list);
  }
  if (groups.size <= 1) return [part];
  return [...groups.values()].map((triangles) => {
    const nextPositions: number[] = [];
    const nextIndices: number[] = [];
    triangles.forEach((triangle) => {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = indices ? indices[triangle * 3 + corner] : triangle * 3 + corner;
        const offset = vertex * 3;
        nextIndices.push(nextPositions.length / 3);
        nextPositions.push(positions[offset], positions[offset + 1], positions[offset + 2]);
      }
    });
    return { ...part, positions: Float32Array.from(nextPositions), indices: Uint32Array.from(nextIndices) };
  });
}

type MeshVertex = { x: number; y: number; z: number };

function solidFromCoplanarRegions(cad: OcctKernel, part: CadModifierMeshPart): ShapeHandle | null {
  if (!part.positions || part.positions.length < 9) return null;
  const positions = part.positions;
  const indices = part.indices;
  const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9);
  if (triCount < 24) return null;
  const keyToId = new Map<string, number>();
  const verts: MeshVertex[] = [];
  const idAt = (corner: number) => {
    const vertex = indices ? indices[corner] : corner;
    const offset = vertex * 3;
    const x = weldMeshCoordinate(positions[offset]);
    const y = weldMeshCoordinate(positions[offset + 1]);
    const z = weldMeshCoordinate(positions[offset + 2]);
    const key = `${x},${y},${z}`;
    let id = keyToId.get(key);
    if (id === undefined) {
      id = verts.length;
      keyToId.set(key, id);
      verts.push({ x, y, z });
    }
    return id;
  };
  const tris: Array<[number, number, number]> = [];
  const normals: Array<MeshVertex | null> = [];
  for (let triangle = 0; triangle < triCount; triangle += 1) {
    const a = idAt(triangle * 3);
    const b = idAt(triangle * 3 + 1);
    const c = idAt(triangle * 3 + 2);
    tris.push([a, b, c]);
    const ab = subVec(verts[b], verts[a]);
    const ac = subVec(verts[c], verts[a]);
    const raw = cross(ab, ac);
    const length = Math.hypot(raw.x, raw.y, raw.z);
    normals.push(length < 1e-10 ? null : scaleVec(raw, 1 / length));
  }
  const parent = tris.map((_, index) => index);
  const find = (index: number) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const planes = tris.map((tri, index) => ({ origin: verts[tri[0]], normal: normals[index] }));
  const onPlane = (plane: { origin: MeshVertex; normal: MeshVertex | null }, point: MeshVertex) => {
    if (!plane.normal) return false;
    return Math.abs(dotVec(subVec(point, plane.origin), plane.normal)) <= 0.08;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    const plane = planes[a];
    const other = planes[b];
    if (!plane.normal || !other.normal || dotVec(plane.normal, other.normal) < 0.999) return;
    if (!tris[b].every((id) => onPlane(plane, verts[id]))) return;
    if (!tris[a].every((id) => onPlane(other, verts[id]))) return;
    parent[b] = a;
  };
  const edgeTris = new Map<string, number[]>();
  tris.forEach((tri, index) => {
    [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]].forEach(([u, v]) => {
      const key = u < v ? `${u}|${v}` : `${v}|${u}`;
      const list = edgeTris.get(key) ?? [];
      list.push(index);
      edgeTris.set(key, list);
    });
  });
  edgeTris.forEach((owners) => {
    if (owners.length === 2) union(owners[0], owners[1]);
  });
  const groups = new Map<number, number[]>();
  tris.forEach((_, index) => {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  });
  // Keep a partial merge. A curved mesh still has many unmerged triangles; throwing
  // the flat walls away forced every later fillet to walk those triangles again.
  if (groups.size > triCount * 0.9) return null;
  const faces: ShapeHandle[] = [];
  try {
    for (const [root, members] of groups) {
      const normal = planes[root].normal;
      if (!normal) return null;
      const shared = new Map<string, number>();
      members.forEach((index) => {
        const tri = tris[index];
        [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]].forEach(([u, v]) => {
          const key = u < v ? `${u}|${v}` : `${v}|${u}`;
          shared.set(key, (shared.get(key) ?? 0) + 1);
        });
      });
      const next = new Map<number, number[]>();
      members.forEach((index) => {
        const tri = tris[index];
        [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]].forEach(([u, v]) => {
          const key = u < v ? `${u}|${v}` : `${v}|${u}`;
          if (shared.get(key) !== 1) return;
          const list = next.get(u) ?? [];
          list.push(v);
          next.set(u, list);
        });
      });
      const loops: number[][] = [];
      const used = new Set<string>();
      for (const [start, destinations] of next) {
        for (const destination of destinations) {
          if (used.has(`${start}>${destination}`)) continue;
          const loop = [start];
          let previous = start;
          let current = destination;
          used.add(`${start}>${destination}`);
          let guard = 0;
          while (current !== start && guard < verts.length + 2) {
            guard += 1;
            loop.push(current);
            const options = next.get(current) ?? [];
            const following = options.find((candidate) => !used.has(`${current}>${candidate}`) && candidate !== previous)
              ?? options.find((candidate) => !used.has(`${current}>${candidate}`));
            if (following === undefined) break;
            used.add(`${current}>${following}`);
            previous = current;
            current = following;
          }
          if (current === start && loop.length >= 3) loops.push(loop);
        }
      }
      if (loops.length === 0) return null;
      const simplify = (loop: number[]) => {
        const points = loop.map((id) => verts[id]);
        if (points.length <= 4) return points;
        const kept: MeshVertex[] = [];
        for (let index = 0; index < points.length; index += 1) {
          const prev = points[(index + points.length - 1) % points.length];
          const current = points[index];
          const upcoming = points[(index + 1) % points.length];
          const span = subVec(upcoming, prev);
          const bend = cross(subVec(current, prev), span);
          const spanLength = Math.hypot(span.x, span.y, span.z) || 1;
          if (Math.hypot(bend.x, bend.y, bend.z) / spanLength > 0.02) kept.push(current);
        }
        return kept.length >= 3 ? kept : points;
      };
      const loopArea = (points: MeshVertex[]) => {
        let area = { x: 0, y: 0, z: 0 };
        for (let index = 0; index < points.length; index += 1) {
          const current = points[index];
          const upcoming = points[(index + 1) % points.length];
          area = addVec(area, cross(current, upcoming));
        }
        return dotVec(area, normal);
      };
      const wires = loops.map((loop) => {
        const points = simplify(loop).filter((point, index, all) => {
          const upcoming = all[(index + 1) % all.length];
          return Math.hypot(point.x - upcoming.x, point.y - upcoming.y, point.z - upcoming.z) > 1e-4;
        });
        if (points.length < 3) return null;
        const edges = points.map((point, index) => cad.makeLineEdge(point, points[(index + 1) % points.length]));
        return { wire: cad.makeWire(edges), area: loopArea(points) };
      }).filter((entry): entry is { wire: ShapeHandle; area: number } => entry !== null);
      if (wires.length === 0) return null;
      wires.sort((left, right) => Math.abs(right.area) - Math.abs(left.area));
      let face = cad.makeFace(wires[0].wire);
      if (wires.length > 1) face = cad.addHolesInFace(face, wires.slice(1).map((entry) => entry.wire));
      faces.push(face);
    }
    let solid = cad.fixShape(cad.sewAndSolidify(faces, 1e-3));
    if (!cad.isSolid(solid)) {
      const solids = cad.getSubShapes(solid, "solid");
      if (solids.length !== 1) return null;
      solid = solids[0];
    }
    solid = cad.healSolid(solid, 1e-3);
    solid = cad.fixFaceOrientations(solid);
    solid = cad.unifySameDomain(solid);
    return cad.isSolid(solid) && cadShapeIsValid(cad, solid) ? solid : null;
  } catch {
    return null;
  }
}

export function reconstructSolid(cad: OcctKernel, part: CadModifierMeshPart): ShapeHandle {
  if (part.primitive) {
    return reconstructPrimitiveSolid(cad, part.primitive);
  }
  if (part.brep) {
    let exact = cad.fromBREP(part.brep);
    if (part.brepTransform?.length === 12) exact = cad.generalTransform(exact, part.brepTransform);
    const restoredSolids = cad.getSubShapes(exact, "solid");
    if (cadShapeIsValid(cad, exact) && (cad.isSolid(exact) || restoredSolids.length > 0)) {
      return restoredSolids.length === 1 ? restoredSolids[0] : exact;
    }
    exact = cad.fixShape(exact);
    exact = cad.fixFaceOrientations(exact);
    if (cad.isSolid(exact)) exact = cad.healSolid(exact, 1e-5);
    const healedSolids = cad.getSubShapes(exact, "solid");
    if (cadShapeIsValid(cad, exact) && (cad.isSolid(exact) || healedSolids.length > 0)) {
      return healedSolids.length === 1 ? healedSolids[0] : exact;
    }
    throw new Error("The stored CAD feature could not be restored as a valid solid");
  }
  const shells = splitClosedMeshShells(part);
  if (shells.length > 1) {
    const solids = shells.map((shell) => reconstructSolid(cad, shell));
    return solids.length === 1 ? solids[0] : cad.makeCompound(solids);
  }
  const merged = solidFromCoplanarRegions(cad, part);
  if (merged) return merged;
  const imported = cad.importStl(meshPartToAsciiStl(part));
  let shape = cad.fixShape(imported);
  if (cad.isSolid(shape)) {
    try {
      shape = cad.healSolid(shape, 1e-4);
      shape = cad.fixFaceOrientations(shape);
      shape = cad.removeDegenerateEdges(shape);
      shape = cad.unifySameDomain(shape);
    } catch {
      // Fall through to face sewing when the imported solid cannot be healed directly.
    }
    if (cad.isSolid(shape) && cadShapeIsValid(cad, shape)) return shape;
  }

  const faces = cad.getSubShapes(imported, "face");
  if (faces.length === 0) throw new Error("The selected object has no closed faces");
  for (const tolerance of [1e-4, 1e-3, 1e-2, 5e-2]) {
    for (const build of [
      () => cad.sewAndSolidify(faces, tolerance),
      () => cad.buildSolidFromFaces(faces, tolerance),
    ]) {
      try {
        let candidate = build();
        candidate = cad.fixShape(candidate);
        const solids = cad.isSolid(candidate) ? [candidate] : cad.getSubShapes(candidate, "solid");
        if (solids.length === 1) {
          candidate = solids[0];
          if (cad.isSolid(candidate)) candidate = cad.healSolid(candidate, tolerance);
          candidate = cad.fixFaceOrientations(candidate);
          candidate = cad.removeDegenerateEdges(candidate);
          candidate = cad.unifySameDomain(candidate);
          if (cad.isSolid(candidate) && cadShapeIsValid(cad, candidate)) return candidate;
        } else if (solids.length > 1) {
          const healed = solids.map((solid) => {
            let next = cad.healSolid(solid, tolerance);
            next = cad.fixFaceOrientations(next);
            next = cad.removeDegenerateEdges(next);
            next = cad.unifySameDomain(next);
            return next;
          });
          if (healed.every((solid) => cad.isSolid(solid) && cadShapeIsValid(cad, solid))) {
            return cad.makeCompound(healed);
          }
        }
      } catch {
        // Try the next tolerance. Curved tessellations can need looser vertex sewing.
      }
    }
  }
  throw new Error("The selected mesh is open or non-manifold. Repair it before adding edge treatments.");
}

function reconstructParts(cad: OcctKernel, parts: CadModifierMeshPart[]) {
  const solids = parts.filter((part) => !part.hole).map((part) => reconstructSolid(cad, part));
  const holes = parts.filter((part) => part.hole).map((part) => reconstructSolid(cad, part));
  // Hole-only selection (e.g. thread a hole cutter before grouping) treats the hole body as the solid.
  if (solids.length === 0) {
    if (holes.length === 0) throw new Error("The group has no solid body to modify");
    let holeBody = holes[0];
    for (let index = 1; index < holes.length; index += 1) {
      holeBody = cad.fuse(holeBody, holes[index]);
      holeBody = cad.simplify(holeBody);
      holeBody = cad.unifySameDomain(holeBody);
    }
    return holeBody;
  }
  let result = solids[0];
  for (let index = 1; index < solids.length; index += 1) {
    result = cad.fuse(result, solids[index]);
    result = cad.simplify(result);
    result = cad.unifySameDomain(result);
  }
  for (const hole of holes) {
    result = cad.cut(result, hole);
    result = cad.simplify(result);
    result = cad.unifySameDomain(result);
  }
  result = cad.fixShape(result);
  result = cad.simplify(result);
  result = cad.unifySameDomain(result);
  const pieces = cad.isSolid(result) ? [result] : cad.getSubShapes(result, "solid");
  if (pieces.length === 1) result = pieces[0];
  if (pieces.length === 0 || !pieces.every((piece) => cadShapeIsValid(cad, piece))) {
    throw new Error("The grouped solid could not be repaired into valid topology");
  }
  return result;
}

function shapeVolume(cad: OcctKernel, shape: ShapeHandle) {
  try {
    return Math.abs(cad.getVolume(shape));
  } catch {
    return 0;
  }
}

function singleSolid(cad: OcctKernel, shape: ShapeHandle) {
  if (cad.isSolid(shape)) return shape;
  const solids = cad.getSubShapes(shape, "solid");
  return solids.length === 1 ? solids[0] : shape;
}

function unitVec(v: { x: number; y: number; z: number }) {
  return scaleVec(v, 1 / (Math.hypot(v.x, v.y, v.z) || 1));
}

function subVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * Face orientation flags are not a reliable outward normal. A normal is outward
 * when the solid lies on its negative side.
 */
function reliableOutwardNormal(
  cad: OcctKernel,
  solid: ShapeHandle,
  face: ShapeHandle,
  point: { x: number; y: number; z: number },
) {
  let normal = outwardNormalAt(cad, face, point);
  const plusInside = cad.containsPoint(solid, addVec(point, scaleVec(normal, 0.05)), 1e-6);
  const minusInside = cad.containsPoint(solid, addVec(point, scaleVec(normal, -0.05)), 1e-6);
  if (plusInside && !minusInside) normal = scaleVec(normal, -1);
  return normal;
}

function edgeCurveSample(cad: OcctKernel, edge: ShapeHandle) {
  const params = cad.curveParameters(edge);
  const closed = cad.curveIsClosed(edge);
  const span = params.last - params.first;
  const sampleParam = closed ? params.first + span * 0.37 : params.first + span * 0.5;
  return {
    origin: cad.curvePointAtParam(edge, params.first),
    sample: cad.curvePointAtParam(edge, sampleParam),
    tangent: unitVec(cad.curveTangent(edge, params.first)),
    length: cad.curveLength(edge),
    curve: cad.curveType(edge),
  };
}

type SolidFaceIndex = {
  faces: ShapeHandle[];
  faceByHash: Map<number, ShapeHandle>;
  adjacent: Map<number, number[]>;
};

function solidFaceIndex(cad: OcctKernel, solid: ShapeHandle): SolidFaceIndex {
  const faces = cad.getSubShapes(solid, "face");
  return {
    faces,
    faceByHash: new Map(faces.map((face) => [cad.hashCode(face, HASH_UPPER_BOUND), face])),
    adjacent: parseEdgeFaceMap(cad.edgeToFaceMap(solid, HASH_UPPER_BOUND)),
  };
}

function facesForEdge(cad: OcctKernel, index: SolidFaceIndex, edge: ShapeHandle) {
  const adjacent = index.adjacent.get(cad.hashCode(edge, HASH_UPPER_BOUND)) ?? [];
  return { faceA: index.faceByHash.get(adjacent[0]), faceB: index.faceByHash.get(adjacent[1]) };
}

function edgeIsConcaveOnIndex(cad: OcctKernel, solid: ShapeHandle, edge: ShapeHandle, index: SolidFaceIndex) {
  const { faceA, faceB } = facesForEdge(cad, index, edge);
  if (!faceA || !faceB) return false;
  const { sample } = edgeCurveSample(cad, edge);
  const n1 = reliableOutwardNormal(cad, solid, faceA, sample);
  const n2 = reliableOutwardNormal(cad, solid, faceB, sample);
  const probe = addVec(sample, addVec(scaleVec(n1, 0.03), scaleVec(n2, -0.03)));
  return cad.containsPoint(solid, probe, 1e-6);
}

/**
 * Concave means the solid wraps the long way around the edge, so an OCCT fillet
 * would add material and plug a hole. One shared face map covers every selected
 * edge; rebuilding that map per edge is what stalled a complicated part.
 */
export function edgeIsConcave(cad: OcctKernel, solid: ShapeHandle, edge: ShapeHandle) {
  const index = solidFaceIndex(cad, solid);
  try {
    return edgeIsConcaveOnIndex(cad, solid, edge, index);
  } catch {
    return false;
  } finally {
    releaseHandles(cad, index.faces);
  }
}

function classifyCornerEdges(cad: OcctKernel, solid: ShapeHandle, edges: ShapeHandle[]) {
  const index = solidFaceIndex(cad, solid);
  const concave: ShapeHandle[] = [];
  const convex: ShapeHandle[] = [];
  try {
    edges.forEach((edge) => {
      try {
        (edgeIsConcaveOnIndex(cad, solid, edge, index) ? concave : convex).push(edge);
      } catch {
        convex.push(edge);
      }
    });
  } finally {
    releaseHandles(cad, index.faces);
  }
  return { concave, convex };
}

function outwardNormalAt(cad: OcctKernel, face: ShapeHandle, point: { x: number; y: number; z: number }) {
  const uv = cad.uvFromPoint(face, point);
  const normal = cad.surfaceNormal(face, uv.u, uv.v);
  if (cad.shapeOrientation(face) === "reversed") {
    normal.x *= -1;
    normal.y *= -1;
    normal.z *= -1;
  }
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return { x: normal.x / length, y: normal.y / length, z: normal.z / length };
}

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function scaleVec(v: { x: number; y: number; z: number }, scale: number) {
  return { x: v.x * scale, y: v.y * scale, z: v.z * scale };
}

function addVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function dotVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Directions along each face, pointing into the material next to this edge. */
function materialBinormals(
  cad: OcctKernel,
  solid: ShapeHandle,
  edge: ShapeHandle,
  index: SolidFaceIndex,
) {
  const lookedUp = facesForEdge(cad, index, edge);
  try {
    if (!lookedUp.faceA || !lookedUp.faceB) return null;
    const { origin, sample, tangent, length, curve } = edgeCurveSample(cad, edge);
    if (!(length > 1e-6)) return null;
    let n1: { x: number; y: number; z: number };
    let n2: { x: number; y: number; z: number };
    try {
      n1 = reliableOutwardNormal(cad, solid, lookedUp.faceA, origin);
      n2 = reliableOutwardNormal(cad, solid, lookedUp.faceB, origin);
    } catch {
      n1 = reliableOutwardNormal(cad, solid, lookedUp.faceA, sample);
      n2 = reliableOutwardNormal(cad, solid, lookedUp.faceB, sample);
    }
    let bin1 = unitVec(cross(tangent, n1));
    if (dotVec(bin1, n2) > 0) bin1 = scaleVec(bin1, -1);
    let bin2 = unitVec(cross(tangent, n2));
    if (dotVec(bin2, n1) > 0) bin2 = scaleVec(bin2, -1);
    const probe = addVec(sample, addVec(scaleVec(bin1, 0.05), scaleVec(bin2, 0.05)));
    if (!cad.containsPoint(solid, probe, 1e-4)) {
      bin1 = scaleVec(bin1, -1);
      bin2 = scaleVec(bin2, -1);
    }
    return { start: origin, tangent, length, curve, bin1, bin2 };
  } catch {
    return null;
  }
}

function cylinderAlong(
  cad: OcctKernel,
  start: { x: number; y: number; z: number },
  tangent: { x: number; y: number; z: number },
  length: number,
  radius: number,
) {
  let tool = cad.makeCylinder(radius, length);
  const axis = { x: -tangent.y, y: tangent.x, z: 0 };
  const axisLen = Math.hypot(axis.x, axis.y, axis.z);
  const dot = Math.max(-1, Math.min(1, tangent.z));
  if (axisLen < 1e-8) {
    if (dot < 0) tool = cad.rotate(tool, { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, Math.PI);
  } else {
    tool = cad.rotate(tool, {
      point: { x: 0, y: 0, z: 0 },
      direction: { x: axis.x / axisLen, y: axis.y / axisLen, z: axis.z / axisLen },
    }, Math.acos(dot));
  }
  return cad.translate(tool, start.x, start.y, start.z);
}

function straightCornerTool(
  cad: OcctKernel,
  frame: { start: { x: number; y: number; z: number }; tangent: { x: number; y: number; z: number }; length: number; bin1: { x: number; y: number; z: number }; bin2: { x: number; y: number; z: number } },
  kind: CadModifierKind,
  amount: number,
  second: number,
) {
  const { start, tangent, length, bin1, bin2 } = frame;
  const extrude = scaleVec(tangent, length);
  if (kind === "fillet") {
    const q1 = addVec(start, scaleVec(bin1, amount));
    const q2 = addVec(q1, scaleVec(bin2, amount));
    const q3 = addVec(start, scaleVec(bin2, amount));
    const square = cad.extrude(cad.makeFace(cad.makeWire([
      cad.makeLineEdge(start, q1),
      cad.makeLineEdge(q1, q2),
      cad.makeLineEdge(q2, q3),
      cad.makeLineEdge(q3, start),
    ])), extrude.x, extrude.y, extrude.z);
    const center = addVec(start, addVec(scaleVec(bin1, amount), scaleVec(bin2, amount)));
    return cad.cut(square, cylinderAlong(cad, center, tangent, length, amount));
  }
  const p1 = addVec(start, scaleVec(bin1, amount));
  const p2 = addVec(start, scaleVec(bin2, second));
  return cad.extrude(cad.makeFace(cad.makeWire([
    cad.makeLineEdge(start, p1),
    cad.makeLineEdge(p1, p2),
    cad.makeLineEdge(p2, start),
  ])), extrude.x, extrude.y, extrude.z);
}

/** Profile of the material cap, swept along a curve that has no single straight length. */
function curvedCornerTool(
  cad: OcctKernel,
  edge: ShapeHandle,
  frame: { start: { x: number; y: number; z: number }; bin1: { x: number; y: number; z: number }; bin2: { x: number; y: number; z: number } },
  kind: CadModifierKind,
  amount: number,
  second: number,
) {
  const { start, bin1, bin2 } = frame;
  let profile: ShapeHandle;
  if (kind === "fillet") {
    const phi = Math.acos(Math.max(-1, Math.min(1, dotVec(bin1, bin2))));
    if (phi < 0.15 || phi > Math.PI - 0.15) throw new Error("That edge is too shallow to fillet.");
    const leg = amount / Math.tan(phi / 2);
    const center = addVec(start, scaleVec(unitVec(addVec(bin1, bin2)), amount / Math.sin(phi / 2)));
    const contact1 = addVec(start, scaleVec(bin1, leg));
    const contact2 = addVec(start, scaleVec(bin2, leg));
    const arcMid = addVec(center, scaleVec(unitVec(subVec(start, center)), amount));
    profile = cad.makeFace(cad.makeWire([
      cad.makeLineEdge(start, contact1),
      cad.makeArcEdge(contact1, arcMid, contact2),
      cad.makeLineEdge(contact2, start),
    ]));
  } else {
    const p1 = addVec(start, scaleVec(bin1, amount));
    const p2 = addVec(start, scaleVec(bin2, second));
    profile = cad.makeFace(cad.makeWire([
      cad.makeLineEdge(start, p1),
      cad.makeLineEdge(p1, p2),
      cad.makeLineEdge(p2, start),
    ]));
  }
  return cad.pipe(profile, cad.makeWire([edge]));
}

function edgeMatchSample(cad: OcctKernel, edge: ShapeHandle) {
  const params = cad.curveParameters(edge);
  const closed = cad.curveIsClosed(edge);
  const span = params.last - params.first;
  const sampleParam = closed ? params.first + span * 0.37 : params.first + span * 0.5;
  return {
    sample: cad.curvePointAtParam(edge, sampleParam),
    tangent: unitVec(cad.curveTangent(edge, params.first)),
  };
}

function pointSegmentDistance(
  point: { x: number; y: number; z: number },
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
) {
  const delta = subVec(end, start);
  const lengthSq = dotVec(delta, delta);
  const amount = lengthSq > 1e-12 ? Math.max(0, Math.min(1, dotVec(subVec(point, start), delta) / lengthSq)) : 0;
  return Math.hypot(
    point.x - (start.x + delta.x * amount),
    point.y - (start.y + delta.y * amount),
    point.z - (start.z + delta.z * amount),
  );
}

function findMatchingEdge(cad: OcctKernel, shape: ShapeHandle, sourceEdge: ShapeHandle) {
  let wanted: ReturnType<typeof edgeMatchSample>;
  try {
    wanted = edgeMatchSample(cad, sourceEdge);
  } catch {
    return null;
  }
  // One wireframe for the whole solid. Sampling every edge curve here was a
  // separate CAD call per edge, which is what made the next click wait.
  const wire = cad.wireframe(shape, 0.35);
  let bestHash = 0;
  let bestDistance = 0.4;
  for (let index = 0; index + 2 < wire.edgeGroups.length; index += 3) {
    const start = wire.edgeGroups[index];
    const count = wire.edgeGroups[index + 1];
    const hash = wire.edgeGroups[index + 2];
    if (count < 6) continue;
    let distance = Number.POSITIVE_INFINITY;
    let tangentAlign = 0;
    for (let offset = start; offset + 5 < start + count; offset += 3) {
      const a = { x: wire.points[offset], y: wire.points[offset + 1], z: wire.points[offset + 2] };
      const b = { x: wire.points[offset + 3], y: wire.points[offset + 4], z: wire.points[offset + 5] };
      distance = Math.min(distance, pointSegmentDistance(wanted.sample, a, b));
      const tangent = unitVec(subVec(b, a));
      tangentAlign = Math.max(tangentAlign, Math.abs(dotVec(tangent, wanted.tangent)));
    }
    if (distance < bestDistance && tangentAlign > 0.97) {
      bestHash = hash;
      bestDistance = distance;
    }
  }
  if (!bestHash) return null;
  const edges = cad.getSubShapes(shape, "edge");
  return edges.find((edge) => cad.hashCode(edge, HASH_UPPER_BOUND) === bestHash) ?? null;
}

function recipeMatches(request: { kind: CadModifierKind; amount: number; chamferAngle: number }) {
  return accumulatedKind === request.kind
    && Math.abs(accumulatedAmount - request.amount) < 1e-6
    && Math.abs(accumulatedChamferAngle - request.chamferAngle) < 1e-6;
}

function flippedFrame<T extends { bin1: { x: number; y: number; z: number }; bin2: { x: number; y: number; z: number } }>(frame: T): T {
  return { ...frame, bin1: scaleVec(frame.bin1, -1), bin2: scaleVec(frame.bin2, -1) };
}

/**
 * Hole corners are concave: OCCT's fillet fills them with material and can close the
 * opening. Cut the material wedge instead so the hole stays open and the edge is beveled.
 * A closed curve has no chord, so the wedge is swept along the edge itself.
 */
export function cutConcaveCorners(
  cad: OcctKernel,
  target: ShapeHandle,
  source: ShapeHandle,
  edges: ShapeHandle[],
  kind: CadModifierKind,
  amount: number,
  chamferAngle: number,
) {
  const angle = Math.max(5, Math.min(85, chamferAngle));
  const second = amount * Math.tan((angle * Math.PI) / 180);
  const index = solidFaceIndex(cad, source);
  let current = target;
  try {
  for (const edge of edges) {
    const frame = materialBinormals(cad, source, edge, index);
    if (!frame) throw new Error("A hole edge could not be beveled");
    const before = shapeVolume(cad, current);
    const toolFor = (binormals: typeof frame) => (
      binormals.curve === "line"
        ? straightCornerTool(cad, binormals, kind, amount, second)
        : curvedCornerTool(cad, edge, binormals, kind, amount, second)
    );
    const apply = (binormals: typeof frame) => {
      try {
        const cut = cad.cut(singleSolid(cad, current), toolFor(binormals));
        let shape = singleSolid(cad, cad.simplify(cut));
        const pieces = cad.isSolid(shape) ? [shape] : cad.getSubShapes(shape, "solid");
        if (pieces.length === 1) shape = pieces[0];
        return { shape, pieces: pieces.length };
      } catch {
        return null;
      }
    };
    let applied = apply(frame);
    const expectedDrop = 0.02 * amount * amount * Math.max(frame.length, 1e-3);
    const dropped = (shape: ShapeHandle) => before - shapeVolume(cad, shape) > expectedDrop;
    if (!applied || (applied.pieces === 1 && !dropped(applied.shape))) {
      const retried = apply(flippedFrame(frame));
      if (retried) applied = retried;
    }
    if (!applied) throw new Error("That edge could not be rounded. Try a smaller radius or select fewer edges.");
    const after = shapeVolume(cad, applied.shape);
    const brokeThrough = applied.pieces !== 1 || after < 1e-3 || after < before * 0.5;
    if (applied.pieces === 1 && !dropped(applied.shape)) {
      throw new Error("That edge could not be rounded. Try a smaller radius or select fewer edges.");
    }
    if (brokeThrough || !cadShapeIsValid(cad, applied.shape)) {
      throw new Error(brokeThrough
        ? "That size cuts through the hole. Choose a smaller fillet or chamfer."
        : "That edge could not be rounded. Try a smaller radius or select fewer edges.");
    }
    current = applied.shape;
  }
  return current;
  } finally {
    releaseHandles(cad, index.faces);
  }
}

function applyRemovingTreatment(
  cad: OcctKernel,
  solid: ShapeHandle,
  edges: ShapeHandle[],
  treat: (target: ShapeHandle, selected: ShapeHandle[]) => ShapeHandle,
  kind: CadModifierKind,
  amount: number,
  chamferAngle: number,
) {
  if (edges.length === 0) return cad.copy(solid);
  const before = shapeVolume(cad, solid);
  try {
    const treated = treat(solid, edges);
    // A convex fillet or chamfer removes material. That is the common click,
    // and it does not need a face map of the whole solid.
    if (shapeVolume(cad, treated) + 1e-3 < before) return singleSolid(cad, treated);
    if (treated !== solid) {
      try { cad.release(treated); } catch { /* The filled corner is discarded. */ }
    }
  } catch {
    // A concave corner can reject the direct fillet. Classify it below.
  }
  const { concave, convex } = classifyCornerEdges(cad, solid, edges);
  let component = convex.length > 0 || concave.length === 0
    ? treat(solid, convex.length > 0 ? convex : edges)
    : cad.copy(solid);
  if (concave.length > 0) {
    component = cutConcaveCorners(
      cad,
      singleSolid(cad, component),
      solid,
      concave,
      kind,
      amount,
      chamferAngle,
    );
  }
  return singleSolid(cad, component);
}

function toClassificationInput(edge: CollectedCadEdgeGeometry) {
  return {
    curveType: edge.curveType,
    surfaceTypes: edge.surfaceTypes,
    angle: edge.angle,
    manifold: edge.manifold,
    boundary: edge.boundary,
    pointCount: edge.points.length,
    faceAreas: edge.faceAreas,
  };
}

function releaseHandles(cad: OcctKernel, handles: ShapeHandle[]) {
  handles.forEach((handle) => {
    try {
      cad.release(handle);
    } catch {
      // A failed topology operation can invalidate temporary handles.
    }
  });
}

function collectEdges(cad: OcctKernel, shape: ShapeHandle, sharpAngle: number, suppressTreatmentDetailEdges = false, retainEdgeHandles = false) {
  const handles = cad.getSubShapes(shape, "edge");
  const faces = cad.getSubShapes(shape, "face");
  let keepEdgeHandles = false;
  try {
    const faceByHash = new Map(faces.map((face) => [cad.hashCode(face, HASH_UPPER_BOUND), face]));
    const planarNormals = new Map<number, { x: number; y: number; z: number } | null>();
    const faceAreaByHash = new Map<number, number>();
    if (suppressTreatmentDetailEdges) {
      faces.forEach((face) => {
        const hash = cad.hashCode(face, HASH_UPPER_BOUND);
        let area = 0;
        try {
          area = Math.abs(cad.getSurfaceArea(face));
        } catch {
          area = 0;
        }
        faceAreaByHash.set(hash, area);
      });
    }
    const treatmentAreaLimit = suppressTreatmentDetailEdges ? treatmentDetailFaceAreaLimit([...faceAreaByHash.values()]) : 0;
    const adjacentFaces = parseEdgeFaceMap(cad.edgeToFaceMap(shape, HASH_UPPER_BOUND));
    const wire = cad.wireframe(shape, CAD_EDGE_WIREFRAME_DEFLECTION);
    const pointsByHash = new Map<number, number[]>();
    for (let index = 0; index + 2 < wire.edgeGroups.length; index += 3) {
      const start = wire.edgeGroups[index];
      const count = wire.edgeGroups[index + 1];
      const hash = wire.edgeGroups[index + 2];
      if (!pointsByHash.has(hash)) pointsByHash.set(hash, Array.from(wire.points.slice(start, start + count)));
    }

    const collectedEdges = handles.map((handle, id) => {
      const hash = cad.hashCode(handle, HASH_UPPER_BOUND);
      const faceHashes = adjacentFaces.get(hash) ?? [];
      const points = pointsByHash.get(hash) ?? [];
      const classification = edgeAngle(cad, points, faceHashes, faceByHash, planarNormals);
      const faceAreas = faceHashes.map((faceHash) => faceAreaByHash.get(faceHash) ?? 0);
      const surfaceTypes = faceHashes
        .map((faceHash) => faceByHash.get(faceHash))
        .filter((face): face is ShapeHandle => face !== undefined)
        .map((face) => {
          try {
            return cad.surfaceType(face);
          } catch {
            return "unknown";
          }
        });
      let curveType = "line";
      try {
        curveType = cad.curveType(handle);
      } catch {
        curveType = "unknown";
      }
      const recovered = recoveredHoleRimClassification({
        curveType,
        surfaceTypes,
        angle: classification.angle,
        manifold: classification.manifold,
        boundary: classification.boundary,
      });
      return { id, points, ...recovered, curveType, surfaceTypes, faceAreas };
    }).filter((edge) => edge.points.length >= 6);
    const edges: CollectedCadEdge[] = collectedEdges.map((edge) => {
      const classified = toClassificationInput(edge);
      const display = treatmentAreaLimit > 0
        ? isModifierDisplayCadEdge(classified, treatmentAreaLimit)
        : isDisplayCadEdge(classified);
      return {
        ...edge,
        display,
        selectable: isSelectableModifierEdge(classified) && (treatmentAreaLimit <= 0 || display),
      };
    });
    const selectableEdgeIds = edges.filter((edge) => edge.selectable && edge.angle + 1e-3 >= sharpAngle).map((edge) => edge.id);
    const displayEdges = cadDisplayEdgesFromCollected(edges);
    keepEdgeHandles = retainEdgeHandles;
    return { handles, edges: edges.map(({ curveType: _curveType, surfaceTypes: _surfaceTypes, faceAreas: _faceAreas, ...edge }) => edge), selectableEdgeIds, displayEdges };
  } finally {
    releaseHandles(cad, faces);
    if (!keepEdgeHandles) releaseHandles(cad, handles);
  }
}

function cadDisplayEdgesFromCollected(edges: CollectedCadEdge[]): CadModifierDisplayEdge[] {
  return edges
    .filter((edge) => edge.display)
    .map((edge) => ({ points: edge.points }));
}

function tessellationOptions(quality: CadModifierQuality, amount: number) {
  if (quality === "draft") return { linearDeflection: Math.max(0.12, amount / 3), angularDeflection: 0.42 };
  if (quality === "ultra") return { linearDeflection: Math.max(0.012, amount / 20), angularDeflection: 0.06 };
  if (quality === "fine") return { linearDeflection: Math.max(0.025, amount / 12), angularDeflection: 0.1 };
  return { linearDeflection: Math.max(0.055, amount / 7), angularDeflection: 0.2 };
}

function previewTessellationOptions(amount: number) {
  // Interactive preview only. Flats stay flat; the new fillet stays visibly round
  // without re-faceting every existing curve at the finer apply tolerance.
  return { linearDeflection: Math.max(0.16, amount / 4), angularDeflection: 0.32 };
}

function copyCadMesh(mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array; triangleCount: number }) {
  return {
    positions: new Float32Array(mesh.positions),
    normals: new Float32Array(mesh.normals),
    indices: new Uint32Array(mesh.indices),
    triangleCount: mesh.triangleCount,
  };
}

function isWasmMemoryFault(message: string) {
  return /memory access out of bounds|WebAssembly\.RuntimeError|wasm|abort/i.test(message);
}

function isImportStlWasmFault(message: string) {
  return /importStl:.*WebAssembly\.Exception/i.test(message);
}

function isMissingValidatorFault(message: string) {
  return /isValid/i.test(message) && /null|not a function|undefined/i.test(message);
}

/**
 * The OCCT Emscripten runtime (`occt-wasm.js` / `.wasm`) is loaded lazily via a raw
 * dynamic `import()` from `/occt/`, staged into `public/occt` at dev/build time by
 * `scripts/copy-occt-wasm.mjs` (see predev/prebuild/preexport hooks). If that staging
 * step didn't run — or the packaged app shipped without it — the fetch 404s or returns
 * the SPA fallback HTML, and the browser rejects the dynamic import with one of these
 * messages depending on engine. This is distinct from a worker module load failure
 * (`cadModifierWorkerFailureMessage`), which means the worker script itself never ran.
 */
function isRuntimeModuleLoadFault(message: string) {
  return /failed to fetch dynamically imported module|error loading dynamically imported module|expected a javascript(?:-| )?module script|error resolving module specifier/i.test(message);
}

function vecLength(v: { x: number; y: number; z: number }) {
  return Math.hypot(v.x, v.y, v.z);
}

function normalizeVec(v: { x: number; y: number; z: number }) {
  const length = vecLength(v) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function crossVec(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function collectCylindricalFaces(cad: OcctKernel, shape: ShapeHandle, solids: ShapeHandle[]): {
  handles: ShapeHandle[];
  faces: CadCylindricalFace[];
} {
  const faces = cad.getSubShapes(shape, "face");
  const solidCenter = cad.getCenterOfMass(shape);
  const handles: ShapeHandle[] = [];
  const collected: CadCylindricalFace[] = [];
  try {
    faces.forEach((face) => {
      if (cad.surfaceType(face) !== "cylinder") return;
      const cyl = cad.getFaceCylinderData(face);
      if (!cyl || !(cyl.radius > 1e-6)) return;
      const bounds = cad.uvBounds(face);
      const u0 = bounds.uMin;
      const u1 = bounds.uMax;
      const v0 = bounds.vMin;
      const v1 = bounds.vMax;
      const um = (u0 + u1) / 2;
      const vm = (v0 + v1) / 2;
      let n1 = cad.surfaceNormal(face, u0, vm);
      let n2 = cad.surfaceNormal(face, u1, vm);
      if (cad.shapeOrientation(face) === "reversed") {
        n1 = { x: -n1.x, y: -n1.y, z: -n1.z };
        n2 = { x: -n2.x, y: -n2.y, z: -n2.z };
      }
      let axis = normalizeVec(crossVec(n1, n2));
      if (vecLength(axis) < 1e-6) {
        const n3 = cad.surfaceNormal(face, um, v0);
        axis = normalizeVec(crossVec(n1, n3));
      }
      if (vecLength(axis) < 1e-6) {
        axis = { x: 0, y: 1, z: 0 };
      }
      const faceCenter = cad.getSurfaceCenterOfMass(face);
      const sample = cad.pointOnSurface(face, um, vm);
      const radial = normalizeVec({
        x: sample.x - faceCenter.x,
        y: sample.y - faceCenter.y,
        z: sample.z - faceCenter.z,
      });
      // Re-fit axis so it stays orthogonal to a radial sample when the cross product is noisy.
      if (vecLength(radial) > 1e-6) {
        const corrected = normalizeVec(crossVec(radial, crossVec(axis, radial)));
        if (vecLength(corrected) > 1e-6) axis = corrected;
      }
      const box = cad.getBoundingBox(face, true);
      const corners = [
        { x: box.xmin, y: box.ymin, z: box.zmin },
        { x: box.xmax, y: box.ymin, z: box.zmin },
        { x: box.xmin, y: box.ymax, z: box.zmin },
        { x: box.xmax, y: box.ymax, z: box.zmin },
        { x: box.xmin, y: box.ymin, z: box.zmax },
        { x: box.xmax, y: box.ymin, z: box.zmax },
        { x: box.xmin, y: box.ymax, z: box.zmax },
        { x: box.xmax, y: box.ymax, z: box.zmax },
      ];
      let minProj = Infinity;
      let maxProj = -Infinity;
      corners.forEach((corner) => {
        const proj = (corner.x - faceCenter.x) * axis.x + (corner.y - faceCenter.y) * axis.y + (corner.z - faceCenter.z) * axis.z;
        minProj = Math.min(minProj, proj);
        maxProj = Math.max(maxProj, proj);
      });
      const height = Math.max(0.1, maxProj - minProj);
      const origin = {
        x: faceCenter.x + axis.x * minProj,
        y: faceCenter.y + axis.y * minProj,
        z: faceCenter.z + axis.z * minProj,
      };
      const outwardNormal = normalizeVec({
        x: sample.x - (origin.x + axis.x * height * 0.5),
        y: sample.y - (origin.y + axis.y * height * 0.5),
        z: sample.z - (origin.z + axis.z * height * 0.5),
      });
      const side = inferThreadSideFromFace({
        faceCenter: sample,
        outwardNormal,
        solidCenter,
      });
      let points: number[] = [];
      try {
        const wire = cad.outerWire(face);
        const wireData = cad.wireframe(wire, CAD_EDGE_WIREFRAME_DEFLECTION);
        points = Array.from(wireData.points);
        cad.release(wire);
      } catch {
        points = [
          origin.x, origin.y, origin.z,
          origin.x + axis.x * height, origin.y + axis.y * height, origin.z + axis.z * height,
        ];
      }
      let owner = 0;
      for (let index = 0; index < solids.length; index += 1) {
        try {
          if (cad.containsPoint(solids[index], sample, 1e-4) || cad.containsPoint(solids[index], faceCenter, 1e-4)) {
            owner = index;
            break;
          }
        } catch {
          // keep searching
        }
      }
      const id = collected.length;
      handles.push(face);
      collected.push({
        id,
        owner,
        radius: cyl.radius,
        height,
        side,
        origin,
        axis,
        points,
      });
    });
    return { handles, faces: collected };
  } finally {
    // Face handles we keep are retained in `handles`; release the rest.
    const kept = new Set(handles);
    faces.forEach((face) => {
      if (!kept.has(face)) cad.release(face);
    });
  }
}

function orthonormalFrame(axis: { x: number; y: number; z: number }) {
  const a = normalizeVec(axis);
  const helper = Math.abs(a.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalizeVec(crossVec(helper, a));
  const v = crossVec(a, u);
  return { axis: a, u, v };
}

function releaseQuiet(cad: OcctKernel, handle: ShapeHandle | null | undefined) {
  if (handle === null || handle === undefined) return;
  try {
    cad.release(handle);
  } catch {
    // already consumed/released
  }
}

/**
 * Build a helical V-tooth ridge by piping a triangular profile along a helix.
 * The root is embedded slightly into the selected face so fuse/cut has volume overlap
 * (a tooth that only kisses the surface as a line usually fails boolean validation).
 */
function buildHelicalToothRidge(
  cad: OcctKernel,
  face: CadCylindricalFace,
  params: ResolvedThreadParams,
  _quality: CadModifierQuality,
) {
  const { axis, u } = orthonormalFrame(face.axis);
  const length = Math.max(params.pitch * 1.05, Math.min(params.length, face.height));
  const pitch = Math.max(0.15, params.pitch);
  if (length < pitch * 0.75) {
    throw new Error("Thread length must be at least about one pitch on this face");
  }
  // Always seat on the selected face radius (preset major Ø is only a guide).
  const rootR = Math.max(0.2, face.radius);
  const depth = Math.min(Math.max(0.08, params.depth), rootR * 0.4);
  const embed = Math.min(depth * 0.55, rootR * 0.18);
  const innerR = Math.max(0.05, rootR - embed);
  const tipR = rootR + depth;
  const halfWidth = Math.min(pitch * 0.34, length * 0.4);

  const o = face.origin;
  // Profile in the axis–radial plane at the helix start (embedded root → outer tip).
  const rootA = {
    x: o.x + u.x * innerR - axis.x * halfWidth,
    y: o.y + u.y * innerR - axis.y * halfWidth,
    z: o.z + u.z * innerR - axis.z * halfWidth,
  };
  const tip = {
    x: o.x + u.x * tipR,
    y: o.y + u.y * tipR,
    z: o.z + u.z * tipR,
  };
  const rootB = {
    x: o.x + u.x * innerR + axis.x * halfWidth,
    y: o.y + u.y * innerR + axis.y * halfWidth,
    z: o.z + u.z * innerR + axis.z * halfWidth,
  };

  const e1 = cad.makeLineEdge(rootA, tip);
  const e2 = cad.makeLineEdge(tip, rootB);
  const e3 = cad.makeLineEdge(rootB, rootA);
  const profile = cad.makeWire([e1, e2, e3]);
  let helix = cad.makeHelixWire(o, axis, pitch, length, rootR);
  let mirroredHelix: ShapeHandle | null = null;
  if (params.handedness === "left") {
    mirroredHelix = cad.mirror(helix, o, u);
    releaseQuiet(cad, helix);
    helix = mirroredHelix;
  }

  try {
    let ridge: ShapeHandle;
    try {
      ridge = cad.pipe(profile, helix);
    } catch {
      ridge = cad.simplePipe(profile, helix);
    }
    if (!cad.isSolid(ridge)) {
      // Some pipe results are shells — try to solidify.
      try {
        const solidified = cad.makeSolid(ridge);
        releaseQuiet(cad, ridge);
        ridge = solidified;
      } catch {
        // keep original
      }
    }
    if (!cad.isSolid(ridge)) {
      releaseQuiet(cad, ridge);
      throw new Error("Could not build a solid helical tooth from these thread dimensions");
    }
    return ridge;
  } finally {
    releaseQuiet(cad, profile);
    releaseQuiet(cad, e1);
    releaseQuiet(cad, e2);
    releaseQuiet(cad, e3);
    releaseQuiet(cad, helix);
  }
}

function applyThreadCut(
  cad: OcctKernel,
  solid: ShapeHandle,
  face: CadCylindricalFace,
  request: Extract<CadModifierWorkerRequest, { type: "previewThread" }>,
) {
  const params = resolveThreadParams({
    majorDiameter: request.majorDiameter,
    pitch: request.pitch,
    length: Math.min(request.length, face.height),
    depth: request.depth,
    side: request.side,
    handedness: request.handedness,
  });
  if (params.pitch >= face.height) {
    throw new Error("Pitch is larger than this face height — shorten the pitch or use a taller cylinder");
  }
  if (Math.abs(params.majorDiameter / 2 - face.radius) / Math.max(face.radius, 1e-6) > 0.45) {
    throw new Error(
      `Thread size Ø${params.majorDiameter} mm does not match this face (~Ø${(face.radius * 2).toFixed(2)} mm). Pick a closer metric size or use Custom.`,
    );
  }

  const ridge = buildHelicalToothRidge(cad, face, params, request.quality);
  try {
    let combined: ShapeHandle;
    try {
      // External: fuse the helical tooth onto the cylinder. Internal: cut into the bore wall.
      combined = params.side === "external" ? cad.fuse(solid, ridge) : cad.cut(solid, ridge);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error ?? "");
      throw new Error(
        `Thread boolean failed${detail ? ` (${detail})` : ""}. Try Draft quality, a shorter length, or a pitch that fits the face.`,
      );
    }

    let result = combined;
    try {
      const simplified = cad.unifySameDomain(cad.simplify(combined));
      if (simplified !== combined) {
        releaseQuiet(cad, combined);
      }
      result = simplified;
    } catch {
      result = combined;
    }

    if (!cad.isSolid(result)) {
      releaseQuiet(cad, result);
      throw new Error("Thread boolean did not produce a solid — try a shorter thread length");
    }

    // Strict B-Rep validity can fail on aggressive helix booleans even when the
    // mesh is usable. Accept solids that tessellate cleanly.
    if (!cadShapeIsValid(cad, result)) {
      try {
        const probe = cad.tessellate(result, { linearDeflection: 0.25, angularDeflection: 0.55 });
        if (!probe.triangleCount) {
          throw new Error("empty tessellation");
        }
      } catch {
        releaseQuiet(cad, result);
        throw new Error(
          "Thread boolean produced unusable geometry. Try a smaller pitch, shorter length, or Draft quality.",
        );
      }
    }
    return result;
  } finally {
    releaseQuiet(cad, ridge);
  }
}

/** Serialize prepare/preview/dispose so concurrent requests cannot corrupt the shared OCCT session. */
let cadModifierQueue: Promise<void> = Promise.resolve();

async function handleCadModifierRequest(request: CadModifierWorkerRequest) {
  let cad: OcctKernel | null = null;
  try {
    cad = await kernel();
    const activeCad = cad;
    if (request.type === "dispose") {
      releaseSession(activeCad);
      post({ type: "disposed", requestId: request.requestId });
      return;
    }
    if (request.type === "warmup") {
      post({ type: "warmup", requestId: request.requestId });
      return;
    }
    if (request.type === "prepare") {
      releaseSession(activeCad);
      sourcePartCount = request.parts.length;
      baseShape = reconstructParts(activeCad, request.parts);
      const collected = collectEdges(activeCad, baseShape, request.sharpAngle, Boolean(request.suppressTreatmentDetailEdges), true);
      edgeHandles = collected.handles;
      baseSolids = activeCad.isSolid(baseShape) ? [baseShape] : activeCad.getSubShapes(baseShape, "solid");
      if (baseSolids.length === 0) throw new Error("The selected group contains no closed solid components");
      const ownerEdgeHandles = baseSolids.map((solid) => activeCad.getSubShapes(solid, "edge"));
      try {
        const ownerCandidates = new Map<number, Array<{ owner: number; edge: ShapeHandle }>>();
        ownerEdgeHandles.forEach((componentEdges, owner) => {
          componentEdges.forEach((edge) => {
            const hash = activeCad.hashCode(edge, HASH_UPPER_BOUND);
            const candidates = ownerCandidates.get(hash) ?? [];
            candidates.push({ owner, edge });
            ownerCandidates.set(hash, candidates);
          });
        });
        edgeOwners = edgeHandles.map((edge) => {
          const hash = activeCad.hashCode(edge, HASH_UPPER_BOUND);
          const candidates = ownerCandidates.get(hash) ?? [];
          const exact = candidates.find((candidate) => activeCad.isSame(edge, candidate.edge));
          if (!exact) throw new Error("A CAD edge could not be mapped to its solid component; restart the edge tool");
          return exact.owner;
        });
      } finally {
        ownerEdgeHandles.forEach((componentEdges) => releaseHandles(activeCad, componentEdges));
      }
      const cyl = collectCylindricalFaces(activeCad, baseShape, baseSolids);
      cylindricalFaceHandles = cyl.handles;
      cylindricalFaces = cyl.faces;
      post({
        type: "ready",
        requestId: request.requestId,
        edges: collected.edges.map((edge) => ({ ...edge, owner: edgeOwners[edge.id] ?? 0 })),
        selectableEdgeIds: collected.selectableEdgeIds,
        cylindricalFaces,
        sourceType: activeCad.getShapeType(baseShape),
      });
      return;
    }
    if (baseShape === null) throw new Error("Prepare an object before previewing the modifier");
    if (request.type === "previewThread") {
      const face = cylindricalFaces.find((entry) => entry.id === request.faceId);
      if (!face) throw new Error("Select a highlighted cylindrical face");
      let result: ShapeHandle | null = null;
      try {
        result = applyThreadCut(activeCad, baseShape, face, request);
        if (!cadShapeIsValid(activeCad, result)) throw new Error("The thread parameters create invalid geometry on this face");
        const options = tessellationOptions(request.quality, request.depth);
        const mesh = copyCadMesh(activeCad.tessellate(result, options));
        const displayEdges = collectEdges(activeCad, result, 0).displayEdges;
        const brep = activeCad.toBREP(result);
        let step: string | undefined;
        try {
          step = activeCad.exportStep(result);
        } catch {
          step = undefined;
        }
        post(
          {
            type: "preview",
            requestId: request.requestId,
            positions: mesh.positions,
            normals: mesh.normals,
            indices: mesh.indices,
            triangleCount: mesh.triangleCount,
            brep,
            step,
            displayEdges,
          },
          [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer],
        );
      } finally {
        if (result !== null) activeCad.release(result);
      }
      return;
    }
    if (request.type === "finalize") {
      if (!accumulatedShape) throw new Error("Preview an edge before applying it");
      let brep = "";
      try {
        brep = activeCad.toBREP(accumulatedShape);
      } catch {
        brep = "";
      }
      post({ type: "previewBrep", requestId: request.requestId, brep });
      return;
    }
    if (request.type !== "preview") {
      throw new Error("Unsupported CAD modifier request");
    }
    const selected = request.edgeIds.map((id) => ({ edge: edgeHandles[id], owner: edgeOwners[id] })).filter((entry): entry is { edge: ShapeHandle; owner: number } => entry.edge !== undefined);
    if (selected.length === 0) throw new Error("Select at least one highlighted edge");
    const componentResults: ShapeHandle[] = [];
    let result: ShapeHandle | null = null;
    try {
      const addedIds = request.edgeIds.filter((id) => !accumulatedEdgeIds.includes(id));
      const selectionShrunk = accumulatedEdgeIds.some((id) => !request.edgeIds.includes(id));
      const canAddOntoPrevious = !selectionShrunk
        && addedIds.length > 0
        && accumulatedShape !== null
        && accumulatedEdgeIds.length > 0
        && recipeMatches(request);
      if (canAddOntoPrevious && accumulatedShape) {
        const host = activeCad.copy(accumulatedShape);
        const matched: ShapeHandle[] = [];
        for (const id of addedIds) {
          const source = edgeHandles[id];
          const found = source ? findMatchingEdge(activeCad, host, source) : null;
          if (!found) break;
          matched.push(found);
        }
        if (matched.length === addedIds.length) {
          try {
          const solids = activeCad.isSolid(host) ? [host] : activeCad.getSubShapes(host, "solid");
          const treat = (target: ShapeHandle, edges: ShapeHandle[]) => (
            edges.length === 0
              ? activeCad.copy(target)
              : request.kind === "fillet"
                ? activeCad.fillet(target, edges, request.amount)
                : Math.abs(request.chamferAngle - 45) < 0.001
                  ? activeCad.chamfer(target, edges, request.amount)
                  : activeCad.chamferDistAngle(target, edges, request.amount, request.chamferAngle)
          );
          const applyToSolid = (solid: ShapeHandle, edges: ShapeHandle[]) => applyRemovingTreatment(
            activeCad,
            solid,
            edges,
            treat,
            request.kind,
            request.amount,
            request.chamferAngle,
          );
          if (solids.length <= 1) {
            componentResults.push(applyToSolid(solids[0] ?? host, matched));
          } else {
            const buckets = solids.map(() => [] as ShapeHandle[]);
            matched.forEach((edge) => {
              const sample = edgeCurveSample(activeCad, edge).sample;
              let owner = 0;
              let best = Number.POSITIVE_INFINITY;
              solids.forEach((solid, index) => {
                const box = activeCad.getBoundingBox(solid, false);
                const dx = sample.x < box.xmin ? box.xmin - sample.x : sample.x > box.xmax ? sample.x - box.xmax : 0;
                const dy = sample.y < box.ymin ? box.ymin - sample.y : sample.y > box.ymax ? sample.y - box.ymax : 0;
                const dz = sample.z < box.zmin ? box.zmin - sample.z : sample.z > box.zmax ? sample.z - box.zmax : 0;
                const distance = dx * dx + dy * dy + dz * dz;
                if (distance < best) {
                  best = distance;
                  owner = index;
                }
              });
              buckets[owner].push(edge);
            });
            componentResults.push(activeCad.makeCompound(solids.map((solid, index) => applyToSolid(solid, buckets[index]))));
          }
          } catch {
            componentResults.length = 0;
          }
        }
        if (componentResults.length === 0) {
          try { activeCad.release(host); } catch { /* The host was not used. */ }
        }
      }
      if (componentResults.length === 0) {
      for (let owner = 0; owner < baseSolids.length; owner += 1) {
        const solid = baseSolids[owner];
        const componentEdges = selected.filter((entry) => entry.owner === owner).map((entry) => entry.edge);
        const treat = (target: ShapeHandle, edges: ShapeHandle[]) => (
          edges.length === 0
            ? activeCad.copy(target)
            : request.kind === "fillet"
              ? activeCad.fillet(target, edges, request.amount)
              : Math.abs(request.chamferAngle - 45) < 0.001
                ? activeCad.chamfer(target, edges, request.amount)
                : activeCad.chamferDistAngle(target, edges, request.amount, request.chamferAngle)
        );
        componentResults.push(applyRemovingTreatment(
          activeCad,
          solid,
          componentEdges,
          treat,
          request.kind,
          request.amount,
          request.chamferAngle,
        ));
      }
      }
      result = componentResults.length === 1 ? componentResults[0] : activeCad.makeCompound(componentResults);
      const options = previewTessellationOptions(request.amount);
      let mesh: ReturnType<typeof copyCadMesh>;
      try {
        const probed = activeCad.tessellate(result, options);
        if (!probed.triangleCount) throw new Error("empty tessellation");
        mesh = copyCadMesh(probed);
      } catch {
        throw new Error("The chosen size creates invalid or overlapping edge geometry");
      }
      // Display edges were already collected while preparing. Rebuilding them
      // here walks every tessellation edge again, and the exact solid is written
      // only when the fillet is applied.
      post(
        { type: "preview", requestId: request.requestId, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, triangleCount: mesh.triangleCount, brep: "", displayEdges: [] },
        [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer],
      );
      if (result) {
        const kept = componentResults.length === 1 ? result : activeCad.copy(result);
        if (accumulatedShape && accumulatedShape !== kept) {
          try { activeCad.release(accumulatedShape); } catch { /* Released with the session. */ }
        }
        accumulatedShape = kept;
        accumulatedEdgeIds = [...request.edgeIds];
        accumulatedKind = request.kind;
        accumulatedAmount = request.amount;
        accumulatedChamferAngle = request.chamferAngle;
      }
    } finally {
      componentResults.forEach((component) => {
        if (component !== accumulatedShape) activeCad.release(component);
      });
      if (result !== null && result !== accumulatedShape && componentResults.length > 1) activeCad.release(result);
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error ?? "");
    if (isRuntimeModuleLoadFault(rawMessage)) {
      // The kernel loader itself never resolved, so there is no live OCCT session to release.
      kernelPromise = null;
      post({
        type: "error",
        requestId: request.requestId,
        message: "The CAD engine files (OCCT) are missing or failed to load from /occt. Reinstall PeakCAD, or if you're developing locally, run `npm run copy:occt` and reload the page.",
        resetSession: true,
      });
      return;
    }
    if (isWasmMemoryFault(rawMessage) || isImportStlWasmFault(rawMessage) || isMissingValidatorFault(rawMessage)) {
      if (cad) releaseSession(cad);
      kernelPromise = null;
      const message = isImportStlWasmFault(rawMessage)
        ? "The selected mesh could not be converted into a closed CAD solid. The CAD kernel reset; try Separate Parts, ungrouping, or simplifying the object before adding edge features."
        : isMissingValidatorFault(rawMessage)
          ? "The CAD kernel exposed an incomplete validation function and reset. Start the edge tool again; no page refresh is needed."
        : "The CAD kernel hit a memory fault and reset. Start the edge tool again; no page refresh is needed.";
      post({
        type: "error",
        requestId: request.requestId,
        message,
        resetSession: true,
      });
      return;
    }
    const message = request.type === "preview" && (rawMessage.includes("WebAssembly.Exception") || rawMessage.includes("fillet:") || rawMessage.includes("chamfer:"))
      ? `The selected edges cannot be ${request.kind === "fillet" ? "filleted" : "chamfered"} together at this size. Reduce the size or select fewer connected edges.`
      : rawMessage || "The CAD kernel could not complete this edge treatment";
    if (request.type === "prepare" && cad) releaseSession(cad);
    post({ type: "error", requestId: request.requestId, message });
  }
}

const cadWorkerGlobal = globalThis as typeof globalThis & {
  onmessage: (event: MessageEvent<CadModifierWorkerRequest>) => void;
};
cadWorkerGlobal.onmessage = (event: MessageEvent<CadModifierWorkerRequest>) => {
  const request = event.data;
  cadModifierQueue = cadModifierQueue
    .then(() => handleCadModifierRequest(request))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "CAD worker queue failed");
      post({ type: "error", requestId: request.requestId, message });
    });
};
