import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Brush, Evaluator, HOLLOW_SUBTRACTION, SUBTRACTION, type CSGOperation } from "three-bvh-csg";
import { analyzeTriangleSoup } from "@/lib/svgImport";
import {
  defaultSketchPlane,
  isDefaultSketchPlane,
  sketchBasisMatrix,
  sketchPlaneFromFaceHit,
  type SketchVec3,
} from "@/lib/sketchPlane";
import type { SketchPlane } from "@/types/sketchforge";

/** Mirrors shapeFromSketchProfile ExtrudeGeometry path (closed rectangular UV profile). */
function extrudeRectSketchHole(
  plane: SketchPlane,
  height: number,
  halfU: number,
  halfV: number,
  centerU = 0,
  centerV = 0,
  options: { curveSegments?: number; toNonIndexed?: boolean } = {},
): THREE.BufferGeometry {
  const minX = centerU - halfU;
  const maxX = centerU + halfU;
  const minZ = centerV - halfV;
  const maxZ = centerV + halfV;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const safeHeight = Math.max(0.01, height);

  const outline = new THREE.Shape();
  const corners: Array<[number, number]> = [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
  const first = corners[0];
  outline.moveTo(first[0] - centerX, -(first[1] - centerZ));
  for (let i = 1; i < corners.length; i += 1) {
    const [x, z] = corners[i];
    outline.lineTo(x - centerX, -(z - centerZ));
  }
  outline.closePath();

  const geometry = new THREE.ExtrudeGeometry(outline, {
    depth: safeHeight,
    bevelEnabled: false,
    steps: 1,
    curveSegments: options.curveSegments ?? 1,
  });
  geometry.rotateX(-Math.PI / 2);

  const uvCenterLocal = new THREE.Matrix4().makeTranslation(centerX, 0, centerZ);
  geometry.applyMatrix4(uvCenterLocal);
  geometry.applyMatrix4(sketchBasisMatrix(plane));

  // Face sketches: extrude inward along -normal so the solid overlaps the host.
  if (!isDefaultSketchPlane(plane)) {
    const n = plane.normal;
    geometry.translate(-n.x * safeHeight, -n.y * safeHeight, -n.z * safeHeight);
  }

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  if (options.toNonIndexed !== false && geometry.index) {
    const nonIndexed = geometry.toNonIndexed();
    geometry.dispose();
    nonIndexed.computeVertexNormals();
    nonIndexed.computeBoundingBox();
    return nonIndexed;
  }
  return geometry;
}

function boxSolid(size: number, center: SketchVec3): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(size, size, size);
  geometry.translate(center.x, center.y, center.z);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  const pos = geometry.getAttribute("position");
  return Math.floor((pos?.count ?? 0) / 3);
}

function positionsFlat(geometry: THREE.BufferGeometry): number[] {
  const position = geometry.getAttribute("position");
  if (!position) return [];
  if (geometry.index) {
    const index = geometry.index;
    const out: number[] = [];
    for (let i = 0; i < index.count; i += 1) {
      const vi = index.getX(i);
      out.push(position.getX(vi), position.getY(vi), position.getZ(vi));
    }
    return out;
  }
  return Array.from(position.array as ArrayLike<number>);
}

/** Count edges by exact vertex index (not position). Non-indexed soups look fully open. */
function indexedBoundaryEdgeCount(geometry: THREE.BufferGeometry): {
  uniqueVertexCount: number;
  positionVertexCount: number;
  boundaryEdgesByIndex: number;
  edgesWithCountNot2: number;
} {
  const position = geometry.getAttribute("position");
  const positionVertexCount = position?.count ?? 0;
  const edgeCounts = new Map<string, number>();
  const bump = (a: number, b: number) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  };

  if (geometry.index) {
    const index = geometry.index;
    for (let i = 0; i + 2 < index.count; i += 3) {
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      bump(a, b);
      bump(b, c);
      bump(c, a);
    }
  } else {
    for (let i = 0; i + 2 < positionVertexCount; i += 3) {
      bump(i, i + 1);
      bump(i + 1, i + 2);
      bump(i + 2, i);
    }
  }

  let boundaryEdgesByIndex = 0;
  let edgesWithCountNot2 = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryEdgesByIndex += 1;
    if (count !== 2) edgesWithCountNot2 += 1;
  }

  // Quantize positions to estimate true unique verts after merge.
  const unique = new Set<string>();
  for (let i = 0; i < positionVertexCount; i += 1) {
    unique.add(
      `${Math.round(position.getX(i) * 1e6)},${Math.round(position.getY(i) * 1e6)},${Math.round(position.getZ(i) * 1e6)}`,
    );
  }

  return {
    uniqueVertexCount: unique.size,
    positionVertexCount,
    boundaryEdgesByIndex,
    edgesWithCountNot2,
  };
}

function trySketchHoleCut(
  solidGeometry: THREE.BufferGeometry,
  holeGeometry: THREE.BufferGeometry,
  operations: CSGOperation[] = [SUBTRACTION, HOLLOW_SUBTRACTION],
): {
  ok: boolean;
  operation: string | null;
  solidTris: number;
  holeTris: number;
  trianglesAfter: number;
  resultAnalysis: ReturnType<typeof analyzeTriangleSoup> | null;
  error: string | null;
} {
  const solidTris = triangleCount(solidGeometry);
  const holeTris = triangleCount(holeGeometry);
  let lastError: string | null = null;

  for (const operation of operations) {
    try {
      const evaluator = new Evaluator();
      evaluator.useGroups = false;
      evaluator.attributes = ["position", "normal"];
      (evaluator as Evaluator & { useCDTClipping?: boolean }).useCDTClipping = true;

      const solid = new Brush(solidGeometry.clone());
      const hole = new Brush(holeGeometry.clone());
      solid.updateMatrixWorld(true);
      hole.updateMatrixWorld(true);

      const result = evaluator.evaluate(solid, hole, operation);
      result.updateMatrixWorld(true);
      const trianglesAfter = triangleCount(result.geometry);

      if (trianglesAfter <= 0) {
        lastError = `${String(operation)} produced empty geometry`;
        continue;
      }
      if (Math.abs(trianglesAfter - solidTris) <= 1) {
        lastError = `${String(operation)} triangle count unchanged (${trianglesAfter} vs solid ${solidTris})`;
        continue;
      }

      let resultAnalysis: ReturnType<typeof analyzeTriangleSoup> | null = null;
      try {
        resultAnalysis = analyzeTriangleSoup(positionsFlat(result.geometry));
      } catch (err) {
        lastError = `${String(operation)} analyze failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      return {
        ok: true,
        operation: String(operation),
        solidTris,
        holeTris,
        trianglesAfter,
        resultAnalysis,
        error: null,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    ok: false,
    operation: null,
    solidTris,
    holeTris,
    trianglesAfter: -1,
    resultAnalysis: null,
    error: lastError,
  };
}

async function tryManifoldOfMeshAndSubtract(
  solidGeometry: THREE.BufferGeometry,
  holeGeometry: THREE.BufferGeometry,
): Promise<{
  available: boolean;
  holeStatusWithoutMerge: string | null;
  holeStatusWithMerge: string | null;
  holeTrisAfterMerge: number | null;
  subtractStatus: string | null;
  subtractTris: number | null;
  subtractBoundaryEdges: number | null;
  error: string | null;
}> {
  try {
    // Prefer package entry used by the app when available in node tests.
    const manifoldMod = await import("manifold-3d");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("manifold-3d/manifold.wasm");
    const fs = await import("node:fs");
    const wasmBinary = fs.readFileSync(wasmPath);
    const runtime = await (manifoldMod.default as (cfg: { wasmBinary: Uint8Array }) => Promise<{
      setup: () => void;
      Mesh: new (data: {
        numProp: number;
        vertProperties: Float32Array;
        triVerts: Uint32Array;
        tolerance?: number;
      }) => { merge: () => void; numTri?: () => number; delete?: () => void };
      Manifold: {
        ofMesh: (mesh: unknown) => {
          status: () => string;
          numTri: () => number;
          getMesh: () => { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
          subtract: (other: unknown) => {
            status: () => string;
            numTri: () => number;
            getMesh: () => { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
            delete?: () => void;
          };
          delete?: () => void;
        };
        cube: (size: [number, number, number]) => {
          status: () => string;
          numTri: () => number;
          getMesh: () => { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
          translate: (offset: [number, number, number]) => unknown;
          subtract: (other: unknown) => {
            status: () => string;
            numTri: () => number;
            getMesh: () => { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
            delete?: () => void;
          };
          delete?: () => void;
        };
      };
    }>)({ wasmBinary });
    runtime.setup();

    const toManifoldMesh = (geometry: THREE.BufferGeometry, merge: boolean) => {
      const positions = positionsFlat(geometry);
      const vertProperties = new Float32Array(positions);
      const triVerts = new Uint32Array(positions.length / 3);
      for (let i = 0; i < triVerts.length; i += 1) triVerts[i] = i;
      const mesh = new runtime.Mesh({
        numProp: 3,
        vertProperties,
        triVerts,
        tolerance: 0.0001,
      });
      if (merge) mesh.merge();
      return mesh;
    };

    const holeNoMerge = toManifoldMesh(holeGeometry, false);
    let holeStatusWithoutMerge: string | null = null;
    try {
      const solid = runtime.Manifold.ofMesh(holeNoMerge);
      holeStatusWithoutMerge = `${solid.status()} tris=${solid.numTri()}`;
      solid.delete?.();
    } catch (err) {
      holeStatusWithoutMerge = `throw: ${err instanceof Error ? err.message : String(err)}`;
    }

    const holeMerged = toManifoldMesh(holeGeometry, true);
    let holeStatusWithMerge: string | null = null;
    let holeTrisAfterMerge: number | null = null;
    let holeSolid: ReturnType<typeof runtime.Manifold.ofMesh> | null = null;
    try {
      holeSolid = runtime.Manifold.ofMesh(holeMerged);
      holeStatusWithMerge = holeSolid.status();
      holeTrisAfterMerge = holeSolid.numTri();
    } catch (err) {
      holeStatusWithMerge = `throw: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Build solid from BoxGeometry positions the same way (triangle soup + merge).
    const solidMerged = toManifoldMesh(solidGeometry, true);
    let subtractStatus: string | null = null;
    let subtractTris: number | null = null;
    let subtractBoundaryEdges: number | null = null;
    try {
      const solid = runtime.Manifold.ofMesh(solidMerged);
      if (!holeSolid || holeSolid.status() !== "NoError") {
        subtractStatus = "hole not manifold";
      } else {
        const result = solid.subtract(holeSolid);
        subtractStatus = result.status();
        subtractTris = result.numTri();
        const out = result.getMesh();
        const positions: number[] = [];
        for (let i = 0; i < out.triVerts.length; i += 1) {
          const vi = out.triVerts[i];
          const o = vi * out.numProp;
          positions.push(out.vertProperties[o], out.vertProperties[o + 1], out.vertProperties[o + 2]);
        }
        subtractBoundaryEdges = analyzeTriangleSoup(positions).boundaryEdges;
        result.delete?.();
      }
      solid.delete?.();
    } catch (err) {
      subtractStatus = `throw: ${err instanceof Error ? err.message : String(err)}`;
    }

    holeSolid?.delete?.();
    holeNoMerge.delete?.();
    holeMerged.delete?.();
    solidMerged.delete?.();

    return {
      available: true,
      holeStatusWithoutMerge,
      holeStatusWithMerge,
      holeTrisAfterMerge,
      subtractStatus,
      subtractTris,
      subtractBoundaryEdges,
      error: null,
    };
  } catch (err) {
    return {
      available: false,
      holeStatusWithoutMerge: null,
      holeStatusWithMerge: null,
      holeTrisAfterMerge: null,
      subtractStatus: null,
      subtractTris: null,
      subtractBoundaryEdges: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("sketch extrusion hole CSG (shapeFromSketchProfile approach)", () => {
  it("ExtrudeGeometry rect hole is position-watertight but index-open after toNonIndexed", () => {
    const hole = extrudeRectSketchHole(defaultSketchPlane(), 22, 4, 4);
    const byIndex = indexedBoundaryEdgeCount(hole);
    const analysis = analyzeTriangleSoup(positionsFlat(hole));

    // eslint-disable-next-line no-console
    console.log("[extrude topology]", { byIndex, analysis });

    // Production stores toNonIndexed triangle soup: every index-edge is unique.
    expect(byIndex.boundaryEdgesByIndex).toBeGreaterThan(0);
    expect(byIndex.positionVertexCount).toBeGreaterThan(byIndex.uniqueVertexCount);

    // After position merge (what Manifold.merge / analyzeTriangleSoup do), rect extrude is closed.
    expect(analysis.boundaryEdges).toBe(0);
    expect(analysis.nonManifoldEdges).toBe(0);
    expect(analysis.degenerateTriangles).toBe(0);
    expect(analysis.triangleCount).toBeGreaterThanOrEqual(12);
    expect(analysis.volume).toBeGreaterThan(0);
  });

  it("THREE.ExtrudeGeometry emits non-indexed triangle soup even before toNonIndexed", () => {
    const hole = extrudeRectSketchHole(defaultSketchPlane(), 22, 4, 4, 0, 0, { toNonIndexed: false });
    const byIndex = indexedBoundaryEdgeCount(hole);
    // eslint-disable-next-line no-console
    console.log("[raw ExtrudeGeometry topology]", {
      hasIndex: Boolean(hole.getIndex()),
      ...byIndex,
    });
    // three@0.184 ExtrudeGeometry is already a non-indexed soup (36 verts / 12 tris for a box).
    expect(hole.getIndex()).toBeNull();
    expect(byIndex.positionVertexCount).toBe(36);
    expect(byIndex.uniqueVertexCount).toBe(8);
    expect(byIndex.boundaryEdgesByIndex).toBe(36);
  });

  it("default workplane sketch hole cuts an overlapping box (SUBTRACTION first)", () => {
    const solid = boxSolid(20, { x: 0, y: 10, z: 0 });
    const hole = extrudeRectSketchHole(defaultSketchPlane(), 22, 4, 4);

    const solidBB = solid.boundingBox!;
    const holeBB = hole.boundingBox!;
    expect(solidBB.intersectsBox(holeBB)).toBe(true);

    const cut = trySketchHoleCut(solid, hole);
    // eslint-disable-next-line no-console
    console.log("[default workplane sketch hole]", cut);

    expect(cut.ok, cut.error ?? "CSG failed").toBe(true);
    expect(cut.operation).toBe(String(SUBTRACTION));
    expect(cut.trianglesAfter).toBeGreaterThan(cut.solidTris);
    // Clean cavity should stay compact — ExtrudeGeometry box cut of BoxGeometry.
    expect(cut.trianglesAfter).toBeLessThan(80);
    expect(cut.resultAnalysis?.boundaryEdges ?? -1).toBe(0);
  });

  it("face-plane sketch (+X) with inward translation cuts an overlapping box", () => {
    const solid = boxSolid(20, { x: 0, y: 10, z: 0 });
    const plane = sketchPlaneFromFaceHit({ x: 10, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, "box-host");
    expect(isDefaultSketchPlane(plane)).toBe(false);
    expect(plane.normal.x).toBeCloseTo(1);

    const hole = extrudeRectSketchHole(plane, 12, 3, 3);

    const solidBB = solid.boundingBox!;
    const holeBB = hole.boundingBox!;
    expect(solidBB.intersectsBox(holeBB)).toBe(true);
    expect(holeBB.min.x).toBeLessThan(10);
    expect(holeBB.max.x).toBeCloseTo(10, 1);

    const cut = trySketchHoleCut(solid, hole);
    // eslint-disable-next-line no-console
    console.log("[face-plane +X sketch hole]", cut);

    expect(cut.ok, cut.error ?? "CSG failed").toBe(true);
    expect(cut.operation).toBe(String(SUBTRACTION));
    expect(cut.trianglesAfter).toBeGreaterThan(0);
    expect(cut.trianglesAfter).not.toBe(triangleCount(solid));
    // Face-plane ExtrudeGeometry + BVH leaves open / non-manifold cut boundaries.
    expect((cut.resultAnalysis?.boundaryEdges ?? 0) + (cut.resultAnalysis?.nonManifoldEdges ?? 0)).toBeGreaterThan(0);
  });

  it("BVH SUBTRACTION cavity is watertight-ish but non-manifold; Manifold is cleaner", async () => {
    const solid = boxSolid(20, { x: 0, y: 10, z: 0 });
    const hole = extrudeRectSketchHole(defaultSketchPlane(), 22, 4, 4);
    const solidCut = trySketchHoleCut(solid, hole, [SUBTRACTION]);
    const hollowCut = trySketchHoleCut(solid, hole, [HOLLOW_SUBTRACTION]);
    const manifold = await tryManifoldOfMeshAndSubtract(solid, hole);

    // eslint-disable-next-line no-console
    console.log("[quality comparison]", {
      subtraction: {
        tris: solidCut.trianglesAfter,
        boundary: solidCut.resultAnalysis?.boundaryEdges,
        nonManifold: solidCut.resultAnalysis?.nonManifoldEdges,
        volume: solidCut.resultAnalysis?.volume,
      },
      hollow: {
        tris: hollowCut.trianglesAfter,
        boundary: hollowCut.resultAnalysis?.boundaryEdges,
        nonManifold: hollowCut.resultAnalysis?.nonManifoldEdges,
        volume: hollowCut.resultAnalysis?.volume,
      },
      manifold: {
        tris: manifold.subtractTris,
        boundary: manifold.subtractBoundaryEdges,
        status: manifold.subtractStatus,
      },
    });

    expect(solidCut.ok).toBe(true);
    expect(hollowCut.ok).toBe(true);
    // Preferring SUBTRACTION still leaves non-manifold edges from ExtrudeGeometry cutters.
    expect(solidCut.resultAnalysis?.nonManifoldEdges ?? 0).toBeGreaterThan(0);
    if (manifold.available) {
      expect(manifold.subtractStatus).toBe("NoError");
      expect(manifold.subtractTris ?? 0).toBeLessThan(solidCut.trianglesAfter);
      expect(manifold.subtractBoundaryEdges).toBe(0);
    }
  });

  it("Manifold.ofMesh needs merge() for non-indexed ExtrudeGeometry soup", async () => {
    const solid = boxSolid(20, { x: 0, y: 10, z: 0 });
    const hole = extrudeRectSketchHole(defaultSketchPlane(), 22, 4, 4);
    const manifold = await tryManifoldOfMeshAndSubtract(solid, hole);
    // eslint-disable-next-line no-console
    console.log("[manifold ofMesh]", manifold);

    if (!manifold.available) {
      // WASM may be unavailable in some CI sandboxes — topology assertions above still hold.
      expect(manifold.error).toBeTruthy();
      return;
    }

    // Without merge, triangle-soup ExtrudeGeometry is not index-manifold (worker path bug risk).
    expect(manifold.holeStatusWithoutMerge).not.toMatch(/^NoError/);
    expect(manifold.holeStatusWithMerge).toBe("NoError");
    expect(manifold.subtractStatus).toBe("NoError");
    expect(manifold.subtractTris ?? 0).toBeGreaterThan(12);
    expect(manifold.subtractBoundaryEdges).toBe(0);
  });
});
