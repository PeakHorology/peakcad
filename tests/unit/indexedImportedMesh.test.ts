import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { WorkplaneShape } from "@/types/sketchforge";
import { seatRotationForIndexedMeshes, seatTriangleSoupOnLargestFlatSurface } from "@/lib/meshSeatOrientation";
import { importedMeshForShape } from "@/lib/editorShapeMesh";
import { localMeshFromImportedShape } from "@/lib/stepFacetedExport";
import { filterCoplanarDisplayEdges } from "@/lib/csgTree";
import { importedMeshTriangleCount } from "@/lib/editorHistory";
import { meshGeometryKey } from "@/lib/meshContentHash";

type IndexedMesh = { positions: number[]; indices: number[] };

function indexedGeometry(geometry: THREE.BufferGeometry): IndexedMesh {
  const position = geometry.getAttribute("position");
  const positions: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    positions.push(position.getX(i), position.getY(i), position.getZ(i));
  }
  const indices = Array.from(geometry.index!.array);
  geometry.dispose();
  return { positions, indices };
}

function soupOf(mesh: IndexedMesh) {
  const soup: number[] = [];
  mesh.indices.forEach((index) => {
    soup.push(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]);
  });
  return soup;
}

function transformed(mesh: IndexedMesh, matrix: THREE.Matrix4): IndexedMesh {
  const p = new THREE.Vector3();
  const positions: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    p.fromArray(mesh.positions, i).applyMatrix4(matrix);
    positions.push(p.x, p.y, p.z);
  }
  return { positions, indices: mesh.indices.slice() };
}

function rotatedExtent(positions: number[], rotation: THREE.Quaternion) {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    box.expandByPoint(p.fromArray(positions, i).applyQuaternion(rotation));
  }
  return box.getSize(new THREE.Vector3());
}

function extentOf(positions: number[]) {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    box.expandByPoint(p.fromArray(positions, i));
  }
  return box.getSize(new THREE.Vector3());
}

function meshShape(mesh: IndexedMesh, overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  const size = extentOf(mesh.positions);
  return {
    id: "imported",
    name: "Imported",
    kind: "mesh",
    color: "#b0b0b0",
    x: 0,
    z: 0,
    size: Math.max(size.x, size.z),
    width: size.x,
    depth: size.z,
    height: size.y,
    rotation: 0,
    importedMesh: {
      positions: mesh.positions,
      indices: mesh.indices,
      baseWidth: size.x,
      baseDepth: size.z,
      baseHeight: size.y,
      triangleCount: mesh.indices.length / 3,
      sourceFormat: "step",
    },
    ...overrides,
  };
}

describe("indexed imported meshes", () => {
  it("seats an indexed body exactly like the equivalent triangle soup", () => {
    const box = indexedGeometry(new THREE.BoxGeometry(20, 4, 10));
    const onSide = transformed(box, new THREE.Matrix4().makeRotationZ(Math.PI / 2));

    const rotation = seatRotationForIndexedMeshes([onSide]);
    const indexedSize = rotatedExtent(onSide.positions, rotation);
    const soupSize = extentOf(seatTriangleSoupOnLargestFlatSurface(soupOf(onSide)).positions);

    expect(indexedSize.y).toBeCloseTo(4, 4);
    expect(indexedSize.x).toBeCloseTo(soupSize.x, 4);
    expect(indexedSize.y).toBeCloseTo(soupSize.y, 4);
    expect(indexedSize.z).toBeCloseTo(soupSize.z, 4);
  });

  it("seats a multi-body assembly from per-body indexed meshes without concatenating them", () => {
    const plate = indexedGeometry(new THREE.BoxGeometry(30, 2, 20));
    const post = transformed(
      indexedGeometry(new THREE.CylinderGeometry(2, 2, 12, 24)),
      new THREE.Matrix4().makeTranslation(0, 7, 0),
    );
    const tilt = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    const bodies = [transformed(plate, tilt), transformed(post, tilt)];

    const rotation = seatRotationForIndexedMeshes(bodies);
    const combined = bodies.flatMap((body) => body.positions);
    const combinedSoup = bodies.flatMap(soupOf);

    const indexedSize = rotatedExtent(combined, rotation);
    const soupSize = extentOf(seatTriangleSoupOnLargestFlatSurface(combinedSoup).positions);
    expect(indexedSize.x).toBeCloseTo(soupSize.x, 4);
    expect(indexedSize.y).toBeCloseTo(soupSize.y, 4);
    expect(indexedSize.z).toBeCloseTo(soupSize.z, 4);
    // The post must stand up from the plate, not hang below it.
    const p = new THREE.Vector3();
    let postMinY = Infinity;
    for (let i = 0; i < bodies[1].positions.length; i += 3) {
      postMinY = Math.min(postMinY, p.fromArray(bodies[1].positions, i).applyQuaternion(rotation).y);
    }
    let plateMinY = Infinity;
    for (let i = 0; i < bodies[0].positions.length; i += 3) {
      plateMinY = Math.min(plateMinY, p.fromArray(bodies[0].positions, i).applyQuaternion(rotation).y);
    }
    expect(postMinY).toBeGreaterThan(plateMinY);
  });

  it("counts triangles from indices when present and from positions otherwise", () => {
    const box = indexedGeometry(new THREE.BoxGeometry(2, 2, 2));
    expect(box.positions.length / 9).not.toBe(12);
    expect(importedMeshTriangleCount(box)).toBe(12);
    expect(importedMeshTriangleCount({ positions: soupOf(box) })).toBe(12);
  });

  it("walks indexed faces for editor meshes and faceted export with correct bounds", () => {
    const box = indexedGeometry(new THREE.BoxGeometry(12, 6, 8));
    const lifted = transformed(box, new THREE.Matrix4().makeTranslation(0, 3, 0));
    const shape = meshShape(lifted);

    const editorMesh = importedMeshForShape(shape);
    expect(editorMesh.faces).toHaveLength(12);
    expect(editorMesh.vertices).toHaveLength(lifted.positions.length / 3);

    const local = localMeshFromImportedShape(shape)!;
    expect(local.faces).toHaveLength(12);
    const box3 = new THREE.Box3();
    local.vertices.forEach((vertex) => box3.expandByPoint(new THREE.Vector3(...vertex)));
    expect(box3.min.y).toBeCloseTo(0, 5);
    const size = box3.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(12, 5);
    expect(size.y).toBeCloseTo(6, 5);
    expect(size.z).toBeCloseTo(8, 5);

    // Closed volume via the divergence theorem: every indexed face must be walked once.
    let volume = 0;
    local.faces.forEach(([a, b, c]) => {
      const va = new THREE.Vector3(...local.vertices[a]);
      const vb = new THREE.Vector3(...local.vertices[b]);
      const vc = new THREE.Vector3(...local.vertices[c]);
      volume += va.dot(vb.cross(vc)) / 6;
    });
    expect(Math.abs(volume)).toBeCloseTo(12 * 6 * 8, 3);
  });

  it("filters coplanar display edges identically for indexed and soup meshes", () => {
    const box = indexedGeometry(new THREE.BoxGeometry(10, 10, 10));
    // A real crease (top front edge) and a same-plane split (diagonal of the top face).
    const crease = { points: [-5, 5, 5, 5, 5, 5] };
    const diagonal = { points: [-5, 5, -5, 5, 5, 5] };
    const edges = [crease, diagonal];

    const fromSoup = filterCoplanarDisplayEdges(edges, soupOf(box));
    const fromIndexed = filterCoplanarDisplayEdges(edges, box.positions, box.indices);
    expect(fromIndexed).toEqual(fromSoup);
    expect(fromIndexed).toContain(crease);
  });

  it("keys identical geometry to one content key and separates changed geometry", () => {
    const box = indexedGeometry(new THREE.BoxGeometry(3, 4, 5));
    const copy = { positions: box.positions.slice(), indices: box.indices.slice() };
    expect(meshGeometryKey(copy)).toBe(meshGeometryKey(box));

    const nudged = { positions: box.positions.slice(), indices: box.indices };
    nudged.positions[7] += 1e-9;
    expect(meshGeometryKey(nudged)).not.toBe(meshGeometryKey(box));

    const reordered = { positions: box.positions, indices: [...box.indices.slice(3), ...box.indices.slice(0, 3)] };
    expect(meshGeometryKey(reordered)).not.toBe(meshGeometryKey(box));
  });
});
