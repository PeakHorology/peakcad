import { describe, expect, it } from "vitest";
import { applyPlacementOffset, applyPlacementOffsetsToSelection, placePlacementRulerLabels, placementOffsetsFromBaseline, placementPoseOf, recapturePlacementBaseline } from "@/lib/placementRuler";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(partial: Partial<WorkplaneShape> & Pick<WorkplaneShape, "id" | "x" | "z">): WorkplaneShape {
  return {
    name: "Box",
    kind: "box",
    color: "#fff",
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...partial,
  };
}

describe("placementOffsetsFromBaseline", () => {
  it("starts at 0,0,0 from the pose when the ruler begins", () => {
    const shape = box({ id: "a", x: 12, z: -4, elevation: 2 });
    expect(placementOffsetsFromBaseline(shape, placementPoseOf(shape))).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("maps Y to workplane depth and Z to height", () => {
    const baseline = { x: 2, z: 1, elevation: 0 };
    expect(placementOffsetsFromBaseline(box({ id: "a", x: 12, z: -4, elevation: 7 }), baseline)).toEqual({
      x: 10,
      y: -5,
      z: 7,
    });
  });
});

describe("applyPlacementOffset", () => {
  it("moves X on the workplane, Y as depth, and Z as up", () => {
    const baseline = { x: 4, z: -3, elevation: 2 };
    expect(applyPlacementOffset(baseline, "x", 8)).toEqual({ x: 12 });
    expect(applyPlacementOffset(baseline, "y", 1)).toEqual({ z: -2 });
    expect(applyPlacementOffset(baseline, "z", 9)).toEqual({ elevation: 11 });
  });
});

describe("recapturePlacementBaseline", () => {
  it("resets 0,0,0 to the restored pose after undo", () => {
    const beforeUndo = box({ id: "a", x: 20, z: 4, elevation: 3 });
    const afterUndo = box({ id: "a", x: 4, z: 0, elevation: 0 });
    const stale = placementPoseOf(beforeUndo);
    expect(placementOffsetsFromBaseline(afterUndo, stale)).toEqual({ x: -16, y: -4, z: -3 });

    const recaptured = recapturePlacementBaseline([afterUndo], ["a"], "a");
    expect(recaptured.baselineId).toBe("a");
    expect(placementOffsetsFromBaseline(afterUndo, recaptured.baseline!)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("applies a typed X from the restored pose, not the pre-undo pose", () => {
    const restored = box({ id: "a", x: 4, z: 0 });
    const recaptured = recapturePlacementBaseline([restored], ["a"], "a");
    const next = applyPlacementOffsetsToSelection([restored], ["a"], recaptured.baseline!, "x", 8);
    expect(next[0].x).toBe(12);
  });
});

describe("applyPlacementOffsetsToSelection", () => {
  it("moves the whole selection by the typed delta from the baseline", () => {
    const shapes = [
      box({ id: "a", x: 4, z: 0 }),
      box({ id: "b", x: 16, z: 0 }),
      box({ id: "c", x: 40, z: 0 }),
    ];
    const next = applyPlacementOffsetsToSelection(shapes, ["a", "b"], { x: 4, z: 0, elevation: 0 }, "x", 20);
    expect(next.find((shape) => shape.id === "a")?.x).toBe(24);
    expect(next.find((shape) => shape.id === "b")?.x).toBe(36);
    expect(next.find((shape) => shape.id === "c")?.x).toBe(40);
  });
});

describe("placePlacementRulerLabels", () => {
  it("keeps collapsed X/Y labels far enough apart to click", () => {
    const [x, y] = placePlacementRulerLabels([
      { axis: "x", x1: 100, y1: 200, x2: 104, y2: 202 },
      { axis: "y", x1: 104, y1: 202, x2: 106, y2: 206 },
      { axis: "z", x1: 106, y1: 206, x2: 106, y2: 80 },
    ]);
    const gap = Math.hypot(x.labelX - y.labelX, x.labelY - y.labelY);
    expect(gap).toBeGreaterThanOrEqual(72);
  });
});
