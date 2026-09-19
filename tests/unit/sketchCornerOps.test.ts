import { describe, expect, it } from "vitest";
import { chamferCorner, filletCorner } from "@/lib/sketch/editOps";
import type { SketchProfile } from "@/types/sketchforge";

/** Corner at the origin with legs running to `a` and `b`. */
function corner(a: { x: number; z: number }, b: { x: number; z: number }, kind: "line" | "bezier" = "line"): SketchProfile {
  return {
    points: [
      { id: "v", x: 0, z: 0 },
      { id: "a", x: a.x, z: a.z },
      { id: "b", x: b.x, z: b.z },
    ],
    segments: [
      { id: "s1", startId: "a", endId: "v", kind },
      { id: "s2", startId: "v", endId: "b", kind },
    ],
  };
}

function pointById(profile: SketchProfile, id: string) {
  const point = profile.points.find((p) => p.id === id);
  if (!point) throw new Error(`missing point ${id}`);
  return point;
}

/** The two points the corner cut introduced, in no particular order. */
function newPoints(before: SketchProfile, after: SketchProfile) {
  const known = new Set(before.points.map((p) => p.id));
  return after.points.filter((p) => !known.has(p.id));
}

function cubicAt(
  p0: { x: number; z: number },
  c1: { x: number; z: number },
  c2: { x: number; z: number },
  p3: { x: number; z: number },
  t: number,
) {
  const inv = 1 - t;
  return {
    x: inv ** 3 * p0.x + 3 * inv ** 2 * t * c1.x + 3 * inv * t ** 2 * c2.x + t ** 3 * p3.x,
    z: inv ** 3 * p0.z + 3 * inv ** 2 * t * c1.z + 3 * inv * t ** 2 * c2.z + t ** 3 * p3.z,
  };
}

/**
 * Distance from the arc's true centre to samples along the fillet curve. For a correct fillet every
 * sample sits at the requested radius.
 */
function filletRadiiSamples(profile: SketchProfile, before: SketchProfile) {
  const [t1, t2] = newPoints(before, profile);
  const arc = profile.segments.find((s) => s.kind === "bezier" && [t1.id, t2.id].includes(s.startId) && [t1.id, t2.id].includes(s.endId));
  if (!arc) throw new Error("no fillet arc produced");
  const from = pointById(profile, arc.startId);
  const to = pointById(profile, arc.endId);
  const control1 = from.handleOut ?? from.handleIn!;
  const control2 = to.handleIn ?? to.handleOut!;

  // Arc centre: offset from each tangent point along the inward leg normal. Derive it as the
  // intersection-free midpoint construction, using the perpendicular at t1 through the corner.
  return { from, to, control1, control2 };
}

describe("filletCorner", () => {
  it("produces a curve at the requested radius on a right-angle corner", () => {
    const before = corner({ x: 40, z: 0 }, { x: 0, z: 40 });
    const after = filletCorner(before, "v", 10);
    expect(after).not.toBeNull();

    const { from, to, control1, control2 } = filletRadiiSamples(after!, before);
    // For a 90 degree corner filleted at r=10 the arc centre is at (10, 10).
    const centre = { x: 10, z: 10 };
    for (let step = 0; step <= 10; step += 1) {
      const sample = cubicAt(from, control1, control2, to, step / 10);
      expect(Math.hypot(sample.x - centre.x, sample.z - centre.z)).toBeCloseTo(10, 2);
    }
  });

  it("holds the requested radius on an acute corner", () => {
    // 60 degree corner. Trimming by the radius rather than r/tan(theta/2) made the curve here only
    // about 0.58 of the requested radius.
    const angle = Math.PI / 3;
    const before = corner({ x: 100, z: 0 }, { x: 100 * Math.cos(angle), z: 100 * Math.sin(angle) });
    const after = filletCorner(before, "v", 10);
    expect(after).not.toBeNull();

    const { from, to, control1, control2 } = filletRadiiSamples(after!, before);
    // Centre lies on the angle bisector at distance r / sin(theta/2).
    const bisector = angle / 2;
    const distance = 10 / Math.sin(angle / 2);
    const centre = { x: Math.cos(bisector) * distance, z: Math.sin(bisector) * distance };
    for (let step = 0; step <= 10; step += 1) {
      const sample = cubicAt(from, control1, control2, to, step / 10);
      expect(Math.hypot(sample.x - centre.x, sample.z - centre.z)).toBeCloseTo(10, 1);
    }
  });

  it("sets the legs back by r / tan(theta/2), not by r", () => {
    const angle = Math.PI / 3;
    const before = corner({ x: 100, z: 0 }, { x: 100 * Math.cos(angle), z: 100 * Math.sin(angle) });
    const after = filletCorner(before, "v", 10)!;
    const cut = newPoints(before, after);
    const expectedTangent = 10 / Math.tan(angle / 2);
    for (const point of cut) {
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(expectedTangent, 6);
    }
  });

  it("keeps curved legs curved", () => {
    const before = corner({ x: 40, z: 0 }, { x: 0, z: 40 }, "bezier");
    const after = filletCorner(before, "v", 8)!;
    // Two legs plus the arc, and no leg was flattened into a line.
    expect(after.segments).toHaveLength(3);
    expect(after.segments.filter((s) => s.kind === "line")).toHaveLength(0);
  });

  it("clamps to the available leg length instead of overrunning", () => {
    const before = corner({ x: 10, z: 0 }, { x: 0, z: 10 });
    const after = filletCorner(before, "v", 100)!;
    for (const point of newPoints(before, after)) {
      expect(Math.hypot(point.x, point.z)).toBeLessThanOrEqual(10 * 0.45 + 1e-9);
    }
  });

  it("refuses a corner that is not a corner", () => {
    expect(filletCorner(corner({ x: 40, z: 0 }, { x: -40, z: 0 }), "v", 5)).toBeNull();
    expect(filletCorner(corner({ x: 40, z: 0 }, { x: 20, z: 0 }), "v", 5)).toBeNull();
    expect(filletCorner(corner({ x: 40, z: 0 }, { x: 0, z: 40 }), "v", 0)).toBeNull();
    expect(filletCorner(corner({ x: 40, z: 0 }, { x: 0, z: 40 }), "missing", 5)).toBeNull();
  });
});

describe("chamferCorner", () => {
  it("sets each leg back by exactly the requested distance", () => {
    const angle = Math.PI / 3;
    const before = corner({ x: 100, z: 0 }, { x: 100 * Math.cos(angle), z: 100 * Math.sin(angle) });
    const after = chamferCorner(before, "v", 12)!;
    for (const point of newPoints(before, after)) {
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(12, 6);
    }
  });

  it("cuts straight across with no handles", () => {
    const before = corner({ x: 40, z: 0 }, { x: 0, z: 40 });
    const after = chamferCorner(before, "v", 10)!;
    const cut = newPoints(before, after);
    for (const point of cut) {
      expect(point.handleIn).toBeUndefined();
      expect(point.handleOut).toBeUndefined();
    }
    const across = after.segments.find((s) => cut.every((p) => [s.startId, s.endId].includes(p.id)));
    expect(across?.kind).toBe("line");
  });

  it("leaves handles on unrelated points alone", () => {
    // Stripping handles across the whole profile destroyed curves nowhere near the chamfer.
    const before = corner({ x: 40, z: 0 }, { x: 0, z: 40 });
    before.points.push({ id: "far", x: 90, z: 90, mode: "smooth", handleIn: { x: 85, z: 90 }, handleOut: { x: 95, z: 90 } });
    const after = chamferCorner(before, "v", 10)!;
    const far = pointById(after, "far");
    expect(far.handleIn).toEqual({ x: 85, z: 90 });
    expect(far.handleOut).toEqual({ x: 95, z: 90 });
    expect(far.mode).toBe("smooth");
  });
});
