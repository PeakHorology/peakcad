import * as THREE from "three";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { importedMeshForShape } from "@/lib/editorShapeMesh";
import { createLocalId } from "@/lib/localIds";
import { importTriangleSoup } from "@/lib/stlImport";
import { meshPlaceholder, remember3mfPackage, type ThreeMfMeshObject, type ThreeMfSourcePackage } from "@/lib/threeMfSource";
import type { WorkplaneShape } from "@/types/sketchforge";

const UNIT_SCALE: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

type LocalMesh = {
  positions: number[];
  triangleAttrs: string[];
};

type ParsedObject = {
  id: string;
  components: { id: string; transform?: string }[];
  mesh?: LocalMesh;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, index + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function attr(source: string, name: string) {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "i").exec(source)?.[1];
}

function zUpToYUp(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

function yUpToZUp(x: number, y: number, z: number): [number, number, number] {
  return [x, -z, y];
}

function formatCoord(value: number) {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 1e6) / 1e6);
}

function matrixFrom3mf(transform: string | undefined) {
  const matrix = new THREE.Matrix4();
  if (!transform) return matrix;
  const values = transform.trim().split(/\s+/).map(Number);
  if (values.length < 12 || values.some((value) => !Number.isFinite(value))) return new THREE.Matrix4();
  matrix.set(
    values[0], values[3], values[6], values[9],
    values[1], values[4], values[7], values[10],
    values[2], values[5], values[8], values[11],
    0, 0, 0, 1,
  );
  return matrix;
}

function readUnitScale(modelXml: string) {
  const header = modelXml.slice(0, 8192);
  const unit = /<model[^>]*\bunit\s*=\s*"([^"]+)"/i.exec(header)?.[1]?.toLowerCase();
  return (unit ? UNIT_SCALE[unit] : undefined) ?? 1;
}

function triangleExtra(attributes: string) {
  return attributes
    .replace(/\bv1\s*=\s*"[^"]*"/gi, "")
    .replace(/\bv2\s*=\s*"[^"]*"/gi, "")
    .replace(/\bv3\s*=\s*"[^"]*"/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readMesh(meshXml: string): LocalMesh | null {
  const vertices: { x: number; y: number; z: number }[] = [];
  const vertexRe = /<vertex\b([^>]*?)\/?>/gi;
  let vertexMatch: RegExpExecArray | null;
  while ((vertexMatch = vertexRe.exec(meshXml))) {
    const x = Number(attr(vertexMatch[1], "x"));
    const y = Number(attr(vertexMatch[1], "y"));
    const z = Number(attr(vertexMatch[1], "z"));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    vertices.push({ x, y, z });
  }
  if (vertices.length < 3) return null;

  const positions: number[] = [];
  const triangleAttrs: string[] = [];
  const triangleRe = /<triangle\b([^>]*?)\/?>/gi;
  let triangleMatch: RegExpExecArray | null;
  while ((triangleMatch = triangleRe.exec(meshXml))) {
    const a = Number(attr(triangleMatch[1], "v1"));
    const b = Number(attr(triangleMatch[1], "v2"));
    const c = Number(attr(triangleMatch[1], "v3"));
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) return null;
    if (a < 0 || b < 0 || c < 0 || a >= vertices.length || b >= vertices.length || c >= vertices.length) return null;
    const va = vertices[a];
    const vb = vertices[b];
    const vc = vertices[c];
    positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
    triangleAttrs.push(triangleExtra(triangleMatch[1]));
  }
  if (positions.length < 9) return null;
  return { positions, triangleAttrs };
}

function parseObjects(modelXml: string) {
  const objects = new Map<string, ParsedObject>();
  const objectRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/gi;
  let match: RegExpExecArray | null;
  while ((match = objectRe.exec(modelXml))) {
    const id = attr(match[1], "id");
    if (!id) continue;
    const body = match[2];
    const components: ParsedObject["components"] = [];
    const componentRe = /<component\b([^>]*?)\/?>/gi;
    let componentMatch: RegExpExecArray | null;
    while ((componentMatch = componentRe.exec(body))) {
      const objectId = attr(componentMatch[1], "objectid");
      if (!objectId) continue;
      components.push({ id: objectId, transform: attr(componentMatch[1], "transform") });
    }
    const meshXml = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/i.exec(body)?.[1];
    const mesh = meshXml ? readMesh(meshXml) ?? undefined : undefined;
    objects.set(id, { id, components, mesh });
  }
  return objects;
}

function keepSidecar(path: string, modelPath: string, size: number) {
  const lower = path.toLowerCase();
  if (lower === modelPath.toLowerCase()) return false;
  if (lower.endsWith(".gcode") || lower.endsWith(".gcode.gz")) return false;
  if (size > MAX_SIDECAR_BYTES) return false;
  return true;
}

function bakeMesh(local: number[], matrix: THREE.Matrix4, unitScale: number) {
  const baked: number[] = [];
  const point = new THREE.Vector3();
  for (let index = 0; index + 2 < local.length; index += 3) {
    point.set(local[index], local[index + 1], local[index + 2]).applyMatrix4(matrix);
    const [x, y, z] = zUpToYUp(point.x * unitScale, point.y * unitScale, point.z * unitScale);
    baked.push(x, y, z);
  }
  return baked;
}

/**
 * Read a 3MF package and the meshes inside it.
 * Returns null when the file has no plain triangle mesh we can edit in place.
 */
export function capture3mfPackage(buffer: ArrayBuffer): { positions: number[]; source: ThreeMfSourcePackage } | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch {
    return null;
  }
  const names = Object.keys(entries);
  const modelPath = names.find((name) => name.toLowerCase() === "3d/3dmodel.model")
    ?? names.find((name) => name.toLowerCase().endsWith(".model"));
  if (!modelPath) return null;
  const modelXml = strFromU8(entries[modelPath]);
  const objects = parseObjects(modelXml);
  if (objects.size === 0) return null;

  const order: string[] = [];
  const placement = new Map<string, THREE.Matrix4>();
  const visit = (id: string, parent: THREE.Matrix4) => {
    const object = objects.get(id);
    if (!object) return;
    if (object.mesh && !placement.has(id)) {
      placement.set(id, parent.clone());
      order.push(id);
    }
    object.components.forEach((component) => {
      visit(component.id, new THREE.Matrix4().multiplyMatrices(parent, matrixFrom3mf(component.transform)));
    });
  };

  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/i.exec(modelXml)?.[1] ?? "";
  const itemRe = /<item\b([^>]*?)\/?>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRe.exec(build))) {
    const objectId = attr(itemMatch[1], "objectid");
    if (!objectId) continue;
    visit(objectId, matrixFrom3mf(attr(itemMatch[1], "transform")));
  }
  objects.forEach((object) => {
    if (object.mesh && !placement.has(object.id)) {
      placement.set(object.id, new THREE.Matrix4());
      order.push(object.id);
    }
  });
  if (order.length === 0) return null;

  const unitScale = readUnitScale(modelXml);
  const bakedParts: number[][] = [];
  const meshObjects: ThreeMfMeshObject[] = [];
  order.forEach((id) => {
    const object = objects.get(id);
    const matrix = placement.get(id);
    if (!object?.mesh || !matrix) return;
    const baked = bakeMesh(object.mesh.positions, matrix, unitScale);
    bakedParts.push(baked);
    const extras = object.mesh.triangleAttrs.some((value) => value.length > 0) ? object.mesh.triangleAttrs : undefined;
    meshObjects.push({
      id,
      vertexCount: baked.length / 3,
      triangleCount: baked.length / 9,
      matrix: matrix.toArray(),
      ...(extras ? { triangleAttrs: extras } : {}),
    });
  });
  if (meshObjects.length === 0) return null;

  const positions = bakedParts.flat();
  let modelTemplate = modelXml;
  const meshIds = new Set(meshObjects.map((object) => object.id));
  modelTemplate = modelTemplate.replace(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi, (full, attributes: string, body: string) => {
    const id = attr(attributes, "id");
    if (!id || !meshIds.has(id) || !/<mesh\b/i.test(body)) return full;
    return `<object${attributes}>${body.replace(/<mesh\b[^>]*>[\s\S]*?<\/mesh>/i, meshPlaceholder(id))}</object>`;
  });
  if (meshObjects.some((object) => !modelTemplate.includes(meshPlaceholder(object.id)))) return null;

  const files = names
    .filter((path) => keepSidecar(path, modelPath, entries[path].byteLength))
    .map((path) => ({ path, data: bytesToBase64(entries[path]) }));

  const source = remember3mfPackage({
    key: createLocalId("3mf"),
    modelPath,
    modelXml: modelTemplate,
    files,
    unitScale,
    seat: [0, 0, 0],
    objects: meshObjects,
  });
  return { positions, source };
}

function editedVertices(shape: WorkplaneShape) {
  const world = importedMeshForShape(shape);
  const originY = (shape.elevation ?? 0) + shape.height / 2;
  return {
    vertices: world.vertices.map(([x, y, z]) => [x - shape.x, y - originY, z - shape.z] as [number, number, number]),
    faces: world.faces,
  };
}

function unseat(vertices: [number, number, number][], seat: [number, number, number]) {
  return vertices.map(([x, y, z]) => [x - seat[0], y - seat[1], z - seat[2]] as [number, number, number]);
}

function toObjectLocal(
  vertices: [number, number, number][],
  matrix: number[],
  unitScale: number,
) {
  const scene = new THREE.Matrix4().fromArray(matrix.slice());
  const determinant = scene.determinant();
  const inverse = scene.clone().invert();
  const point = new THREE.Vector3();
  const local = vertices.map(([x, y, z]) => {
    const [zx, zy, zz] = yUpToZUp(x, y, z);
    point.set(zx / unitScale, zy / unitScale, zz / unitScale).applyMatrix4(inverse);
    return [point.x, point.y, point.z] as [number, number, number];
  });
  return { local, flipWinding: determinant < 0 };
}

function meshXml(
  vertices: [number, number, number][],
  faces: [number, number, number][],
  extras: string[] | undefined,
  flipWinding: boolean,
) {
  const parts: string[] = ["<mesh>\n<vertices>\n"];
  vertices.forEach(([x, y, z]) => {
    parts.push(`<vertex x="${formatCoord(x)}" y="${formatCoord(y)}" z="${formatCoord(z)}" />\n`);
  });
  parts.push("</vertices>\n<triangles>\n");
  faces.forEach(([a, b, c], index) => {
    const triangle = flipWinding ? [a, c, b] : [a, b, c];
    const extra = extras && extras[index] ? ` ${extras[index]}` : "";
    parts.push(`<triangle v1="${triangle[0]}" v2="${triangle[1]}" v3="${triangle[2]}"${extra} />\n`);
  });
  parts.push("</triangles>\n</mesh>");
  return parts.join("");
}

function removeObject(xml: string, objectId: string) {
  const id = objectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xml
    .replace(new RegExp(`\\s*<object\\b[^>]*\\bid\\s*=\\s*"${id}"[^>]*>[\\s\\S]*?</object>`, "i"), "")
    .replace(new RegExp(`\\s*<item\\b[^>]*\\bobjectid\\s*=\\s*"${id}"[^>]*/>`, "gi"), "")
    .replace(new RegExp(`\\s*<component\\b[^>]*\\bobjectid\\s*=\\s*"${id}"[^>]*/>`, "gi"), "");
}

function facesForRange(
  faces: [number, number, number][],
  offset: number,
  count: number,
): [number, number, number][] | null {
  const local: [number, number, number][] = [];
  for (const [a, b, c] of faces) {
    const inside = (index: number) => index >= offset && index < offset + count;
    if (!inside(a) || !inside(b) || !inside(c)) {
      if (inside(a) || inside(b) || inside(c)) return null;
      continue;
    }
    local.push([a - offset, b - offset, c - offset]);
  }
  return local;
}

/** Write the edited mesh back into the original 3MF. Other package files stay as they were. */
export function rewrite3mf(shape: WorkplaneShape): Uint8Array | null {
  const source = shape.source3mf;
  if (!source || !shape.importedMesh || source.objects.length === 0) return null;
  const mesh = shape.importedMesh;
  const edited = editedVertices(shape);
  const scene = unseat(edited.vertices, source.seat);
  const expectedVertices = source.objects.reduce((total, object) => total + object.vertexCount, 0);
  const canSplit = !mesh.indices?.length && scene.length === expectedVertices;

  let modelXml = source.modelXml;
  if (canSplit) {
    let offset = 0;
    for (const object of source.objects) {
      const slice = scene.slice(offset, offset + object.vertexCount);
      const faces = facesForRange(edited.faces, offset, object.vertexCount);
      if (!faces || faces.length !== object.triangleCount) return null;
      const local = toObjectLocal(slice, object.matrix, source.unitScale);
      const extras = object.triangleAttrs && object.triangleAttrs.length === faces.length ? object.triangleAttrs : undefined;
      const placeholder = meshPlaceholder(object.id);
      if (!modelXml.includes(placeholder)) return null;
      modelXml = modelXml.replace(placeholder, meshXml(local.local, faces, extras, local.flipWinding));
      offset += object.vertexCount;
    }
  } else {
    const first = source.objects[0];
    const local = toObjectLocal(scene, first.matrix, source.unitScale);
    const placeholder = meshPlaceholder(first.id);
    if (!modelXml.includes(placeholder)) return null;
    modelXml = modelXml.replace(placeholder, meshXml(local.local, edited.faces, undefined, local.flipWinding));
    source.objects.slice(1).forEach((object) => {
      modelXml = removeObject(modelXml, object.id);
    });
  }

  const entries: Record<string, Uint8Array> = {
    [source.modelPath]: strToU8(modelXml),
  };
  source.files.forEach((file) => {
    entries[file.path] = base64ToBytes(file.data);
  });
  return zipSync(entries, { level: 6 });
}

export function importedShapeFrom3mfPackage(fileName: string, buffer: ArrayBuffer): WorkplaneShape | null {
  const captured = capture3mfPackage(buffer);
  if (!captured) return null;
  const imported = importTriangleSoup(fileName, captured.positions, undefined, "3mf", "keep-orientation");
  const seat = imported.seatTranslation;
  const source: ThreeMfSourcePackage = remember3mfPackage({
    ...captured.source,
    seat: [seat.x, seat.y, seat.z],
  });
  return {
    ...imported.shape,
    source3mf: source,
    source3mfKey: source.key,
  };
}
