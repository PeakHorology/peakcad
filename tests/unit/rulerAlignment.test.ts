import { describe, expect, it } from "vitest";
import {
  antipodeThroughAxis,
  closestPointOnSegmentToRay,
  classifyMeasureAlignment,
  diameterMagnetTarget,
  faceToFacePoint,
  fitCircleFromPoints,
  intersectRayFiniteCylinder,
  measureAlignLabelPrefix,
  radialsAreOpposite,
  rulerEdgeNearSurfaceHit,
  snapPointToCylinder,
  vec3,
  vecDistance,
  vecLength,
} from "@/lib/rulerAlignment";

describe("classifyMeasureAlignment", () => {
  it("flags a hole diameter when the chord goes through the axis", () => {
    const alignment = classifyMeasureAlignment({
      start: vec3(-5, 4, 0),
      end: vec3(5, 4, 0),
      cylinder: { origin: vec3(0, 0, 0), axis: vec3(0, 1, 0), radius: 5 },
      round: true,
    });
    expect(alignment).toEqual({ kind: "diameter" });
    expect(measureAlignLabelPrefix(alignment?.kind)).toBe("⌀ ");
  });

  it("does not flag a chord that misses the center", () => {
    const alignment = classifyMeasureAlignment({
      start: vec3(-5, 4, 4),
      end: vec3(5, 4, 4),
      cylinder: { origin: vec3(0, 0, 0), axis: vec3(0, 1, 0), radius: 5 },
    });
    expect(alignment).toBeNull();
  });

  it("flags a near-full chord even when the midpoint is a little off-axis", () => {
    const alignment = classifyMeasureAlignment({
      start: vec3(-10, 4, 0),
      end: vec3(9.7, 4, 1.4),
      cylinder: { origin: vec3(0, 0, 0), axis: vec3(0, 1, 0), radius: 10 },
    });
    expect(alignment).toEqual({ kind: "diameter" });
  });

  it("flags a measure parallel to a box width axis", () => {
    const alignment = classifyMeasureAlignment({
      start: vec3(-10, 5, 0),
      end: vec3(10, 5, 0),
      axes: {
        origin: vec3(0, 5, 0),
        x: vec3(1, 0, 0),
        y: vec3(0, 1, 0),
        z: vec3(0, 0, 1),
      },
    });
    expect(alignment).toEqual({ kind: "axis", axis: "x" });
    expect(measureAlignLabelPrefix(alignment?.kind)).toBe("∥ ");
  });

  it("flags face-to-face distance along parallel normals", () => {
    const alignment = classifyMeasureAlignment({
      start: vec3(0, 0, 0),
      end: vec3(0, 12, 0),
      startNormal: vec3(0, 1, 0),
      endNormal: vec3(0, -1, 0),
    });
    expect(alignment).toEqual({ kind: "face" });
  });
});

describe("antipodeThroughAxis", () => {
  it("returns the opposite wall of a cylinder", () => {
    const antipode = antipodeThroughAxis(vec3(6, 3, 0), vec3(0, 0, 0), vec3(0, 1, 0));
    expect(antipode.x).toBeCloseTo(-6);
    expect(antipode.y).toBeCloseTo(3);
    expect(antipode.z).toBeCloseTo(0);
  });
});

describe("diameterMagnetTarget", () => {
  const circle = { center: vec3(0, 0, 0), axis: vec3(0, 1, 0), radius: 10 };

  it("snaps opposite-wall hits even when the pointer is farther than 12px from the exact antipode", () => {
    const target = diameterMagnetTarget(vec3(10, 4, 0), vec3(-9.6, 4.5, 1.2), circle, 22);
    expect(target).not.toBeNull();
    expect(target!.x).toBeCloseTo(-10);
    expect(target!.y).toBeCloseTo(4);
    expect(target!.z).toBeCloseTo(0);
  });

  it("does not snap a same-side hit that is far from the antipode", () => {
    expect(diameterMagnetTarget(vec3(10, 4, 0), vec3(9.8, 4, 2), circle, 40)).toBeNull();
  });
});

describe("snapPointToCylinder", () => {
  it("pushes a tessellated chord out to the true diameter", () => {
    const radius = 10;
    const sides = 64;
    const origin = vec3(0, 0, 0);
    const axis = vec3(0, 1, 0);
    const a = vec3(radius, 4, 0);
    const step = (2 * Math.PI) / sides;
    const b = vec3(radius * Math.cos(step), 4, radius * Math.sin(step));
    const chordMid = vec3((a.x + b.x) / 2, 4, (a.z + b.z) / 2);
    expect(vecDistance(chordMid, antipodeThroughAxis(chordMid, origin, axis))).toBeLessThan(2 * radius - 0.02);

    const snapped = snapPointToCylinder(chordMid, origin, axis, radius);
    expect(vecLength(vec3(snapped.x, 0, snapped.z))).toBeCloseTo(radius, 6);
    expect(snapped.y).toBeCloseTo(4, 6);
    const antipode = antipodeThroughAxis(snapped, origin, axis);
    expect(vecDistance(snapped, antipode)).toBeCloseTo(2 * radius, 6);
    expect(radialsAreOpposite(snapped, antipode, origin, axis)).toBe(true);
  });
});

describe("closestPointOnSegmentToRay", () => {
  it("hits the front of a segment instead of a screen-overlapping back edge", () => {
    const front = closestPointOnSegmentToRay(
      vec3(-5, 10, 0),
      vec3(5, 10, 0),
      vec3(0, 10, 40),
      vec3(0, 0, -1),
    );
    const back = closestPointOnSegmentToRay(
      vec3(-5, 0, -20),
      vec3(5, 0, -20),
      vec3(0, 10, 40),
      vec3(0, 0, -1),
    );
    expect(front.point.y).toBeCloseTo(10);
    expect(front.distance).toBeLessThan(back.distance);
    expect(front.rayT).toBeLessThan(back.rayT);
  });
});

describe("faceToFacePoint", () => {
  it("projects the first pick onto the opposite parallel face", () => {
    const next = faceToFacePoint(vec3(2, 0, 3), vec3(0, 1, 0), vec3(8, 20, -4), vec3(0, -1, 0));
    expect(next).not.toBeNull();
    expect(next!.x).toBeCloseTo(2);
    expect(next!.y).toBeCloseTo(20);
    expect(next!.z).toBeCloseTo(3);
  });
});

describe("rulerEdgeNearSurfaceHit", () => {
  it("accepts a crease next to the hit and rejects a far overlapping rim", () => {
    const hit = vec3(10, 10, 0);
    expect(rulerEdgeNearSurfaceHit(hit, vec3(10, 10, 0.4), 0.2)).toBe(true);
    expect(rulerEdgeNearSurfaceHit(hit, vec3(10, 0, 0), 0.2)).toBe(false);
  });
});

describe("intersectRayFiniteCylinder", () => {
  it("hits the near wall of a 20 mm cylinder", () => {
    const hit = intersectRayFiniteCylinder(
      vec3(0, 10, 40),
      vec3(0, 0, -1),
      vec3(0, 10, 0),
      vec3(0, 1, 0),
      10,
      10,
    );
    expect(hit).not.toBeNull();
    expect(hit!.point.z).toBeCloseTo(10, 4);
    expect(hit!.point.y).toBeCloseTo(10, 4);
  });
});

describe("fitCircleFromPoints", () => {
  it("fits a tessellated hole rim", () => {
    const points = Array.from({ length: 24 }, (_, index) => {
      const angle = (index / 24) * Math.PI * 2;
      return vec3(Math.cos(angle) * 4, 10, Math.sin(angle) * 4);
    });
    points.push(points[0]);
    const fit = fitCircleFromPoints(points);
    expect(fit).not.toBeNull();
    expect(fit!.radius).toBeCloseTo(4, 1);
    expect(Math.abs(fit!.axis.y)).toBeCloseTo(1, 1);
  });
});
