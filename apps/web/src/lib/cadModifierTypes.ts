export type CadModifierKind = "chamfer" | "fillet";

export type CadModifierEdge = {
  id: number;
  owner?: number;
  points: number[];
  display: boolean;
  selectable: boolean;
  angle: number;
  boundary: boolean;
  manifold: boolean;
};

export type CadModifierQuality = "draft" | "standard" | "fine" | "ultra";

export type CadModifierDisplayEdge = {
  points: number[];
};

export type CadCylindricalFace = {
  id: number;
  owner: number;
  radius: number;
  height: number;
  side: "external" | "internal";
  origin: { x: number; y: number; z: number };
  axis: { x: number; y: number; z: number };
  /** Boundary polyline(s) flattened as xyz for viewport highlight. */
  points: number[];
};

export type CadModifierPrimitivePart =
  | {
      kind: "box";
      width: number;
      depth: number;
      height: number;
      transform?: number[];
    }
  | {
      kind: "cylinder";
      radius: number;
      height: number;
      transform?: number[];
    };

export type CadModifierMeshPart = {
  positions?: Float32Array;
  indices?: Uint32Array;
  brep?: string;
  brepTransform?: number[];
  primitive?: CadModifierPrimitivePart;
  hole: boolean;
};

export type CadModifierComponentMesh = {
  owner: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  brep: string;
  displayEdges: CadModifierDisplayEdge[];
};

export type CadThreadPreviewRequest = {
  type: "previewThread";
  requestId: number;
  faceId: number;
  majorDiameter: number;
  pitch: number;
  length: number;
  depth: number;
  side: "external" | "internal";
  handedness: "right" | "left";
  quality: CadModifierQuality;
};

export type CadModifierWorkerRequest =
  | { type: "prepare"; requestId: number; parts: CadModifierMeshPart[]; sharpAngle: number; suppressTreatmentDetailEdges?: boolean }
  | {
      type: "preview";
      requestId: number;
      kind: CadModifierKind;
      edgeIds: number[];
      amount: number;
      quality: CadModifierQuality;
      chamferAngle: number;
    }
  | CadThreadPreviewRequest
  | { type: "dispose"; requestId: number };

export type CadModifierWorkerResponse =
  | {
      type: "ready";
      requestId: number;
      edges: CadModifierEdge[];
      selectableEdgeIds: number[];
      cylindricalFaces: CadCylindricalFace[];
      sourceType: string;
    }
  | {
      type: "preview";
      requestId: number;
      positions: Float32Array;
      normals: Float32Array;
      indices: Uint32Array;
      triangleCount: number;
      brep: string;
      /** STEP text of the result for round-trip export (optional). */
      step?: string;
      displayEdges: CadModifierDisplayEdge[];
      components?: CadModifierComponentMesh[];
    }
  | { type: "disposed"; requestId: number }
  | { type: "error"; requestId: number; message: string; resetSession?: boolean };
