import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import { cutConcaveCorners, edgeIsConcave } from "@/workers/cadModifier.worker";

const occtDir = join(process.cwd(), "node_modules", "occt-wasm", "dist");
const { OcctKernel } = await import(pathToFileURL(join(occtDir, "index.js")).href);

const kernel: OcctKernel = await OcctKernel.init({ wasm: join(occtDir, "occt-wasm.wasm") });

function volume(shape: ShapeHandle) {
  return Math.abs(kernel.getVolume(shape));
}

function cut(solid: ShapeHandle, tool: ShapeHandle) {
  let result = kernel.simplify(kernel.cut(solid, tool));
  if (!kernel.isSolid(result)) {
    const solids = kernel.getSubShapes(result, "solid");
    if (solids.length === 1) result = solids[0];
  }
  return result;
}

function rectangularHole() {
  const plate = kernel.makeBoxFromCorners({ x: -20, y: 0, z: -15 }, { x: 20, y: 10, z: 15 });
  const cutter = kernel.makeBoxFromCorners({ x: -6, y: -1, z: -4 }, { x: 6, y: 12, z: 4 });
  return cut(plate, cutter);
}

function blindRoundHole() {
  const plate = kernel.makeBoxFromCorners({ x: -20, y: 0, z: -20 }, { x: 20, y: 10, z: 20 });
  let hole = kernel.makeCylinder(4, 6);
  hole = kernel.rotate(hole, { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, -Math.PI / 2);
  hole = kernel.translate(hole, 0, 4, 0);
  return cut(plate, hole);
}

function concaveEdges(solid: ShapeHandle) {
  return kernel.getSubShapes(solid, "edge").filter((edge) => edgeIsConcave(kernel, solid, edge));
}

describe("concave fillet", () => {
  it("rounds a rectangular hole corner without filling it", () => {
    const solid = rectangularHole();
    const edges = concaveEdges(solid);
    expect(edges).toHaveLength(4);
    const result = cutConcaveCorners(kernel, kernel.copy(solid), solid, edges, "fillet", 1, 45);
    expect(kernel.isValid(result)).toBe(true);
    expect(volume(result)).toBeCloseTo(11031.416, 2);
  });

  it("fillets the bottom of a blind round hole at a small radius", () => {
    const solid = blindRoundHole();
    const edges = concaveEdges(solid);
    expect(edges).toHaveLength(1);
    expect(kernel.curveType(edges[0])).toBe("circle");
    const before = volume(solid);
    for (const amount of [0.05, 0.2, 0.5]) {
      const result = cutConcaveCorners(kernel, kernel.copy(solid), solid, edges, "fillet", amount, 45);
      expect(kernel.isValid(result)).toBe(true);
      expect(kernel.isSolid(result)).toBe(true);
      const removed = before - volume(result);
      expect(removed).toBeGreaterThan(0);
      expect(removed).toBeLessThan(before * 0.02);
    }
  });

  it("fillets every corner of a slotted plate without a trial fillet per edge", () => {
    let solid = kernel.makeBoxFromCorners({ x: -40, y: 0, z: -20 }, { x: 40, y: 8, z: 20 });
    for (let index = 0; index < 8; index += 1) {
      const z = -16 + index * 4;
      const cutter = kernel.makeBoxFromCorners({ x: -30, y: -1, z }, { x: 30, y: 12, z: z + 1.5 });
      solid = cut(solid, cutter);
    }
    const edges = concaveEdges(solid);
    expect(edges).toHaveLength(32);
    const before = volume(solid);
    const result = cutConcaveCorners(kernel, kernel.copy(solid), solid, edges, "fillet", 0.4, 45);
    expect(kernel.isValid(result)).toBe(true);
    expect(before - volume(result)).toBeGreaterThan(1);
    expect(before - volume(result)).toBeLessThan(80);
  });

  it("rejects a radius that breaks through the blind-hole floor", () => {
    const solid = blindRoundHole();
    const edges = concaveEdges(solid);
    expect(() => cutConcaveCorners(kernel, kernel.copy(solid), solid, edges, "fillet", 5, 45)).toThrow(/smaller fillet/);
  });
});
