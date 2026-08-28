import { describe, expect, it } from "vitest";
import { prepareFaceSketchReference, type WorldTriangle } from "@/lib/sketchFaceReference";
import { sketchPlaneFromFaceHit } from "@/lib/sketchPlane";

describe("prepareFaceSketchReference", () => {
  it("recenters a box side face and returns a rectangular UV loop", () => {
    // +X face of a 20x20x20 box centered at origin (x from -10..10, etc.)
    const triangles: WorldTriangle[] = [
      [
        { x: 10, y: 0, z: -10 },
        { x: 10, y: 20, z: -10 },
        { x: 10, y: 20, z: 10 },
      ],
      [
        { x: 10, y: 0, z: -10 },
        { x: 10, y: 20, z: 10 },
        { x: 10, y: 0, z: 10 },
      ],
    ];
    const hitPlane = sketchPlaneFromFaceHit({ x: 10, y: 5, z: 2 }, { x: 1, y: 0, z: 0 }, "box-1");
    const prepared = prepareFaceSketchReference(hitPlane, triangles);
    expect(prepared.plane.hostShapeId).toBe("box-1");
    expect(prepared.plane.origin.x).toBeCloseTo(10, 3);
    expect(prepared.plane.origin.y).toBeCloseTo(10, 3);
    expect(prepared.plane.origin.z).toBeCloseTo(0, 3);
    expect(prepared.loops.length).toBeGreaterThan(0);
    const points = prepared.loops.flat();
    expect(Math.min(...points.map((point) => point.x))).toBeLessThan(-1);
    expect(Math.max(...points.map((point) => point.x))).toBeGreaterThan(1);
  });

  it("snaps a recessed top-face hit up to the outer face envelope", () => {
    // Top face mostly at y=1, with a scar triangle at y=0.95 that the ray may hit.
    const triangles: WorldTriangle[] = [
      [
        { x: -5, y: 1, z: -5 },
        { x: 5, y: 1, z: -5 },
        { x: 5, y: 1, z: 5 },
      ],
      [
        { x: -5, y: 1, z: -5 },
        { x: 5, y: 1, z: 5 },
        { x: -5, y: 1, z: 5 },
      ],
      [
        { x: -1, y: 0.95, z: -1 },
        { x: 1, y: 0.95, z: -1 },
        { x: 0, y: 0.95, z: 1 },
      ],
    ];
    const hitPlane = sketchPlaneFromFaceHit({ x: 0, y: 0.95, z: 0 }, { x: 0, y: 1, z: 0 }, "wheel");
    const prepared = prepareFaceSketchReference(hitPlane, triangles);
    expect(prepared.plane.origin.y).toBeCloseTo(1, 3);
  });
});
