import { describe, expect, it } from "vitest";
import { tangentCadEdgeChain } from "@/lib/editorEdgeTreatments";
import type { CadModifierEdge } from "@/lib/cadModifierTypes";

function segment(id: number, x0: number, x1: number): CadModifierEdge {
  return {
    id,
    points: [x0, 0, 0, x1, 0, 0],
    display: true,
    selectable: true,
    angle: 90,
    boundary: false,
    manifold: true,
  };
}

describe("tangent fillet chain", () => {
  it("keeps a short smooth run together", () => {
    const edges = [segment(0, 0, 10), segment(1, 10, 20), segment(2, 20, 30)];
    const allowed = new Set(edges.map((edge) => edge.id));
    expect(tangentCadEdgeChain(edges, 0, allowed).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("does not fillet a whole tessellated loop from one click", () => {
    const edges = Array.from({ length: 40 }, (_, id) => segment(id, id, id + 1));
    const allowed = new Set(edges.map((edge) => edge.id));
    expect(tangentCadEdgeChain(edges, 0, allowed)).toEqual([0]);
  });
});
