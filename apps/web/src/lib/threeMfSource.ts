/** A 3MF package with its triangle meshes lifted out so an edit can be written back. */
export type ThreeMfMeshObject = {
  id: string;
  /** Non-indexed vertex count (3 per triangle) in the combined PeakCAD mesh. */
  vertexCount: number;
  triangleCount: number;
  /** Column-major 4×4. Maps object-local Z-up file units into scene space. */
  matrix: number[];
  /** Extra attributes from each `<triangle>` tag, in order. Empty when the file had none. */
  triangleAttrs?: string[];
};

export type ThreeMfSourcePackage = {
  key: string;
  modelPath: string;
  /** Model XML with each mesh replaced by `<!--PEAKCAD-MESH:id-->`. */
  modelXml: string;
  /** Other package files, base64. The model part itself is not included. */
  files: { path: string; data: string }[];
  /** Millimetres per file unit. */
  unitScale: number;
  /** Translation added so the imported mesh sits on the workplane. */
  seat: [number, number, number];
  objects: ThreeMfMeshObject[];
};

const packages = new Map<string, ThreeMfSourcePackage>();

export function remember3mfPackage(source: ThreeMfSourcePackage) {
  packages.set(source.key, source);
  return source;
}

export function lookup3mfPackage(key: string | undefined): ThreeMfSourcePackage | undefined {
  if (!key) return undefined;
  return packages.get(key);
}

export function meshPlaceholder(objectId: string) {
  return `<!--PEAKCAD-MESH:${objectId}-->`;
}
