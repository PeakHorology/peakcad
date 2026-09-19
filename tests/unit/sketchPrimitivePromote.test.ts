import { describe, expect, it } from "vitest";
import {
  axisAlignedRectFromPoints,
  circleFromPoints,
  promoteWorkplaneSketchToPrimitive,
} from "@/lib/sketchPrimitivePromote";
import type { WorkplaneShape } from "@/types/sketchforge";

function meshShape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "s1",
    name: "Sketch",
    kind: "mesh",
    color: "#d41721",
    x: 0,
    z: 0,
    size: 20,
    width: 20,
    depth: 10,
    height: 5,
    rotation: 0,
    importedMesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      baseWidth: 20,
      baseDepth: 10,
      baseHeight: 5,
    },
    ...overrides,
  };
}

describe("axisAlignedRectFromPoints", () => {
  it("detects a rectangle", () => {
    const rect = axisAlignedRectFromPoints([
      { x: -10, z: -5 },
      { x: 10, z: -5 },
      { x: 10, z: 5 },
      { x: -10, z: 5 },
    ]);
    expect(rect).toEqual({ width: 20, depth: 10, centerX: 0, centerZ: 0 });
  });

  it("rejects a freeform polygon", () => {
    expect(axisAlignedRectFromPoints([
      { x: 0, z: 0 },
      { x: 10, z: 1 },
      { x: 8, z: 9 },
      { x: 1, z: 7 },
    ])).toBeNull();
  });

  it("rejects a self-crossing bow tie that touches all four corners", () => {
    // Every point sits on the bounding box and four are corners, so the boundary test passed and
    // this promoted to a solid box — STEP exported filled stock while the mesh path extruded two
    // crossed triangles.
    expect(axisAlignedRectFromPoints([
      { x: 0, z: 0 },
      { x: 10, z: 10 },
      { x: 10, z: 0 },
      { x: 0, z: 10 },
    ])).toBeNull();
  });

  it("rejects a rectangle whose corners are visited in a crossing order", () => {
    expect(axisAlignedRectFromPoints([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 0, z: 10 },
      { x: 10, z: 10 },
    ])).toBeNull();
  });

  it("still accepts a rectangle traced clockwise", () => {
    expect(axisAlignedRectFromPoints([
      { x: -10, z: 5 },
      { x: 10, z: 5 },
      { x: 10, z: -5 },
      { x: -10, z: -5 },
    ])).toEqual({ width: 20, depth: 10, centerX: 0, centerZ: 0 });
  });

  it("still accepts a rectangle with extra points along its edges", () => {
    expect(axisAlignedRectFromPoints([
      { x: -10, z: -5 },
      { x: 0, z: -5 },
      { x: 10, z: -5 },
      { x: 10, z: 5 },
      { x: 0, z: 5 },
      { x: -10, z: 5 },
    ])).toEqual({ width: 20, depth: 10, centerX: 0, centerZ: 0 });
  });
});

describe("circleFromPoints", () => {
  it("detects a uniform circle polyline", () => {
    const points = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      return { x: Math.cos(a) * 5, z: Math.sin(a) * 5 };
    });
    const circle = circleFromPoints(points);
    expect(circle).not.toBeNull();
    expect(circle!.radius).toBeCloseTo(5, 2);
  });
});

describe("promoteWorkplaneSketchToPrimitive", () => {
  it("promotes a workplane rectangle to box", () => {
    const next = promoteWorkplaneSketchToPrimitive(
      meshShape(),
      [{
        closed: true,
        points: [
          { x: -10, z: -5 },
          { x: 10, z: -5 },
          { x: 10, z: 5 },
          { x: -10, z: 5 },
        ],
      }],
    );
    expect(next.kind).toBe("box");
  });

  it("leaves face-hosted sketches as mesh", () => {
    const next = promoteWorkplaneSketchToPrimitive(
      meshShape({
        sketchPlane: {
          origin: { x: 0, y: 10, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          uAxis: { x: 1, y: 0, z: 0 },
          hostShapeId: "host",
        },
      }),
      [{
        closed: true,
        points: [
          { x: -10, z: -5 },
          { x: 10, z: -5 },
          { x: 10, z: 5 },
          { x: -10, z: 5 },
        ],
      }],
    );
    expect(next.kind).toBe("mesh");
  });
});
