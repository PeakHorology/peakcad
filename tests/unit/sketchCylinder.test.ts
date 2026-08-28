import { describe, expect, it } from "vitest";
import {
  barrelFaceLoop,
  barrelThroughDepthMm,
  cylinderSurfaceFromHit,
  cylinderUVToWorld,
  isCircularCylinderPrimitive,
  worldToCylinderUV,
  wrapCircleRadialCylinder,
  wrapUvLoopRadialPrism,
} from "@/lib/sketchCylinder";
import type { WorkplaneShape } from "@/types/sketchforge";

function cylinder(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "cyl-1",
    name: "Cylinder",
    kind: "cylinder",
    color: "#d97813",
    x: 0,
    z: 0,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 40,
    rotation: 0,
    sides: 64,
    locked: false,
    hidden: false,
    ...overrides,
  };
}

describe("sketchCylinder UV", () => {
  it("recognizes circular cylinders and rejects elliptical ones", () => {
    expect(isCircularCylinderPrimitive(cylinder())).toBe(true);
    expect(isCircularCylinderPrimitive(cylinder({ depth: 12 }))).toBe(false);
  });

  it("round-trips world ↔ UV around the barrel", () => {
    const shape = cylinder();
    const hit = { x: 10, y: 20, z: 0 };
    const surface = cylinderSurfaceFromHit(shape, hit);
    expect(surface).not.toBeNull();
    if (!surface) return;
    const uv = worldToCylinderUV(surface, hit);
    expect(uv.u).toBeCloseTo(0, 5);
    expect(uv.v).toBeCloseTo(0, 5);
    const back = cylinderUVToWorld(surface, uv.u, uv.v);
    expect(back.x).toBeCloseTo(hit.x, 3);
    expect(back.y).toBeCloseTo(hit.y, 3);
    expect(back.z).toBeCloseTo(hit.z, 3);

    // Sketch V is screen-friendly: +V goes toward the cylinder bottom (-axis).
    const quarter = cylinderUVToWorld(surface, Math.PI * surface.radius / 2, 5);
    expect(quarter.z).toBeCloseTo(10, 2);
    expect(quarter.y).toBeCloseTo(15, 2);

    const top = cylinderUVToWorld(surface, 0, -surface.height / 2);
    expect(top.y).toBeCloseTo(40, 2);
    const bottom = cylinderUVToWorld(surface, 0, surface.height / 2);
    expect(bottom.y).toBeCloseTo(0, 2);
  });

  it("builds an unwrapped rectangular face loop", () => {
    const loop = barrelFaceLoop(10, 40);
    expect(loop).toHaveLength(4);
    expect(Math.min(...loop.map((p) => p.x))).toBeCloseTo(-Math.PI * 10, 5);
    expect(Math.max(...loop.map((p) => p.x))).toBeCloseTo(Math.PI * 10, 5);
    expect(Math.min(...loop.map((p) => p.z))).toBeCloseTo(-20, 5);
    expect(Math.max(...loop.map((p) => p.z))).toBeCloseTo(20, 5);
  });

  it("reports through-diameter depth", () => {
    const surface = cylinderSurfaceFromHit(cylinder(), { x: 10, y: 20, z: 0 });
    expect(surface).not.toBeNull();
    if (!surface) return;
    expect(barrelThroughDepthMm(surface)).toBeCloseTo(20, 5);
  });

  it("builds a radial circle cutter and a wrapped prism", () => {
    const surface = cylinderSurfaceFromHit(cylinder(), { x: 10, y: 20, z: 0 });
    expect(surface).not.toBeNull();
    if (!surface) return;
    const circle = wrapCircleRadialCylinder(0, 0, 3, surface, 22, true);
    expect(circle).not.toBeNull();
    circle?.computeBoundingBox();
    expect(circle?.boundingBox).toBeTruthy();

    const rect = [
      { x: -4, z: -3 },
      { x: 4, z: -3 },
      { x: 4, z: 3 },
      { x: -4, z: 3 },
    ];
    const prism = wrapUvLoopRadialPrism(rect, surface, 8, false);
    expect(prism).not.toBeNull();
    const pos = prism?.getAttribute("position");
    expect(pos && pos.count).toBeGreaterThan(8);
  });
});
