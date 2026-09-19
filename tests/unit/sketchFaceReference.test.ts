import { describe, expect, it } from "vitest";
import { prepareFaceSketchReference, type WorldTriangle } from "@/lib/sketchFaceReference";
import type { SketchPlane } from "@/types/sketchforge";

const TOP_PLANE: SketchPlane = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  uAxis: { x: 1, y: 0, z: 0 },
};

function pt(x: number, z: number) {
  return { x, y: 0, z };
}

describe("prepareFaceSketchReference", () => {
  it("returns one loop for a clean square face", () => {
    const a = pt(-10, -10);
    const b = pt(10, -10);
    const c = pt(10, 10);
    const d = pt(-10, 10);
    const triangles: WorldTriangle[] = [[a, b, c], [a, c, d]];

    const { loops } = prepareFaceSketchReference(TOP_PLANE, triangles);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it("drops a boundary walk that never closed", () => {
    // Three triangles sharing edge A-B. That edge is incident to three faces, so the count===1
    // boundary filter discards it and leaves A and B with odd degree: the walk finds the real
    // quad B-C-A-D and then strands A-E-B as an open chain. Accepting a chain on point count
    // alone handed back a face reference whose outline never closed.
    const a = pt(0, 0);
    const b = pt(10, 0);
    const c = pt(5, 5);
    const d = pt(5, -5);
    const e = pt(15, 3);
    const triangles: WorldTriangle[] = [[a, b, c], [a, b, d], [a, b, e]];

    const { loops } = prepareFaceSketchReference(TOP_PLANE, triangles);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it("keeps both loops of a face with a hole", () => {
    // Square annulus: outer ring and an inner square hole, triangulated so the hole's edges are
    // each used once and therefore register as a second boundary loop.
    const o = [pt(-20, -20), pt(20, -20), pt(20, 20), pt(-20, 20)];
    const i = [pt(-5, -5), pt(5, -5), pt(5, 5), pt(-5, 5)];
    const triangles: WorldTriangle[] = [];
    for (let k = 0; k < 4; k += 1) {
      const next = (k + 1) % 4;
      triangles.push([o[k], o[next], i[next]]);
      triangles.push([o[k], i[next], i[k]]);
    }

    const { loops } = prepareFaceSketchReference(TOP_PLANE, triangles);
    expect(loops).toHaveLength(2);
    expect(loops.map((loop) => loop.length).sort()).toEqual([4, 4]);
  });

  it("returns no loops when nothing is coplanar with the plane", () => {
    const triangles: WorldTriangle[] = [[
      { x: 0, y: 5, z: 0 },
      { x: 10, y: 5, z: 0 },
      { x: 0, y: 5, z: 10 },
    ]];
    const { loops } = prepareFaceSketchReference(
      { ...TOP_PLANE, normal: { x: 1, y: 0, z: 0 }, uAxis: { x: 0, y: 1, z: 0 } },
      triangles,
    );
    expect(loops).toHaveLength(0);
  });
});
