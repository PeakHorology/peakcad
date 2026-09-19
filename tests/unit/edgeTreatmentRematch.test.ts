import { describe, expect, it } from "vitest";
import {
  fingerprintCadEdge,
  fingerprintsForEdgeIds,
  matchRecipeEdgeIds,
} from "../../apps/web/src/lib/edgeTreatmentRematch";

function edge(id: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, angle = 90) {
  return {
    id,
    angle,
    selectable: true,
    points: [ax, ay, az, bx, by, bz],
  };
}

/** Closed circular edge (a cylinder rim) tessellated starting at `seam` radians. */
function circleEdge(id: number, radius: number, y: number, seam: number, segments = 32, angle = 90) {
  const points: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = seam + (i / segments) * Math.PI * 2;
    points.push(Math.cos(t) * radius, y, Math.sin(t) * radius);
  }
  return { id, points, angle, selectable: true };
}

describe("edgeTreatmentRematch", () => {
  it("fingerprints midpoints and length", () => {
    const fp = fingerprintCadEdge(edge(1, 0, 0, 0, 10, 0, 0, 90));
    expect(fp).toEqual({
      mid: [5, 0, 0],
      centroid: [5, 0, 0],
      direction: [1, 0, 0],
      length: 10,
      angle: 90,
    });
  });

  it("fingerprints a closed rim by its centre, not by the tessellation seam", () => {
    const seamAtZero = fingerprintCadEdge(circleEdge(1, 20, 10, 0))!;
    const seamAtPi = fingerprintCadEdge(circleEdge(1, 20, 10, Math.PI))!;
    // The chord midpoint lands on the circle wherever the seam falls...
    expect(Math.hypot(seamAtZero.mid[0], seamAtZero.mid[2])).toBeCloseTo(20, 3);
    // ...while the centroid is the rim centre either way.
    for (const fp of [seamAtZero, seamAtPi]) {
      expect(fp.centroid![0]).toBeCloseTo(0, 6);
      expect(fp.centroid![1]).toBeCloseTo(10, 6);
      expect(fp.centroid![2]).toBeCloseTo(0, 6);
    }
    expect(seamAtZero.length).toBeCloseTo(seamAtPi.length, 6);
  });

  it("keeps a rim fillet on its own end of a cylinder after the seam moves", () => {
    const recipe = {
      edgeCount: 1,
      edgeIds: [1],
      edgeFingerprints: [fingerprintCadEdge(circleEdge(1, 20, 10, 0))!],
    };
    // Remesh: same cylinder, top rim re-seamed, ids churned.
    const remeshed = [circleEdge(7, 20, 10, Math.PI), circleEdge(8, 20, 0, 0)];
    expect(matchRecipeEdgeIds(recipe, remeshed, 25)).toEqual([7]);
  });

  it("refuses to move a fillet to a distant parallel edge", () => {
    const intended = edge(1, -50, 10, 20, 50, 10, 20);
    const farParallel = edge(2, -50, 10, -20, 50, 10, -20);
    const recipe = {
      edgeCount: 1,
      edgeIds: [1],
      edgeFingerprints: [fingerprintCadEdge(intended)!],
    };
    // The intended edge did not survive the remesh; 40mm away is not the same edge.
    expect(matchRecipeEdgeIds(recipe, [farParallel], 25)).toEqual([]);
    // ...but it still matches when the edge itself is present.
    expect(matchRecipeEdgeIds(recipe, [farParallel, edge(9, -50, 10, 20, 50, 10, 20)], 25)).toEqual([9]);
  });

  it("matches recipes by geometry after id churn", () => {
    const original = [
      edge(0, 0, 10, 0, 10, 10, 0, 90),
      edge(1, 10, 0, 0, 10, 10, 0, 90),
      edge(2, 0, 0, 0, 0, 10, 0, 45),
    ];
    const fingerprints = fingerprintsForEdgeIds(original, [0, 1]);
    // Remesh renumbers edges and nudges slightly.
    const remeshed = [
      edge(7, 0.2, 10.1, 0, 10.1, 10, 0, 89),
      edge(8, 10.05, 0.1, 0, 10, 10.05, 0, 91),
      edge(9, 0, 0, 0, 0, 10, 0, 45),
    ];
    const matched = matchRecipeEdgeIds(
      { edgeCount: 2, edgeFingerprints: fingerprints, edgeIds: [0, 1] },
      remeshed,
      25,
    );
    expect(matched).toEqual([7, 8]);
  });

  it("falls back to top-N by angle only when the recipe has no ids or fingerprints", () => {
    const edges = [
      edge(1, 0, 0, 0, 1, 0, 0, 40),
      edge(2, 0, 0, 0, 0, 1, 0, 90),
      edge(3, 0, 0, 0, 0, 0, 1, 70),
    ];
    expect(matchRecipeEdgeIds({ edgeCount: 2 }, edges, 25)).toEqual([2, 3]);
  });

  it("does not fillet the sharpest leftover edges when stored ids are stale", () => {
    const edges = [
      edge(1, 0, 0, 0, 1, 0, 0, 40),
      edge(2, 0, 0, 0, 0, 1, 0, 90),
      edge(3, 0, 0, 0, 0, 0, 1, 70),
    ];
    expect(matchRecipeEdgeIds({ edgeCount: 2, edgeIds: [40, 41] }, edges, 25)).toEqual([]);
  });

  it("reuses stable edgeIds when still selectable", () => {
    const edges = [edge(4, 0, 0, 0, 5, 0, 0, 90), edge(5, 0, 0, 0, 0, 5, 0, 90)];
    expect(matchRecipeEdgeIds({ edgeCount: 2, edgeIds: [5, 4] }, edges, 25)).toEqual([5, 4]);
  });
});
