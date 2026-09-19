import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import {
  applyRepeatActionToDuplicate,
  computeShapeRepeatDelta,
  createDuplicateForRepeat,
  hasShapeRepeatDelta,
} from "@/lib/shapeRepeat";
import { MAX_SHAPE_SIDES } from "@/lib/workplaneShapes";

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

/** 200 x 200 plate, 2mm thick: its 45-degree diagonal (282.8mm) exceeds the 220mm clamp. */
function largePlate(): WorkplaneShape {
  return shape({
    kind: "mesh",
    width: 200,
    depth: 200,
    height: 2,
    size: 200,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions: [
        -100, 0, -100, 100, 0, -100, 100, 0, 100,
        -100, 0, -100, 100, 0, 100, -100, 0, 100,
        -100, 2, -100, 100, 2, -100, 100, 2, 100,
        -100, 2, -100, 100, 2, 100, -100, 2, 100,
      ],
      baseWidth: 200,
      baseDepth: 200,
      baseHeight: 2,
      triangleCount: 4,
      sourceFormat: "json",
    },
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

  it("keeps a rotated import's declared size equal to its real mesh extent", () => {
    const repeated = applyRepeatActionToDuplicate(
      createDuplicateForRepeat(largePlate(), "plate-repeat"),
      { rotation: 45 },
      { incremental: true },
    );

    const diagonal = Math.SQRT2 * 200;
    expect(repeated.width).toBeCloseTo(diagonal, 3);
    expect(repeated.depth).toBeCloseTo(diagonal, 3);

    // Geometry renders through width/baseWidth. Clamping only the declared side to 220mm
    // rescaled the whole mesh, shipping the part 22% undersized with no warning.
    expect(repeated.width).toBeCloseTo(repeated.importedMesh!.baseWidth!, 6);
    expect(repeated.depth).toBeCloseTo(repeated.importedMesh!.baseDepth!, 6);
  });

  it("clamps repeated facet counts as integers rather than as millimetres", () => {
    const shrunk = applyRepeatActionToDuplicate(
      createDuplicateForRepeat(shape({ kind: "cylinder", sides: 8 }), "cyl-a"),
      { sides: -20 },
      { incremental: true },
    );
    // The millimetre clamp bottomed out at 0.01, which is not a facet count.
    expect(shrunk.sides).toBe(3);

    const grown = applyRepeatActionToDuplicate(
      createDuplicateForRepeat(shape({ kind: "cylinder", sides: 200 }), "cyl-b"),
      { sides: 40 },
      { incremental: true },
    );
    expect(grown.sides).toBe(Math.min(MAX_SHAPE_SIDES, 240));
    expect(Number.isInteger(grown.sides)).toBe(true);
  });
});
