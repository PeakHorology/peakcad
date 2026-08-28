import type { SketchDoc } from "@/lib/sketch/types";

export type ShapeKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "sketch"
  | "scribble"
  | "cone"
  | "pyramid"
  | "roof"
  | "text"
  | "roundRoof"
  | "halfSphere"
  | "torus"
  | "tube"
  | "ring"
  | "wedge"
  | "polygon"
  | "icosahedron"
  | "mesh"
  | "thread";

export type ShapeAsset = {
  id: string;
  name: string;
  src: string;
  kind: ShapeKind;
  color: string;
  hole?: boolean;
};

export type GridSize = "Off" | "0.1 mm" | "0.25 mm" | "0.5 mm" | "1.0 mm" | "2.0 mm" | "5.0 mm" | "Brick";
export type MeasurementAccuracy = 1 | 2 | 3;
/** Viewport / CSG curve density. Smooth is the default for PeakCAD. */
export type DisplayQuality = "draft" | "standard" | "smooth";

export type WorkplaneWorkspaceSettings = {
  width: number;
  depth: number;
  sizePreset: string;
  gridBlockSize: number;
  gridBlockPreset: string;
  background: string;
  showShadows: boolean;
  showGrid: boolean;
  cruiseShapes: boolean;
  zoomSpeed: number;
  units: string;
  scale: string;
  accuracy: MeasurementAccuracy;
  displayQuality: DisplayQuality;
};

export type AlignAxis = "x" | "y" | "z";
export type AlignTarget = "min" | "center" | "max";
export type AlignHandleStatus = {
  axis: AlignAxis;
  target: AlignTarget;
  disabled: boolean;
  aligned: boolean;
  title: string;
};

export type SketchPoint = {
  id: string;
  x: number;
  z: number;
  handleIn?: { x: number; z: number };
  handleOut?: { x: number; z: number };
  mode?: "corner" | "smooth" | "split";
};

export type SketchSegment = {
  id: string;
  startId: string;
  endId: string;
  kind?: "line" | "bezier" | "smooth";
};

export type SketchImage = {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  pixelWidth: number;
  pixelHeight: number;
  x: number;
  z: number;
  width: number;
  depth: number;
  opacity?: number;
  lockAspect?: boolean;
};

/**
 * Cylindrical host surface for barrel sketches.
 * UV: U = R·θ (mm arc length from `radial0`), V = height along `axisDir` from mid.
 */
export type SketchCylinderSurface = {
  kind: "cylinder";
  axisOrigin: { x: number; y: number; z: number };
  axisDir: { x: number; y: number; z: number };
  /** World direction of U = 0 (unit, ⊥ axis). */
  radial0: { x: number; y: number; z: number };
  radius: number;
  height: number;
  /** Extra seam offset in radians (usually 0; baked into radial0 on pick). */
  theta0: number;
};

/** World-space frame for a sketch. Profile `x`/`z` are plane-local U/V. */
export type SketchPlane = {
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  /** In-plane X (U). V = normal × uAxis. */
  uAxis: { x: number; y: number; z: number };
  /** When set, the plane was picked from this shape’s face. */
  hostShapeId?: string;
  /** Present when the sketch is unwrapped onto a cylinder barrel. */
  surface?: SketchCylinderSurface;
};

export type SketchProfile = {
  points: SketchPoint[];
  segments: SketchSegment[];
  images?: SketchImage[];
  sketchPlane?: SketchPlane;
  /** UV outline of the host face being sketched on (plane-local x/z). */
  faceReferenceLoops?: Array<Array<{ x: number; z: number }>>;
};

export type EdgeTreatmentFeature = {
  kind: "fillet" | "chamfer";
  amount: number;
  edgeCount: number;
  chamferAngle?: number;
  /** Durable recipe so remesh can re-apply after edge IDs change. */
  edgeIds?: number[];
  /** Geometric fingerprints (mid/length/angle) for rematch after remesh. */
  edgeFingerprints?: Array<{
    mid: [number, number, number];
    length: number;
    angle: number;
  }>;
  allEdges?: boolean;
  sharpAngle?: number;
  quality?: "draft" | "standard" | "fine" | "ultra";
};

export type EdgeTreatmentHistoryEntry = {
  id: string;
  createdAt: number;
  feature: EdgeTreatmentFeature;
  before: WorkplaneShape;
  appliedFrame?: {
    x: number;
    z: number;
    elevation: number;
    width: number;
    depth: number;
    height: number;
    rotation: number;
    rotationX: number;
    rotationZ: number;
    mirrorX: boolean;
    mirrorY: boolean;
    mirrorZ: boolean;
  };
};

export type ThreadFeature = {
  side: "external" | "internal";
  /** ISO metric designation when applied from a preset (e.g. "M3"). */
  designation?: string;
  majorDiameter: number;
  pitch: number;
  length: number;
  depth: number;
  handedness: "right" | "left";
  faceId: number;
};

export type ThreadHistoryEntry = {
  id: string;
  createdAt: number;
  feature: ThreadFeature;
  before: WorkplaneShape;
  appliedFrame?: EdgeTreatmentHistoryEntry["appliedFrame"];
};

export type CadDisplayEdge = {
  points: number[];
};

export type CadBrepFrame = {
  x: number;
  z: number;
  elevation: number;
  width: number;
  depth: number;
  height: number;
  sourceTransform?: number[];
};

/**
 * Analytic primitive identity carried through a bake so the body can still export as an exact
 * solid. Cylinders record their diameter in `width`/`depth`; a bake that leaves the two unequal is
 * an elliptic cylinder and no longer qualifies.
 */
export type CadPrimitiveFrame = {
  kind: "box" | "cylinder";
  width: number;
  depth: number;
  height: number;
  frame: CadBrepFrame;
};

/** Live CSG / feature-tree op on a body. Mesh cache is derived; children are truth. */
export type CsgOp = "union" | "subtract" | "intersect" | "assemble";

export type CsgBodyMeta = {
  op: CsgOp;
  /** Bumps when operands change so caches can be invalidated. */
  version: number;
  /** True when importedMesh may not match groupedShapes. */
  dirty?: boolean;
  /** When true, this body/feature is skipped during evaluate and export. */
  suppressed?: boolean;
};

export type WorkplaneShape = {
  id: string;
  name: string;
  kind: ShapeKind;
  color: string;
  hole?: boolean;
  x: number;
  z: number;
  elevation?: number;
  size: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  rotationX?: number;
  rotationZ?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  mirrorZ?: boolean;
  radius?: number;
  steps?: number;
  sides?: number;
  bevel?: number;
  segments?: number;
  topRadius?: number;
  baseRadius?: number;
  /** Triangle/roof left slope angle in degrees from horizontal. */
  leftAngle?: number;
  /** Triangle/roof right slope angle in degrees from horizontal. */
  rightAngle?: number;
  text?: string;
  font?: string;
  importedMesh?: {
    positions: number[];
    /** Optional indexed triangles into `positions` (shared verts). Prefer when present. */
    indices?: number[];
    normals?: number[];
    baseWidth: number;
    baseDepth: number;
    baseHeight: number;
    triangleCount: number;
    sourceFormat: "stl" | "obj" | "svg" | "json" | "step" | "3mf";
    // Exact OpenCascade B-Rep of the body (single-shape STEP text) in the same
    // local frame as `positions`. Set for STEP imports, sketch OCCT bakes, and
    // CSG boolean bakes so the exporter can re-emit analytic geometry.
    brepStep?: string;
  };
  imagePlate?: {
    dataUrl: string;
    mimeType: string;
    pixelWidth: number;
    pixelHeight: number;
  };
  sketchProfile?: SketchProfile;
  /**
   * Parametric sketch document (Fusion-like). When present, preferred over
   * reconstructing from `sketchProfile` alone. Kept in sync on finish/edit.
   */
  sketchDoc?: SketchDoc;
  /** Stable id linking Extrude/Revolve features back to a sketch document. */
  sketchId?: string;
  /** Closed profile ids from the sketch that were used for this feature. */
  sketchProfileIds?: string[];
  /** Plane the sketch was drawn on (defaults to workplane when missing). */
  sketchPlane?: SketchPlane;
  /** How the stored sketch profile was turned into this solid. */
  sketchFinish?: "extrude" | "revolve";
  /** Axis used for `sketchFinish: "revolve"` (sketch-plane XZ coordinates). */
  sketchRevolveAxis?: { x1: number; z1: number; x2: number; z2: number };
  edgeTreatments?: EdgeTreatmentFeature[];
  edgeTreatmentHistory?: EdgeTreatmentHistoryEntry[];
  /** Metric coarse size / style for `kind: "thread"` solids. */
  threadSpec?: {
    designation: string;
    majorDiameter: number;
    pitch: number;
    /** screw = fastener; hole = clearance cutter for a receiving hole. */
    style?: "screw" | "hole";
    /** Radial clearance in mm for hole cutters. */
    clearance?: number;
    /** screw | shaft | threads after Separate. */
    part?: "screw" | "shaft" | "threads";
  };
  threadFeatures?: ThreadFeature[];
  threadHistory?: ThreadHistoryEntry[];
  cadDisplayEdges?: CadDisplayEdge[];
  cadDisplayEdgesVersion?: 2;
  edgeResizeMode?: "scale" | "preserve";
  cadBrep?: string;
  cadBrepFrame?: CadBrepFrame;
  cadPrimitiveFrame?: CadPrimitiveFrame;
  /**
   * Live CSG body metadata. When present with `groupedShapes`, children are the
   * source of truth and `importedMesh` is an evaluation cache.
   */
  csg?: CsgBodyMeta;
  groupedShapes?: WorkplaneShape[];
  groupedBaseWidth?: number;
  groupedBaseDepth?: number;
  groupedBaseHeight?: number;
  locked?: boolean;
  hidden?: boolean;
  /** When true, skipped during CSG evaluate / STEP (feature suppress). */
  suppressed?: boolean;
};
