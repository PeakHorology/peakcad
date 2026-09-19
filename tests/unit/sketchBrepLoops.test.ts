import { describe, expect, it } from "vitest";
import { pathArea, pathContains, type ClosedPath } from "@/lib/sketchBrep";

function rect(x: number, z: number, w: number, d: number): ClosedPath {
  return {
    points: [
      { x, z },
      { x: x + w, z },
      { x: x + w, z: z + d },
      { x, z: z + d },
    ],
  };
}

/** The nesting rule drawingFromClosedPaths applies, without needing the OCCT kernel. */
function loopRoles(paths: ClosedPath[]): ("material" | "void")[] {
  const sorted = [...paths].sort((a, b) => pathArea(b) - pathArea(a));
  return sorted.map((path, i) => {
    let depth = 0;
    for (let j = 0; j < i; j += 1) {
      if (pathContains(sorted[j], path)) depth += 1;
    }
    return depth % 2 === 1 ? "void" : "material";
  });
}

describe("sketch B-Rep loop nesting", () => {
  it("cuts a hole that sits inside the second outline, not just the largest one", () => {
    // Two 20mm plates side by side, each with its own 5mm hole. Testing containment against only
    // the largest loop fused the second hole as solid material, so the STEP had a plug where the
    // viewport showed a hole.
    const roles = loopRoles([
      rect(0, 0, 20, 20),
      rect(5, 5, 5, 5),
      rect(40, 0, 20, 20),
      rect(45, 5, 5, 5),
    ]);
    expect(roles).toEqual(["material", "material", "void", "void"]);
  });

  it("keeps a single plate with a hole working", () => {
    expect(loopRoles([rect(0, 0, 20, 20), rect(5, 5, 5, 5)])).toEqual(["material", "void"]);
  });

  it("treats an island inside a hole as material again", () => {
    const roles = loopRoles([rect(0, 0, 40, 40), rect(5, 5, 30, 30), rect(10, 10, 10, 10)]);
    expect(roles).toEqual(["material", "void", "material"]);
  });

  it("leaves two separate outlines with no holes as material", () => {
    expect(loopRoles([rect(0, 0, 20, 20), rect(40, 0, 20, 20)])).toEqual(["material", "material"]);
  });

  it("measures true area so a diagonal sliver cannot outrank the loop that encloses it", () => {
    const square = rect(0, 0, 10, 10);
    // Bounding box 9x9 = 81, larger than the square's 100? No — but a thin diagonal inside the
    // square has bbox 81 while its real area is ~4.5, so bbox ordering could rank it as outer.
    const sliver: ClosedPath = {
      points: [
        { x: 0.5, z: 0.5 },
        { x: 9.5, z: 9.5 },
        { x: 9.5, z: 8.5 },
        { x: 0.5, z: 0.5 },
      ],
    };
    expect(pathArea(square)).toBeGreaterThan(pathArea(sliver));
    expect(loopRoles([square, sliver])).toEqual(["material", "void"]);
  });

  it("does not call a loop contained when it merely shares a corner", () => {
    expect(pathContains(rect(0, 0, 10, 10), rect(10, 10, 10, 10))).toBe(false);
  });
});
