import { describe, expect, it } from "vitest";
import {
  classifyMeshNeighborhoodPlanarity,
  classifySketchFaceHit,
  discCapFaceLoop,
} from "@/lib/sketchFaceClassify";
import type { WorkplaneShape } from "@/types/sketchforge";

function cylinder(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "cyl-1",
    name: "Cylinder",
    kind: "cylinder",
    color: "#d97813",
    x: 0,
    z: 0,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 40,
    rotation: 0,
    sides: 64,
    locked: false,
    hidden: false,
    ...overrides,
  };
}

describe("classifySketchFaceHit", () => {
  it("accepts cylinder top and bottom caps as planar disc faces", () => {
    const shape = cylinder();
    const top = classifySketchFaceHit(shape, { x: 2, y: 40, z: -1 }, { x: 0, y: 1, z: 0 });
    expect(top.kind).toBe("planar");
    expect(top.analytic?.type).toBe("disc-cap");
    expect(top.plane?.hostShapeId).toBe("cyl-1");
    expect(top.analytic?.radius).toBeCloseTo(10, 5);
    expect(top.plane?.origin.y).toBeCloseTo(40, 3);

    const bottom = classifySketchFaceHit(shape, { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(bottom.kind).toBe("planar");
    expect(bottom.analytic?.type).toBe("disc-cap");
    expect(bottom.plane?.origin.y).toBeCloseTo(0, 3);
  });

  it("accepts circular cylinder barrel side picks as cylindrical unwraps", () => {
    const shape = cylinder();
    // Mid-height on the side wall; outward radial normal.
    const side = classifySketchFaceHit(shape, { x: 10, y: 20, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(side.kind).toBe("cylindrical");
    expect(side.analytic?.type).toBe("barrel");
    expect(side.plane?.surface?.kind).toBe("cylinder");
    expect(side.plane?.hostShapeId).toBe("cyl-1");
  });

  it("blocks elliptical cylinder barrels", () => {
    const shape = cylinder({ depth: 12 });
    const side = classifySketchFaceHit(shape, { x: 10, y: 20, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(side.kind).toBe("curved");
    expect(side.blockedReason).toMatch(/circular|elliptical|flat end/i);
  });

  it("blocks sphere faces entirely", () => {
    const shape = cylinder({ kind: "sphere", height: 20, width: 20, depth: 20 });
    const hit = classifySketchFaceHit(shape, { x: 0, y: 20, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(hit.kind).toBe("curved");
    expect(hit.blockedReason).toMatch(/curved/i);
  });

  it("allows half-sphere flat cut and blocks the dome", () => {
    const shape = cylinder({ kind: "halfSphere", height: 10, width: 20, depth: 20 });
    const flat = classifySketchFaceHit(shape, { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(flat.kind).toBe("planar");
    expect(flat.analytic?.type).toBe("disc-cap");

    const dome = classifySketchFaceHit(shape, { x: 0, y: 10, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(dome.kind).toBe("curved");
  });

  it("treats box-like meshes as planar when nearby normals agree", () => {
    const shape = cylinder({ kind: "box", importedMesh: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      baseWidth: 20,
      baseDepth: 20,
      baseHeight: 20,
      triangleCount: 1,
      sourceFormat: "stl",
    } });
    const planar = classifySketchFaceHit(
      shape,
      { x: 0, y: 10, z: 0 },
      { x: 0, y: 1, z: 0 },
      [
        { x: 0, y: 1, z: 0 },
        { x: 0.02, y: 0.999, z: 0 },
        { x: -0.01, y: 0.999, z: 0.02 },
      ],
    );
    expect(planar.kind).toBe("planar");
  });

  it("flags imported curved neighborhoods as blocked", () => {
    const shape = cylinder({ kind: "box", importedMesh: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      baseWidth: 20,
      baseDepth: 20,
      baseHeight: 20,
      triangleCount: 1,
      sourceFormat: "stl",
    } });
    const curved = classifySketchFaceHit(
      shape,
      { x: 0, y: 10, z: 0 },
      { x: 1, y: 0, z: 0 },
      [
        { x: 1, y: 0, z: 0 },
        { x: 0.7, y: 0, z: 0.7 },
        { x: 0, y: 0, z: 1 },
      ],
    );
    expect(curved.kind).toBe("curved");
  });
});

describe("classifyMeshNeighborhoodPlanarity", () => {
  it("detects normal spread on curved patches", () => {
    expect(classifyMeshNeighborhoodPlanarity([
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ])).toBe("curved");
    expect(classifyMeshNeighborhoodPlanarity([
      { x: 0, y: 1, z: 0 },
      { x: 0.01, y: 0.999, z: 0 },
    ])).toBe("planar");
  });
});

describe("discCapFaceLoop", () => {
  it("builds a closed circular UV loop at the given radius", () => {
    const loop = discCapFaceLoop(12, 32);
    expect(loop).toHaveLength(32);
    const radii = loop.map((point) => Math.hypot(point.x, point.z));
    expect(Math.min(...radii)).toBeCloseTo(12, 5);
    expect(Math.max(...radii)).toBeCloseTo(12, 5);
  });
});
