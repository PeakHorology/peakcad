import { describe, expect, it } from "vitest";
import {
  NATIVE_EXACT_KINDS,
  NATIVE_FACETED_KINDS,
  shapeSupportsExactNativeBrep,
} from "@/lib/shapeBrep";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(kind: WorkplaneShape["kind"], overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "s1",
    name: kind,
    kind,
    color: "#ffffff",
    x: 0,
    z: 0,
    size: 20,
    width: 20,
    depth: 12,
    height: 10,
    rotation: 0,
    ...overrides,
  };
}

describe("shapeBrep catalog", () => {
  it("marks toolbar solids as exact-capable including elliptical footprints", () => {
    expect(shapeSupportsExactNativeBrep(shape("cylinder"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("cylinder", { width: 20, depth: 8 }))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("pyramid"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("torus"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("tube"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("roof"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("wedge"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("polygon"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("halfSphere"))).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("roundRoof"))).toBe(true);
  });

  it("keeps text / icosahedron / thread as faceted-by-nature", () => {
    expect(NATIVE_FACETED_KINDS.has("text")).toBe(true);
    expect(NATIVE_FACETED_KINDS.has("icosahedron")).toBe(true);
    expect(NATIVE_FACETED_KINDS.has("thread")).toBe(true);
    expect(shapeSupportsExactNativeBrep(shape("text"))).toBe(false);
    expect(shapeSupportsExactNativeBrep(shape("icosahedron"))).toBe(false);
    expect(shapeSupportsExactNativeBrep(shape("thread"))).toBe(false);
  });

  it("does not overlap exact and faceted kind sets", () => {
    for (const kind of NATIVE_EXACT_KINDS) {
      expect(NATIVE_FACETED_KINDS.has(kind)).toBe(false);
    }
  });
});
