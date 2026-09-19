import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import {
  aabbsOverlap,
  booleanResultLooksExploded,
  meshFrameOriginFromPositions,
  resolveImportedSolidScale,
  shapeYawDegrees,
  worldAabb,
} from "@/lib/stepExport";
import { facetedStepTriangleLimit, localBoxMesh, meshToBinaryStlBlob } from "@/lib/stepFacetedExport";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "s1",
    name: "Shape",
    kind: "box",
    color: "#ffffff",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...overrides,
  };
}

describe("shapeYawDegrees", () => {
  it("drops yaw on a circular cylinder so the exported diameter is invariant", () => {
    expect(shapeYawDegrees(shape({ kind: "cylinder", width: 8, depth: 8, rotation: 30 }))).toBe(0);
  });

  it("drops yaw on a circular cone too", () => {
    expect(shapeYawDegrees(shape({ kind: "cone", width: 8, depth: 8, rotation: 30 }))).toBe(0);
  });

  it("keeps yaw on an elliptical cylinder where orientation matters", () => {
    expect(shapeYawDegrees(shape({ kind: "cylinder", width: 8, depth: 4, rotation: 30 }))).toBe(30);
  });

  it("keeps yaw on a box regardless of footprint", () => {
    expect(shapeYawDegrees(shape({ kind: "box", width: 8, depth: 8, rotation: 45 }))).toBe(45);
  });

  it("keeps yaw on an n-gon prism, which is not invariant around Y", () => {
    // A hex standoff exported flat-to-flat while the viewport showed it point-to-point.
    expect(shapeYawDegrees(shape({ kind: "polygon", width: 8, depth: 8, sides: 6, rotation: 30 }))).toBe(30);
  });

  it("still drops yaw on genuinely round-about-Y kinds", () => {
    for (const kind of ["tube", "ring", "torus", "halfSphere"] as const) {
      expect(shapeYawDegrees(shape({ kind, width: 8, depth: 8, rotation: 30 }))).toBe(0);
    }
  });
});

describe("worldAabb", () => {
  it("builds a tight box for an axis-aligned shape, offset by elevation", () => {
    const box = worldAabb(shape({ x: 5, z: -3, elevation: 2, width: 10, depth: 6, height: 4 }));
    expect(box.min).toEqual([0, 2, -6]);
    expect(box.max).toEqual([10, 6, 0]);
  });

  it("falls back to the bounding-sphere box for a rotated shape", () => {
    const box = worldAabb(shape({ width: 10, depth: 6, height: 4, rotation: 30 }));
    const r = 0.5 * Math.sqrt(10 * 10 + 4 * 4 + 6 * 6);
    expect(box.min).toEqual([-r, 2 - r, -r]);
    expect(box.max).toEqual([r, 2 + r, r]);
  });

  it("treats a circular cylinder's yaw as no rotation and keeps the tight box", () => {
    const box = worldAabb(shape({ kind: "cylinder", width: 8, depth: 8, height: 4, rotation: 90 }));
    expect(box.min).toEqual([-4, 0, -4]);
    expect(box.max).toEqual([4, 4, 4]);
  });
});

describe("aabbsOverlap", () => {
  const a = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

  it("detects overlapping boxes", () => {
    expect(aabbsOverlap(a, { min: [5, 5, 5], max: [15, 15, 15] })).toBe(true);
  });

  it("treats face-touching boxes as overlapping (inclusive bounds)", () => {
    expect(aabbsOverlap(a, { min: [10, 0, 0], max: [20, 10, 10] })).toBe(true);
  });

  it("rejects boxes separated on a single axis", () => {
    expect(aabbsOverlap(a, { min: [11, 0, 0], max: [20, 10, 10] })).toBe(false);
    expect(aabbsOverlap(a, { min: [0, 0, 11], max: [10, 10, 20] })).toBe(false);
  });
});

describe("resolveImportedSolidScale", () => {
  const live = { width: 40, height: 2, depth: 40 };

  it("is identity when the reimported STEP already matches the live size", () => {
    expect(resolveImportedSolidScale(live, live)).toEqual({ width: 1, height: 1, depth: 1 });
  });

  it("shrinks a 1000x exploded STEP back to the live knurl", () => {
    const scale = resolveImportedSolidScale(live, { width: 40000, height: 2000, depth: 40000 });
    expect(scale.width).toBeCloseTo(0.001, 8);
    expect(scale.height).toBeCloseTo(0.001, 8);
    expect(scale.depth).toBeCloseTo(0.001, 8);
  });

  it("grows a millimetre-as-metre STEP back to the live knurl", () => {
    const scale = resolveImportedSolidScale(live, { width: 0.04, height: 0.002, depth: 0.04 });
    expect(scale.width).toBeCloseTo(1000, 6);
    expect(scale.height).toBeCloseTo(1000, 6);
    expect(scale.depth).toBeCloseTo(1000, 6);
  });
});

describe("booleanResultLooksExploded", () => {
  const knurl = { width: 40, height: 4, depth: 40 };

  it("rejects a union that grew an order of magnitude", () => {
    expect(booleanResultLooksExploded(knurl, { width: 400, height: 40, depth: 400 })).toBe(true);
  });

  it("keeps a stacked pair whose height merely doubled", () => {
    expect(booleanResultLooksExploded(knurl, { width: 40, height: 8, depth: 40 })).toBe(false);
  });
});

describe("meshFrameOriginFromPositions", () => {
  it("uses the bottom-center of a world-space soup so stored B-Rep matches the mesh frame", () => {
    const positions = [
      10, 20, -4,
      14, 20, -4,
      10, 28, -4,
      10, 20, 2,
      14, 20, 2,
      10, 28, 2,
    ];
    expect(meshFrameOriginFromPositions(positions)).toEqual({ x: 12, y: 20, z: -1 });
  });

  it("returns null for an empty soup", () => {
    expect(meshFrameOriginFromPositions([])).toBeNull();
  });
});

describe("faceted STEP mesh helpers", () => {
  it("builds a non-empty binary STL from a local box mesh", () => {
    const mesh = localBoxMesh(shape({ width: 10, depth: 6, height: 4 }));
    expect(mesh.faces.length).toBe(12);
    const blob = meshToBinaryStlBlob(mesh);
    expect(blob.size).toBeGreaterThan(84);
  });

  it("winds every box triangle so its normal points outward", () => {
    const width = 10;
    const depth = 6;
    const height = 4;
    const mesh = localBoxMesh(shape({ width, depth, height }));
    // Local frame spans y in [0, height] and is centred in x/z.
    const centre = [0, height / 2, 0];

    for (const [ia, ib, ic] of mesh.faces) {
      const a = mesh.vertices[ia];
      const b = mesh.vertices[ib];
      const c = mesh.vertices[ic];
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const normal = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      // A face's outward normal must point away from the solid's centre.
      const outward = [
        (a[0] + b[0] + c[0]) / 3 - centre[0],
        (a[1] + b[1] + c[1]) / 3 - centre[1],
        (a[2] + b[2] + c[2]) / 3 - centre[2],
      ];
      const alignment = normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2];
      expect(alignment).toBeGreaterThan(0);
    }
  });

  it("exposes a positive triangle cap", () => {
    expect(facetedStepTriangleLimit()).toBeGreaterThan(1000);
  });
});
