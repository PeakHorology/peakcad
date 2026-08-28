import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { seatTriangleSoupOnLargestFlatSurface } from "@/lib/meshSeatOrientation";
import { importTriangleSoup } from "@/lib/stlImport";

function boxPositions(width: number, height: number, depth: number) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  const mesh = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = mesh.getAttribute("position");
  const positions: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    positions.push(position.getX(i), position.getY(i), position.getZ(i));
  }
  geometry.dispose();
  if (mesh !== geometry) {
    mesh.dispose();
  }
  return positions;
}

function rotatePositions(positions: number[], axis: THREE.Vector3, degrees: number) {
  const q = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), (degrees * Math.PI) / 180);
  const out: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    p.set(positions[i], positions[i + 1], positions[i + 2]).applyQuaternion(q);
    out.push(p.x, p.y, p.z);
  }
  return out;
}

function bounds(positions: number[]) {
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
    depth: maxZ - minZ,
    minY,
  };
}

describe("seatTriangleSoupOnLargestFlatSurface", () => {
  it("lays a box on its largest face", () => {
    // Largest faces are 20×10 (±Z); after seating height should be the thin 4 axis.
    const positions = boxPositions(20, 10, 4);
    const seated = seatTriangleSoupOnLargestFlatSurface(positions);
    const size = bounds(seated.positions);
    expect(size.height).toBeCloseTo(4, 4);
    expect(Math.max(size.width, size.depth)).toBeCloseTo(20, 4);
    expect(Math.min(size.width, size.depth)).toBeCloseTo(10, 4);
  });

  it("rights a box that was imported on its side", () => {
    const upright = boxPositions(20, 4, 10);
    const onSide = rotatePositions(upright, new THREE.Vector3(0, 0, 1), 90);
    const seated = seatTriangleSoupOnLargestFlatSurface(onSide);
    const size = bounds(seated.positions);
    expect(size.height).toBeCloseTo(4, 4);
  });

  it("keeps the solid above the seated face", () => {
    const positions = boxPositions(12, 6, 8);
    const seated = seatTriangleSoupOnLargestFlatSurface(positions);
    const size = bounds(seated.positions);
    expect(size.minY + size.height / 2).toBeGreaterThan(size.minY);
  });
});

describe("importTriangleSoup seating", () => {
  it("centers the seated mesh on the workplane", () => {
    const onSide = rotatePositions(boxPositions(16, 3, 9), new THREE.Vector3(1, 0, 0), 90);
    const { shape } = importTriangleSoup("plate.stl", onSide, undefined, "stl");
    expect(shape.height).toBeCloseTo(3, 3);
    expect(shape.importedMesh?.positions).toBeTruthy();
    const size = bounds(shape.importedMesh!.positions);
    expect(size.minY).toBeCloseTo(0, 4);
    expect(size.height).toBeCloseTo(3, 3);
  });
});
