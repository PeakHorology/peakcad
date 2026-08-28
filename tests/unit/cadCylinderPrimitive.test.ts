import { describe, expect, it } from "vitest";
import { cadModifierPrimitiveForAnalyticCylinder } from "@/lib/cadBakeMetadata";
import type { WorkplaneShape } from "@/types/sketchforge";

function cylinder(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "cyl-1",
    name: "Cylinder",
    kind: "cylinder",
    color: "#d97813",
    x: 10,
    z: -10,
    size: 20,
    width: 20,
    depth: 20,
    height: 30,
    rotation: 0,
    sides: 96,
    locked: false,
    hidden: false,
    ...overrides,
  };
}

describe("cadModifierPrimitiveForAnalyticCylinder", () => {
  it("builds an exact cylinder primitive for circular native cylinders", () => {
    const primitive = cadModifierPrimitiveForAnalyticCylinder(cylinder());
    expect(primitive).toEqual(expect.objectContaining({
      kind: "cylinder",
      radius: 10,
      height: 30,
    }));
  });

  it("rejects elliptical cylinders and imported meshes", () => {
    expect(cadModifierPrimitiveForAnalyticCylinder(cylinder({ depth: 12 }))).toBeNull();
    expect(cadModifierPrimitiveForAnalyticCylinder(cylinder({
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 20,
        baseDepth: 20,
        baseHeight: 30,
        triangleCount: 1,
        sourceFormat: "stl",
      },
    }))).toBeNull();
  });
});
