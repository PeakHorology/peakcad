import { describe, expect, it } from "vitest";
import { faceHoleCutDepthMm, faceHoleOvershootMm } from "@/lib/csgTree";

describe("face hole through-all depth", () => {
  it("adds overshoot on both sides of the host thickness", () => {
    const thickness = 20;
    const os = faceHoleOvershootMm(thickness);
    expect(os).toBeGreaterThanOrEqual(0.5);
    expect(faceHoleCutDepthMm(thickness)).toBeCloseTo(thickness + 2 * os, 5);
  });

  it("never returns less than the host thickness", () => {
    expect(faceHoleCutDepthMm(10)).toBeGreaterThan(10);
    expect(faceHoleCutDepthMm(0.1)).toBeGreaterThanOrEqual(0.5);
  });
});
