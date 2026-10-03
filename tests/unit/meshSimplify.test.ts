import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { WorkplaneShape } from "@/types/sketchforge";
import { simplifiedImportedShapePatch } from "@/lib/meshSimplify";

function indexedFrom(geometry: THREE.BufferGeometry): { positions: number[]; indices: number[] } {
  const position = geometry.getAttribute("position");
  const positions: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    positions.push(position.getX(i), position.getY(i), position.getZ(i));
  }
  const index = geometry.index;
  const indices = index ? Array.from(index.array) : positions.map((_, i) => i);
  geometry.dispose();
  return { positions, indices };
}

function merge(parts: Array<{ positions: number[]; indices: number[] }>): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    for (const index of part.indices) indices.push(index + offset);
  }
  return { positions, indices };
}

function shapeOf(mesh: { positions: number[]; indices: number[] }): WorkplaneShape {
  return {
    id: "imported",
    name: "Imported",
    kind: "mesh",
    color: "#b0b0b0",
    x: 0,
    z: 0,
    size: 8,
    width: 8,
    depth: 6,
    height: 2,
    rotation: 0,
    importedMesh: {
      positions: mesh.positions,
      indices: mesh.indices,
      baseWidth: 8,
      baseDepth: 6,
      baseHeight: 2,
      triangleCount: mesh.indices.length / 3,
      sourceFormat: "step",
    },
  };
}

describe("triangle reduce", () => {
  it("drops interior triangles on a faceted plate without sanding off a thin rib", async () => {
    const plate = indexedFrom(new THREE.BoxGeometry(8, 1, 6, 8, 2, 8));
    const rib = indexedFrom(new THREE.BoxGeometry(0.2, 0.8, 6, 1, 2, 12));
    for (let i = 1; i < rib.positions.length; i += 3) rib.positions[i] += 0.9;
    const mesh = merge([plate, rib]);
    const sourceTriangles = mesh.indices.length / 3;

    const patch = await simplifiedImportedShapePatch(shapeOf(mesh), 0.4);
    const next = patch?.importedMesh;
    expect(next).toBeTruthy();
    expect(next!.triangleCount).toBeLessThan(sourceTriangles);

    let maxY = -Infinity;
    let thin = 0;
    for (let i = 0; i < next!.positions.length; i += 3) {
      const y = next!.positions[i + 1];
      if (y > maxY) maxY = y;
      if (y > 1.15) thin += 1;
    }
    expect(maxY).toBeGreaterThan(1.25);
    expect(thin).toBeGreaterThan(4);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < next!.positions.length; i += 3) {
      minX = Math.min(minX, next!.positions[i]);
      maxX = Math.max(maxX, next!.positions[i]);
      minZ = Math.min(minZ, next!.positions[i + 2]);
      maxZ = Math.max(maxZ, next!.positions[i + 2]);
    }
    expect(maxX - minX).toBeGreaterThan(7.9);
    expect(maxZ - minZ).toBeGreaterThan(5.9);
  });

  it("stores face normals at a box corner instead of one averaged vector", async () => {
    const box = indexedFrom(new THREE.BoxGeometry(4, 4, 4, 4, 4, 4));
    const patch = await simplifiedImportedShapePatch(shapeOf(box), 0.4);
    const mesh = patch?.importedMesh;
    expect(mesh?.normals?.length).toBe(mesh?.positions.length);

    const cornerNormals: Array<[number, number, number]> = [];
    for (let i = 0; i < mesh!.positions.length; i += 3) {
      const dx = mesh!.positions[i] - 2;
      const dy = mesh!.positions[i + 1] - 2;
      const dz = mesh!.positions[i + 2] - 2;
      if (dx * dx + dy * dy + dz * dz < 0.04) {
        cornerNormals.push([mesh!.normals![i], mesh!.normals![i + 1], mesh!.normals![i + 2]]);
      }
    }
    expect(cornerNormals.length).toBeGreaterThan(1);
    let minDot = 1;
    for (let a = 0; a < cornerNormals.length; a += 1) {
      for (let b = a + 1; b < cornerNormals.length; b += 1) {
        const dot = cornerNormals[a][0] * cornerNormals[b][0] + cornerNormals[a][1] * cornerNormals[b][1] + cornerNormals[a][2] * cornerNormals[b][2];
        if (dot < minDot) minDot = dot;
      }
    }
    expect(minDot).toBeLessThan(0.2);
  });

  it("spends the triangle cut on a large flat grid and keeps a small sharp part", async () => {
    const plate = indexedFrom(new THREE.BoxGeometry(20, 0.5, 20, 10, 1, 10));
    const jewel = indexedFrom(new THREE.BoxGeometry(1, 1, 1));
    for (let i = 0; i < jewel.positions.length; i += 3) jewel.positions[i] += 40;
    const mesh = merge([plate, jewel]);

    const plateBefore = plate.indices.length / 3;
    const jewelBefore = jewel.indices.length / 3;
    const patch = await simplifiedImportedShapePatch(shapeOf(mesh), 0.4);
    const next = patch?.importedMesh;
    expect(next).toBeTruthy();

    let plateAfter = 0;
    let jewelAfter = 0;
    for (let i = 0; i < next!.indices.length; i += 3) {
      let x = 0;
      for (const index of [next!.indices[i], next!.indices[i + 1], next!.indices[i + 2]]) {
        x += next!.positions[index * 3];
      }
      if (x / 3 > 20) jewelAfter += 1;
      else plateAfter += 1;
    }
    const plateRatio = plateAfter / plateBefore;
    const jewelRatio = jewelAfter / jewelBefore;
    expect(plateRatio).toBeLessThan(0.5);
    expect(jewelRatio).toBeGreaterThan(0.9);
    expect(plateRatio).toBeLessThan(jewelRatio * 0.5);
  });
});
