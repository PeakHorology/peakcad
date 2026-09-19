import { describe, expect, it, vi } from "vitest";
import { ensureExactBrepSources, sketchOperandsNeedingExactBake, withBakedSketchBrepStep } from "@/lib/sketchBrep";
import type { SketchProfile, WorkplaneShape } from "@/types/sketchforge";

const profile: SketchProfile = {
  points: [],
  segments: [],
};

function mesh(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "sketch-1",
    name: "Sketch",
    kind: "sketch",
    color: "#fff",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 6,
    rotation: 0,
    sketchProfile: profile,
    importedMesh: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      baseWidth: 10,
      baseDepth: 10,
      baseHeight: 6,
      triangleCount: 1,
      sourceFormat: "json",
    },
    ...overrides,
  };
}

function box(): WorkplaneShape {
  return {
    id: "box-1",
    name: "Box",
    kind: "box",
    color: "#fff",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
  };
}

describe("ensureExactBrepSources", () => {
  it("lists sketch meshes without B-Rep as remesh bake operands", () => {
    const sketch = mesh();
    expect(sketchOperandsNeedingExactBake([box(), sketch]).map((shape) => shape.id)).toEqual(["sketch-1"]);
  });

  it("skips native boxes and already-baked sketches", () => {
    const baked = withBakedSketchBrepStep(mesh(), "ISO-10303-21;");
    expect(sketchOperandsNeedingExactBake([box(), baked])).toEqual([]);
  });

  it("bakes sketch children before a remesh-style boolean so OCCT can run", async () => {
    const bake = vi.fn(async () => "ISO-10303-21;SKETCH");
    const [boxShape, sketch] = await ensureExactBrepSources([box(), mesh()], bake);
    expect(bake).toHaveBeenCalledTimes(1);
    expect(boxShape.importedMesh?.brepStep).toBeUndefined();
    expect(sketch.importedMesh?.brepStep).toBe("ISO-10303-21;SKETCH");
  });

  it("keeps the mesh when bake fails so remesh can still fall to mesh CSG", async () => {
    const sketch = await ensureExactBrepSources([mesh()], async () => {
      throw new Error("occt down");
    });
    expect(sketch[0].importedMesh?.brepStep).toBeUndefined();
    expect(sketch[0].importedMesh?.positions.length).toBeGreaterThan(0);
  });
});
