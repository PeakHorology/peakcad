import * as THREE from "three";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { strFromU8, unzipSync } from "fflate";
import { importedShapeFromTriangleSoup } from "@/lib/stlImport";
import type { WorkplaneShape } from "@/types/sketchforge";

const threeMfLoader = new ThreeMFLoader();

/** Millimetres per unit for each 3MF model unit (3MF Core Specification, `unit` attribute). */
const THREE_MF_UNIT_SCALE: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/**
 * Millimetres per unit for a 3MF package, defaulting to 1 (the spec's own default).
 *
 * three.js's ThreeMFLoader reads the `unit` attribute into its model data and then never
 * applies it or exposes it, so vertices arrive in the file's own units. An inch-authored
 * part therefore imported 25.4x too small, and a metre-authored one 1000x too small, with
 * nothing on screen indicating a scale change.
 */
export function read3mfUnitScale(buffer: ArrayBuffer): number {
  try {
    const entries = unzipSync(new Uint8Array(buffer));
    const names = Object.keys(entries);
    const modelPath =
      names.find((name) => name.toLowerCase() === "3d/3dmodel.model")
      ?? names.find((name) => name.toLowerCase().endsWith(".model"));
    if (!modelPath) {
      return 1;
    }
    // The root <model> element opens the document, so its attributes are in the first bytes.
    const header = strFromU8(entries[modelPath].subarray(0, 8192));
    const unit = /<model[^>]*\bunit\s*=\s*"([^"]+)"/i.exec(header)?.[1]?.toLowerCase();
    return (unit ? THREE_MF_UNIT_SCALE[unit] : undefined) ?? 1;
  } catch {
    return 1;
  }
}

/** Convert a Z-up 3MF coordinate into PeakCAD Y-up (rotate −90° about X). */
function zUpToYUp(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

function collectTriangleSoup(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const positions: number[] = [];
  const normals: number[] = [];
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) {
      return;
    }
    const geometry = mesh.geometry;
    const positionAttr = geometry.getAttribute("position");
    if (!positionAttr) {
      return;
    }
    const normalAttr = geometry.getAttribute("normal");
    const index = geometry.index;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);

    const pushVertex = (vertexIndex: number) => {
      position.fromBufferAttribute(positionAttr, vertexIndex).applyMatrix4(mesh.matrixWorld);
      const [yx, yy, yz] = zUpToYUp(position.x, position.y, position.z);
      positions.push(yx, yy, yz);
      if (normalAttr) {
        normal.fromBufferAttribute(normalAttr, vertexIndex).applyMatrix3(normalMatrix).normalize();
        const [nx, ny, nz] = zUpToYUp(normal.x, normal.y, normal.z);
        normals.push(nx, ny, nz);
      }
    };

    // Walk the index buffer instead of cloning via toNonIndexed().
    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        pushVertex(index.getX(i));
      }
      return;
    }
    for (let i = 0; i < positionAttr.count; i += 1) {
      pushVertex(i);
    }
  });

  return {
    positions,
    normals: normals.length === positions.length ? normals : undefined,
  };
}

export function importedShapeFrom3mf(fileName: string, buffer: ArrayBuffer): WorkplaneShape {
  const group = threeMfLoader.parse(buffer);
  const soup = collectTriangleSoup(group);
  if (soup.positions.length < 9) {
    throw new Error("3MF has no readable triangle geometry");
  }
  // Normals are directions, so a uniform positive scale leaves them unchanged.
  const scale = read3mfUnitScale(buffer);
  const positions = scale === 1 ? soup.positions : soup.positions.map((value) => value * scale);
  return importedShapeFromTriangleSoup(fileName, positions, soup.normals, "3mf");
}
