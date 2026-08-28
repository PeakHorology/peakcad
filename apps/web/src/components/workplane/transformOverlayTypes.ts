import type { PointerEvent as ReactPointerEvent } from "react";

export type TransformHandleKind = "scale" | "height" | "lift" | "rotate";
export type RotationAxis = "x" | "y" | "z";

/** Local SVG units for the rotation protractor (maps to screen via planeRadius). */
export const ROTATION_RING_INNER = 68;
export const ROTATION_RING_OUTER = 94;
export const ROTATION_RING_POINTER = 92;
export const ROTATION_RING_LOCAL_EXTENT = 100;
export const ROTATION_SNAP_STEP = 22.5;

export type RotationWheelView = {
  x: number;
  y: number;
  /** Screen-space radius of the outer ring edge. */
  radius: number;
  /** Screen-space radius of the inner snap ring. */
  innerRadius: number;
  /** Screen-space radius of the outer free-rotation ring. */
  outerRadius: number;
};

export function rotationWheelRadiiFromPlaneRadius(planeRadius: number): Pick<RotationWheelView, "radius" | "innerRadius" | "outerRadius"> {
  const outerRadius = planeRadius * (ROTATION_RING_OUTER / ROTATION_RING_LOCAL_EXTENT);
  return {
    radius: outerRadius,
    innerRadius: planeRadius * (ROTATION_RING_INNER / ROTATION_RING_LOCAL_EXTENT),
    outerRadius,
  };
}

export type RotationPlaneView = {
  x: number;
  y: number;
  a: number;
  b: number;
  c: number;
  d: number;
};

export type PinnedRotationWheelView = {
  axis: RotationAxis;
  wheel: RotationWheelView;
  plane: RotationPlaneView;
};

export type DimensionMark = {
  key: string;
  handleKey: string;
  axis: "width" | "depth" | "height" | "elevation";
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  e1x1: number;
  e1y1: number;
  e1x2: number;
  e1y2: number;
  e2x1: number;
  e2y1: number;
  e2x2: number;
  e2y2: number;
  labelX: number;
  labelY: number;
};

export type TransformOverlayState = {
  id: string;
  width: number;
  height: number;
  guides: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  handles: Array<{ key: string; className: string; kind: TransformHandleKind; x: number; y: number; title: string }>;
  rotateHandles: Array<{ key: string; className: string; x: number; y: number; angle: number; title?: string }>;
  dimensions: Record<string, DimensionMark[]>;
  rotationWheel: RotationWheelView | null;
  rotationWheels: Record<RotationAxis, RotationWheelView>;
  rotationPlaneCenters: Record<RotationAxis, { x: number; y: number; z: number }>;
  rotationPlanes: Record<RotationAxis, RotationPlaneView>;
};

export type RotationReadout = {
  x: number;
  y: number;
  text: string;
  /** Signed rotation delta in degrees (for the readout label). */
  angle?: number;
  /** Protractor degrees (0 = up, clockwise) for the live mouse pointer. */
  pointerAngle?: number;
  /** Protractor degrees where the drag started (zero / grab mark). */
  startPointerAngle?: number;
  snapMode?: "stepped" | "free";
} | null;

export type EditingDimension = {
  key: string;
  axis: "width" | "depth" | "height" | "elevation";
  x: number;
  y: number;
  value: string;
} | null;

export type EditingRotation = {
  axis: RotationAxis;
  handleKey: string;
  x: number;
  y: number;
  value: string;
  /** Value when the box opened; used to detect typed edits on blur. */
  initialValue: string;
} | null;

export type TransformOverlayProps = {
  box: TransformOverlayState;
  measureKey: string | null;
  editingDimension: EditingDimension;
  editingRotation: EditingRotation;
  rotationReadout: RotationReadout;
  showRotationWheel: boolean;
  hideSelectionChrome: boolean;
  hideDimensionMarks: boolean;
  rotationWheelAxis: RotationAxis;
  pinnedRotationWheelView: PinnedRotationWheelView | null;
  onBeginTransform: (kind: TransformHandleKind, handleKey: string, event: ReactPointerEvent<Element>) => void;
  onMoveTransform: (clientX: number, clientY: number, shiftKey?: boolean, altKey?: boolean) => boolean;
  onFinishTransform: (event: ReactPointerEvent<Element>) => void;
  onHoverMeasure: (key: string | null) => void;
  onPinMeasure: (key: string | null) => void;
  onBeginDimensionEdit: (mark: DimensionMark) => void;
  onBeginLiftEdit: (handleKey: string, x: number, y: number) => void;
  onDropSelectionToWorkplane?: () => void;
  onEditingDimensionChange: (value: string) => void;
  onCommitDimensionEdit: () => void;
  onCancelDimensionEdit: () => void;
  onBeginRotationEdit: (handleKey: string, x: number, y: number) => void;
  onEditingRotationChange: (value: string) => void;
  onCommitRotationEdit: () => void;
  onCancelRotationEdit: () => void;
};

export function getElevationMeasureKey(overlay: TransformOverlayState | null) {
  return (
    Object.values(overlay?.dimensions ?? {})
      .flat()
      .find((mark) => mark.axis === "elevation")?.handleKey ?? null
  );
}

export function measureKeyForHandle(kind: TransformHandleKind, handleKey: string, overlay: TransformOverlayState | null) {
  if (kind === "lift") {
    return getElevationMeasureKey(overlay) ?? handleKey;
  }
  return handleKey;
}
