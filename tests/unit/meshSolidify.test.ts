import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { OcctKernel } from "occt-wasm";
import { reconstructSolid } from "@/workers/cadModifier.worker";

const occtDir = join(process.cwd(), "node_modules", "occt-wasm", "dist");
const { OcctKernel } = await import(pathToFileURL(join(occtDir, "index.js")).href);
const kernel: OcctKernel = await OcctKernel.init({ wasm: join(occtDir, "occt-wasm.wasm") });

function meshPartFromShapes(shapes: ReturnType<OcctKernel["makeBox"]>[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const shape of shapes) {
    const mesh = kernel.tessellate(shape, { linearDeflection: 0.2, angularDeflection: 0.5 });
    const offset = positions.length / 3;
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(index + offset);
  }
  return {
    hole: false,
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
  };
}

function gridFace(
  origin: { x: number; y: number; z: number },
  axisU: { x: number; y: number; z: number },
  axisV: { x: number; y: number; z: number },
  cells: number,
  positions: number[],
  indices: number[],
) {
  const base = positions.length / 3;
  const point = (u: number, v: number) => {
    positions.push(
      origin.x + axisU.x * u + axisV.x * v,
      origin.y + axisU.y * u + axisV.y * v,
      origin.z + axisU.z * u + axisV.z * v,
    );
  };
  for (let v = 0; v <= cells; v += 1) {
    for (let u = 0; u <= cells; u += 1) point(u / cells, v / cells);
  }
  const stride = cells + 1;
  for (let v = 0; v < cells; v += 1) {
    for (let u = 0; u < cells; u += 1) {
      const a = base + v * stride + u;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
}

describe("mesh solidify", () => {
  it("keeps both closed pieces of a disconnected mesh", () => {
    const part = meshPartFromShapes([
      kernel.makeBox(20, 8, 12),
      kernel.makeBoxFromCorners({ x: 40, y: 0, z: 0 }, { x: 52, y: 4, z: 8 }),
    ]);
    const solid = reconstructSolid(kernel, part);
    const pieces = kernel.isSolid(solid) ? [solid] : kernel.getSubShapes(solid, "solid");
    expect(pieces.length).toBe(2);
    expect(pieces.every((piece) => kernel.isValid(piece))).toBe(true);
  });

  it("merges a tessellated box into its six flat faces", () => {
    const positions: number[] = [];
    const indices: number[] = [];
    const width = 30;
    const depth = 16;
    const height = 10;
    gridFace({ x: 0, y: 0, z: height }, { x: width, y: 0, z: 0 }, { x: 0, y: depth, z: 0 }, 6, positions, indices);
    gridFace({ x: 0, y: 0, z: 0 }, { x: 0, y: depth, z: 0 }, { x: width, y: 0, z: 0 }, 6, positions, indices);
    gridFace({ x: 0, y: 0, z: 0 }, { x: width, y: 0, z: 0 }, { x: 0, y: 0, z: height }, 6, positions, indices);
    gridFace({ x: 0, y: depth, z: 0 }, { x: 0, y: 0, z: height }, { x: width, y: 0, z: 0 }, 6, positions, indices);
    gridFace({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: height }, { x: 0, y: depth, z: 0 }, 6, positions, indices);
    gridFace({ x: width, y: 0, z: 0 }, { x: 0, y: depth, z: 0 }, { x: 0, y: 0, z: height }, 6, positions, indices);
    const solid = reconstructSolid(kernel, {
      hole: false,
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
    });
    expect(kernel.isSolid(solid)).toBe(true);
    expect(kernel.getSubShapes(solid, "face").length).toBeLessThanOrEqual(12);
    expect(Math.abs(kernel.getVolume(solid))).toBeCloseTo(width * depth * height, -1);
  });

  it("keeps merged flat faces when the mesh also has curved triangles", () => {
    const positions: number[] = [];
    const indices: number[] = [];
    const width = 30;
    const depth = 16;
    const height = 10;
    gridFace({ x: 0, y: 0, z: height }, { x: width, y: 0, z: 0 }, { x: 0, y: depth, z: 0 }, 6, positions, indices);
    gridFace({ x: 0, y: 0, z: 0 }, { x: 0, y: depth, z: 0 }, { x: width, y: 0, z: 0 }, 6, positions, indices);
    gridFace({ x: 0, y: 0, z: 0 }, { x: width, y: 0, z: 0 }, { x: 0, y: 0, z: height }, 6, positions, indices);
    gridFace({ x: 0, y: depth, z: 0 }, { x: 0, y: 0, z: height }, { x: width, y: 0, z: 0 }, 6, positions, indices);
    gridFace({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: height }, { x: 0, y: depth, z: 0 }, 6, positions, indices);
    gridFace({ x: width, y: 0, z: 0 }, { x: 0, y: depth, z: 0 }, { x: 0, y: 0, z: height }, 6, positions, indices);
    const curved = kernel.tessellate(kernel.makeCylinder(6, 14), { linearDeflection: 0.35, angularDeflection: 0.45 });
    const offset = positions.length / 3;
    for (let index = 0; index < curved.positions.length; index += 3) {
      positions.push(curved.positions[index] + 80, curved.positions[index + 1], curved.positions[index + 2]);
    }
    for (const index of curved.indices) indices.push(index + offset);
    const solid = reconstructSolid(kernel, {
      hole: false,
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
    });
    const faces = kernel.getSubShapes(solid, "face").length;
    const triangles = indices.length / 3;
    expect(faces).toBeLessThan(triangles * 0.75);
    expect(faces).toBeGreaterThan(0);
  });
});
