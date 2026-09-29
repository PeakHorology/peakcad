import { beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WorkplaneShape } from "@/types/sketchforge";

// Drive the REAL exporter/importer against the REAL OpenCascade kernel, loaded
// from node_modules instead of the browser-only /occt/ URL. Everything else in
// stepExport.ts / stepImport.ts runs unmodified.
vi.mock("@/lib/brepKernel", async () => {
  const brep = await import("brepjs");
  const { OcctKernel } = await import("occt-wasm");
  const wasm = join(dirname(fileURLToPath(import.meta.resolve("occt-wasm"))), "occt-wasm.wasm");
  let ready: Promise<typeof brep> | null = null;
  return {
    loadBrepWithOcct: () =>
      (ready ??= (async () => {
        const kernel = await OcctKernel.init({ wasm });
        brep.registerKernel("occt-wasm", brep.OcctWasmAdapter.fromKernel(kernel));
        return brep;
      })()),
  };
});

let brep: typeof import("brepjs");
let exportShapesToStep: typeof import("@/lib/stepExport").exportShapesToStep;
let importedShapeFromStep: typeof import("@/lib/stepImport").importedShapeFromStep;
let importedShapesFromStep: typeof import("@/lib/stepImport").importedShapesFromStep;
let importedMeshHasExactSource: typeof import("@/lib/importedBrepSource").importedMeshHasExactSource;
let withBakedImportedBrepSteps: typeof import("@/lib/importedBrepSource").withBakedImportedBrepSteps;
let bakeImportedBrepStepsForSave: typeof import("@/lib/importedBrepSource").bakeImportedBrepStepsForSave;
let importedBrepStepsAwaitingSave: typeof import("@/lib/importedBrepSource").importedBrepStepsAwaitingSave;

beforeAll(async () => {
  brep = await import("brepjs");
  ({
    importedMeshHasExactSource,
    withBakedImportedBrepSteps,
    bakeImportedBrepStepsForSave,
    importedBrepStepsAwaitingSave,
  } = await import("@/lib/importedBrepSource"));
  ({ exportShapesToStep } = await import("@/lib/stepExport"));
  ({ importedShapeFromStep, importedShapesFromStep } = await import("@/lib/stepImport"));
  // Warm the kernel via the mocked loader so brepjs has a registered kernel for
  // the re-import assertions below.
  const { loadBrepWithOcct } = await import("@/lib/brepKernel");
  await loadBrepWithOcct();
});

function shape(overrides: Partial<WorkplaneShape>): WorkplaneShape {
  return {
    id: Math.random().toString(36).slice(2),
    name: "Shape",
    kind: "box",
    color: "#0098c7",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...overrides,
  };
}

async function reimportVolume(blob: Blob): Promise<number> {
  const r = await brep.importSTEP(blob);
  if (!r.ok) throw new Error(`reimport failed: ${String(r.error?.message ?? r.error)}`);
  const v = brep.measureVolume(r.value);
  if (!v.ok) throw new Error("measureVolume failed");
  return v.value;
}

const PI = Math.PI;
const near = (a: number, b: number, relTol = 0.01) => Math.abs(a - b) <= relTol * Math.abs(b) + 1e-6;

describe("STEP export round-trip (real OCCT kernel)", () => {
  it("exports box + cylinder + sphere as exact B-Rep with conserved volume", async () => {
    const box = shape({ kind: "box", name: "Box", x: -30, width: 10, depth: 6, height: 4 });
    const cyl = shape({ kind: "cylinder", name: "Cyl", x: 0, width: 8, depth: 8, height: 12 });
    const sph = shape({ kind: "sphere", name: "Sph", x: 30, width: 10, depth: 10, height: 10 });

    const { blob, exportedCount, skipped } = await exportShapesToStep([box, cyl, sph]);
    expect(exportedCount).toBe(3);
    expect(skipped).toEqual([]);

    const expected = 10 * 6 * 4 + PI * 4 * 4 * 12 + (4 / 3) * PI * 5 ** 3;
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("subtracts an overlapping hole and conserves the cut volume", async () => {
    const body = shape({ kind: "box", name: "Plate", width: 20, depth: 20, height: 10, elevation: 0 });
    // Cylinder hole punched fully through the plate's full height (overhangs both faces).
    const hole = shape({ kind: "cylinder", name: "Bore", hole: true, width: 6, depth: 6, height: 14, elevation: -2 });

    const { blob, exportedCount, skipped } = await exportShapesToStep([body, hole]);
    expect(exportedCount).toBe(1);
    expect(skipped).toEqual([]);

    const expected = 20 * 20 * 10 - PI * 3 * 3 * 10;
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("leaves a body untouched when the hole's AABB does not reach it", async () => {
    const body = shape({ kind: "box", name: "Plate", x: 0, width: 10, depth: 10, height: 10 });
    const farHole = shape({ kind: "cylinder", name: "Bore", hole: true, x: 500, width: 4, depth: 4, height: 20 });

    const { blob } = await exportShapesToStep([body, farHole]);
    expect(near(await reimportVolume(blob), 1000)).toBe(true);
  });

  it("exports a full cone in a multi-solid assembly with conserved volume (occt-wasm 3.6.1 fix)", async () => {
    const cone = shape({ kind: "cone", name: "Cone", x: -20, width: 8, depth: 8, height: 10, baseRadius: 4, topRadius: 0 });
    const box = shape({ kind: "box", name: "Box", x: 20, width: 6, depth: 6, height: 6 });

    const { blob, exportedCount, skipped } = await exportShapesToStep([cone, box]);
    expect(exportedCount).toBe(2);
    expect(skipped).toEqual([]);

    const expected = (1 / 3) * PI * 4 * 4 * 10 + 6 * 6 * 6;
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("exports a truncated cone with conserved volume", async () => {
    const frustum = shape({ kind: "cone", name: "Frustum", width: 10, depth: 10, height: 12, baseRadius: 5, topRadius: 2 });
    const { blob, exportedCount } = await exportShapesToStep([frustum]);
    expect(exportedCount).toBe(1);
    // Frustum volume = (π h / 3)(R² + R r + r²), with R=5, r=2, h=12.
    const expected = (PI * 12 / 3) * (25 + 10 + 4);
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });

  it("exports exact natives (incl. pyramid) and skips empty meshes with a reason", async () => {
    const box = shape({ kind: "box", name: "Box", width: 8, depth: 8, height: 8 });
    const pyramid = shape({ kind: "pyramid", name: "Pyramid", width: 8, depth: 8, height: 8 });
    const meshNoBrep = shape({ kind: "mesh", name: "RawMesh" });

    const { exportedCount, exactCount, facetedCount, skipped } = await exportShapesToStep([box, pyramid, meshNoBrep]);
    expect(exportedCount).toBe(2);
    expect(exactCount).toBe(2);
    expect(facetedCount).toBe(0);
    expect(skipped.map((s) => s.kind)).toEqual(["mesh"]);
    expect(skipped[0]?.reason).toMatch(/no mesh available|no B-Rep|faceted/i);
  });

  it("throws when there is no solid geometry to export", async () => {
    await expect(exportShapesToStep([shape({ kind: "mesh", name: "EmptyMesh" })])).rejects.toThrow(/No solid geometry/i);
  });

  it("exports an assemble Group as multi-solid STEP (not fused)", async () => {
    const assembly = shape({
      kind: "mesh",
      name: "Assembly",
      width: 30,
      depth: 10,
      height: 10,
      csg: { op: "assemble", version: 1 },
      groupedShapes: [
        shape({ id: "left", kind: "box", name: "Left", x: -10, width: 10, depth: 10, height: 10 }),
        shape({ id: "right", kind: "box", name: "Right", x: 10, width: 10, depth: 10, height: 10 }),
      ],
    });
    const { blob, exportedCount, exactCount } = await exportShapesToStep([assembly]);
    expect(exportedCount).toBe(2);
    expect(exactCount).toBe(2);
    // Two separate 10×10×10 boxes → volume 2000 (not a fused solid count of 1).
    expect(near(await reimportVolume(blob), 2000)).toBe(true);
  });

  it("evaluates a live CSG union body to exact B-Rep STEP", async () => {
    const unionBody = shape({
      kind: "mesh",
      name: "UnionBody",
      width: 20,
      depth: 10,
      height: 10,
      csg: { op: "union", version: 1 },
      groupedShapes: [
        shape({ id: "a", kind: "box", name: "A", x: -5, width: 10, depth: 10, height: 10 }),
        shape({ id: "b", kind: "box", name: "B", x: 5, width: 10, depth: 10, height: 10 }),
      ],
    });
    const { blob, exportedCount, skipped } = await exportShapesToStep([unionBody]);
    expect(exportedCount).toBe(1);
    expect(skipped.filter((s) => s.name === "UnionBody")).toEqual([]);
    // Two 10×10×10 boxes sharing a face → volume 2000
    expect(near(await reimportVolume(blob), 2000)).toBe(true);
  });

  it("evaluates a live CSG subtract body (box − cylinder) to exact B-Rep STEP", async () => {
    const cutBody = shape({
      kind: "mesh",
      name: "CutBody",
      width: 20,
      depth: 20,
      height: 10,
      csg: { op: "subtract", version: 1 },
      groupedShapes: [
        shape({ id: "plate", kind: "box", name: "Plate", width: 20, depth: 20, height: 10 }),
        shape({
          id: "bore",
          kind: "cylinder",
          name: "Bore",
          hole: true,
          width: 6,
          depth: 6,
          height: 14,
          elevation: -2,
        }),
      ],
    });
    const { blob, exportedCount } = await exportShapesToStep([cutBody]);
    expect(exportedCount).toBe(1);
    const expected = 20 * 20 * 10 - PI * 3 * 3 * 10;
    expect(near(await reimportVolume(blob), expected)).toBe(true);
  });
});

describe("STEP import → re-export round-trip (real OCCT kernel)", () => {
  it("imports a STEP body, stores its B-Rep, and re-exports it losslessly", async () => {
    // Author a source STEP file straight from the kernel: a 12×8×6 box in CAD Z-up.
    const src = brep.exportSTEP(brep.box(12, 8, 6, { centered: true }));
    expect(src.ok).toBe(true);
    const bytes = await (src as { value: Blob }).value.arrayBuffer();

    const imported = await importedShapeFromStep("widget.step", bytes);
    expect(imported.kind).toBe("mesh");
    expect(imported.importedMesh?.sourceFormat).toBe("step");
    // The exact B-Rep is baked lazily: nothing stored at import, but the source is live.
    expect(imported.importedMesh?.brepStep).toBeUndefined();
    expect(importedMeshHasExactSource(imported.importedMesh)).toBe(true);
    expect(imported.importedMesh?.indices?.length).toBeGreaterThan(0);
    expect(imported.importedMesh?.triangleCount).toBe(imported.importedMesh!.indices!.length / 3);
    // Importer maps CAD Z-up (X12,Y8,Z6) to SketchForge Y-up (width12, height6, depth8).
    expect(near(imported.importedMesh!.baseWidth, 12)).toBe(true);
    expect(near(imported.importedMesh!.baseHeight, 6)).toBe(true);
    expect(near(imported.importedMesh!.baseDepth, 8)).toBe(true);

    // Re-export the imported body at native size and confirm volume survives the
    // import-normalize → store → re-emit pipeline.
    const reexport = await exportShapesToStep([imported]);
    expect(reexport.exportedCount).toBe(1);
    expect(reexport.exactCount).toBe(1);
    expect(reexport.skipped).toEqual([]);
    expect(near(await reimportVolume(reexport.blob), 12 * 8 * 6)).toBe(true);

    // First export bakes the text; attaching it lets a later export / save work without the kernel solid.
    const [baked] = withBakedImportedBrepSteps([imported]);
    expect(baked.importedMesh?.brepStep).toBeTruthy();
    const again = await exportShapesToStep([baked]);
    expect(again.exactCount).toBe(1);
    expect(near(await reimportVolume(again.blob), 12 * 8 * 6)).toBe(true);
  });

  it("bakes exact STEP on explicit save so a reloaded project still exports exact", async () => {
    const left = brep.translate(brep.box(10, 10, 10, { centered: true }), [-15, 0, 0]);
    const right = brep.translate(brep.cylinder(4, 10), [15, 0, 0]);
    const src = brep.exportSTEP(brep.compound([left, right]));
    const bytes = await (src as { value: Blob }).value.arrayBuffer();
    const shapes = await importedShapesFromStep("saved.step", bytes);
    expect(importedBrepStepsAwaitingSave(shapes)).toHaveLength(2);

    const saved = await bakeImportedBrepStepsForSave(shapes);
    expect(saved.baked).toBe(2);
    expect(saved.failedNames).toEqual([]);
    expect(saved.shapes.every((entry) => Boolean(entry.importedMesh?.brepStep))).toBe(true);
    expect(importedBrepStepsAwaitingSave(saved.shapes)).toEqual([]);

    // Reload: a fresh mesh identity misses this session's registry, so only the stored text is left.
    const reloaded = saved.shapes.map((entry) => ({
      ...entry,
      importedMesh: {
        ...entry.importedMesh!,
        positions: entry.importedMesh!.positions.slice(),
        indices: [...entry.importedMesh!.indices!.slice(3), ...entry.importedMesh!.indices!.slice(0, 3)],
      },
    }));
    const reexport = await exportShapesToStep(reloaded);
    expect(reexport.exportedCount).toBe(2);
    expect(reexport.exactCount).toBe(2);
    expect(near(await reimportVolume(reexport.blob), 1000 + PI * 16 * 10)).toBe(true);
  });

  it("falls back to faceted export when a reloaded STEP import has no stored B-Rep", async () => {
    const src = brep.exportSTEP(brep.box(12, 8, 6, { centered: true }));
    const bytes = await (src as { value: Blob }).value.arrayBuffer();
    const imported = await importedShapeFromStep("reloaded.step", bytes);
    // Simulate a reload: the mesh survives but the live kernel solid does not. Rotating the
    // triangle order keeps the geometry and winding but misses this session's registry entry.
    const indices = imported.importedMesh!.indices!;
    const reloaded: WorkplaneShape = {
      ...imported,
      importedMesh: {
        ...imported.importedMesh!,
        positions: imported.importedMesh!.positions.slice(),
        indices: [...indices.slice(3), ...indices.slice(0, 3)],
      },
    };
    expect(importedMeshHasExactSource(reloaded.importedMesh)).toBe(false);
    const reexport = await exportShapesToStep([reloaded]);
    expect(reexport.exportedCount).toBe(1);
    expect(reexport.facetedCount).toBe(1);
  });

  it("imports each solid in a multi-body STEP as its own shape", async () => {
    const left = brep.translate(brep.box(10, 10, 10, { centered: true }), [-15, 0, 0]);
    const right = brep.translate(brep.box(10, 10, 10, { centered: true }), [15, 0, 0]);
    const src = brep.exportSTEP(brep.compound([left, right]));
    expect(src.ok).toBe(true);
    const bytes = await (src as { value: Blob }).value.arrayBuffer();
    const shapes = await importedShapesFromStep("pair.step", bytes);
    expect(shapes).toHaveLength(2);
    expect(shapes.every((entry) => importedMeshHasExactSource(entry.importedMesh))).toBe(true);
    const reexport = await exportShapesToStep(shapes);
    expect(reexport.exportedCount).toBe(2);
    expect(reexport.exactCount).toBe(2);
    expect(near(await reimportVolume(reexport.blob), 2000)).toBe(true);
    const xs = shapes.map((entry) => entry.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeGreaterThan(20);

    // Per-solid local frames: xz-centred, sitting on y=0, placed about the (10, -10) drop point.
    for (const entry of shapes) {
      const positions = entry.importedMesh!.positions;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
        minY = Math.min(minY, positions[i + 1]);
        minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
      }
      expect(Math.abs(minX + maxX)).toBeLessThan(1e-6);
      expect(Math.abs(minZ + maxZ)).toBeLessThan(1e-6);
      expect(Math.abs(minY)).toBeLessThan(1e-6);
      expect(entry.importedMesh!.triangleCount).toBe(entry.importedMesh!.indices!.length / 3);
    }
    expect(Math.min(...shapes.map((entry) => entry.elevation ?? 0))).toBeCloseTo(0, 6);
    const centerX = (Math.min(...shapes.map((entry) => entry.x - entry.width / 2)) + Math.max(...shapes.map((entry) => entry.x + entry.width / 2))) / 2;
    const centerZ = (Math.min(...shapes.map((entry) => entry.z - entry.depth / 2)) + Math.max(...shapes.map((entry) => entry.z + entry.depth / 2))) / 2;
    expect(centerX).toBeCloseTo(10, 6);
    expect(centerZ).toBeCloseTo(-10, 6);
  });

  it("keeps a grouped sketch at the group position when its plane is still in world coordinates", async () => {
    const plane = {
      origin: { x: 80, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      uAxis: { x: 1, y: 0, z: 0 },
    };
    const sketch = shape({
      id: "sk",
      kind: "mesh",
      name: "Sketch",
      x: 0,
      width: 10,
      depth: 10,
      height: 10,
      sketchFinish: "extrude",
      sketchPlane: plane,
      sketchProfile: {
        sketchPlane: plane,
        points: [
          { id: "p0", x: -5, z: -5 },
          { id: "p1", x: 5, z: -5 },
          { id: "p2", x: 5, z: 5 },
          { id: "p3", x: -5, z: 5 },
        ],
        segments: [
          { id: "e0", kind: "line", startId: "p0", endId: "p1" },
          { id: "e1", kind: "line", startId: "p1", endId: "p2" },
          { id: "e2", kind: "line", startId: "p2", endId: "p3" },
          { id: "e3", kind: "line", startId: "p3", endId: "p0" },
        ],
      },
    });
    const group = shape({
      kind: "mesh",
      name: "GroupedSketch",
      x: 80,
      width: 10,
      depth: 10,
      height: 10,
      csg: { op: "union", version: 1 },
      groupedShapes: [sketch],
    });
    const { blob, exportedCount, exactCount } = await exportShapesToStep([group]);
    expect(exportedCount).toBe(1);
    expect(exactCount).toBe(1);
    expect(near(await reimportVolume(blob), 1000)).toBe(true);
    const imported = await brep.importSTEP(blob);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const tess = brep.mesh(imported.value);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < tess.vertices.length; i += 3) {
      minX = Math.min(minX, tess.vertices[i]);
      maxX = Math.max(maxX, tess.vertices[i]);
    }
    expect((minX + maxX) / 2).toBeCloseTo(80, 0);
  });

  it("cuts a grouped planar sketch hole and keeps the group position", async () => {
    const plane = {
      origin: { x: 40, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      uAxis: { x: 1, y: 0, z: 0 },
    };
    const box = shape({ id: "plate", kind: "box", name: "Plate", x: 0, width: 20, depth: 20, height: 10 });
    const hole = shape({
      id: "sk-hole",
      kind: "mesh",
      name: "Hole",
      hole: true,
      x: 0,
      width: 6,
      depth: 6,
      height: 10,
      sketchFinish: "extrude",
      sketchPlane: plane,
      sketchProfile: {
        sketchPlane: plane,
        points: [
          { id: "p0", x: -3, z: -3 },
          { id: "p1", x: 3, z: -3 },
          { id: "p2", x: 3, z: 3 },
          { id: "p3", x: -3, z: 3 },
        ],
        segments: [
          { id: "e0", kind: "line", startId: "p0", endId: "p1" },
          { id: "e1", kind: "line", startId: "p1", endId: "p2" },
          { id: "e2", kind: "line", startId: "p2", endId: "p3" },
          { id: "e3", kind: "line", startId: "p3", endId: "p0" },
        ],
      },
    });
    const group = shape({
      kind: "mesh",
      name: "GroupedHole",
      x: 40,
      width: 20,
      depth: 20,
      height: 10,
      csg: { op: "subtract", version: 1 },
      groupedShapes: [box, hole],
    });
    const { blob, exportedCount, exactCount } = await exportShapesToStep([group]);
    expect(exportedCount).toBe(1);
    expect(exactCount).toBe(1);
    expect(near(await reimportVolume(blob), 20 * 20 * 10 - 6 * 6 * 10)).toBe(true);
    const imported = await brep.importSTEP(blob);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const tess = brep.mesh(imported.value);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < tess.vertices.length; i += 3) {
      minX = Math.min(minX, tess.vertices[i]);
      maxX = Math.max(maxX, tess.vertices[i]);
    }
    expect((minX + maxX) / 2).toBeCloseTo(40, 0);
  });

  it("bakes a circular barrel sketch as an exact radial cylinder", async () => {
    const points = Array.from({ length: 16 }, (_, index) => {
      const t = (index / 16) * Math.PI * 2;
      return { id: `p${index}`, x: Math.cos(t) * 2, z: Math.sin(t) * 2 };
    });
    const surface = {
      kind: "cylinder" as const,
      axisOrigin: { x: 0, y: 5, z: 0 },
      axisDir: { x: 0, y: 1, z: 0 },
      radial0: { x: 1, y: 0, z: 0 },
      radius: 10,
      height: 10,
      theta0: 0,
    };
    const plane = {
      origin: { x: 10, y: 5, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      uAxis: { x: 0, y: 0, z: 1 },
      surface,
    };
    const boss = shape({
      kind: "mesh",
      name: "BarrelBoss",
      width: 4,
      depth: 4,
      height: 4,
      sketchFinish: "extrude",
      sketchPlane: plane,
      sketchProfile: {
        sketchPlane: plane,
        points,
        segments: points.map((_, index) => ({
          id: `e${index}`,
          kind: "line" as const,
          startId: `p${index}`,
          endId: `p${(index + 1) % points.length}`,
        })),
      },
    });
    const { blob, exportedCount, exactCount } = await exportShapesToStep([boss]);
    expect(exportedCount).toBe(1);
    expect(exactCount).toBe(1);
    expect(near(await reimportVolume(blob), Math.PI * 4 * 4)).toBe(true);
  });
});
