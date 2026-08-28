import type { WorkplaneShape } from "@/types/sketchforge";
import { hardwareProfile } from "@/lib/desktopHardware";
import { resizedImportedMeshPositions, shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import type { Brep, BrepSolid } from "@/lib/brepKernel";

const profile = hardwareProfile();

export type FacetedMeshInput = {
  name: string;
  /** World-space or local-space triangle vertices (x,y,z triples flattened into faces). */
  vertices: [number, number, number][];
  faces: [number, number, number][];
};

/** Cap faceted STEP triangle count so export stays responsive. */
export function facetedStepTriangleLimit() {
  return Math.min(profile.booleanTriangleLimit, 500_000);
}

/** Build a binary STL blob from indexed triangle mesh data. */
export function meshToBinaryStlBlob(mesh: FacetedMeshInput): Blob {
  const triangleCount = mesh.faces.length;
  const bytes = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(bytes.buffer);
  const header = "PeakCAD faceted STEP";
  for (let i = 0; i < 80; i += 1) {
    bytes[i] = i < header.length ? header.charCodeAt(i) : 0;
  }
  view.setUint32(80, triangleCount, true);
  let offset = 84;
  for (const [ai, bi, ci] of mesh.faces) {
    const a = mesh.vertices[ai];
    const b = mesh.vertices[bi];
    const c = mesh.vertices[ci];
    if (!a || !b || !c) continue;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(offset, nx, true); offset += 4;
    view.setFloat32(offset, ny, true); offset += 4;
    view.setFloat32(offset, nz, true); offset += 4;
    view.setFloat32(offset, a[0], true); offset += 4;
    view.setFloat32(offset, a[1], true); offset += 4;
    view.setFloat32(offset, a[2], true); offset += 4;
    view.setFloat32(offset, b[0], true); offset += 4;
    view.setFloat32(offset, b[1], true); offset += 4;
    view.setFloat32(offset, b[2], true); offset += 4;
    view.setFloat32(offset, c[0], true); offset += 4;
    view.setFloat32(offset, c[1], true); offset += 4;
    view.setFloat32(offset, c[2], true); offset += 4;
    view.setUint16(offset, 0, true); offset += 2;
  }
  return new Blob([bytes], { type: "model/stl" });
}

/**
 * Build a local-frame triangle mesh from a shape's importedMesh cache
 * (x/z centred, y in [0, height]) — same frame as STEP import round-trip.
 */
export function localMeshFromImportedShape(shape: WorkplaneShape): FacetedMeshInput | null {
  const mesh = shape.importedMesh;
  if (!mesh || mesh.positions.length < 9) return null;
  const positions = resizedImportedMeshPositions(shape);
  if (positions.length < 9) return null;

  const vertices: [number, number, number][] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    vertices.push([positions[i], positions[i + 1], positions[i + 2]]);
  }

  const faces: [number, number, number][] = [];
  if (mesh.indices && mesh.indices.length >= 3) {
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const a = mesh.indices[i];
      const b = mesh.indices[i + 1];
      const c = mesh.indices[i + 2];
      if (a < vertices.length && b < vertices.length && c < vertices.length) {
        faces.push([a, b, c]);
      }
    }
  } else {
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      faces.push([i, i + 1, i + 2]);
    }
  }
  if (faces.length === 0) return null;
  return { name: shape.name, vertices, faces };
}

/** Axis-aligned box tessellation in the same local frame as imported meshes. */
export function localBoxMesh(shape: WorkplaneShape): FacetedMeshInput {
  const w = shapeWidth(shape);
  const d = shapeDepth(shape);
  const h = Math.max(0.01, shape.height);
  const hx = w / 2;
  const hz = d / 2;
  const vertices: [number, number, number][] = [
    [-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz],
    [-hx, h, -hz], [hx, h, -hz], [hx, h, hz], [-hx, h, hz],
  ];
  // Counter-clockwise seen from outside, so the right-hand rule gives outward normals.
  // Every triangle used to be wound the other way, making the whole box inside-out.
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 5, 1], [0, 4, 5],
    [1, 6, 2], [1, 5, 6],
    [2, 7, 3], [2, 6, 7],
    [3, 4, 0], [3, 7, 4],
  ];
  return { name: shape.name, vertices, faces };
}

/**
 * Import a triangle mesh as an OCCT solid via STL (faceted B-Rep).
 * Returns a solid in the mesh's local frame (not yet world-placed).
 */
export async function importFacetedSolidFromMesh(
  brep: Brep,
  mesh: FacetedMeshInput,
): Promise<{ solid: BrepSolid } | { skip: string }> {
  const limit = facetedStepTriangleLimit();
  if (mesh.faces.length > limit) {
    return { skip: `mesh has ${mesh.faces.length} triangles (limit ${limit}); simplify before STEP` };
  }
  if (mesh.faces.length === 0 || mesh.vertices.length < 3) {
    return { skip: "mesh has no triangles" };
  }
  try {
    const blob = meshToBinaryStlBlob(mesh);
    const imported = await brep.importSTL(blob);
    if (!imported.ok) {
      return { skip: `faceted STL import failed: ${String(imported.error.message ?? imported.error)}` };
    }
    return { solid: imported.value as unknown as BrepSolid };
  } catch (error) {
    return { skip: error instanceof Error ? error.message : "faceted STL import failed" };
  }
}
