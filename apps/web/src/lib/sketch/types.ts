import { cloneSketchPlane } from "@/lib/sketchPlane";
import type { SketchImage, SketchPlane, SketchPoint, SketchProfile, SketchSegment } from "@/types/sketchforge";

/** First-class parametric sketch document (Fusion-like). */
export type SketchDoc = {
  id: string;
  plane: SketchPlane;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  dimensions: SketchDimension[];
  images: SketchImage[];
  faceReferenceLoops?: Array<Array<{ x: number; z: number }>>;
  settings: SketchDocSettings;
  /** Selected closed profile ids for extrude/revolve. */
  selectedProfileIds: string[];
};

export type SketchDocSettings = {
  showConstraints: boolean;
  showDimensions: boolean;
  showConstruction: boolean;
  constructionMode: boolean;
};

export type SketchVec2 = { x: number; z: number };

export type SketchEntityBase = {
  id: string;
  construction?: boolean;
  /** Projected from 3D host geometry (Fusion Project/Include). */
  projected?: boolean;
  /** Opaque host edge/vertex key for relinking projections. */
  projectSourceId?: string;
  fixed?: boolean;
};

export type SketchPointEntity = SketchEntityBase & {
  kind: "point";
  x: number;
  z: number;
  handleIn?: SketchVec2;
  handleOut?: SketchVec2;
  mode?: "corner" | "smooth" | "split";
};

export type SketchLineEntity = SketchEntityBase & {
  kind: "line";
  startId: string;
  endId: string;
};

export type SketchArcEntity = SketchEntityBase & {
  kind: "arc";
  centerId: string;
  startId: string;
  endId: string;
  /** True = CCW from start to end in UV. */
  ccw?: boolean;
};

export type SketchCircleEntity = SketchEntityBase & {
  kind: "circle";
  centerId: string;
  radius: number;
};

export type SketchBezierEntity = SketchEntityBase & {
  kind: "bezier" | "smooth";
  startId: string;
  endId: string;
};

export type SketchEntity =
  | SketchPointEntity
  | SketchLineEntity
  | SketchArcEntity
  | SketchCircleEntity
  | SketchBezierEntity;

export type SketchConstraintKind =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "concentric"
  | "tangent"
  | "midpoint"
  | "symmetry"
  | "fix";

export type SketchConstraint = {
  id: string;
  kind: SketchConstraintKind;
  entityIds: string[];
  /** Optional point ids for point-on-entity style constraints. */
  pointIds?: string[];
  suppressed?: boolean;
};

export type SketchDimensionKind = "linear" | "angular" | "radius" | "diameter";

export type SketchDimension = {
  id: string;
  kind: SketchDimensionKind;
  entityIds: string[];
  pointIds?: string[];
  value: number;
  driving: boolean;
  /** Placement offset in UV for dimension text. */
  labelOffset?: SketchVec2;
  expression?: string;
};

export type SketchDefinitionStatus =
  | "empty"
  | "under-defined"
  | "fully-defined"
  | "over-constrained"
  /** Solved geometry does not match a driving dimension; the sketch is not trustworthy. */
  | "unsolved";

export type SketchSolveResult = {
  doc: SketchDoc;
  status: SketchDefinitionStatus;
  dof: number;
  conflicts: string[];
  profiles: SketchClosedProfile[];
};

export type SketchClosedProfile = {
  id: string;
  /** Outer loop point ids in order. */
  pointIds: string[];
  /** Nested hole loops. */
  holePointIdLoops: string[][];
  /** Approximate area for sorting / picking. */
  area: number;
  /** Centroid in UV. */
  centroid: SketchVec2;
};

export type SketchSessionPhase = "idle" | "plane-pick" | "active" | "finishing";

export type SketchFocusMode = "3d" | "2d";

export type SketchSession = {
  phase: SketchSessionPhase;
  focusMode: SketchFocusMode;
  editingShapeId: string | null;
  doc: SketchDoc | null;
};

export type SketchSnapKind =
  | "endpoint"
  | "midpoint"
  | "center"
  | "quadrant"
  | "intersection"
  | "nearest"
  | "grid"
  | "horizontal"
  | "vertical";

export type SketchSnapResult = {
  x: number;
  z: number;
  kind: SketchSnapKind;
  entityId?: string;
  pointId?: string;
  /** Constraints inferred by accepting this snap. */
  inferredConstraints: Array<Omit<SketchConstraint, "id">>;
};

export const DEFAULT_SKETCH_DOC_SETTINGS: SketchDocSettings = {
  showConstraints: true,
  showDimensions: true,
  showConstruction: true,
  constructionMode: false,
};

export function createEmptySketchDoc(plane: SketchPlane, id = `sketch-${Date.now().toString(36)}`): SketchDoc {
  return {
    id,
    plane: cloneSketchPlane(plane),
    entities: [],
    constraints: [],
    dimensions: [],
    images: [],
    settings: { ...DEFAULT_SKETCH_DOC_SETTINGS },
    selectedProfileIds: [],
  };
}

/** Legacy segment graph helpers re-exported via migrate for compatibility. */
export type LegacySketchProfile = SketchProfile;
export type LegacySketchPoint = SketchPoint;
export type LegacySketchSegment = SketchSegment;
