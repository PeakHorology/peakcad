import { describe, expect, it } from "vitest";
import {
  clampRoofRidgeX,
  roofAnglesFromProfile,
  roofAnglesFromRidge,
  roofRidgeXFromLeftAngle,
  roofRidgeXFromRightAngle,
} from "@/lib/roofGeometry";

describe("roof ridge clamping", () => {
  it("keeps a wide flat triangle symmetric", () => {
    // Both clamp bounds came from the left base angle, centring the allowed span on the left
    // corner instead of the shape. A symmetric 66 x 0.5mm roof was pushed to ridgeX = -4.64,
    // and both the viewport and the STEP builder used that skewed apex.
    expect(clampRoofRidgeX(66, 0.5, 0)).toBe(0);

    const profile = roofAnglesFromProfile(66, 0.5);
    expect(profile.ridgeX).toBe(0);
    expect(profile.leftAngle).toBeCloseTo(profile.rightAngle, 6);
    expect(profile.leftRun).toBeCloseTo(profile.rightRun, 6);
  });

  it("still admits a genuinely asymmetric ridge", () => {
    const ridge = roofRidgeXFromLeftAngle(40, 20, 60);
    expect(clampRoofRidgeX(40, 20, ridge)).toBeCloseTo(ridge, 6);
    expect(roofAnglesFromRidge(40, 20, ridge).leftAngle).toBeCloseTo(60, 4);
  });

  it("constrains the right base angle, not only the left", () => {
    const clamped = clampRoofRidgeX(20, 20, 5000);
    // The old bound allowed a ridge far past the point where the right angle collapsed.
    const angles = roofAnglesFromRidge(20, 20, clamped);
    expect(angles.rightAngle).toBeGreaterThan(0.9);
    expect(angles.leftAngle).toBeGreaterThan(0.9);
  });

  it("clamps symmetrically on both sides", () => {
    const high = clampRoofRidgeX(20, 20, 1e6);
    const low = clampRoofRidgeX(20, 20, -1e6);
    expect(high).toBeCloseTo(-low, 6);
  });

  it("round-trips a right base angle", () => {
    const ridge = roofRidgeXFromRightAngle(40, 20, 50);
    expect(roofAnglesFromRidge(40, 20, ridge).rightAngle).toBeCloseTo(50, 4);
  });

  it("resolves a stored left angle into matching runs", () => {
    const profile = roofAnglesFromProfile(40, 20, 45);
    expect(profile.leftAngle).toBeCloseTo(45, 4);
    expect(profile.leftRun + profile.rightRun).toBeCloseTo(40, 6);
  });

  it("keeps both base angles when width and height scale together", () => {
    const start = roofAnglesFromProfile(40, 20, 60);
    const scaled = roofAnglesFromProfile(80, 40, start.leftAngle, start.rightAngle);
    expect(start.leftAngle).toBeCloseTo(60, 4);
    expect(scaled.leftAngle).toBeCloseTo(start.leftAngle, 4);
    expect(scaled.rightAngle).toBeCloseTo(start.rightAngle, 4);
    expect(scaled.ridgeX).toBeCloseTo(start.ridgeX * 2, 5);
  });
});
