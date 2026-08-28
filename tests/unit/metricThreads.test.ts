import { describe, expect, it } from "vitest";
import {
  findMetricThread,
  inferThreadSideFromFace,
  metricThreadDepth,
  metricThreadMinorDiameter,
  nearestMetricThreadForDiameter,
  resolveThreadParams,
} from "@/lib/metricThreads";
import { buildThreadGrooveCutterMesh, threadGrooveMeshBounds } from "@/lib/threadGeometry";

describe("metricThreads", () => {
  it("exposes ISO coarse pitches", () => {
    expect(findMetricThread("M3")?.pitch).toBe(0.5);
    expect(findMetricThread("M6")?.pitch).toBe(1);
    expect(findMetricThread("M12")?.pitch).toBe(1.75);
  });

  it("picks the nearest metric size for a face diameter", () => {
    expect(nearestMetricThreadForDiameter(5.9).designation).toBe("M6");
    expect(nearestMetricThreadForDiameter(3.1).designation).toBe("M3");
  });

  it("resolves custom params without a designation", () => {
    const params = resolveThreadParams({
      majorDiameter: 7,
      pitch: 1.1,
      length: 8,
      side: "external",
      handedness: "left",
    });
    expect(params.designation).toBeUndefined();
    expect(params.majorDiameter).toBe(7);
    expect(params.pitch).toBe(1.1);
    expect(params.handedness).toBe("left");
    expect(params.depth).toBeCloseTo(metricThreadDepth(1.1), 5);
  });

  it("computes minor diameter below the major", () => {
    expect(metricThreadMinorDiameter(6, 1)).toBeLessThan(6);
    expect(metricThreadMinorDiameter(6, 1)).toBeGreaterThan(4);
  });

  it("infers internal threads when the face normal points toward the solid", () => {
    expect(
      inferThreadSideFromFace({
        faceCenter: { x: 3, y: 5, z: 0 },
        outwardNormal: { x: -1, y: 0, z: 0 },
        solidCenter: { x: 0, y: 5, z: 0 },
      }),
    ).toBe("internal");
    expect(
      inferThreadSideFromFace({
        faceCenter: { x: 3, y: 5, z: 0 },
        outwardNormal: { x: 1, y: 0, z: 0 },
        solidCenter: { x: 0, y: 5, z: 0 },
      }),
    ).toBe("external");
  });
});

describe("threadGeometry", () => {
  it("builds a helical groove cutter with expected axial span", () => {
    const params = resolveThreadParams({
      designation: "M6",
      length: 6,
      side: "external",
    });
    const mesh = buildThreadGrooveCutterMesh(
      { origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, radius: 3, height: 10 },
      params,
      "draft",
    );
    expect(mesh.triangleCount).toBeGreaterThan(20);
    const bounds = threadGrooveMeshBounds(mesh);
    expect(bounds.height).toBeGreaterThan(params.length * 0.5);
    expect(bounds.height).toBeLessThan(params.length + params.pitch * 2);
  });

  it("keeps internal cutters near the bore radius", () => {
    const params = resolveThreadParams({
      designation: "M8",
      length: 8,
      side: "internal",
    });
    const mesh = buildThreadGrooveCutterMesh(
      { origin: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 }, radius: 4, height: 12 },
      params,
      "standard",
    );
    const bounds = threadGrooveMeshBounds(mesh);
    const radial = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minZ), Math.abs(bounds.maxZ));
    expect(radial).toBeGreaterThan(3);
    expect(radial).toBeLessThan(8);
  });
});
