import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { defaultSketchPlane, sketchBasisMatrix, sketchPlaneFromFaceHit } from "@/lib/sketchPlane";

describe("sketchBasisMatrix", () => {
  it("is left-handed for the default workplane (callers must flip winding)", () => {
    const matrix = sketchBasisMatrix(defaultSketchPlane());
    expect(matrix.determinant()).toBeLessThan(0);
  });

  it("is left-handed for a vertical face plane", () => {
    const plane = sketchPlaneFromFaceHit(
      { x: 10, y: 10, z: 0 },
      { x: 1, y: 0, z: 0 },
      "host",
    );
    const matrix = sketchBasisMatrix(plane);
    expect(matrix.determinant()).toBeLessThan(0);
  });

  it("maps local +Y (extrusion) onto the plane normal", () => {
    const plane = sketchPlaneFromFaceHit(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      "host",
    );
    const point = new THREE.Vector3(0, 5, 0).applyMatrix4(sketchBasisMatrix(plane));
    expect(point.z).toBeCloseTo(5, 5);
    expect(point.x).toBeCloseTo(0, 5);
    expect(point.y).toBeCloseTo(0, 5);
  });
});
