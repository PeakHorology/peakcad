import { describe, expect, it } from "vitest";
import { curveSegmentCount } from "@/lib/sketch/migrate";

/** How far the tessellated polyline sits inside the true radius. */
function chordError(radius: number, segments: number, sweep = Math.PI * 2) {
  return radius * (1 - Math.cos(sweep / segments / 2));
}

describe("sketch curve tessellation", () => {
  it("holds a large circle within 0.01mm of its true radius", () => {
    // A fixed 32-gon left a 100mm circle 0.48mm undersized, and this polyline is what the STEP
    // bake extrudes — so the error shipped inside a body the UI badged "exact".
    expect(chordError(100, 32)).toBeGreaterThan(0.4);
    expect(chordError(100, curveSegmentCount(100))).toBeLessThanOrEqual(0.011);
  });

  it("keeps the error size-independent across a wide radius range", () => {
    for (const radius of [1, 3, 12.5, 40, 100, 250]) {
      expect(chordError(radius, curveSegmentCount(radius))).toBeLessThanOrEqual(0.011);
    }
  });

  it("never tessellates a circle more coarsely than the old fixed count", () => {
    for (const radius of [0.5, 1, 5, 20]) {
      expect(curveSegmentCount(radius)).toBeGreaterThanOrEqual(32);
    }
  });

  it("scales an arc by its sweep rather than a fixed step", () => {
    const quarter = curveSegmentCount(50, Math.PI / 2);
    const half = curveSegmentCount(50, Math.PI);
    expect(half).toBeGreaterThan(quarter);
    expect(chordError(50, quarter, Math.PI / 2)).toBeLessThanOrEqual(0.011);
    expect(chordError(50, half, Math.PI)).toBeLessThanOrEqual(0.011);
  });

  it("stays bounded so a huge radius cannot explode the point count", () => {
    expect(curveSegmentCount(1e6)).toBeLessThanOrEqual(512);
  });

  it("falls back to the floor for degenerate input", () => {
    expect(curveSegmentCount(0)).toBe(32);
    expect(curveSegmentCount(Number.NaN)).toBe(32);
    expect(curveSegmentCount(10, 0)).toBe(4);
  });
});
