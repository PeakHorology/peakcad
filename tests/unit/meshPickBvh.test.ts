import { describe, expect, it } from "vitest";
import { buildPickBvh, raycastPickBvh, type PickTriangle } from "@/lib/meshPickBvh";

function triangle(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): PickTriangle {
  return { ax: a[0], ay: a[1], az: a[2], bx: b[0], by: b[1], bz: b[2], cx: c[0], cy: c[1], cz: c[2] };
}

describe("mesh pick index", () => {
  it("hits the near triangle and skips one that only shares the ray on screen", () => {
    const near = triangle([0, 0, 0], [2, 0, 0], [0, 2, 0]);
    const far = triangle([0, 0, 10], [2, 0, 10], [0, 2, 10]);
    const extras = Array.from({ length: 40 }, (_, index) => triangle(
      [20 + index, 0, 0],
      [21 + index, 0, 0],
      [20 + index, 1, 0],
    ));
    const root = buildPickBvh([far, ...extras, near]);
    expect(root).not.toBeNull();
    const hit = raycastPickBvh(root!, { x: 0.4, y: 0.4, z: 5 }, { x: 0, y: 0, z: -1 });
    expect(hit).not.toBeNull();
    expect(hit!.z).toBeCloseTo(0, 4);
    expect(hit!.t).toBeCloseTo(5, 4);
  });

  it("rejects a back face unless both sides count", () => {
    const root = buildPickBvh([triangle([0, 0, 0], [0, 2, 0], [2, 0, 0])]);
    const origin = { x: 0.4, y: 0.4, z: 5 };
    const direction = { x: 0, y: 0, z: -1 };
    expect(raycastPickBvh(root!, origin, direction)).toBeNull();
    expect(raycastPickBvh(root!, origin, direction, true)?.z).toBeCloseTo(0, 4);
  });
});
