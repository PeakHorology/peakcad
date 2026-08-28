import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import {
  applyRepeatActionToDuplicate,
  computeShapeRepeatDelta,
  createDuplicateForRepeat,
  hasShapeRepeatDelta,
} from "@/lib/shapeRepeat";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "box-1",
    name: "Box",
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 4,
    rotation: 0,
    ...overrides,
  };
}

function bakedThinRectangle(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return shape({
    kind: "mesh",
    width: 20,
    depth: 4,
    height: 2,
    size: 20,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions: [-10, 0, -2, 10, 0, -2, 10, 0, 2, -10, 0, -2, 10, 0, 2, -10, 0, 2],
      baseWidth: 20,
      baseDepth: 4,
      baseHeight: 2,
      triangleCount: 2,
      sourceFormat: "json",
    },
    ...overrides,
  });
}

describe("shapeRepeat", () => {
  it("captures rotation deltas with shortest arc", () => {
    const delta = computeShapeRepeatDelta(shape({ rotation: 350 }), shape({ rotation: 10 }));
    expect(delta.rotation).toBe(20);
    expect(hasShapeRepeatDelta(delta)).toBe(true);
  });

  it("duplicates first, then applies the rotation delta on the first repeat", () => {
    const before = shape({ rotation: 0 });
    const rotated = shape({ rotation: 10 });
    const delta = computeShapeRepeatDelta(before, rotated);
    expect(delta).toEqual({ rotation: 10 });

    const duplicate = createDuplicateForRepeat(rotated, "box-1-repeat");
    expect(duplicate.rotation).toBeCloseTo(10, 5);

    const firstRepeat = applyRepeatActionToDuplicate(duplicate, delta, { incremental: true });
    expect(firstRepeat.id).toBe("box-1-repeat");
    expect(firstRepeat.rotation).toBeCloseTo(20, 5);
  });

  it("keeps applying one rotation increment on chained duplicate-and-repeat", () => {
    const before = shape({ rotation: 0 });
    const rotated = shape({ rotation: 10 });
    const delta = computeShapeRepeatDelta(before, rotated);

    const first = applyRepeatActionToDuplicate(createDuplicateForRepeat(rotated, "box-1-repeat"), delta, { incremental: true });
    const second = applyRepeatActionToDuplicate(createDuplicateForRepeat(first, "box-1-repeat-2"), delta, { incremental: true });

    expect(first.rotation).toBeCloseTo(20, 5);
    expect(second.rotation).toBeCloseTo(30, 5);
  });

  it("applies one incremental rotation to baked meshes without changing the source id", () => {
    const baked = bakedThinRectangle();
    const delta = { rotation: 10 };
    const duplicate = createDuplicateForRepeat(baked, "mesh-1-repeat");

    const repeated = applyRepeatActionToDuplicate(duplicate, delta, { incremental: true });

    expect(repeated.id).toBe("mesh-1-repeat");
    expect(repeated.rotation).toBe(0);
    expect(repeated.importedMesh?.positions).not.toEqual(baked.importedMesh?.positions);
  });
});
