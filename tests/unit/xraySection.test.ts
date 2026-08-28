import { describe, expect, it } from "vitest";
import { xrayHeightBounds } from "@/lib/xraySection";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "shape-1",
    name: "Shape",
    kind: "box",
    color: "#ffffff",
    x: 0,
    z: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 20,
    rotation: 0,
    locked: false,
    hidden: false,
    ...overrides,
  };
}

describe("xrayHeightBounds", () => {
  it("includes visible geometry below the workplane", () => {
    expect(xrayHeightBounds([shape({ elevation: -30, height: 12 })])).toEqual({
      min: -34,
      max: 24,
    });
  });

  it("ignores hidden shapes", () => {
    expect(
      xrayHeightBounds([
        shape({ elevation: 5, height: 40 }),
        shape({ id: "hidden", elevation: -100, height: 300, hidden: true }),
      ]),
    ).toEqual({ min: -4, max: 49 });
  });
});
