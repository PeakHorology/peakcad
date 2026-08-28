import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  defaultSketchPlane,
  isDefaultSketchPlane,
  planeUVToWorld,
  resolveSketchPlane,
  sketchBasisMatrix,
  sketchPlaneFromFaceHit,
  sketchPlaneVAxis,
  worldToPlaneUV,
} from "@/lib/sketchPlane";

describe("defaultSketchPlane", () => {
  it("is the world XZ workplane", () => {
    const plane = defaultSketchPlane();
    expect(isDefaultSketchPlane(plane)).toBe(true);
    expect(plane.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(plane.uAxis).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("treats elevated workplane orientation as default", () => {
    const plane = defaultSketchPlane();
    plane.origin = { x: 0, y: 12, z: 0 };
    expect(isDefaultSketchPlane(plane)).toBe(true);
  });

  it("rejects host-face planes even when normal is +Y", () => {
    const plane = sketchPlaneFromFaceHit({ x: 0, y: 12, z: 0 }, { x: 0, y: 1, z: 0 }, "box-1");
    expect(isDefaultSketchPlane(plane)).toBe(false);
  });
});

describe("sketchPlaneFromFaceHit", () => {
  it("builds a right-handed frame for a +X face", () => {
    const plane = sketchPlaneFromFaceHit({ x: 10, y: 5, z: 2 }, { x: 1, y: 0, z: 0 }, "box-1");
    expect(plane.hostShapeId).toBe("box-1");
    expect(plane.normal.x).toBeCloseTo(1);
    expect(Math.abs(plane.normal.y)).toBeLessThan(1e-6);
    const v = sketchPlaneVAxis(plane);
    expect(plane.uAxis.x * plane.normal.x + plane.uAxis.y * plane.normal.y + plane.uAxis.z * plane.normal.z).toBeCloseTo(0);
    expect(v.x * plane.normal.x + v.y * plane.normal.y + v.z * plane.normal.z).toBeCloseTo(0);
  });

  it("keeps horizontal faces with U near world +X", () => {
    const plane = sketchPlaneFromFaceHit({ x: 0, y: 12, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(plane.uAxis.x).toBeCloseTo(1);
    expect(Math.abs(plane.uAxis.y)).toBeLessThan(1e-6);
  });
});

describe("worldToPlaneUV / planeUVToWorld", () => {
  it("round-trips on a vertical face", () => {
    const plane = sketchPlaneFromFaceHit({ x: 5, y: 3, z: -1 }, { x: 0, y: 0, z: 1 });
    const world = planeUVToWorld(plane, 4, -2);
    const uv = worldToPlaneUV(plane, world);
    expect(uv.u).toBeCloseTo(4);
    expect(uv.v).toBeCloseTo(-2);
  });
});

describe("sketchBasisMatrix", () => {
  it("maps local +Y to the plane normal", () => {
    const plane = sketchPlaneFromFaceHit({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 1 });
    const matrix = sketchBasisMatrix(plane);
    const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
    const tip = new THREE.Vector3(0, 1, 0).applyMatrix4(matrix);
    expect(tip.x - origin.x).toBeCloseTo(plane.normal.x);
    expect(tip.y - origin.y).toBeCloseTo(plane.normal.y);
    expect(tip.z - origin.z).toBeCloseTo(plane.normal.z);
  });
});

describe("resolveSketchPlane", () => {
  it("fills in a default when missing", () => {
    expect(isDefaultSketchPlane(resolveSketchPlane(null))).toBe(true);
  });
});
