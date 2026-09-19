import { describe, expect, it } from "vitest";
import {
  chooseModifierEdgeCandidate,
  closestPointOnScreenSegment,
  MODIFIER_EDGE_PICK_RADIUS_PX,
} from "@/lib/modifierEdgePick";

describe("closestPointOnScreenSegment", () => {
  it("measures perpendicular distance to the middle of a segment", () => {
    const hit = closestPointOnScreenSegment(50, 10, 0, 0, 100, 0);
    expect(hit.distance).toBeCloseTo(10);
    expect(hit.amount).toBeCloseTo(0.5);
  });

  it("clamps to the endpoints rather than the infinite line", () => {
    const hit = closestPointOnScreenSegment(-30, 0, 0, 0, 100, 0);
    expect(hit.distance).toBeCloseTo(30);
    expect(hit.amount).toBe(0);
  });

  it("handles a degenerate segment", () => {
    const hit = closestPointOnScreenSegment(3, 4, 0, 0, 0, 0);
    expect(hit.distance).toBeCloseTo(5);
  });
});

describe("chooseModifierEdgeCandidate", () => {
  it("prefers the edge facing the camera when both sit under the cursor", () => {
    // A thin plate seen at a shallow angle: the hidden bottom rim projects a pixel from the top rim
    // it is under. Ranking on cursor distance alone gave the hover to the rim you cannot point at.
    const top = { id: 1, distance: 3.2, depth: 0.40 };
    const bottomBehind = { id: 2, distance: 2.6, depth: 0.62 };
    expect(chooseModifierEdgeCandidate([top, bottomBehind])).toBe(1);
    expect(chooseModifierEdgeCandidate([bottomBehind, top])).toBe(1);
  });

  it("still honours the pointer when one edge is clearly closer to it", () => {
    const aimedAt = { id: 1, distance: 1, depth: 0.8 };
    const nearerCamera = { id: 2, distance: 12, depth: 0.1 };
    expect(chooseModifierEdgeCandidate([aimedAt, nearerCamera])).toBe(1);
    expect(chooseModifierEdgeCandidate([nearerCamera, aimedAt])).toBe(1);
  });

  it("falls back to distance among edges at the same depth", () => {
    expect(chooseModifierEdgeCandidate([
      { id: 1, distance: 9, depth: 0.5 },
      { id: 2, distance: 2, depth: 0.5 },
    ])).toBe(2);
  });

  it("ignores anything outside the pick radius", () => {
    expect(chooseModifierEdgeCandidate([
      { id: 1, distance: MODIFIER_EDGE_PICK_RADIUS_PX, depth: 0.1 },
      { id: 2, distance: MODIFIER_EDGE_PICK_RADIUS_PX + 20, depth: 0 },
    ])).toBeNull();
  });

  it("returns nothing when the cursor is over empty space", () => {
    expect(chooseModifierEdgeCandidate([])).toBeNull();
  });

  it("picks the nearest of three edges meeting at a corner", () => {
    // All three converge within a couple of pixels, so depth is the only honest tie-break.
    expect(chooseModifierEdgeCandidate([
      { id: 1, distance: 4.0, depth: 0.55 },
      { id: 2, distance: 3.4, depth: 0.51 },
      { id: 3, distance: 4.4, depth: 0.72 },
    ])).toBe(2);
  });
});
