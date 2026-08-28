import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { createLocalId } from "@/lib/localIds";
import { seatTriangleSoupOnLargestFlatSurface } from "@/lib/meshSeatOrientation";
import type { WorkplaneShape } from "@/types/sketchforge";

const stlLoader = new STLLoader();
const SUPPORTED_IMPORT_EXTENSIONS = new Set(["stl", "svg", "3mf"]);

/**
 * Floor for a declared shape dimension, matching the editor's MIN_SHAPE_DIMENSION.
 * A 1mm floor would round a 0.6mm shim up to 1.00mm in the inspector, and since resizes
 * scale by `height / baseHeight`, every later edit would then be off by that ratio.
 */
const MIN_IMPORT_DIMENSION = 0.01;

function fileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

export type TriangleSoupImportResult = {
  shape: WorkplaneShape;
  /** Rigid rotation applied about the origin before workplane centering. */
  seatRotation: THREE.Quaternion;
  /** Translation applied after seatRotation so the mesh is x/z-centred with y≥0. */
  seatTranslation: THREE.Vector3;
};

export function importedShapeFromTriangleSoup(
  fileName: string,
  rawPositions: number[],
  rawNormals: number[] | undefined,
  sourceFormat: NonNullable<WorkplaneShape["importedMesh"]>["sourceFormat"] = "stl",
): WorkplaneShape {
  return importTriangleSoup(fileName, rawPositions, rawNormals, sourceFormat).shape;
}

export function importTriangleSoup(
  fileName: string,
  rawPositions: number[],
  rawNormals: number[] | undefined,
  sourceFormat: NonNullable<WorkplaneShape["importedMesh"]>["sourceFormat"] = "stl",
): TriangleSoupImportResult {
  const seated = seatTriangleSoupOnLargestFlatSurface(rawPositions, rawNormals);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(seated.positions, 3));
  if (seated.normals?.length === seated.positions.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(seated.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  geometry.computeBoundingBox();

  const box = geometry.boundingBox;
  if (!box) {
    throw new Error("STL has no readable geometry");
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) {
    throw new Error("STL geometry is empty");
  }

  const scale = 1;
  const seatTranslation = new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const positions: number[] = [];
  const normals: number[] = [];

  for (let i = 0; i < position.count; i += 1) {
    positions.push(
      position.getX(i) * scale + seatTranslation.x,
      position.getY(i) * scale + seatTranslation.y,
      position.getZ(i) * scale + seatTranslation.z,
    );
    if (normal) {
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
  }

  const width = Math.max(MIN_IMPORT_DIMENSION, size.x * scale);
  const height = Math.max(MIN_IMPORT_DIMENSION, size.y * scale);
  const depth = Math.max(MIN_IMPORT_DIMENSION, size.z * scale);
  const triangleCount = Math.floor(position.count / 3);

  return {
    shape: {
      id: createLocalId("uploaded-mesh"),
      name: fileName.replace(/\.[^.]+$/, "") || `Imported ${sourceFormat.toUpperCase()}`,
      kind: "mesh",
      color: "#0098c7",
      x: 10,
      z: -10,
      size: Math.max(width, depth),
      width,
      depth,
      height,
      rotation: 0,
      rotationX: 0,
      rotationZ: 0,
      importedMesh: {
        positions,
        normals: normals.length ? normals : undefined,
        baseWidth: width,
        baseDepth: depth,
        baseHeight: height,
        triangleCount,
        sourceFormat,
      },
      locked: false,
      hidden: false,
    },
    seatRotation: seated.rotation,
    seatTranslation,
  };
}

export function importExtensionSupported(fileName: string) {
  return SUPPORTED_IMPORT_EXTENSIONS.has(fileExtension(fileName));
}

export function importedShapeFromStl(fileName: string, buffer: ArrayBuffer): WorkplaneShape {
  const rawGeometry = stlLoader.parse(buffer);
  const geometry = rawGeometry.index ? rawGeometry.toNonIndexed() : rawGeometry.clone();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const rawPositions: number[] = [];
  const rawNormals: number[] = [];

  for (let i = 0; i < position.count; i += 1) {
    rawPositions.push(position.getX(i), position.getY(i), position.getZ(i));
    if (normal) {
      rawNormals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
  }

  return importedShapeFromTriangleSoup(fileName, rawPositions, rawNormals.length ? rawNormals : undefined);
}
