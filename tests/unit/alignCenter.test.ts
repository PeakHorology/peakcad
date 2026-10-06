import { describe, expect, it } from "vitest";
import { alignedShapesForSelection } from "@/lib/editorBoolean";
import { meshAabb } from "@/lib/editorShapeMesh";
import { worldAabb } from "@/lib/shapeBounds";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(overrides: Partial<WorkplaneShape>): WorkplaneShape {
  return {
    id: "box",
    name: "Box",
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 20,
    rotation: 0,
    ...overrides,
  };
}

describe("align center", () => {
  it("centers another shape on a square that was stretched into a rectangle", () => {
    const rectangle = box({ id: "rect", x: 0, width: 60, depth: 20, size: 60 });
    const other = box({ id: "other", x: 18, z: 4, width: 10, depth: 10, size: 10 });
    const { nextShapes } = alignedShapesForSelection(
      [rectangle, other],
      ["rect", "other"],
      [rectangle, other],
      "rect",
      "x",
      "center",
    );
    const moved = nextShapes.find((shape) => shape.id === "other");
    const rectBounds = meshAabb(rectangle);
    const movedBounds = meshAabb({ ...other, x: moved?.x ?? 0 });
    const rectCenter = (rectBounds.minX + rectBounds.maxX) / 2;
    const movedCenter = (movedBounds.minX + movedBounds.maxX) / 2;
    expect(movedCenter).toBeCloseTo(rectCenter, 3);
    expect(nextShapes.find((shape) => shape.id === "rect")?.x).toBe(0);
  });

  it("centers on an oval cylinder the same way as a rectangle", () => {
    const oval = box({
      id: "oval",
      kind: "cylinder",
      x: 4,
      z: -6,
      width: 50,
      depth: 16,
      size: 50,
      height: 20,
      rotation: 30,
    });
    const other = box({ id: "other", x: 20, z: 8, width: 8, depth: 8, size: 8 });
    const { nextShapes } = alignedShapesForSelection(
      [oval, other],
      ["oval", "other"],
      [oval, other],
      "oval",
      "x",
      "center",
    );
    const ovalBounds = meshAabb(oval);
    const moved = nextShapes.find((shape) => shape.id === "other");
    const movedBounds = meshAabb({ ...other, x: moved?.x ?? 0, z: moved?.z ?? 0 });
    expect((movedBounds.minX + movedBounds.maxX) / 2).toBeCloseTo((ovalBounds.minX + ovalBounds.maxX) / 2, 3);
    expect(ovalBounds.maxX - ovalBounds.minX).toBeGreaterThan(20);

    const rectangle = box({ id: "rect", kind: "box", x: 4, z: -6, width: 50, depth: 16, size: 50, height: 20, rotation: 30 });
    const ovalBox = worldAabb(oval);
    const rectBox = worldAabb(rectangle);
    expect(ovalBox.min[0]).toBeCloseTo(rectBox.min[0], 4);
    expect(ovalBox.max[0]).toBeCloseTo(rectBox.max[0], 4);
    expect(ovalBox.min[2]).toBeCloseTo(rectBox.min[2], 4);
    expect(ovalBox.max[2]).toBeCloseTo(rectBox.max[2], 4);
  });

  it("uses the visible body center when the mesh is not centered on the pivot", () => {
    const stretched: WorkplaneShape = {
      ...box({ id: "stretched", x: 0, width: 40, depth: 20, size: 40, kind: "mesh" }),
      importedMesh: {
        positions: [0, 0, 0, 40, 0, 0, 40, 10, 0],
        baseWidth: 40,
        baseDepth: 20,
        baseHeight: 10,
        triangleCount: 1,
        sourceFormat: "stl",
      },
    };
    const other = box({ id: "other", x: 0, width: 4, depth: 4, size: 4, height: 4 });
    const { nextShapes } = alignedShapesForSelection(
      [stretched, other],
      ["stretched", "other"],
      [stretched, other],
      "stretched",
      "x",
      "center",
    );
    const bounds = meshAabb(stretched);
    const center = (bounds.minX + bounds.maxX) / 2;
    const moved = nextShapes.find((shape) => shape.id === "other");
    const movedBounds = meshAabb({ ...other, x: moved?.x ?? 0 });
    expect(center).toBeGreaterThan(5);
    expect((movedBounds.minX + movedBounds.maxX) / 2).toBeCloseTo(center, 3);
  });
});
