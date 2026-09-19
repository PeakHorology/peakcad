import { describe, expect, it } from "vitest";
import {
  bakeCadMetadataForShapeTransform,
  cadModifierPrimitiveForBakedShape,
  type BakedCadMetadataFrame,
} from "@/lib/cadBakeMetadata";
import type { WorkplaneShape } from "@/types/sketchforge";

function cylinder(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "cyl-1",
    name: "Cylinder",
    kind: "cylinder",
    color: "#888888",
    x: 12,
    z: -8,
    size: 20,
    width: 20,
    depth: 20,
    height: 30,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    elevation: 5,
    ...overrides,
  } as WorkplaneShape;
}

function box(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return { ...cylinder(overrides), kind: "box", id: "box-1", name: "Box" } as WorkplaneShape;
}

function frameFor(shape: WorkplaneShape): BakedCadMetadataFrame {
  return {
    centerX: shape.x,
    minY: shape.elevation ?? 0,
    centerZ: shape.z,
    width: shape.width ?? shape.size,
    depth: shape.depth ?? shape.size,
    height: shape.height,
    yawDegrees: shape.rotation,
  };
}

describe("bakeCadMetadataForShapeTransform", () => {
  it("keeps a cylinder's exact identity through a bake, like a box", () => {
    // Cylinders were skipped here, so a baked cylinder exported faceted while the same operation on
    // a box stayed exact.
    const shape = cylinder();
    const baked = bakeCadMetadataForShapeTransform(shape, frameFor(shape));
    expect(baked.cadPrimitiveFrame?.kind).toBe("cylinder");
    expect(baked.cadPrimitiveFrame?.width).toBeCloseTo(20, 6);
    expect(baked.cadPrimitiveFrame?.height).toBeCloseTo(30, 6);

    const bakedBox = bakeCadMetadataForShapeTransform(box(), frameFor(box()));
    expect(bakedBox.cadPrimitiveFrame?.kind).toBe("box");
  });

  it("round-trips a baked cylinder back to an exact cylinder primitive", () => {
    const shape = cylinder();
    const baked = bakeCadMetadataForShapeTransform(shape, frameFor(shape));
    const afterBake = { ...shape, ...baked, importedMesh: { positions: [0] } } as WorkplaneShape;

    const primitive = cadModifierPrimitiveForBakedShape(afterBake);
    expect(primitive?.kind).toBe("cylinder");
    expect(primitive && "radius" in primitive ? primitive.radius : null).toBeCloseTo(10, 6);
    expect(primitive?.height).toBeCloseTo(30, 6);
  });

  it("refuses an unevenly scaled cylinder rather than claiming an ellipse is exact", () => {
    const shape = cylinder();
    const baked = bakeCadMetadataForShapeTransform(shape, frameFor(shape));
    // Stretch only X after the bake: the solid is now elliptic, so no exact cylinder can stand in.
    const stretched = {
      ...shape,
      ...baked,
      width: 40,
      depth: 20,
      importedMesh: { positions: [0] },
    } as WorkplaneShape;
    expect(cadModifierPrimitiveForBakedShape(stretched)).toBeNull();
  });

  it("still accepts a uniformly scaled cylinder", () => {
    const shape = cylinder();
    const baked = bakeCadMetadataForShapeTransform(shape, frameFor(shape));
    const scaled = {
      ...shape,
      ...baked,
      width: 40,
      depth: 40,
      size: 40,
      importedMesh: { positions: [0] },
    } as WorkplaneShape;
    const primitive = cadModifierPrimitiveForBakedShape(scaled);
    expect(primitive?.kind).toBe("cylinder");
  });

  it("leaves a non-circular cylinder without an exact identity", () => {
    const elliptic = cylinder({ width: 30, depth: 20 });
    const baked = bakeCadMetadataForShapeTransform(elliptic, frameFor(elliptic));
    expect(baked.cadPrimitiveFrame).toBeUndefined();
  });
});
