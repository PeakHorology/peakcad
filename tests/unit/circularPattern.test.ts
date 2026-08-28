import { describe, expect, it } from "vitest";
import {
  circularPatternCopyId,
  circularPatternInstances,
  circularPatternRadiusFromShape,
  circularPatternSuggestedRadius,
  circularPatternWouldClamp,
  clampCircularPatternCount,
  clampCircularPatternRadius,
  clampCircularPatternRotation,
  patternPolarAngle,
  patternRadius,
  patternYawDegrees,
  resolveCircularPatternSourceId,
} from "@/lib/circularPattern";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(partial: Partial<WorkplaneShape> & Pick<WorkplaneShape, "id" | "x" | "z">): WorkplaneShape {
  return {
    name: partial.name ?? "Box",
    kind: "box",
    color: "#fff",
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...partial,
  };
}

describe("clampCircularPatternCount", () => {
  it("clamps to 2–72", () => {
    expect(clampCircularPatternCount(1)).toBe(2);
    expect(clampCircularPatternCount(6.7)).toBe(7);
    expect(clampCircularPatternCount(100)).toBe(72);
  });
});

describe("clampCircularPatternRadius", () => {
  it("clamps radius to 1–100 mm", () => {
    expect(clampCircularPatternRadius(0)).toBe(1);
    expect(clampCircularPatternRadius(25.5)).toBe(25.5);
    expect(clampCircularPatternRadius(200)).toBe(100);
  });
});

describe("clampCircularPatternRotation", () => {
  it("snaps to 0 / 90 / 180 / 270 only", () => {
    expect(clampCircularPatternRotation(0)).toBe(0);
    expect(clampCircularPatternRotation(44)).toBe(0);
    expect(clampCircularPatternRotation(46)).toBe(90);
    expect(clampCircularPatternRotation(135)).toBe(90);
    expect(clampCircularPatternRotation(136)).toBe(180);
    expect(clampCircularPatternRotation(270)).toBe(270);
    expect(clampCircularPatternRotation(359)).toBe(0);
  });
});

describe("resolveCircularPatternSourceId", () => {
  it("maps stable copy ids and preview hits back to the source", () => {
    const sourceId = "box-1";
    const copyId = circularPatternCopyId(sourceId, 2);
    expect(resolveCircularPatternSourceId(sourceId, {
      sourceIds: [sourceId],
      count: 4,
      preview: null,
    })).toBe(sourceId);
    expect(resolveCircularPatternSourceId(copyId, {
      sourceIds: [sourceId],
      count: 4,
      preview: null,
    })).toBe(sourceId);
    expect(resolveCircularPatternSourceId("other", {
      sourceIds: [sourceId],
      count: 4,
      preview: null,
    })).toBeNull();
  });
});

describe("patternYawDegrees", () => {
  it("faces the center from +X", () => {
    expect(patternYawDegrees({ x: 0, z: 0 }, { x: 10, z: 0 })).toBeCloseTo(90);
  });

  it("faces the center from +Z", () => {
    expect(patternYawDegrees({ x: 0, z: 0 }, { x: 0, z: 10 })).toBeCloseTo(0);
  });
});

describe("circularPatternInstances", () => {
  it("places N=4 instances evenly and keeps instance 0 on the original slot", () => {
    const source = box({ id: "a", x: 10, z: 0, width: 12 });
    const center = { x: 0, z: 0 };
    const instances = circularPatternInstances([source], center, 4);
    expect(instances).toHaveLength(4);
    expect(instances[0].id).toBe("a");
    expect(instances[0].x).toBeCloseTo(10);
    expect(instances[0].z).toBeCloseTo(0);
    expect(patternRadius(center, instances[1])).toBeCloseTo(10);

    const angles = instances.map((shape) => patternPolarAngle(center, shape));
    const base = angles[0];
    const norm = (delta: number) => {
      let value = delta;
      while (value <= -Math.PI) value += Math.PI * 2;
      while (value > Math.PI) value -= Math.PI * 2;
      return value;
    };
    expect(norm(angles[1] - base)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(norm(angles[2] - base))).toBeCloseTo(Math.PI);
    expect(norm(angles[3] - base)).toBeCloseTo(-Math.PI / 2);
  });

  it("uses an explicit radius while keeping the original polar angle", () => {
    const source = box({ id: "a", x: 10, z: 0 });
    const center = { x: 0, z: 0 };
    const instances = circularPatternInstances([source], center, 4, { radius: 20 });
    expect(patternRadius(center, instances[0])).toBeCloseTo(20);
    expect(patternRadius(center, instances[1])).toBeCloseTo(20);
    expect(patternPolarAngle(center, instances[0])).toBeCloseTo(Math.PI / 2);
  });

  it("seats instance bottoms on the pivot top elevation", () => {
    const source = box({ id: "a", x: 10, z: 0, elevation: 2, height: 8 });
    const instances = circularPatternInstances([source], { x: 0, z: 0 }, 3, {
      radius: 15,
      seatElevation: 40,
    });
    for (const shape of instances) {
      expect(shape.elevation).toBe(40);
    }
  });

  it("orients every instance toward the center", () => {
    const source = box({ id: "a", x: 0, z: 20 });
    const center = { x: 0, z: 0 };
    const instances = circularPatternInstances([source], center, 3, { radius: 15 });
    for (const shape of instances) {
      expect(shape.rotation).toBeCloseTo(patternYawDegrees(center, { x: shape.x, z: shape.z }));
    }
  });

  it("applies a 90° rotation offset on top of face-center yaw", () => {
    const source = box({ id: "a", x: 0, z: 20 });
    const center = { x: 0, z: 0 };
    const instances = circularPatternInstances([source], center, 3, { radius: 15, rotationOffset: 90 });
    for (const shape of instances) {
      const facing = patternYawDegrees(center, { x: shape.x, z: shape.z });
      let expected = facing + 90;
      while (expected > 180) expected -= 360;
      while (expected <= -180) expected += 360;
      expect(shape.rotation).toBeCloseTo(expected);
    }
  });

  it("suggests a starting radius from source distance", () => {
    expect(circularPatternSuggestedRadius([box({ id: "a", x: 30, z: 0 })], { x: 0, z: 0 })).toBe(30);
  });

  it("uses the pivot footprint radius when starting a pattern", () => {
    expect(circularPatternRadiusFromShape(box({ id: "cyl", x: 0, z: 0, width: 40, depth: 40, height: 40 }))).toBe(20);
    expect(circularPatternRadiusFromShape(box({ id: "box", x: 0, z: 0, width: 30, depth: 10, height: 30 }))).toBe(15);
  });

  it("detects when patterned positions would clamp to ±110", () => {
    expect(circularPatternWouldClamp({ x: 0, z: 0 }, 20, 6)).toBe(false);
    expect(circularPatternWouldClamp({ x: 100, z: 0 }, 50, 8)).toBe(true);
  });
});
