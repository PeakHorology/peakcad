import { describe, expect, it } from "vitest";
import {
  isModifierDisplayCadEdge,
  isSelectableModifierEdge,
  recoveredHoleRimClassification,
  treatmentDetailFaceAreaLimit,
} from "@/lib/cadModifierEdges";

const SHARP_ANGLE = 25;

function edge(overrides: Partial<Parameters<typeof isModifierDisplayCadEdge>[0]>) {
  return {
    curveType: "line",
    surfaceTypes: ["plane", "plane"],
    angle: 90,
    manifold: true,
    boundary: false,
    pointCount: 12,
    faceAreas: [1200, 400],
    ...overrides,
  };
}

describe("CAD modifier hole-rim selection", () => {
  it("keeps a circular hole rim selectable after earlier chamfers hide small faces", () => {
    const topFace = 40 * 40 - Math.PI * 10 * 10;
    const holeWall = 2 * Math.PI * 10 * 4;
    const treatmentLimit = treatmentDetailFaceAreaLimit([topFace, topFace, 160, 160, 160, 160, holeWall, 8, 8]);
    const rim = edge({
      curveType: "circle",
      surfaceTypes: ["plane", "cylinder"],
      angle: 90,
      faceAreas: [topFace, holeWall],
    });

    expect(treatmentLimit).toBeGreaterThan(holeWall);
    expect(isModifierDisplayCadEdge(rim, treatmentLimit)).toBe(true);
    expect(isSelectableModifierEdge(rim) && rim.angle >= SHARP_ANGLE).toBe(true);
  });

  it("still hides straight chamfer-strip rails that only touch a small blend face", () => {
    const treatmentLimit = treatmentDetailFaceAreaLimit([1600, 1600, 400, 8]);
    const rail = edge({
      curveType: "line",
      surfaceTypes: ["plane", "plane"],
      angle: 45,
      faceAreas: [1600, 8],
    });

    expect(isModifierDisplayCadEdge(rail, treatmentLimit)).toBe(false);
  });

  it("still hides a near-tangent fillet rail along a straight edge", () => {
    const treatmentLimit = treatmentDetailFaceAreaLimit([1600, 1600, 12]);
    const rail = edge({
      curveType: "line",
      surfaceTypes: ["plane", "cylinder"],
      angle: 2,
      faceAreas: [1600, 12],
    });

    expect(isModifierDisplayCadEdge(rail, treatmentLimit)).toBe(false);
  });

  it("recovers a closed hole rim when UV sampling reports a failed dihedral", () => {
    const failed = recoveredHoleRimClassification({
      curveType: "circle",
      surfaceTypes: ["plane", "cylinder"],
      angle: 0,
      manifold: false,
      boundary: false,
    });

    expect(failed).toEqual({
      curveType: "circle",
      surfaceTypes: ["plane", "cylinder"],
      angle: 90,
      manifold: true,
      boundary: false,
    });
    expect(isModifierDisplayCadEdge(edge({ ...failed, faceAreas: [1200, 200] }), 400)).toBe(true);
  });

  it("does not invent a dihedral for a non-hole curved edge", () => {
    const filletEnd = recoveredHoleRimClassification({
      curveType: "circle",
      surfaceTypes: ["plane", "torus"],
      angle: 0,
      manifold: false,
      boundary: false,
    });
    expect(filletEnd.manifold).toBe(false);
    expect(filletEnd.angle).toBe(0);
  });
});
