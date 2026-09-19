import { describe, expect, it } from "vitest";
import {
  clampLinearPatternCount,
  clampLinearPatternSpacing,
  linearPatternCopyId,
  linearPatternInstanceCount,
  linearPatternInstances,
  linearPatternSuggestedSpacing,
  resolveLinearPatternSourceId,
} from "@/lib/linearPattern";
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
    groupedShapes: [{
      id: `${partial.id}-child`,
      name: "Child",
      kind: "box",
      color: "#eee",
      size: 4,
      width: 4,
      depth: 4,
      height: 4,
      rotation: 0,
      x: 0,
      z: 0,
    }],
    ...partial,
  };
}

describe("clampLinearPatternCount", () => {
  it("clamps to 1–24", () => {
    expect(clampLinearPatternCount(0)).toBe(1);
    expect(clampLinearPatternCount(3.6)).toBe(4);
    expect(clampLinearPatternCount(40)).toBe(24);
  });
});

describe("clampLinearPatternSpacing", () => {
  it("allows reverse (negative) spacing", () => {
    expect(clampLinearPatternSpacing(-22)).toBe(-22);
    expect(clampLinearPatternSpacing(0)).toBe(0);
    expect(clampLinearPatternSpacing(400)).toBe(160);
  });
});

describe("linearPatternInstances", () => {
  it("keeps the original and offsets copies on X/Z", () => {
    const source = box({ id: "src", x: 0, z: 0 });
    const instances = linearPatternInstances([source], { countX: 3, countZ: 2 }, { spacingX: 12, spacingZ: 8 });
    expect(instances).toHaveLength(6);
    expect(instances[0]).toMatchObject({ id: "src", x: 0, z: 0 });
    expect(instances.map((shape) => ({ id: shape.id, x: shape.x, z: shape.z }))).toEqual([
      { id: "src", x: 0, z: 0 },
      { id: linearPatternCopyId("src", 1, 0, 0), x: 12, z: 0 },
      { id: linearPatternCopyId("src", 2, 0, 0), x: 24, z: 0 },
      { id: linearPatternCopyId("src", 0, 1, 0), x: 0, z: 8 },
      { id: linearPatternCopyId("src", 1, 1, 0), x: 12, z: 8 },
      { id: linearPatternCopyId("src", 2, 1, 0), x: 24, z: 8 },
    ]);
    expect(instances[1].groupedShapes).toHaveLength(1);
  });

  it("offsets copies in the negative Width direction", () => {
    const source = box({ id: "src", x: 0, z: 0 });
    const instances = linearPatternInstances([source], { countX: 3, countZ: 1 }, { spacingX: -12, spacingZ: 8 });
    expect(instances.map((shape) => shape.x)).toEqual([0, -12, -24]);
  });

  it("stacks copies in Y when countY is set", () => {
    const source = box({ id: "src", x: 5, z: -2, elevation: 1, height: 10 });
    const instances = linearPatternInstances(
      [source],
      { countX: 1, countZ: 1, countY: 3 },
      { spacingX: 12, spacingZ: 8, spacingY: 12 },
    );
    expect(instances.map((shape) => shape.elevation)).toEqual([1, 13, 25]);
  });
});

describe("linearPatternSuggestedSpacing", () => {
  it("uses the source size plus a small gap", () => {
    expect(linearPatternSuggestedSpacing([box({ id: "a", x: 0, z: 0, width: 16 })], "x")).toBe(18);
  });
});

describe("resolveLinearPatternSourceId", () => {
  it("maps copy ids back to the source", () => {
    const sourceId = "box-1";
    expect(resolveLinearPatternSourceId(sourceId, { sourceIds: [sourceId] })).toBe(sourceId);
    expect(resolveLinearPatternSourceId(linearPatternCopyId(sourceId, 2, 1, 0), { sourceIds: [sourceId] })).toBe(sourceId);
    expect(resolveLinearPatternSourceId("other", { sourceIds: [sourceId] })).toBeNull();
  });
});

describe("linearPatternInstanceCount", () => {
  it("multiplies the three axes", () => {
    expect(linearPatternInstanceCount({ countX: 3, countZ: 2, countY: 2 })).toBe(12);
  });
});
