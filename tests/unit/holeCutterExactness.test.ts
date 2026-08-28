import { describe, expect, it } from "vitest";
import { circleSketchGeometry, squareSketchGeometry } from "../../apps/web/src/lib/sketchDrawShapes";

/**
 * Guards the Tinkercad-like contract: hole profiles keep user size at bake time.
 * In-plane padding (SKETCH_HOLE_PROFILE_PAD / inflateForHole) must stay gone.
 */
describe("hole cutter exactness (Tinkercad-like)", () => {
  it("circle sketch geometry uses the requested radius", () => {
    const radius = 5;
    const geom = circleSketchGeometry({ x: 0, z: 0 }, radius);
    const distances = geom.points.map((point) => Math.hypot(point.x, point.z));
    for (const distance of distances) {
      expect(distance).toBeCloseTo(radius, 5);
    }
  });

  it("square sketch geometry uses the requested side length", () => {
    const geom = squareSketchGeometry({ x: -4, z: -4 }, { x: 4, z: 4 });
    expect(geom).not.toBeNull();
    const xs = geom!.points.map((point) => point.x);
    const zs = geom!.points.map((point) => point.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(8, 5);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(8, 5);
  });
});
