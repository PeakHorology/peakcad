import { describe, expect, it } from "vitest";
import { __blueprintTestUtils, blueprintPartFrame, buildBlueprintPdf, type BlueprintMeshPart } from "../../apps/web/src/lib/blueprintExport";

const boxPart = (): BlueprintMeshPart => ({
  name: "Block",
  kind: "box",
  width: 40,
  depth: 20,
  height: 10,
  elevation: 0,
  x: 0,
  z: 0,
  vertices: [
    [-20, 0, -10],
    [20, 0, -10],
    [20, 0, 10],
    [-20, 0, 10],
    [-20, 10, -10],
    [20, 10, -10],
    [20, 10, 10],
    [-20, 10, 10],
  ],
  faces: [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0],
  ],
});

function cylinderPart(sides = 48): BlueprintMeshPart {
  const radius = 32;
  const height = 12;
  const vertices: Array<[number, number, number]> = [[0, height, 0], [0, 0, 0]];
  const faces: Array<[number, number, number]> = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    vertices.push([Math.cos(angle) * radius, height, Math.sin(angle) * radius]);
    vertices.push([Math.cos(angle) * radius, 0, Math.sin(angle) * radius]);
  }
  for (let i = 0; i < sides; i += 1) {
    const next = (i + 1) % sides;
    const topA = 2 + i * 2;
    const botA = topA + 1;
    const topB = 2 + next * 2;
    const botB = topB + 1;
    faces.push([0, topA, topB]);
    faces.push([1, botB, botA]);
    faces.push([topA, botA, botB]);
    faces.push([topA, botB, topB]);
  }
  return {
    name: "Cup",
    kind: "cylinder",
    width: radius * 2,
    depth: radius * 2,
    height,
    elevation: 0,
    x: 0,
    z: 0,
    vertices,
    faces,
  };
}

describe("blueprintExport", () => {
  it("projects orthographic and isometric points", () => {
    const point: [number, number, number] = [10, 5, 2];
    expect(__blueprintTestUtils.projectPoint("top", point)).toEqual({ x: 10, y: -2 });
    expect(__blueprintTestUtils.projectPoint("front", point)).toEqual({ x: 10, y: 5 });
    expect(__blueprintTestUtils.projectPoint("right", point)).toEqual({ x: 2, y: 5 });
    const iso = __blueprintTestUtils.projectPoint("iso", point);
    expect(iso.x).toBeCloseTo((10 - 2) * Math.cos(Math.PI / 6), 5);
    expect(iso.y).toBeCloseTo(5 + (10 + 2) * Math.sin(Math.PI / 6), 5);
  });

  it("keeps cylinder top views as outlines instead of tessellation spaghetti", () => {
    const part = cylinderPart(64);
    const totalTriangleEdges = part.faces.length * 3;
    const topEdges = __blueprintTestUtils.collectDrawingEdges(part, "top");
    // Top/bottom rims only (~2 * sides), not every radial fan spoke.
    expect(topEdges.length).toBeLessThan(part.faces.length);
    expect(topEdges.length).toBeLessThan(totalTriangleEdges / 4);
    expect(topEdges.length).toBeGreaterThanOrEqual(32);
  });

  it("derives table dimensions from transformed mesh bounds", () => {
    const frame = blueprintPartFrame(
      [
        [5, -3, 10],
        [25, 7, 40],
        [15, 2, 20],
      ],
      { width: 1, depth: 1, height: 1, elevation: 0, x: 0, z: 0 },
    );
    expect(frame).toEqual({
      width: 20,
      depth: 30,
      height: 10,
      elevation: -3,
      x: 15,
      z: 25,
    });
  });

  it("builds a non-empty PDF for solid parts", () => {
    const bytes = buildBlueprintPdf({
      projectName: "Test Assembly",
      parts: [boxPart()],
      workspace: { units: "Metric (Default)", scale: "1:1 (millimeters)", accuracy: 2 },
    });
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    const head = String.fromCharCode(...bytes.slice(0, 5));
    expect(head).toBe("%PDF-");
  });

  it("rejects empty part lists", () => {
    expect(() =>
      buildBlueprintPdf({
        projectName: "Empty",
        parts: [],
        workspace: { units: "Metric (Default)", scale: "1:1 (millimeters)", accuracy: 2 },
      }),
    ).toThrow(/solid shape/i);
  });
});
