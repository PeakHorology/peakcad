import * as THREE from "three";
import type { WorkplaneShape } from "@/types/sketchforge";
import { createLocalId } from "@/lib/localIds";
import { loadBrepWithOcct, type Brep } from "@/lib/brepKernel";
import { quaternionToAxisAngleDegrees, seatRotationForIndexedMeshes } from "@/lib/meshSeatOrientation";
import { registerPendingImportedBrep } from "@/lib/importedBrepSource";

const STEP_EXTENSIONS = new Set(["step", "stp"]);
const MIN_IMPORT_DIMENSION = 0.01;

export function isStepFile(fileName: string): boolean {
  return STEP_EXTENSIONS.has(fileName.split(".").pop()?.toLowerCase() ?? "");
}

type Tessellation = {
  vertices: ArrayLike<number>;
  normals: ArrayLike<number>;
  triangles: ArrayLike<number>;
};

type Bounds = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };

/** One body's indexed display mesh in the seated (Y-up, lay-flat) frame, before recentering. */
type SeatedBody = {
  name: string;
  part: unknown;
  positions: number[];
  normals: number[] | undefined;
  indices: number[];
  bounds: Bounds;
};

function fileStem(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "") || "Imported STEP";
}

function usableTessellation(tess: Tessellation | undefined): tess is Tessellation {
  return Boolean(tess && tess.vertices.length >= 9 && tess.triangles.length >= 3);
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
}

/** Rotate vertices/normals into the seated frame, keeping the tessellation indexed. */
function seatBody(name: string, part: unknown, tess: Tessellation, rotation: THREE.Quaternion | null): SeatedBody {
  const vertexCount = Math.floor(tess.vertices.length / 3);
  const positions = new Array<number>(vertexCount * 3);
  const hasNormals = tess.normals.length === tess.vertices.length;
  const normals = hasNormals ? new Array<number>(vertexCount * 3) : undefined;
  const bounds = emptyBounds();
  const point = new THREE.Vector3();
  for (let v = 0; v < vertexCount; v += 1) {
    const i = v * 3;
    point.set(tess.vertices[i], tess.vertices[i + 1], tess.vertices[i + 2]);
    if (rotation) point.applyQuaternion(rotation);
    positions[i] = point.x;
    positions[i + 1] = point.y;
    positions[i + 2] = point.z;
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
    bounds.minZ = Math.min(bounds.minZ, point.z);
    bounds.maxZ = Math.max(bounds.maxZ, point.z);
    if (normals) {
      point.set(tess.normals[i], tess.normals[i + 1], tess.normals[i + 2]);
      if (rotation) point.applyQuaternion(rotation).normalize();
      normals[i] = point.x;
      normals[i + 1] = point.y;
      normals[i + 2] = point.z;
    }
  }
  const usable = tess.triangles.length - (tess.triangles.length % 3);
  const indices = new Array<number>(usable);
  for (let i = 0; i < usable; i += 1) indices[i] = tess.triangles[i];
  return { name, part, positions, normals, indices, bounds };
}

function stepTextFromSolid(brep: Brep, solid: unknown) {
  return async () => {
    const exported = brep.exportSTEP(solid as never);
    if (!exported.ok) return undefined;
    const text = await exported.value.text();
    return text.trim() ? text : undefined;
  };
}

/**
 * Build the editor shape for one seated body: local mesh XZ-centred with y ≥ 0, placed at
 * x = 10 + cx, z = −10 + cz, elevation = minY in the assembly's floor-seated frame.
 */
function shapeFromSeatedBody(
  brep: Brep,
  body: SeatedBody,
  seat: { axis: [number, number, number]; angle: number; translation: THREE.Vector3 },
): WorkplaneShape {
  const { bounds } = body;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const local = body.positions;
  for (let i = 0; i < local.length; i += 3) {
    local[i] -= cx;
    local[i + 1] -= bounds.minY;
    local[i + 2] -= cz;
  }
  const width = Math.max(MIN_IMPORT_DIMENSION, bounds.maxX - bounds.minX);
  const height = Math.max(MIN_IMPORT_DIMENSION, bounds.maxY - bounds.minY);
  const depth = Math.max(MIN_IMPORT_DIMENSION, bounds.maxZ - bounds.minZ);
  const placement = {
    x: cx + seat.translation.x,
    y: bounds.minY + seat.translation.y,
    z: cz + seat.translation.z,
  };
  const shape: WorkplaneShape = {
    id: createLocalId("uploaded-mesh"),
    name: body.name,
    kind: "mesh",
    color: "#0098c7",
    x: 10 + placement.x,
    z: -10 + placement.z,
    elevation: placement.y,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions: local,
      indices: body.indices,
      normals: body.normals?.length ? body.normals : undefined,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: Math.floor(body.indices.length / 3),
      sourceFormat: "step",
    },
    locked: false,
    hidden: false,
  };

  // The kernel solid in the same local frame as `local`: seat rotation about the origin, then
  // the recentering translation, composed only when an export first asks for it.
  const { part } = body;
  registerPendingImportedBrep(shape.importedMesh!, () => {
    let solid = part;
    if (Math.abs(seat.angle) > 1e-6) {
      solid = brep.rotate(solid as never, seat.angle, { axis: seat.axis });
    }
    if (Math.hypot(cx, bounds.minY, cz) > 1e-12) {
      solid = brep.translate(solid as never, [-cx, -bounds.minY, -cz]);
    }
    return stepTextFromSolid(brep, solid)();
  });
  return shape;
}

export async function importedShapesFromStep(fileName: string, buffer: ArrayBuffer): Promise<WorkplaneShape[]> {
  const brep = await loadBrepWithOcct();
  const imported = await brep.importSTEP(new Blob([buffer]));
  if (!imported.ok) {
    throw new Error(`Could not read STEP: ${String(imported.error.message ?? imported.error)}`);
  }

  // STEP/CAD space is Z-up; the editor is Y-up. −90° about X maps CAD +Z to +Y.
  const flipped = brep.rotate(imported.value, -90, { axis: [1, 0, 0] });
  const solids = brep.getSolids(flipped as never);
  const stem = fileStem(fileName);
  const parts: Array<{ name: string; part: unknown }> = solids.length > 1
    ? solids.map((part, index) => ({ name: `${stem} ${index + 1}`, part }))
    : [{ name: stem, part: flipped }];

  // Tessellate each body exactly once, indexed. The lay-flat seat and the floor/centre
  // translation are derived from these meshes, so the assembly is never meshed as a whole.
  const tessellated: Array<{ name: string; part: unknown; tess: Tessellation }> = [];
  for (const { name, part } of parts) {
    const tess = brep.mesh(part as never) as Tessellation;
    if (usableTessellation(tess)) tessellated.push({ name, part, tess });
  }
  if (tessellated.length === 0) {
    throw new Error("STEP file has no solid geometry to import");
  }

  const rotation = seatRotationForIndexedMeshes(
    tessellated.map(({ tess }) => ({ positions: tess.vertices, indices: tess.triangles })),
  );
  const { axis, angle } = quaternionToAxisAngleDegrees(rotation);
  const rotate = Math.abs(angle) > 1e-6 ? rotation : null;
  const bodies = tessellated.map(({ name, part, tess }) => seatBody(name, part, tess, rotate));

  // Floor-seat the whole assembly (min Y at 0) and centre it in X/Z.
  const assembly = emptyBounds();
  for (const { bounds } of bodies) {
    assembly.minX = Math.min(assembly.minX, bounds.minX);
    assembly.maxX = Math.max(assembly.maxX, bounds.maxX);
    assembly.minY = Math.min(assembly.minY, bounds.minY);
    assembly.maxY = Math.max(assembly.maxY, bounds.maxY);
    assembly.minZ = Math.min(assembly.minZ, bounds.minZ);
    assembly.maxZ = Math.max(assembly.maxZ, bounds.maxZ);
  }
  const translation = new THREE.Vector3(
    -(assembly.minX + assembly.maxX) / 2,
    -assembly.minY,
    -(assembly.minZ + assembly.maxZ) / 2,
  );
  return bodies.map((body) => shapeFromSeatedBody(brep, body, { axis, angle, translation }));
}

export async function importedShapeFromStep(fileName: string, buffer: ArrayBuffer): Promise<WorkplaneShape> {
  const shapes = await importedShapesFromStep(fileName, buffer);
  return shapes[0];
}
