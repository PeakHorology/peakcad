/// <reference lib="webworker" />

import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type {
  CadCylindricalFace,
  CadModifierComponentMesh,
  CadModifierDisplayEdge,
  CadModifierEdge,
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
  const last = Math.max(0, pointCount - 3);
  const mid = Math.max(0, Math.floor(pointCount / 6) * 3);
  const quarter = Math.max(0, Math.floor(pointCount / 12) * 3);
  return [...new Set([mid, quarter, 0, last])];
}

function edgeAngle(cad: OcctKernel, points: number[], faceHashes: number[], faceByHash: Map<number, ShapeHandle>) {
  if (faceHashes.length !== 2 || points.length < 6) return { angle: 0, boundary: faceHashes.length < 2, manifold: false };
  const faceA = faceByHash.get(faceHashes[0]);
  const faceB = faceByHash.get(faceHashes[1]);
  if (faceA === undefined || faceB === undefined) return { angle: 0, boundary: false, manifold: false };
  for (const offset of edgeAngleSampleOffsets(points.length)) {
    const point = { x: points[offset], y: points[offset + 1], z: points[offset + 2] };
    try {
      const a = orientedFaceNormal(cad, faceA, point);
      const b = orientedFaceNormal(cad, faceB, point);
      const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
      const rawAngle = (Math.acos(dot) * 180) / Math.PI;
      return { angle: Math.min(rawAngle, 180 - rawAngle), boundary: false, manifold: true };
    } catch {
      // Closed circular edges often fail UV projection at the seam; try another sample.
    }
  }
  return { angle: 0, boundary: false, manifold: false };
}

function meshPartToAsciiStl(part: CadModifierMeshPart) {
  if (!part.positions || !part.indices) throw new Error("The selected object has no mesh data");
  const lines = new Array<string>(part.indices.length / 3 + 2);
  lines[0] = "solid sketchforge";
  const { positions, indices } = part;
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
  lines[lines.length - 1] = "endsolid sketchforge";
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

function reconstructSolid(cad: OcctKernel, part: CadModifierMeshPart) {
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
  for (const tolerance of [1e-5, 1e-4, 1e-3, 1e-2]) {
    try {
      let candidate = cad.sewAndSolidify(faces, tolerance);
      candidate = cad.fixShape(candidate);
      if (cad.isSolid(candidate)) candidate = cad.healSolid(candidate, tolerance);
      candidate = cad.fixFaceOrientations(candidate);
      candidate = cad.removeDegenerateEdges(candidate);
      candidate = cad.unifySameDomain(candidate);
      if (cad.isSolid(candidate) && cadShapeIsValid(cad, candidate)) return candidate;
    } catch {
      // Try the next tolerance. Curved tessellations can need looser vertex sewing.
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
  if (!cadShapeIsValid(cad, result)) throw new Error("The grouped solid could not be repaired into valid topology");
  return result;
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
    const faceAreaByHash = new Map<number, number>();
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
      const classification = edgeAngle(cad, points, faceHashes, faceByHash);
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
    if (request.type === "prepare") {
      releaseSession(activeCad);
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
    if (request.type !== "preview") {
      throw new Error("Unsupported CAD modifier request");
    }
    const selected = request.edgeIds.map((id) => ({ edge: edgeHandles[id], owner: edgeOwners[id] })).filter((entry): entry is { edge: ShapeHandle; owner: number } => entry.edge !== undefined);
    if (selected.length === 0) throw new Error("Select at least one highlighted edge");
    const componentResults: ShapeHandle[] = [];
    let result: ShapeHandle | null = null;
    try {
      for (let owner = 0; owner < baseSolids.length; owner += 1) {
        const solid = baseSolids[owner];
        const componentEdges = selected.filter((entry) => entry.owner === owner).map((entry) => entry.edge);
        const component = componentEdges.length === 0
          ? activeCad.copy(solid)
          : request.kind === "fillet"
            ? activeCad.fillet(solid, componentEdges, request.amount)
            : Math.abs(request.chamferAngle - 45) < 0.001
              ? activeCad.chamfer(solid, componentEdges, request.amount)
              : activeCad.chamferDistAngle(solid, componentEdges, request.amount, request.chamferAngle);
        componentResults.push(component);
      }
      result = componentResults.length === 1 ? componentResults[0] : activeCad.makeCompound(componentResults);
      if (!cadShapeIsValid(activeCad, result)) throw new Error("The chosen size creates invalid or overlapping edge geometry");
      const options = tessellationOptions(request.quality, request.amount);
      const mesh = copyCadMesh(activeCad.tessellate(result, options));
      const displayEdges = collectEdges(activeCad, result, 0).displayEdges;
      const brep = activeCad.toBREP(result);
      let step: string | undefined;
      try {
        step = activeCad.exportStep(result);
      } catch {
        step = undefined;
      }
      const components: CadModifierComponentMesh[] = componentResults.map((component, owner) => {
        const componentMesh = copyCadMesh(activeCad.tessellate(component, options));
        return {
          owner,
          positions: componentMesh.positions,
          normals: componentMesh.normals,
          indices: componentMesh.indices,
          triangleCount: componentMesh.triangleCount,
          brep: activeCad.toBREP(component),
          displayEdges: collectEdges(activeCad, component, 0).displayEdges,
        };
      });
      post(
        { type: "preview", requestId: request.requestId, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, triangleCount: mesh.triangleCount, brep, step, displayEdges, components },
        [
          mesh.positions.buffer,
          mesh.normals.buffer,
          mesh.indices.buffer,
          ...components.flatMap((component) => [component.positions.buffer, component.normals.buffer, component.indices.buffer]),
        ],
      );
    } finally {
      componentResults.forEach((component) => activeCad.release(component));
      if (result !== null && componentResults.length > 1) activeCad.release(result);
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

self.onmessage = (event: MessageEvent<CadModifierWorkerRequest>) => {
  const request = event.data;
  cadModifierQueue = cadModifierQueue
    .then(() => handleCadModifierRequest(request))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error ?? "CAD worker queue failed");
      post({ type: "error", requestId: request.requestId, message });
    });
};

export {};
