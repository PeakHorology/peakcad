"use client";

import { ChevronLeft, ChevronRight, Home, Minus, MousePointer2, Plus, Ruler, ScanEye, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import * as THREE from "three";
import { Brush, Evaluator, HOLLOW_INTERSECTION } from "three-bvh-csg";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { AlignOverlay, CircularPatternOverlay, MirrorOverlay, type AlignOverlayState, type CircularPatternOverlayState, type MirrorOverlayState } from "@/components/workplane/ActionOverlays";
import { ShapeInspector, SnapGridControl, type ShapeInspectorUpdateOptions } from "@/components/workplane/ShapeInspector";
import { ToolbarSnapGridIcon } from "@/components/icons";
import { PeakTipButton } from "@/components/workplane/ToolNameTooltip";
import { WorkplaneDimensionsControl } from "@/components/workplane/WorkplaneDimensionsControl";
import { WorkplaneEmptyCoach } from "@/components/workplane/WorkplaneEmptyCoach";
import { WorkspaceSettingsModal } from "@/components/workplane/WorkspaceSettingsModal";
import { HOTKEYS_CHANGED_EVENT, isHotkeyRecordingActive, loadHotkeyBindings, matchHotkeyAction } from "@/lib/hotkeys";
import {
  chooseModifierEdgeCandidate,
  closestPointOnScreenSegment,
  MODIFIER_EDGE_PICK_RADIUS_PX,
  type ModifierEdgeCandidate,
} from "@/lib/modifierEdgePick";
import { defaultSketchPlane, sketchPlaneFromThreeVectors } from "@/lib/sketchPlane";
import {
  barrelHighlightPositions,
  classifySketchFaceHit,
  collectNearbyTriangleNormals,
  discCapHighlightPositions,
  type SketchFaceClassification,
} from "@/lib/sketchFaceClassify";
import { TOOL_DESCRIPTIONS } from "@/lib/toolDescriptions";
import {
  getActiveDisplayQuality,
  resolveHollowCylinderSegments,
  resolveIcosahedronDetail,
  resolveShapeSides,
  resolveShapeSteps,
  setActiveDisplayQuality,
  shapeTessellationFingerprint,
} from "@/lib/displayTessellation";
import { DEFAULT_SNAP_GRID, DEFAULT_WORKPLANE_WORKSPACE, normalizeSnapGrid, normalizeWorkspaceSettings, saveGlobalWorkspaceDefaults, workplaneSettingsFingerprint, workspaceHydrationSyncDecision } from "@/lib/workplaneSettings";
import { interiorWorkplaneGridCoordinates, workplaneGridPalette, WORKPLANE_LINE_ELEVATION } from "@/lib/workplaneGrid";
import { cleanNearZero, cleanRotationDegrees, conePatchForFootprint, coneUnitBaseScale, coneUnitTopScale, fallbackSolidColor, mirroredAxisCount, mirrorSign, preservesEdgeTreatmentSize, proportionalResizeScale, resizedImportedCoordinates, resizedImportedMeshPositions, resizedShapeSize, shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import { sphereTessellation } from "@/lib/sphereTessellation";
import { roofAnglesFromProfile } from "@/lib/roofGeometry";
import { computeViewNudgeAxes, type ViewNudgeAxes } from "@/lib/viewNudge";
import { xrayHeightBounds } from "@/lib/xraySection";
import type { SketchForgeMcpViewFace } from "@/lib/sketchforgeMcpProtocol";
import {
  TransformOverlay,
  getElevationMeasureKey,
  measureKeyForHandle,
  type DimensionMark,
  type EditingDimension,
  type EditingRotation,
  type PinnedRotationWheelView,
  type RotationAxis,
  type RotationPlaneView,
  type RotationReadout,
  type RotationWheelView,
  ROTATION_SNAP_STEP,
  rotationWheelRadiiFromPlaneRadius,
  type TransformHandleKind,
  type TransformOverlayState,
} from "@/components/workplane/TransformOverlay";
import type { AlignAxis, AlignHandleStatus, AlignTarget, GridSize, MeasurementAccuracy, ShapeAsset, SketchPlane, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";
import type { CadModifierEdge } from "@/lib/cadModifierTypes";
import { hardwareProfile, resolvePixelRatio } from "@/lib/desktopHardware";
import { projectShapesFingerprint } from "@/lib/editorHistory";
import { endShapeAssetDrag, getShapeAssetDrag } from "@/lib/shapeAssetDrag";
import { makeShapeFromAsset } from "@/lib/shapeCatalog";
import { DEFAULT_TEXT_FONT, resolveTextFont, textFontCurveSegments } from "@/lib/textFonts";
import {
  DEFAULT_LIGHT_VIEWPORT_BACKGROUND,
  resolveViewportBackground,
  resolveWorkplaneBaseColor,
  UI_THEME_CHANGED_EVENT,
  type UiTheme,
} from "@/lib/uiTheme";

const WORKPLANE_WIDTH = 200;
const WORKPLANE_DEPTH = 140;
const MIN_GRID_BLOCK_SIZE = 1;
const MAX_GRID_BLOCK_SIZE = 200;
const WORKSPACE_DEFAULTS_STORAGE_PREFIX = "sketchForge.workspaceDefault.";
const DEFAULT_WORKSPACE = DEFAULT_WORKPLANE_WORKSPACE;
const CAMERA_HOME = new THREE.Vector3(118, 96, 118);
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0);
const MIN_SHAPE_SIZE = 0.01;
const CUT_PREVIEW_PADDING = 0.01;
const MIN_ELEVATION = -180;
const MAX_ELEVATION = 220;
const CAMERA_MIN_TARGET_Y = -70;
const CAMERA_MAX_TARGET_Y = 120;
const SHAPE_KINDS = new Set<ShapeAsset["kind"]>([
  "box",
  "cylinder",
  "sphere",
  "sketch",
  "scribble",
  "cone",
  "pyramid",
  "roof",
  "text",
  "roundRoof",
  "halfSphere",
  "torus",
  "tube",
  "ring",
  "wedge",
  "polygon",
  "icosahedron",
  "mesh",
  "thread",
]);
const importedGeometryCache = new WeakMap<
  NonNullable<WorkplaneShape["importedMesh"]>,
  { geometry: THREE.BufferGeometry; edges: Map<number, THREE.EdgesGeometry> }
>();
const preservedImportedGeometryCache = new WeakMap<WorkplaneShape, THREE.BufferGeometry>();
const imageTextureLoader = new THREE.TextureLoader();
/**
 * Decoded image-plate textures, keyed by the plate they came from.
 *
 * Shape rebuilds run on every drag, resize and selection change, and each one was decoding the
 * plate's full-resolution data URL again and re-uploading it to the GPU. The plate object identity
 * only changes when the picture does, so it is the right cache key.
 */
const imagePlateTextureCache = new WeakMap<NonNullable<WorkplaneShape["imagePlate"]>, THREE.Texture>();
const IMPORTED_SELECTED_EDGE_TRIANGLE_LIMIT = hardwareProfile().importedEdgeTriangleLimit;
const NORMAL_IMPORTED_SELECTION_EDGE_ANGLE = 60;
/** Hide near-coplanar triangulation seams on union meshes (radial hubs, etc.). */
const IMPORTED_MESH_EDGE_ANGLE = 50;
const ASSET_PLACEMENT_PREVIEW_NAME = "AssetPlacementPreview";

function parseDroppedShapeAsset(raw: string): ShapeAsset | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return null;
    }
    const asset = value as Partial<ShapeAsset>;
    if (
      typeof asset.id !== "string" ||
      typeof asset.name !== "string" ||
      typeof asset.src !== "string" ||
      typeof asset.color !== "string" ||
      !SHAPE_KINDS.has(asset.kind as ShapeAsset["kind"]) ||
      (asset.hole !== undefined && typeof asset.hole !== "boolean")
    ) {
      return null;
    }
    return {
      id: asset.id,
      name: asset.name,
      src: asset.src,
      kind: asset.kind as ShapeAsset["kind"],
      color: asset.color,
      hole: asset.hole,
    };
  } catch {
    return null;
  }
}

type WorkplaneViewportProps = {
  shapes: WorkplaneShape[];
  selectedIds: string[];
  alignMode: boolean;
  alignAnchorId: string | null;
  alignHandles: AlignHandleStatus[];
  alignReferenceShapes: WorkplaneShape[];
  mirrorMode: boolean;
  mirrorReferenceShapes: WorkplaneShape[];
  placementElevation: number;
  workplaneMode: boolean;
  initialSnap?: GridSize;
  initialWorkspace?: WorkplaneWorkspaceSettings;
  workspaceSettingsKey?: string | null;
  onAddShape: (shape: ShapeAsset, point?: { x: number; z: number; elevation?: number }) => void;
  onAlignAnchorChange: (id: string) => void;
  onAlignPreview: (axis: AlignAxis, target: AlignTarget) => void;
  onAlignPreviewClear: () => void;
  onAlignSelection: (axis: AlignAxis, target: AlignTarget) => void;
  onMirrorPreview: (axis: AlignAxis) => void;
  onMirrorPreviewClear: () => void;
  onMirrorSelection: (axis: AlignAxis) => void;
  circularPatternMode?: boolean;
  circularPatternCenter?: { x: number; z: number } | null;
  circularPatternRadius?: number;
  onCircularPatternPivotPick?: (shapeId: string) => void;
  /** When true, left-click picks a face (or workplane) to start a sketch. */
  sketchFacePickMode?: boolean;
  onSketchPlanePicked?: (plane: SketchPlane) => void;
  /** Called when the user clicks a curved face that cannot host a planar sketch yet. */
  onSketchFacePickRejected?: (reason: string) => void;
  onSketchFacePickCancel?: () => void;
  onSelectShape: (id: string | string[] | null, mode?: "replace" | "toggle") => void;
  onSetPlacementElevation: (elevation: number, source: "shape" | "base") => void;
  onInteractionActiveChange?: (active: boolean) => void;
  onEditSketch?: () => void;
  onEditSketchDimension?: (dimensionId: string, value: number) => void;
  canSeparateParts?: boolean;
  onSeparateParts?: () => void;
  activeFeatureId?: string | null;
  onSelectFeature?: (featureId: string | null) => void;
  onSuppressFeature?: (featureId: string, suppressed: boolean) => void;
  onReorderFeature?: (featureId: string, direction: "up" | "down") => void;
  onUpdateFeature?: (featureId: string, patch: ShapeUpdatePatch, options?: ShapeInspectorUpdateOptions) => void;
  onUpdateShape: (id: string, patch: ShapeUpdatePatch) => void;
  onWorkspaceSettingsChange?: (settings: { workspace: WorkplaneWorkspaceSettings; snap: GridSize }) => void;
  onWorkplaneModeChange: (active: boolean) => void;
  modifierActive?: boolean;
  /** When true, keep the object selection outline visible while a modifier tool is active. */
  modifierPreserveSelection?: boolean;
  modifierPreviewActive?: boolean;
  modifierEdges?: CadModifierEdge[];
  selectedModifierEdgeIds?: number[];
  onModifierEdgeToggle?: (id: number, singleEdge: boolean) => void;
  viewNudgeAxesRef?: MutableRefObject<ViewNudgeAxes>;
  /** Lets the editor dismiss the degree box (and bake) before toolbar actions. */
  rotationEditApiRef?: MutableRefObject<{ dismiss: () => void } | null>;
  onDropToWorkplane?: () => void;
  onSnapSelection?: () => void;
  /** Floated in the shape-inspector column so width/alignment stay matched. */
  inspectorDock?: ReactNode;
  /** Top of the inspector column (fillet / chamfer panel). */
  inspectorDockTop?: ReactNode;
};

export type WorkplaneRotationEditApi = { dismiss: () => void };

type WorkspaceSettings = WorkplaneWorkspaceSettings;
type ViewCubeFace = "top" | "bottom" | "front" | "back" | "right" | "left";

function readSavedWorkspaceDefault(key: string | null) {
  if (!key || typeof window === "undefined") {
    return null;
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${WORKSPACE_DEFAULTS_STORAGE_PREFIX}${key}`) ?? "null") as {
      workspace?: unknown;
      snap?: unknown;
    } | null;
    if (!parsed) {
      return null;
    }
    return {
      workspace: normalizeWorkspaceSettings(parsed.workspace),
      snap: normalizeSnapGrid(parsed.snap, DEFAULT_SNAP_GRID),
    };
  } catch {
    return null;
  }
}

type ThreeState = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  keyLight: THREE.DirectionalLight;
  workplaneLayer: THREE.Group;
  shapeLayer: THREE.Group;
  helperLayer: THREE.Group;
  modifierLayer: THREE.Group;
  xrayLayer: THREE.Group;
  clippingPlane: THREE.Plane;
  xrayEnabled: boolean;
  xrayHeight: number;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  dragPlane: THREE.Plane;
  animationId: number;
  needsRender: boolean;
  wasCameraMoving: boolean;
  lastOverlaySync: number;
  lastViewCubeSync: number;
  rotationHandleSides: RotationHandleSides | null;
  disposeInteractionListeners: () => void;
  resize: () => void;
};

/** Force shadow maps to regenerate so contact/WebGL shadows track live drag previews. */
function markShadowsDirty(state: ThreeState) {
  state.renderer.shadowMap.needsUpdate = true;
  state.keyLight.shadow.needsUpdate = true;
}

type CaptureSceneImageOptions = {
  /** When true (default), hide workplane/helpers for model-only captures (MCP / automation). */
  hideOverlays?: boolean;
};

/** Capture the current viewport as a PNG data URL. */
function captureSceneImage(state: ThreeState, options: CaptureSceneImageOptions = {}) {
  const hideOverlays = options.hideOverlays !== false;
  const overlayLayers = [state.workplaneLayer, state.helperLayer, state.modifierLayer, state.xrayLayer];
  const previousVisibility = overlayLayers.map((layer) => layer.visible);
  const previousXrayEnabled = state.xrayEnabled;
  const previousXrayHeight = state.xrayHeight;
  if (hideOverlays) {
    for (const layer of overlayLayers) {
      layer.visible = false;
    }
  }
  try {
    if (hideOverlays && previousXrayEnabled) {
      applyXrayClipping(state, false, previousXrayHeight);
    }
    state.camera.updateMatrixWorld();
    state.renderer.render(state.scene, state.camera);
    return state.renderer.domElement.toDataURL("image/png");
  } finally {
    if (hideOverlays && previousXrayEnabled) {
      applyXrayClipping(state, true, previousXrayHeight);
    }
    if (hideOverlays) {
      overlayLayers.forEach((layer, index) => {
        layer.visible = previousVisibility[index] ?? true;
      });
    }
    state.needsRender = true;
  }
}

function applyCaptureThemeLook(state: ThreeState, storedBackground: string, theme: UiTheme) {
  state.scene.background = new THREE.Color(resolveViewportBackground(storedBackground, theme));
  const base = state.workplaneLayer.getObjectByName("WorkplaneBase");
  if (base instanceof THREE.Mesh && base.material instanceof THREE.MeshStandardMaterial) {
    base.material.color.set(resolveWorkplaneBaseColor(theme));
  }
}

/** Capture the same framing once for light and once for dark dashboard tiles. */
function captureSceneImagesForThemes(
  state: ThreeState,
  storedBackground: string,
  options: CaptureSceneImageOptions = {},
) {
  const previousBackground = state.scene.background;
  const base = state.workplaneLayer.getObjectByName("WorkplaneBase");
  const previousBaseColor =
    base instanceof THREE.Mesh && base.material instanceof THREE.MeshStandardMaterial
      ? base.material.color.clone()
      : null;
  try {
    applyCaptureThemeLook(state, storedBackground, "light");
    const light = captureSceneImage(state, options);
    applyCaptureThemeLook(state, storedBackground, "dark");
    const dark = captureSceneImage(state, options);
    return { light, dark };
  } finally {
    if (previousBackground) {
      state.scene.background = previousBackground;
    }
    if (
      previousBaseColor
      && base instanceof THREE.Mesh
      && base.material instanceof THREE.MeshStandardMaterial
    ) {
      base.material.color.copy(previousBaseColor);
    }
    state.needsRender = true;
  }
}

type ViewportPerfStats = {
  fps: number;
  frameMs: number;
  maxFrameMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  shapeCount: number;
};

declare global {
  interface Window {
    sketchforgePerf?: {
      get: () => ViewportPerfStats;
    };
    sketchforgeCaptureCanvas?: (options?: CaptureSceneImageOptions) => string;
    sketchforgeCaptureView?: (face?: SketchForgeMcpViewFace) => Promise<string> | string;
    sketchforgeCaptureProjectThumbnails?: (options?: CaptureSceneImageOptions) => { light: string; dark: string } | null;
  }
}

type DragState = {
  primaryId: string;
  offsetX: number;
  offsetZ: number;
  planeY: number;
  pointerId: number;
  primaryStartX: number;
  primaryStartZ: number;
  items: DragItem[];
};

type MarqueeState = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
  hasMoved: boolean;
};

type RulerPoint = {
  id: string;
  x: number;
  y: number;
  z: number;
  attachment?: RulerAttachment;
};

type RulerAttachment = {
  shapeId: string;
  normalized: [number, number, number];
  kind?: "vertex" | "edge" | "surface";
  topologyKey?: string;
};

type RulerEdgeAttachment = {
  key: string;
  shapeId: string;
  normalizedPoints: Array<[number, number, number]>;
  topologyKey?: string;
};

type RulerSegment = {
  id: string;
  startId: string;
  endId: string;
  edge?: RulerEdgeAttachment;
};

type RulerModel = {
  points: RulerPoint[];
  segments: RulerSegment[];
  startPointId: string | null;
  hover: RulerCandidate | null;
};

type RulerOverlayState = {
  points: Array<RulerPoint & { screenX: number; screenY: number }>;
  segments: Array<RulerSegment & { x1: number; y1: number; x2: number; y2: number; screenPoints?: string; labelX: number; labelY: number; label: string }>;
  hover: { screenX: number; screenY: number; edgeScreenPoints?: string } | null;
};

type RulerCandidate = {
  x: number;
  y: number;
  z: number;
  pointId?: string;
  attachment?: RulerAttachment;
  edge?: RulerEdgeAttachment;
};

type RulerPointDragState = {
  pointId: string;
  pointerId: number;
};

type RotationHandleSide = "near" | "right" | "far" | "left";
type RotationHandleSides = Record<RotationAxis, RotationHandleSide>;
type ShapeUpdatePatch = Partial<WorkplaneShape> & { bakeTransform?: boolean; repeatDeltaBefore?: WorkplaneShape };
type ResizeSigns = { x: number; z: number };
type ResizeAnchorMemory = {
  shapeId: string;
  handleKey: string;
  signs: ResizeSigns;
  pressedY: "top" | "bottom" | null;
};
type TransformDragState = {
  id: string;
  ids: string[];
  kind: TransformHandleKind;
  handleKey: string;
  rotationAxis: RotationAxis;
  pointerId: number;
  startShape: WorkplaneShape;
  items: TransformDragItem[];
  selectionFrame: SelectionFrame;
  startScreenAngle: number;
  startClientX: number;
  startClientY: number;
  startScreenY: number;
  startWorldY: number;
  handleWorldOffset: number;
  screenYPerWorldUnit: number;
  scalePlaneY: number;
  scalePlane?: THREE.Plane;
  scaleSigns?: ResizeSigns;
  scaleAnchorPoint?: THREE.Vector3;
  scaleStartPoint?: THREE.Vector3;
  rotationAxisVector?: THREE.Vector3;
  rotationPivot?: THREE.Vector3;
  rotationPlaneCenter?: THREE.Vector3;
  rotationStartVector?: THREE.Vector3;
  rotationScreenCenter?: { x: number; y: number };
  rotationScreenSign?: number;
  rotationStartQuaternion?: THREE.Quaternion;
  wheelCenter?: RotationWheelView;
  hasMoved?: boolean;
};

type TransformDragItem = {
  id: string;
  startShape: WorkplaneShape;
  startCenter: THREE.Vector3;
  startQuaternion: THREE.Quaternion;
};

type SelectionFrame = {
  ids: string[];
  center: THREE.Vector3;
  quaternion: THREE.Quaternion;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  zAxis: THREE.Vector3;
  width: number;
  height: number;
  depth: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
  singleShape: WorkplaneShape | null;
};

type DragItem = {
  id: string;
  startX: number;
  startZ: number;
  nextX: number;
  nextZ: number;
  visual: THREE.Object3D | null;
  helper: THREE.Box3Helper | null;
  helperBox: THREE.Box3 | null;
  hadPreviewSimplified: boolean;
};

function isVerticalMeasureHandleKind(kind: TransformHandleKind) {
  return kind === "height" || kind === "lift";
}

function previewShapesForDrag(shapes: WorkplaneShape[], drag: DragState | null) {
  if (!drag) {
    return shapes;
  }
  const previewById = new Map(drag.items.map((item) => [item.id, item]));
  return shapes.map((shape) => {
    const preview = previewById.get(shape.id);
    return preview ? { ...shape, x: preview.nextX, z: preview.nextZ } : shape;
  });
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function snapStep(size: GridSize) {
  if (size === "Off") {
    return 0;
  }
  if (size === "Brick") {
    return 8;
  }
  return Number.parseFloat(size) || 1;
}

function snapValue(value: number, step: number) {
  return step > 0 ? Math.round(value / step) * step : value;
}

function snapDimension(value: number, step: number, min = MIN_SHAPE_SIZE, max = 220) {
  const snapped = step > 0 ? snapValue(value, step) : value;
  const effectiveMin = step > 0 ? Math.max(min, Math.min(step, max)) : min;
  return clamp(snapped, effectiveMin, max);
}

function snapPositionValue(value: number, step: number, min: number, max: number) {
  return clamp(step > 0 ? snapValue(value, step) : value, min, max);
}

function projectedScreenY(state: ThreeState, shape: WorkplaneShape, y: number) {
  return projectedScreenYAt(state, shape.x, shape.z, y);
}

function projectedScreenYAt(state: ThreeState, x: number, z: number, y: number) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.camera.updateMatrixWorld();
  const projected = new THREE.Vector3(x, y, z).project(state.camera);
  return ((1 - projected.y) / 2) * rect.height;
}

function projectedScreenYPerWorldUnit(state: ThreeState, shape: WorkplaneShape, y: number) {
  return projectedScreenYPerWorldUnitAt(state, shape.x, shape.z, y);
}

function projectedScreenYPerWorldUnitAt(state: ThreeState, x: number, z: number, y: number) {
  const sample = 8;
  const start = projectedScreenYAt(state, x, z, y);
  const end = projectedScreenYAt(state, x, z, y + sample);
  const slope = (end - start) / sample;
  return Math.abs(slope) > 0.01 ? slope : -3.2;
}

function screenAngle(clientX: number, clientY: number, center: { x: number; y: number }) {
  return Math.atan2(clientY - center.y, clientX - center.x);
}

function unwrapRadians(value: number) {
  if (value > Math.PI) {
    return value - Math.PI * 2;
  }
  if (value < -Math.PI) {
    return value + Math.PI * 2;
  }
  return value;
}

function rotationAxisForHandle(handleKey: string): RotationAxis {
  if (handleKey === "rotate-tilt") {
    return "x";
  }
  if (handleKey.endsWith("-x") || handleKey === "rotate-left" || handleKey === "rotate-x") {
    return "x";
  }
  if (handleKey.endsWith("-z") || handleKey === "rotate-right" || handleKey === "rotate-z") {
    return "z";
  }
  return "y";
}

function axisScreenHorizontality(state: ThreeState, origin: THREE.Vector3, axis: THREE.Vector3) {
  const direction = axis.clone();
  if (direction.lengthSq() < 0.0001) {
    return 0;
  }
  direction.normalize().multiplyScalar(8);
  const a = projectToScreen(origin, state);
  const b = projectToScreen(origin.clone().add(direction), state);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) {
    return 0;
  }
  return Math.abs(dx) / length;
}

function cameraFacingTiltAxis(state: ThreeState, frame: SelectionFrame): RotationAxis {
  const origin = frame.center;
  const xHorizontality = axisScreenHorizontality(state, origin, frame.xAxis);
  const zHorizontality = axisScreenHorizontality(state, origin, frame.zAxis);
  // Prefer the axis that is less screen-horizontal so X/Z tilt appear when
  // viewing from the opposite side compared with the previous mapping.
  if (Math.abs(xHorizontality - zHorizontality) < 0.04) {
    const cameraRight = new THREE.Vector3();
    state.camera.updateMatrixWorld();
    cameraRight.setFromMatrixColumn(state.camera.matrixWorld, 0).normalize();
    const xAxis = frame.xAxis.clone().normalize();
    const zAxis = frame.zAxis.clone().normalize();
    return Math.abs(xAxis.dot(cameraRight)) >= Math.abs(zAxis.dot(cameraRight)) ? "z" : "x";
  }
  return xHorizontality >= zHorizontality ? "z" : "x";
}

function resolveRotationAxis(handleKey: string, state: ThreeState | null, frame: SelectionFrame | null): RotationAxis {
  if (handleKey === "rotate-tilt") {
    return state && frame ? cameraFacingTiltAxis(state, frame) : "x";
  }
  return rotationAxisForHandle(handleKey);
}

function rotationValueForAxis(shape: WorkplaneShape, axis: RotationAxis) {
  if (axis === "x") {
    return shape.rotationX ?? 0;
  }
  if (axis === "z") {
    return shape.rotationZ ?? 0;
  }
  return shape.rotation;
}

function rotationSnapModeAtPointer(wheel: RotationWheelView | undefined, localX: number, localY: number): "stepped" | "free" {
  if (!wheel) {
    return "free";
  }
  const distance = Math.hypot(localX - wheel.x, localY - wheel.y);
  // Inner circle = indexed/snappy steps; outside that circle = free rotation.
  return distance <= wheel.innerRadius ? "stepped" : "free";
}

/** Screen atan2 → protractor degrees (0 = up, clockwise positive). */
function protractorAngleFromPointer(localX: number, localY: number, center: { x: number; y: number }) {
  return THREE.MathUtils.radToDeg(screenAngle(localX, localY, center)) + 90;
}

function rotationReadoutAtPointer(
  wheel: RotationWheelView | undefined,
  localX: number,
  localY: number,
  delta: number,
  startPointerAngle?: number,
): RotationReadout {
  const snapMode = rotationSnapModeAtPointer(wheel, localX, localY);
  const readoutText = delta % 1 === 0 ? `${delta}°` : `${Number(delta.toFixed(1))}°`;
  const pointerCenter = wheel ?? { x: localX, y: localY };
  const pointerAngle = protractorAngleFromPointer(localX, localY, pointerCenter);
  return {
    x: snapMode === "stepped" && wheel ? wheel.x : localX + 14,
    y: snapMode === "stepped" && wheel ? wheel.y - 80 : localY - 14,
    text: readoutText,
    angle: delta,
    pointerAngle,
    startPointerAngle: startPointerAngle ?? pointerAngle,
    snapMode,
  };
}

function rotationPatchForAxis(axis: RotationAxis, value: number): Partial<WorkplaneShape> {
  const normalized = cleanRotationDegrees(value);
  if (axis === "x") {
    return { rotationX: normalized };
  }
  if (axis === "z") {
    return { rotationZ: normalized };
  }
  return { rotation: normalized };
}

function quaternionForShape(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shape.rotation),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
}

function rotationPatchFromQuaternion(quaternion: THREE.Quaternion): Partial<WorkplaneShape> {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    rotationX: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.x)),
    rotation: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.y)),
    rotationZ: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.z)),
  };
}

function shouldPreserveDrawingBufferForLocalAutomation() {
  // Capture paths render immediately before toDataURL, so the buffer does not
  // need to be preserved every frame (expensive on discrete GPUs).
  return hardwareProfile().preserveDrawingBuffer;
}

function rotationScreenSign(axisVector: THREE.Vector3, camera: THREE.Camera) {
  const cameraForward = camera.getWorldDirection(new THREE.Vector3());
  return axisVector.dot(cameraForward) >= 0 ? 1 : -1;
}

function projectToScreen(point: THREE.Vector3, state: ThreeState) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.camera.updateMatrixWorld();
  const projected = point.clone().project(state.camera);
  return {
    x: ((projected.x + 1) / 2) * rect.width,
    y: ((1 - projected.y) / 2) * rect.height,
  };
}

function rulerShapeDimensions(object: THREE.Object3D) {
  const dimensions = object.userData.rulerDimensions as [number, number, number] | undefined;
  return dimensions ?? [1, 1, 1];
}

function rulerShapeTopologyKey(shape: WorkplaneShape): string {
  const positions = shape.importedMesh?.positions ?? [];
  const positionSample = positions.length > 0
    ? Array.from({ length: Math.min(12, positions.length) }, (_, index) => positions[Math.floor(index * (positions.length - 1) / Math.max(1, Math.min(12, positions.length) - 1))]?.toFixed(4) ?? "0").join(",")
    : "";
  const brep = shape.cadBrep ?? "";
  const brepSample = brep.length > 0
    ? Array.from({ length: Math.min(8, brep.length) }, (_, index) => brep.charCodeAt(Math.floor(index * (brep.length - 1) / Math.max(1, Math.min(8, brep.length) - 1)))).join(",")
    : "";
  return JSON.stringify({
    kind: shape.kind,
    radius: shape.radius,
    steps: shape.steps,
    sides: shape.sides,
    bevel: shape.bevel,
    segments: shape.segments,
    topRadius: shape.topRadius,
    baseRadius: shape.baseRadius,
    leftAngle: shape.leftAngle,
    rightAngle: shape.rightAngle,
    text: shape.text,
    font: shape.font,
    mesh: [positions.length, positionSample],
    brep: [brep.length, brepSample],
    treatments: shape.edgeTreatments,
    children: shape.groupedShapes?.map((child) => [child.id, rulerShapeTopologyKey(child)]),
  });
}

function rulerAttachmentWorld(state: ThreeState, attachment: RulerAttachment) {
  const object = findShapeObject(state, attachment.shapeId);
  if (!object) return null;
  const dimensions = rulerShapeDimensions(object);
  return object.localToWorld(new THREE.Vector3(
    attachment.normalized[0] * dimensions[0],
    attachment.normalized[1] * dimensions[1],
    attachment.normalized[2] * dimensions[2],
  ));
}

function rulerAttachmentFromWorld(state: ThreeState, shapeId: string, world: THREE.Vector3, kind: RulerAttachment["kind"] = "surface"): RulerAttachment | null {
  const object = findShapeObject(state, shapeId);
  if (!object) return null;
  const dimensions = rulerShapeDimensions(object);
  const local = object.worldToLocal(world.clone());
  return {
    shapeId,
    kind,
    topologyKey: object.userData.rulerTopologyKey as string | undefined,
    normalized: [
      local.x / Math.max(0.001, dimensions[0]),
      local.y / Math.max(0.001, dimensions[1]),
      local.z / Math.max(0.001, dimensions[2]),
    ],
  };
}

function rulerPointWorld(state: ThreeState, point: Pick<RulerPoint, "x" | "y" | "z" | "attachment">) {
  return point.attachment ? rulerAttachmentWorld(state, point.attachment) ?? new THREE.Vector3(point.x, point.y, point.z) : new THREE.Vector3(point.x, point.y, point.z);
}

function rulerEdgeWorldPoints(state: ThreeState, edge: RulerEdgeAttachment) {
  return edge.normalizedPoints.flatMap((normalized) => {
    const world = rulerAttachmentWorld(state, { shapeId: edge.shapeId, normalized });
    return world ? [world] : [];
  });
}

function rulerPolylineLength(points: THREE.Vector3[]) {
  let length = 0;
  for (let index = 0; index + 1 < points.length; index += 1) length += points[index].distanceTo(points[index + 1]);
  return length;
}

function rulerPolylineMidpoint(points: THREE.Vector3[]) {
  if (points.length === 0) return new THREE.Vector3();
  const half = rulerPolylineLength(points) / 2;
  let traversed = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const length = points[index].distanceTo(points[index + 1]);
    if (traversed + length >= half && length > 1e-9) return points[index].clone().lerp(points[index + 1], (half - traversed) / length);
    traversed += length;
  }
  return points[points.length - 1].clone();
}

function rulerScreenPointList(points: THREE.Vector3[], state: ThreeState) {
  return points.map((point) => {
    const screen = projectToScreen(point, state);
    return `${screen.x},${screen.y}`;
  }).join(" ");
}

function chainRulerLineSegments(segments: Array<[THREE.Vector3, THREE.Vector3]>) {
  if (segments.length <= 1) return segments.map(([a, b]) => [a, b]);
  const bounds = new THREE.Box3();
  segments.forEach(([a, b]) => {
    bounds.expandByPoint(a);
    bounds.expandByPoint(b);
  });
  const tolerance = Math.max(1e-6, bounds.getSize(new THREE.Vector3()).length() * 1e-5);
  const tangentLimit = Math.cos(THREE.MathUtils.degToRad(20));
  const unused = new Set(segments.map((_, index) => index));
  const paths: THREE.Vector3[][] = [];

  while (unused.size > 0) {
    const firstIndex = unused.values().next().value as number;
    unused.delete(firstIndex);
    const path = [segments[firstIndex][0].clone(), segments[firstIndex][1].clone()];
    let extended = true;
    while (extended) {
      extended = false;
      for (const index of unused) {
        const [a, b] = segments[index];
        const end = path[path.length - 1];
        const endDirection = end.clone().sub(path[path.length - 2]).normalize();
        const endOther = a.distanceTo(end) <= tolerance ? b : b.distanceTo(end) <= tolerance ? a : null;
        if (endOther && Math.abs(endDirection.dot(endOther.clone().sub(end).normalize())) >= tangentLimit) {
          path.push(endOther.clone());
          unused.delete(index);
          extended = true;
          break;
        }
        const start = path[0];
        const startDirection = start.clone().sub(path[1]).normalize();
        const startOther = a.distanceTo(start) <= tolerance ? b : b.distanceTo(start) <= tolerance ? a : null;
        if (startOther && Math.abs(startDirection.dot(startOther.clone().sub(start).normalize())) >= tangentLimit) {
          path.unshift(startOther.clone());
          unused.delete(index);
          extended = true;
          break;
        }
      }
    }
    paths.push(path);
  }
  return paths;
}

function rulerNormalizedLineSegments(state: ThreeState, shapeId: string) {
  const object = findShapeObject(state, shapeId);
  if (!object) return [];
  object.updateWorldMatrix(true, true);
  const dimensions = rulerShapeDimensions(object);
  const normalizedFromWorld = (world: THREE.Vector3) => {
    const local = object.worldToLocal(world.clone());
    return new THREE.Vector3(
      local.x / Math.max(0.001, dimensions[0]),
      local.y / Math.max(0.001, dimensions[1]),
      local.z / Math.max(0.001, dimensions[2]),
    );
  };
  const segments: Array<[THREE.Vector3, THREE.Vector3]> = [];
  object.traverse((child) => {
    if (!(child instanceof THREE.Line) || !child.visible) return;
    const position = child.geometry.getAttribute("position");
    if (!position || position.count < 2) return;
    const points: THREE.Vector3[] = [];
    for (let index = 0; index < position.count; index += 1) {
      points.push(normalizedFromWorld(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld)));
    }
    if ((child as THREE.LineSegments).isLineSegments) {
      for (let index = 0; index + 1 < points.length; index += 2) segments.push([points[index], points[index + 1]]);
    } else {
      for (let index = 0; index + 1 < points.length; index += 1) segments.push([points[index], points[index + 1]]);
      if ((child as THREE.LineLoop).isLineLoop && points.length > 2) segments.push([points[points.length - 1], points[0]]);
    }
  });
  return segments;
}

function rulerPointToSegmentDistance(point: THREE.Vector3, start: THREE.Vector3, end: THREE.Vector3) {
  const delta = end.clone().sub(start);
  const lengthSq = delta.lengthSq();
  const amount = lengthSq > 1e-12 ? clamp(point.clone().sub(start).dot(delta) / lengthSq, 0, 1) : 0;
  return point.distanceTo(start.clone().addScaledVector(delta, amount));
}

function rulerAttachmentMatchesTopology(state: ThreeState, attachment: RulerAttachment) {
  const object = findShapeObject(state, attachment.shapeId);
  if (!object) return false;
  const currentTopologyKey = object.userData.rulerTopologyKey as string | undefined;
  if (!attachment.topologyKey || attachment.topologyKey === currentTopologyKey || attachment.kind === "surface") return true;
  const target = new THREE.Vector3(...attachment.normalized);
  const segments = rulerNormalizedLineSegments(state, attachment.shapeId);
  if (attachment.kind === "vertex") {
    return segments.some(([start, end]) => start.distanceTo(target) <= 0.002 || end.distanceTo(target) <= 0.002);
  }
  return segments.some(([start, end]) => rulerPointToSegmentDistance(target, start, end) <= 0.002);
}

function rulerEdgeMatchesTopology(state: ThreeState, edge: RulerEdgeAttachment) {
  const object = findShapeObject(state, edge.shapeId);
  if (!object) return false;
  const currentTopologyKey = object.userData.rulerTopologyKey as string | undefined;
  if (!edge.topologyKey || edge.topologyKey === currentTopologyKey) return true;
  const segments = rulerNormalizedLineSegments(state, edge.shapeId);
  if (segments.length === 0) return false;
  const samples = edge.normalizedPoints.filter((_, index) => (
    index === 0
    || index === edge.normalizedPoints.length - 1
    || index % Math.max(1, Math.floor(edge.normalizedPoints.length / 8)) === 0
  ));
  return samples.every((point) => {
    const target = new THREE.Vector3(...point);
    return segments.some(([start, end]) => rulerPointToSegmentDistance(target, start, end) <= 0.002);
  });
}

function pickModelRulerCandidate(state: ThreeState, shapeIds: string[], clientX: number, clientY: number): RulerCandidate | null {
  const rect = state.renderer.domElement.getBoundingClientRect();
  const pointerX = clientX - rect.left;
  const pointerY = clientY - rect.top;
  const targets = shapeIds.flatMap((id) => {
    const object = findShapeObject(state, id);
    return object ? [object] : [];
  });
  if (targets.length === 0) return null;

  state.camera.updateMatrixWorld();
  targets.forEach((target) => target.updateWorldMatrix(true, true));
  const vertexCandidates: Array<{ distance: number; candidate: RulerCandidate }> = [];
  const edgeCandidates: Array<{ distance: number; candidate: RulerCandidate }> = [];

  targets.forEach((target) => {
    const shapeId = target.userData.shapeId as string;
    target.traverse((child) => {
      if (!(child instanceof THREE.Line) || !child.visible) return;
      const position = child.geometry.getAttribute("position");
      if (!position || position.count < 2) return;
      const paths: THREE.Vector3[][] = [];
      if ((child as THREE.LineSegments).isLineSegments) {
        const segments: Array<[THREE.Vector3, THREE.Vector3]> = [];
        for (let index = 0; index + 1 < position.count; index += 2) {
          segments.push([
            new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld),
            new THREE.Vector3().fromBufferAttribute(position, index + 1).applyMatrix4(child.matrixWorld),
          ]);
        }
        paths.push(...chainRulerLineSegments(segments));
      } else {
        const path: THREE.Vector3[] = [];
        for (let index = 0; index < position.count; index += 1) path.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld));
        if ((child as THREE.LineLoop).isLineLoop && path.length > 2) path.push(path[0].clone());
        paths.push(path);
      }

      paths.forEach((worldPoints, pathIndex) => {
        if (worldPoints.length < 2) return;
        const attachments = worldPoints.map((point) => rulerAttachmentFromWorld(state, shapeId, point, "edge"));
        if (attachments.some((attachment) => !attachment)) return;
        const normalizedPoints = attachments.map((attachment) => (attachment as RulerAttachment).normalized);
        const edge: RulerEdgeAttachment = {
          key: `${shapeId}:${child.uuid}:${pathIndex}`,
          shapeId,
          normalizedPoints,
          topologyKey: target.userData.rulerTopologyKey as string | undefined,
        };
        const endpointIndexes = worldPoints[0].distanceToSquared(worldPoints[worldPoints.length - 1]) < 1e-10 ? [0] : [0, worldPoints.length - 1];
        endpointIndexes.forEach((index) => {
          const screen = projectToScreen(worldPoints[index], state);
          const distance = Math.hypot(pointerX - screen.x, pointerY - screen.y);
          if (distance <= 9) {
            vertexCandidates.push({
              distance,
              candidate: {
                x: worldPoints[index].x,
                y: worldPoints[index].y,
                z: worldPoints[index].z,
                attachment: { ...(attachments[index] as RulerAttachment), kind: "vertex" },
              },
            });
          }
        });

        for (let index = 0; index + 1 < worldPoints.length; index += 1) {
          const aScreen = projectToScreen(worldPoints[index], state);
          const bScreen = projectToScreen(worldPoints[index + 1], state);
          const dx = bScreen.x - aScreen.x;
          const dy = bScreen.y - aScreen.y;
          const amount = dx * dx + dy * dy > 0.001 ? clamp(((pointerX - aScreen.x) * dx + (pointerY - aScreen.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
          const distance = Math.hypot(pointerX - (aScreen.x + dx * amount), pointerY - (aScreen.y + dy * amount));
          if (distance <= 12) {
            const world = worldPoints[index].clone().lerp(worldPoints[index + 1], amount);
            const normalizedA = normalizedPoints[index];
            const normalizedB = normalizedPoints[index + 1];
            edgeCandidates.push({
              distance,
              candidate: {
                x: world.x,
                y: world.y,
                z: world.z,
                attachment: {
                  shapeId,
                  kind: "edge",
                  topologyKey: target.userData.rulerTopologyKey as string | undefined,
                  normalized: [
                    normalizedA[0] + (normalizedB[0] - normalizedA[0]) * amount,
                    normalizedA[1] + (normalizedB[1] - normalizedA[1]) * amount,
                    normalizedA[2] + (normalizedB[2] - normalizedA[2]) * amount,
                  ],
                },
                edge,
              },
            });
          }
        }
      });
    });
  });

  vertexCandidates.sort((a, b) => a.distance - b.distance);
  edgeCandidates.sort((a, b) => a.distance - b.distance);
  if (vertexCandidates[0]) return vertexCandidates[0].candidate;
  if (edgeCandidates[0]) return edgeCandidates[0].candidate;

  state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const surfaceHit = state.raycaster.intersectObjects(targets, true).find((entry) => entry.object instanceof THREE.Mesh);
  if (!surfaceHit) return null;
  const shapeId = surfaceHit.object.userData.shapeId as string;
  const attachment = rulerAttachmentFromWorld(state, shapeId, surfaceHit.point);
  return attachment ? { x: surfaceHit.point.x, y: surfaceHit.point.y, z: surfaceHit.point.z, attachment } : null;
}

function projectCadPointToCanvas(point: THREE.Vector3, state: ThreeState, rect: DOMRect) {
  const projected = point.clone().project(state.camera);
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < -1 || projected.z > 1) {
    return null;
  }
  return {
    x: ((projected.x + 1) / 2) * rect.width,
    y: ((1 - projected.y) / 2) * rect.height,
    depth: projected.z,
  };
}

function pickModifierEdgeFromScreen(state: ThreeState, edges: CadModifierEdge[], clientX: number, clientY: number) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  const pointerX = clientX - rect.left;
  const pointerY = clientY - rect.top;
  const pointA = new THREE.Vector3();
  const pointB = new THREE.Vector3();
  const candidates = new Map<number, ModifierEdgeCandidate>();
  state.camera.updateMatrixWorld();
  edges.forEach((edge) => {
    for (let index = 0; index + 5 < edge.points.length; index += 3) {
      pointA.set(edge.points[index], edge.points[index + 1], edge.points[index + 2]);
      pointB.set(edge.points[index + 3], edge.points[index + 4], edge.points[index + 5]);
      const a = projectCadPointToCanvas(pointA, state, rect);
      const b = projectCadPointToCanvas(pointB, state, rect);
      if (!a || !b) continue;
      const hit = closestPointOnScreenSegment(pointerX, pointerY, a.x, a.y, b.x, b.y);
      if (hit.distance >= MODIFIER_EDGE_PICK_RADIUS_PX) continue;
      const existing = candidates.get(edge.id);
      if (existing && existing.distance <= hit.distance) continue;
      candidates.set(edge.id, {
        id: edge.id,
        distance: hit.distance,
        depth: a.depth + (b.depth - a.depth) * hit.amount,
      });
    }
  });
  return chooseModifierEdgeCandidate(candidates.values());
}

function syncRulerOverlay(
  state: ThreeState,
  model: RulerModel,
  overlayRef: MutableRefObject<RulerOverlayState | null>,
  setOverlay: Dispatch<SetStateAction<RulerOverlayState | null>>,
  accuracy: MeasurementAccuracy,
) {
  const projectedPoints = new Map<string, { screenX: number; screenY: number }>();
  const points = model.points.map((point) => {
    const screen = projectToScreen(rulerPointWorld(state, point), state);
    const projected = { screenX: screen.x, screenY: screen.y };
    projectedPoints.set(point.id, projected);
    return { ...point, ...projected };
  });
  const segments = model.segments.flatMap((segment) => {
    const start = model.points.find((point) => point.id === segment.startId);
    const end = model.points.find((point) => point.id === segment.endId);
    const startScreen = projectedPoints.get(segment.startId);
    const endScreen = projectedPoints.get(segment.endId);
    if (!start || !end || !startScreen || !endScreen) {
      return [];
    }
    const startWorld = rulerPointWorld(state, start);
    const endWorld = rulerPointWorld(state, end);
    const attachedEdgePoints = segment.edge ? rulerEdgeWorldPoints(state, segment.edge) : [];
    const worldPoints = attachedEdgePoints.length >= 2 ? attachedEdgePoints : [startWorld, endWorld];
    const labelScreen = projectToScreen(rulerPolylineMidpoint(worldPoints), state);
    return [
      {
        ...segment,
        x1: startScreen.screenX,
        y1: startScreen.screenY,
        x2: endScreen.screenX,
        y2: endScreen.screenY,
        screenPoints: segment.edge && worldPoints.length >= 2 ? rulerScreenPointList(worldPoints, state) : undefined,
        labelX: labelScreen.x,
        labelY: labelScreen.y - 18,
        label: formatMeasure(rulerPolylineLength(worldPoints), accuracy),
      },
    ];
  });
  const hoverWorld = model.hover ? rulerPointWorld(state, model.hover) : null;
  const hoverScreen = hoverWorld ? projectToScreen(hoverWorld, state) : null;
  const hoverEdgePoints = model.hover?.edge ? rulerEdgeWorldPoints(state, model.hover.edge) : [];
  const next: RulerOverlayState = {
    points,
    segments,
    hover: hoverScreen ? {
      screenX: hoverScreen.x,
      screenY: hoverScreen.y,
      edgeScreenPoints: hoverEdgePoints.length >= 2 ? rulerScreenPointList(hoverEdgePoints, state) : undefined,
    } : null,
  };
  const previous = overlayRef.current;
  const unchanged =
    previous &&
    previous.points.length === next.points.length &&
    previous.segments.length === next.segments.length &&
    previous.points.every((point, index) => {
      const candidate = next.points[index];
      return point.id === candidate.id && Math.abs(point.screenX - candidate.screenX) < 0.2 && Math.abs(point.screenY - candidate.screenY) < 0.2;
    }) &&
    previous.segments.every((segment, index) => {
      const candidate = next.segments[index];
      return segment.id === candidate.id
        && segment.label === candidate.label
        && segment.screenPoints === candidate.screenPoints
        && Math.abs(segment.x1 - candidate.x1) < 0.2
        && Math.abs(segment.y1 - candidate.y1) < 0.2
        && Math.abs(segment.x2 - candidate.x2) < 0.2
        && Math.abs(segment.y2 - candidate.y2) < 0.2
        && Math.abs(segment.labelX - candidate.labelX) < 0.2
        && Math.abs(segment.labelY - candidate.labelY) < 0.2;
    }) &&
    ((!previous.hover && !next.hover) ||
      (previous.hover && next.hover
        && previous.hover.edgeScreenPoints === next.hover.edgeScreenPoints
        && Math.abs(previous.hover.screenX - next.hover.screenX) < 0.2
        && Math.abs(previous.hover.screenY - next.hover.screenY) < 0.2));
  if (!unchanged) {
    overlayRef.current = next;
    setOverlay(next);
  }
}

function RulerOverlay({
  overlay,
  startPointId,
  active,
  deleteMode,
  moveMode,
  onPointPointerDown,
  onPointPointerMove,
  onPointPointerUp,
  onSegmentPointerDown,
}: {
  overlay: RulerOverlayState;
  startPointId: string | null;
  active: boolean;
  deleteMode: boolean;
  moveMode: boolean;
  onPointPointerDown: (event: ReactPointerEvent<SVGCircleElement>, pointId: string) => void;
  onPointPointerMove: (event: ReactPointerEvent<SVGCircleElement>, pointId: string) => void;
  onPointPointerUp: (event: ReactPointerEvent<SVGCircleElement>, pointId: string) => void;
  onSegmentPointerDown: (event: ReactPointerEvent<SVGElement>, segmentId: string) => void;
}) {
  return (
    <div className={`ruler-overlay ${active ? "active" : ""} ${deleteMode ? "delete-mode" : ""} ${moveMode ? "move-mode" : ""}`} aria-label="Ruler measurements">
      <svg className="ruler-guides" width="100%" height="100%" aria-hidden="true">
        {overlay.segments.map((segment) => (
          <g key={segment.id} className="ruler-segment-group">
            {segment.screenPoints ? (
              <>
                <polyline className="ruler-segment" points={segment.screenPoints} fill="none" />
                <polyline className="ruler-segment-hit" points={segment.screenPoints} fill="none" onPointerDown={(event) => onSegmentPointerDown(event, segment.id)} />
              </>
            ) : (
              <>
                <line className="ruler-segment" x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />
                <line
                  className="ruler-segment-hit"
                  x1={segment.x1}
                  y1={segment.y1}
                  x2={segment.x2}
                  y2={segment.y2}
                  onPointerDown={(event) => onSegmentPointerDown(event, segment.id)}
                />
              </>
            )}
          </g>
        ))}
        {overlay.points.map((point) => (
          <circle
            key={point.id}
            className={`ruler-point ${point.id === startPointId ? "pending" : ""}`}
            cx={point.screenX}
            cy={point.screenY}
            r="5"
            onPointerDown={(event) => onPointPointerDown(event, point.id)}
            onPointerMove={(event) => onPointPointerMove(event, point.id)}
            onPointerUp={(event) => onPointPointerUp(event, point.id)}
            onPointerCancel={(event) => onPointPointerUp(event, point.id)}
          />
        ))}
        {active && overlay.hover?.edgeScreenPoints ? <polyline className="ruler-hover-edge" points={overlay.hover.edgeScreenPoints} fill="none" /> : null}
        {active && overlay.hover ? <circle className="ruler-hover-point" cx={overlay.hover.screenX} cy={overlay.hover.screenY} r="5" /> : null}
      </svg>
      {overlay.segments.map((segment) => (
        <span key={`${segment.id}-label`} className="ruler-label" style={{ left: segment.labelX, top: segment.labelY }}>
          {segment.label}
        </span>
      ))}
    </div>
  );
}

function shapeCenter(shape: WorkplaneShape) {
  return new THREE.Vector3(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z);
}

function shapeLocalExtents(shape: WorkplaneShape) {
  return {
    x: shapeWidth(shape) / 2,
    y: shape.height / 2,
    z: shapeDepth(shape) / 2,
  };
}

function selectionFrameForShapes(shapes: WorkplaneShape[], selectedIds: string[]): SelectionFrame | null {
  const selected = selectedIds.map((id) => shapes.find((shape) => shape.id === id)).filter((shape): shape is WorkplaneShape => Boolean(shape && !shape.hidden));
  if (selected.length === 0) {
    return null;
  }

  const singleShape = selected.length === 1 ? selected[0] : null;
  const quaternion = singleShape ? quaternionForShape(singleShape) : new THREE.Quaternion();
  const inverse = quaternion.clone().invert();
  const localMin = new THREE.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const localMax = new THREE.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  const origin = singleShape ? shapeCenter(singleShape) : new THREE.Vector3();

  if (!singleShape) {
    selected.forEach((shape) => origin.add(shapeCenter(shape)));
    origin.multiplyScalar(1 / selected.length);
  }

  selected.forEach((shape) => {
    const center = shapeCenter(shape);
    const extents = shapeLocalExtents(shape);
    const shapeQuaternion = quaternionForShape(shape);
    [-1, 1].forEach((xSign) => {
      [-1, 1].forEach((ySign) => {
        [-1, 1].forEach((zSign) => {
          const point = new THREE.Vector3(xSign * extents.x, ySign * extents.y, zSign * extents.z).applyQuaternion(shapeQuaternion).add(center);
          const local = point.sub(origin).applyQuaternion(inverse);
          localMin.min(local);
          localMax.max(local);
        });
      });
    });
  });

  const localCenter = localMin.clone().add(localMax).multiplyScalar(0.5);
  const center = origin.clone().add(localCenter.clone().applyQuaternion(quaternion));
  const width = Math.max(MIN_SHAPE_SIZE, localMax.x - localMin.x);
  const height = Math.max(MIN_SHAPE_SIZE, localMax.y - localMin.y);
  const depth = Math.max(MIN_SHAPE_SIZE, localMax.z - localMin.z);
  const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion).normalize();
  const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
  const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();

  return {
    ids: selected.map((shape) => shape.id),
    center,
    quaternion,
    xAxis,
    yAxis,
    zAxis,
    width,
    height,
    depth,
    min: new THREE.Vector3(-width / 2, -height / 2, -depth / 2),
    max: new THREE.Vector3(width / 2, height / 2, depth / 2),
    singleShape,
  };
}

function framePoint(frame: SelectionFrame, x: number, y: number, z: number) {
  return frame.center
    .clone()
    .add(frame.xAxis.clone().multiplyScalar(x))
    .add(frame.yAxis.clone().multiplyScalar(y))
    .add(frame.zAxis.clone().multiplyScalar(z));
}

function frameLocalPoint(frame: SelectionFrame, point: THREE.Vector3) {
  const offset = point.clone().sub(frame.center);
  return new THREE.Vector3(offset.dot(frame.xAxis), offset.dot(frame.yAxis), offset.dot(frame.zAxis));
}

function frameLocalDelta(frame: SelectionFrame, start: THREE.Vector3, current: THREE.Vector3) {
  const offset = current.clone().sub(start);
  return new THREE.Vector3(offset.dot(frame.xAxis), offset.dot(frame.yAxis), offset.dot(frame.zAxis));
}

function selectionFrameCorners(frame: SelectionFrame) {
  const corners: THREE.Vector3[] = [];
  [-1, 1].forEach((xSign) => {
    [-1, 1].forEach((ySign) => {
      [-1, 1].forEach((zSign) => {
        corners.push(framePoint(frame, (xSign * frame.width) / 2, (ySign * frame.height) / 2, (zSign * frame.depth) / 2));
      });
    });
  });
  return corners;
}

function selectionWorldYBounds(frame: SelectionFrame) {
  const corners = selectionFrameCorners(frame);
  const min = cleanNearZero(Math.min(...corners.map((corner) => corner.y)));
  const max = cleanNearZero(Math.max(...corners.map((corner) => corner.y)));
  return { min, max, height: Math.max(MIN_SHAPE_SIZE, max - min) };
}

function localResizePlaneForFrame(frame: SelectionFrame) {
  return new THREE.Plane().setFromNormalAndCoplanarPoint(
    frame.yAxis.clone().normalize(),
    framePoint(frame, 0, frame.min.y, 0),
  );
}

function resizeSignsForHandle(handleKey: string): ResizeSigns {
  const key = handleKey.toLowerCase();
  return {
    x: key.includes("right") ? 1 : key.includes("left") ? -1 : 0,
    z: key.includes("near") ? 1 : key.includes("far") ? -1 : 0,
  };
}

function resizeAnchorPointForFrame(frame: SelectionFrame, signs: ResizeSigns) {
  return framePoint(
    frame,
    signs.x ? (-signs.x * frame.width) / 2 : 0,
    frame.min.y,
    signs.z ? (-signs.z * frame.depth) / 2 : 0,
  );
}

function resizeCenterFromAnchor(frame: SelectionFrame, anchor: THREE.Vector3, signs: ResizeSigns, width: number, depth: number) {
  return anchor
    .clone()
    .add(frame.yAxis.clone().multiplyScalar(frame.height / 2))
    .add(frame.xAxis.clone().multiplyScalar(signs.x ? (signs.x * width) / 2 : 0))
    .add(frame.zAxis.clone().multiplyScalar(signs.z ? (signs.z * depth) / 2 : 0));
}

function resizedShapePatchFromFrame(shape: WorkplaneShape, center: THREE.Vector3, width: number, depth: number): Partial<WorkplaneShape> {
  const patch: Partial<WorkplaneShape> = {
    x: cleanNearZero(center.x, 0.0005),
    z: cleanNearZero(center.z, 0.0005),
    elevation: cleanNearZero(center.y - shape.height / 2, 0.0005),
    width,
    depth,
    size: resizedShapeSize(width, depth),
  };
  if (shape.kind === "cone") {
    Object.assign(patch, conePatchForFootprint(shape, width, depth));
  }
  return patch;
}

function shapeScreenBounds(state: ThreeState, shape: WorkplaneShape) {
  const frame = selectionFrameForShapes([shape], [shape.id]);
  if (!frame) {
    return null;
  }
  const points = selectionFrameCorners(frame).map((corner) => projectToScreen(corner, state));
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function boundsIntersectRect(bounds: NonNullable<ReturnType<typeof shapeScreenBounds>>, rect: { left: number; top: number; right: number; bottom: number }) {
  return bounds.maxX >= rect.left && bounds.minX <= rect.right && bounds.maxY >= rect.top && bounds.minY <= rect.bottom;
}

function rotationAxisVectorForFrame(handleKey: string, frame: SelectionFrame, resolvedAxis?: RotationAxis) {
  const axis = resolvedAxis ?? resolveRotationAxis(handleKey, null, frame);
  if (axis === "x") {
    return frame.xAxis.clone().normalize();
  }
  if (axis === "z") {
    return frame.zAxis.clone().normalize();
  }
  return frame.yAxis.clone().normalize();
}

function rayPointOnRotationPlane(state: ThreeState, clientX: number, clientY: number, pivot: THREE.Vector3, axis: THREE.Vector3) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis.clone().normalize(), pivot);
  return state.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
}

function signedAngleAroundAxis(start: THREE.Vector3, current: THREE.Vector3, axis: THREE.Vector3) {
  const a = start.clone().normalize();
  const b = current.clone().normalize();
  return Math.atan2(axis.clone().normalize().dot(a.clone().cross(b)), clamp(a.dot(b), -1, 1));
}

const ROTATION_HANDLE_SIDE_HYSTERESIS = 0.22;
const ROTATION_HANDLE_DOMINANCE_HYSTERESIS = 0.18;
/** Rotate-cw art ends toward top-right; offset so the tip tracks the motion tangent. */
const ROTATION_HANDLE_ICON_ART_OFFSET = -40;
const ROTATION_FACE_SCREEN_OFFSET = 24;
const ROTATION_TILT_ABOVE_LIFT_OFFSET = 42;

/** Motion tangent around `axis` at `handleWorld`, for aligning curved rotate icons. */
function rotationHandleTangent(axis: THREE.Vector3, pivot: THREE.Vector3, handleWorld: THREE.Vector3, fallback: THREE.Vector3) {
  const axisN = axis.clone().normalize();
  const fromPivot = handleWorld.clone().sub(pivot);
  fromPivot.addScaledVector(axisN, -fromPivot.dot(axisN));
  if (fromPivot.lengthSq() < 0.0001) {
    const fallbackDir = fallback.clone();
    if (fallbackDir.lengthSq() < 0.0001) {
      return new THREE.Vector3(1, 0, 0);
    }
    return fallbackDir.normalize();
  }
  const tangent = axisN.cross(fromPivot);
  if (tangent.lengthSq() < 0.0001) {
    return fallback.clone().normalize();
  }
  return tangent.normalize();
}

/** Keep wheel centers on the camera-facing side and slightly in front of the mesh. */
function wheelCenterTowardCamera(camera: THREE.Camera, pivot: THREE.Vector3, face: THREE.Vector3, nudge: number) {
  const toCamera = camera.position.clone().sub(pivot);
  if (toCamera.lengthSq() < 0.0001) {
    return face.clone();
  }
  toCamera.normalize();
  const offset = face.clone().sub(pivot);
  const nearFace = offset.dot(toCamera) < -0.05 ? pivot.clone().sub(offset) : face.clone();
  return nearFace.add(toCamera.multiplyScalar(nudge));
}

function rotationHandleIconAngle(
  project: (point: THREE.Vector3) => { x: number; y: number },
  origin: THREE.Vector3,
  tangent: THREE.Vector3,
  /** Extra degrees so glyph art lines up with the motion tangent (tilt cw tip vs yaw left/right arc). */
  artOffset = ROTATION_HANDLE_ICON_ART_OFFSET,
) {
  const step = 8;
  const direction = tangent.clone();
  if (direction.lengthSq() < 0.0001) {
    return artOffset;
  }
  direction.normalize().multiplyScalar(step);
  const a = project(origin);
  const b = project(origin.clone().add(direction));
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + artOffset;
}

function signedRotationSide(value: number, previous: RotationHandleSide | undefined, positiveSide: RotationHandleSide, negativeSide: RotationHandleSide) {
  if (previous === positiveSide && value > -ROTATION_HANDLE_SIDE_HYSTERESIS) {
    return previous;
  }
  if (previous === negativeSide && value < ROTATION_HANDLE_SIDE_HYSTERESIS) {
    return previous;
  }
  return value >= 0 ? positiveSide : negativeSide;
}

function rotationSideScore(side: RotationHandleSide, viewX: number, viewZ: number) {
  if (side === "right") {
    return viewX;
  }
  if (side === "left") {
    return -viewX;
  }
  if (side === "near") {
    return viewZ;
  }
  return -viewZ;
}

function dominantRotationSide(viewX: number, viewZ: number, previous: RotationHandleSide | undefined) {
  const sides: RotationHandleSide[] = ["near", "right", "far", "left"];
  const best = sides.reduce(
    (current, side) => {
      const score = rotationSideScore(side, viewX, viewZ);
      return score > current.score ? { side, score } : current;
    },
    { side: "near" as RotationHandleSide, score: Number.NEGATIVE_INFINITY },
  );

  if (previous && rotationSideScore(previous, viewX, viewZ) >= best.score - ROTATION_HANDLE_DOMINANCE_HYSTERESIS) {
    return previous;
  }
  return best.side;
}

function rotationHandleSidesForCamera(state: ThreeState, center: THREE.Vector3) {
  const view = state.camera.position.clone().sub(center);
  view.y = 0;
  const length = view.length();
  if (length < 0.0001) {
    return state.rotationHandleSides ?? { x: "right", y: "near", z: "near" };
  }

  const viewX = view.x / length;
  const viewZ = view.z / length;
  const previous = state.rotationHandleSides ?? undefined;
  const next: RotationHandleSides = {
    x: signedRotationSide(viewX, previous?.x, "right", "left"),
    y: dominantRotationSide(viewX, viewZ, previous?.y),
    z: signedRotationSide(viewZ, previous?.z, "near", "far"),
  };
  state.rotationHandleSides = next;
  return next;
}

function projectedWorldYForScreenY(state: ThreeState, shape: WorkplaneShape, targetScreenY: number, startWorldY: number) {
  let nextWorldY = startWorldY;
  for (let index = 0; index < 8; index += 1) {
    const currentScreenY = projectedScreenY(state, shape, nextWorldY);
    const screenSlope = projectedScreenYPerWorldUnit(state, shape, nextWorldY);
    if (Math.abs(screenSlope) < 0.01) {
      break;
    }
    nextWorldY = clamp(nextWorldY - (currentScreenY - targetScreenY) / screenSlope, MIN_ELEVATION - 80, MAX_ELEVATION + 80);
  }
  return nextWorldY;
}

function patchWithPreservedWorldYEdge(shape: WorkplaneShape, patch: Partial<WorkplaneShape>, edge: "bottom" | "top") {
  const startFrame = selectionFrameForShapes([shape], [shape.id]);
  if (!startFrame) {
    return patch;
  }
  const startBounds = selectionWorldYBounds(startFrame);
  const draftShape = { ...shape, ...patch };
  const draftFrame = selectionFrameForShapes([draftShape], [shape.id]);
  if (!draftFrame) {
    return patch;
  }
  const draftBounds = selectionWorldYBounds(draftFrame);
  const delta = edge === "bottom" ? startBounds.min - draftBounds.min : startBounds.max - draftBounds.max;
  return {
    ...patch,
    elevation: cleanNearZero(clamp((draftShape.elevation ?? 0) + delta, MIN_ELEVATION, MAX_ELEVATION), 0.0005),
  };
}

function patchWithPreservedWorldBottom(shape: WorkplaneShape, patch: Partial<WorkplaneShape>) {
  return patchWithPreservedWorldYEdge(shape, patch, "bottom");
}

function resizeSignsForDimension(signs: ResizeSigns, axis: "width" | "depth") {
  return axis === "width" ? { x: signs.x, z: 0 } : { x: 0, z: signs.z };
}

function patchWithResizeAnchor(
  shape: WorkplaneShape,
  patch: Partial<WorkplaneShape>,
  axis: ShapeInspectorUpdateOptions["resizeAxis"] | DimensionMark["axis"],
  anchor: ResizeAnchorMemory | null,
) {
  // Hole/solid/color/lock/hide toggles must not run through elevation preservation —
  // that path can nudge oriented sketch meshes and make hole mode feel broken.
  const patchKeys = Object.keys(patch);
  if (
    patchKeys.length > 0 &&
    patchKeys.every((key) => key === "hole" || key === "color" || key === "locked" || key === "hidden" || key === "name")
  ) {
    return patch;
  }

  if (axis === "height") {
    return patchWithPreservedWorldYEdge(shape, patch, anchor?.shapeId === shape.id && anchor.pressedY === "bottom" ? "top" : "bottom");
  }

  if (axis !== "width" && axis !== "depth") {
    return patchWithPreservedWorldBottom(shape, patch);
  }
  if (!anchor || anchor.shapeId !== shape.id) {
    return patchWithPreservedWorldBottom(shape, patch);
  }

  const signs = resizeSignsForDimension(anchor.signs, axis);
  if (!signs.x && !signs.z) {
    return patchWithPreservedWorldBottom(shape, patch);
  }

  const frame = selectionFrameForShapes([shape], [shape.id]);
  if (!frame) {
    return patchWithPreservedWorldBottom(shape, patch);
  }

  const width = Math.max(MIN_SHAPE_SIZE, patch.width ?? shapeWidth(shape));
  const depth = Math.max(MIN_SHAPE_SIZE, patch.depth ?? shapeDepth(shape));
  const center = resizeCenterFromAnchor(frame, resizeAnchorPointForFrame(frame, signs), signs, width, depth);
  return patchWithPreservedWorldBottom(shape, {
    ...patch,
    ...resizedShapePatchFromFrame(shape, center, width, depth),
  });
}

function resizeShapeFromFrameHandle(
  transform: TransformDragState,
  point: THREE.Vector3,
  handleKey: string,
  shiftKey: boolean,
  altKey: boolean,
  step: number,
): Partial<WorkplaneShape> {
  const shape = transform.startShape;
  const frame = transform.selectionFrame;
  const width = frame.width;
  const depth = frame.depth;
  const localDelta = transform.scaleStartPoint ? frameLocalDelta(frame, transform.scaleStartPoint, point) : new THREE.Vector3();

  const signs = transform.scaleSigns ?? resizeSignsForHandle(handleKey);
  const maxSize = 220;

  const axisResize = (current: number, delta: number, sign: number) => {
    if (!sign) {
      return current;
    }
    const signedDelta = sign * delta;
    if (altKey) {
      return snapDimension(current + signedDelta * 2, step, MIN_SHAPE_SIZE, maxSize);
    }
    return snapDimension(current + signedDelta, step, MIN_SHAPE_SIZE, maxSize);
  };

  let nextWidth = axisResize(width, localDelta.x, signs.x);
  let nextDepth = axisResize(depth, localDelta.z, signs.z);

  if (shiftKey && signs.x && signs.z) {
    const scale = proportionalResizeScale(width, depth, nextWidth, nextDepth);
    const limitedScale = clamp(scale, MIN_SHAPE_SIZE / Math.max(MIN_SHAPE_SIZE, Math.min(width, depth)), maxSize / Math.max(width, depth));
    nextWidth = snapDimension(width * limitedScale, step, MIN_SHAPE_SIZE, maxSize);
    nextDepth = snapDimension(depth * limitedScale, step, MIN_SHAPE_SIZE, maxSize);
  }

  const nextCenter = altKey
    ? frame.center.clone()
    : resizeCenterFromAnchor(frame, transform.scaleAnchorPoint ?? resizeAnchorPointForFrame(frame, signs), signs, nextWidth, nextDepth);
  return resizedShapePatchFromFrame(shape, nextCenter, nextWidth, nextDepth);
}

function resizeSelectionFromHandle(
  transform: TransformDragState,
  point: THREE.Vector3,
  handleKey: string,
  shiftKey: boolean,
  altKey: boolean,
  step: number,
) {
  const frame = transform.selectionFrame;
  const localDelta = transform.scaleStartPoint ? frameLocalDelta(frame, transform.scaleStartPoint, point) : new THREE.Vector3();
  const signs = transform.scaleSigns ?? resizeSignsForHandle(handleKey);
  const axisResize = (current: number, delta: number, sign: number) => {
    if (!sign) {
      return { size: current, scale: 1 };
    }
    const signedDelta = sign * delta;
    if (altKey) {
      const size = snapDimension(current + signedDelta * 2, step, MIN_SHAPE_SIZE, 260);
      return { size, scale: size / Math.max(MIN_SHAPE_SIZE, current) };
    }
    const rawSize = current + signedDelta;
    const size = snapDimension(rawSize, step, MIN_SHAPE_SIZE, 260);
    return {
      size,
      scale: size / Math.max(MIN_SHAPE_SIZE, current),
    };
  };

  let nextX = axisResize(frame.width, localDelta.x, signs.x);
  let nextZ = axisResize(frame.depth, localDelta.z, signs.z);
  if (shiftKey && signs.x && signs.z) {
    const scale = proportionalResizeScale(frame.width, frame.depth, nextX.size, nextZ.size);
    const limitedScale = clamp(scale, MIN_SHAPE_SIZE / Math.max(MIN_SHAPE_SIZE, Math.min(frame.width, frame.depth)), 260 / Math.max(frame.width, frame.depth));
    const width = snapDimension(frame.width * limitedScale, step, MIN_SHAPE_SIZE, 260);
    const depth = snapDimension(frame.depth * limitedScale, step, MIN_SHAPE_SIZE, 260);
    nextX = {
      size: width,
      scale: width / Math.max(MIN_SHAPE_SIZE, frame.width),
    };
    nextZ = {
      size: depth,
      scale: depth / Math.max(MIN_SHAPE_SIZE, frame.depth),
    };
  }

  const nextCenter = altKey
    ? frame.center.clone()
    : resizeCenterFromAnchor(frame, transform.scaleAnchorPoint ?? resizeAnchorPointForFrame(frame, signs), signs, nextX.size, nextZ.size);

  return transform.items.map((item) => {
    const localCenter = frameLocalPoint(frame, item.startCenter);
    const nextItemCenter = nextCenter
      .clone()
      .add(frame.xAxis.clone().multiplyScalar(localCenter.x * nextX.scale))
      .add(frame.yAxis.clone().multiplyScalar(localCenter.y))
      .add(frame.zAxis.clone().multiplyScalar(localCenter.z * nextZ.scale));
    const width = snapDimension(shapeWidth(item.startShape) * nextX.scale, step, MIN_SHAPE_SIZE, 260);
    const depth = snapDimension(shapeDepth(item.startShape) * nextZ.scale, step, MIN_SHAPE_SIZE, 260);
    const patch = {
      x: nextItemCenter.x,
      z: nextItemCenter.z,
      elevation: cleanNearZero(nextItemCenter.y - item.startShape.height / 2, 0.0005),
      width,
      depth,
      size: resizedShapeSize(width, depth),
    } satisfies Partial<WorkplaneShape>;
    return {
      id: item.id,
      patch,
    };
  });
}

export function WorkplaneViewport({
  shapes,
  selectedIds,
  alignMode,
  alignAnchorId,
  alignHandles,
  alignReferenceShapes,
  mirrorMode,
  mirrorReferenceShapes,
  placementElevation,
  workplaneMode,
  initialSnap,
  initialWorkspace,
  workspaceSettingsKey,
  onAddShape,
  onAlignAnchorChange,
  onAlignPreview,
  onAlignPreviewClear,
  onAlignSelection,
  onMirrorPreview,
  onMirrorPreviewClear,
  onMirrorSelection,
  circularPatternMode = false,
  circularPatternCenter = null,
  circularPatternRadius = 0,
  onCircularPatternPivotPick,
  sketchFacePickMode = false,
  onSketchPlanePicked,
  onSketchFacePickRejected,
  onSketchFacePickCancel,
  onSelectShape,
  onSetPlacementElevation,
  onInteractionActiveChange,
  onEditSketch,
  onEditSketchDimension,
  canSeparateParts = false,
  onSeparateParts,
  activeFeatureId = null,
  onSelectFeature,
  onSuppressFeature,
  onReorderFeature,
  onUpdateFeature,
  onUpdateShape,
  onWorkspaceSettingsChange,
  onWorkplaneModeChange,
  modifierActive = false,
  modifierPreserveSelection = false,
  modifierPreviewActive = false,
  modifierEdges = [],
  selectedModifierEdgeIds = [],
  onModifierEdgeToggle,
  viewNudgeAxesRef,
  rotationEditApiRef,
  onDropToWorkplane,
  onSnapSelection,
  inspectorDock,
  inspectorDockTop,
}: WorkplaneViewportProps) {
  const [snapOpen, setSnapOpen] = useState(false);
  const [snap, setSnap] = useState<GridSize>(() => normalizeSnapGrid(initialSnap, DEFAULT_SNAP_GRID));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hotkeys, setHotkeys] = useState(() => loadHotkeyBindings());
  const [workspace, setWorkspace] = useState<WorkspaceSettings>(() => {
    const normalized = normalizeWorkspaceSettings(initialWorkspace);
    setActiveDisplayQuality(normalized.displayQuality);
    return normalized;
  });
  const [transformOverlay, setTransformOverlay] = useState<TransformOverlayState | null>(null);
  const [alignOverlay, setAlignOverlay] = useState<AlignOverlayState | null>(null);
  const [mirrorOverlay, setMirrorOverlay] = useState<MirrorOverlayState | null>(null);
  const [circularPatternOverlay, setCircularPatternOverlay] = useState<CircularPatternOverlayState | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [hoverMeasureKey, setHoverMeasureKey] = useState<string | null>(null);
  const [pinnedMeasureKey, setPinnedMeasureKey] = useState<string | null>(null);
  const [rotationReadout, setRotationReadout] = useState<RotationReadout>(null);
  const [activeRotationWheel, setActiveRotationWheel] = useState(false);
  const [activeTransformKind, setActiveTransformKind] = useState<TransformHandleKind | null>(null);
  const [rotationWheelAxis, setRotationWheelAxis] = useState<RotationAxis>("y");
  const [pinnedRotationWheelView, setPinnedRotationWheelView] = useState<PinnedRotationWheelView | null>(null);
  const [editingDimension, setEditingDimension] = useState<EditingDimension>(null);
  const [editingRotation, setEditingRotation] = useState<EditingRotation>(null);
  const [rulerMode, setRulerMode] = useState(false);
  const [rulerDeleteMode, setRulerDeleteMode] = useState(false);
  const [rulerMoveMode, setRulerMoveMode] = useState(false);
  const [rulerToolsOpen, setRulerToolsOpen] = useState(false);
  const [xrayEnabled, setXrayEnabled] = useState(false);
  const [xrayHeight, setXrayHeight] = useState(40);
  const [xrayControlsOpen, setXrayControlsOpen] = useState(false);
  const [cameraControlsCollapsed, setCameraControlsCollapsed] = useState(false);
  const [inspectorPanelOpen, setInspectorPanelOpen] = useState(true);
  const [assetDragOver, setAssetDragOver] = useState(false);
  const [rulerModel, setRulerModel] = useState<RulerModel>({ points: [], segments: [], startPointId: null, hover: null });
  const [rulerOverlay, setRulerOverlay] = useState<RulerOverlayState | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const threeRef = useRef<ThreeState | null>(null);
  const shapesRef = useRef(shapes);
  const alignReferenceShapesRef = useRef(alignReferenceShapes);
  const mirrorReferenceShapesRef = useRef(mirrorReferenceShapes);
  const selectedIdsRef = useRef(selectedIds);
  const dragRef = useRef<DragState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const transformRef = useRef<TransformDragState | null>(null);
  const lastResizeAnchorRef = useRef<ResizeAnchorMemory | null>(null);
  const suppressNextLiftEditRef = useRef(false);
  const suppressNextRotationEditRef = useRef(false);
  const rotationReadoutRef = useRef<RotationReadout>(null);
  /** Shape IDs waiting to bake after a mouse rotate while the degree box is open. */
  const pendingRotationBakeIdsRef = useRef<string[]>([]);
  const pendingRotationBeforeByIdRef = useRef<Record<string, WorkplaneShape>>({});
  const bakePendingRotationsRef = useRef<() => void>(() => {});
  const editingRotationRef = useRef<EditingRotation>(null);
  const snapRef = useRef(snap);
  const workspaceRef = useRef(workspace);
  const workspaceSettingsKeyRef = useRef(workspaceSettingsKey ?? null);
  const lastWorkspaceSettingsSyncRef = useRef("");
  const pendingWorkspaceHydrationFingerprintRef = useRef<string | null>(null);
  const viewCubeRef = useRef<HTMLDivElement | null>(null);
  const viewCubeDragRef = useRef<{
    pointerId: number;
    lastX: number;
    lastY: number;
    dragged: boolean;
    face: ViewCubeFace | null;
    capturer: HTMLElement | null;
  } | null>(null);
  const transformOverlayRef = useRef<TransformOverlayState | null>(null);
  const alignOverlayRef = useRef<AlignOverlayState | null>(null);
  const mirrorOverlayRef = useRef<MirrorOverlayState | null>(null);
  const rulerModeRef = useRef(false);
  const rulerDeleteModeRef = useRef(false);
  const rulerMoveModeRef = useRef(false);
  const rulerPointDragRef = useRef<RulerPointDragState | null>(null);
  const rulerModelRef = useRef(rulerModel);
  const rulerOverlayRef = useRef<RulerOverlayState | null>(null);
  const rulerIdRef = useRef(0);
  const alignModeRef = useRef(alignMode);
  const alignAnchorIdRef = useRef(alignAnchorId);
  const alignHandlesRef = useRef(alignHandles);
  const mirrorModeRef = useRef(mirrorMode);
  const circularPatternModeRef = useRef(circularPatternMode);
  const circularPatternCenterRef = useRef(circularPatternCenter);
  const circularPatternRadiusRef = useRef(circularPatternRadius);
  const onCircularPatternPivotPickRef = useRef(onCircularPatternPivotPick);
  const sketchFacePickModeRef = useRef(sketchFacePickMode);
  const onSketchPlanePickedRef = useRef(onSketchPlanePicked);
  const onSketchFacePickRejectedRef = useRef(onSketchFacePickRejected);
  const onSketchFacePickCancelRef = useRef(onSketchFacePickCancel);
  const sketchFaceHoverKeyRef = useRef<string | null>(null);
  const [sketchFaceHovering, setSketchFaceHovering] = useState(false);
  const [sketchFaceHoverBlocked, setSketchFaceHoverBlocked] = useState(false);
  const circularPatternOverlayRef = useRef<CircularPatternOverlayState | null>(null);
  const modifierActiveRef = useRef(modifierActive);
  const modifierPreserveSelectionRef = useRef(modifierPreserveSelection);
  const modifierPreviewActiveRef = useRef(modifierPreviewActive);
  const modifierEdgesRef = useRef(modifierEdges);
  const [hoverModifierEdgeId, setHoverModifierEdgeId] = useState<number | null>(null);
  const selectedIdsKeyRef = useRef(selectedIds.join("|"));
  const perfRef = useRef({
    fps: 0,
    frameMs: 0,
    maxFrameMs: 0,
    frames: 0,
    lastSample: 0,
  });

  // During circular pattern, viewport `shapes` are preview instances. Prefer the
  // document shapes so Properties edits resize the real source (preview rebuilds from that).
  const selectedShape = useMemo(() => {
    if (selectedIds.length !== 1) return null;
    const id = selectedIds[0];
    if (circularPatternMode) {
      const documentShape = alignReferenceShapes.find((shape) => shape.id === id);
      if (documentShape) return documentShape;
    }
    return shapes.find((shape) => shape.id === id) ?? null;
  }, [alignReferenceShapes, circularPatternMode, selectedIds, shapes]);
  const renderSelectionIds = useCallback(
    (ids = selectedIdsRef.current) => (
      modifierActiveRef.current && !modifierPreviewActiveRef.current && !modifierPreserveSelectionRef.current
        ? []
        : ids
    ),
    [],
  );

  const cancelActiveInteraction = useCallback(
    (selectionIds = selectedIdsRef.current) => {
      const hadInteraction = Boolean(transformRef.current || dragRef.current || marqueeRef.current);
      transformRef.current = null;
      dragRef.current = null;
      marqueeRef.current = null;
      rulerPointDragRef.current = null;
      setMarqueeRect(null);
      setActiveTransformKind(null);
      setActiveRotationWheel(false);
      setPinnedRotationWheelView(null);
      setRotationReadout(null);
      const state = threeRef.current;
      if (state) {
        rebuildShapes(state, shapesRef.current, renderSelectionIds(selectionIds));
        setSelectionHelpersVisible(state, true);
        state.controls.enabled = true;
        state.needsRender = true;
      }
      if (hadInteraction) {
        onInteractionActiveChange?.(false);
      }
    },
    [onInteractionActiveChange, renderSelectionIds],
  );

  useEffect(() => {
    modifierEdgesRef.current = modifierEdges;
    rebuildModifierEdges(threeRef.current, modifierEdges, selectedModifierEdgeIds, modifierPreviewActive, hoverModifierEdgeId);
  }, [hoverModifierEdgeId, modifierEdges, modifierPreviewActive, selectedModifierEdgeIds]);

  const placementElevationRef = useRef(placementElevation);
  const workplaneModeRef = useRef(workplaneMode);

  const rememberResizeAnchor = useCallback((shapeId: string, kind: TransformHandleKind, handleKey: string) => {
    if (kind === "scale") {
      const signs = resizeSignsForHandle(handleKey);
      if (signs.x || signs.z) {
        lastResizeAnchorRef.current = { shapeId, handleKey, signs, pressedY: null };
      }
      return;
    }
    if (kind === "height") {
      lastResizeAnchorRef.current = {
        shapeId,
        handleKey,
        signs: { x: 0, z: 0 },
        pressedY: handleKey === "bottom-height" ? "bottom" : "top",
      };
    }
  }, []);

  const applyWorkspaceSettings = useCallback((nextWorkspace: WorkplaneWorkspaceSettings, nextSnap = snapRef.current) => {
    const normalizedWorkspace = normalizeWorkspaceSettings(nextWorkspace);
    const normalizedSnap = normalizeSnapGrid(nextSnap, DEFAULT_SNAP_GRID);
    const fingerprint = workplaneSettingsFingerprint(normalizedWorkspace, normalizedSnap);
    const qualityChanged = workspaceRef.current.displayQuality !== normalizedWorkspace.displayQuality;
    pendingWorkspaceHydrationFingerprintRef.current = null;
    lastWorkspaceSettingsSyncRef.current = fingerprint;
    snapRef.current = normalizedSnap;
    workspaceRef.current = normalizedWorkspace;
    setActiveDisplayQuality(normalizedWorkspace.displayQuality);
    if (threeRef.current) {
      rebuildWorkplane(threeRef.current, normalizedWorkspace);
      if (qualityChanged) {
        rebuildShapes(threeRef.current, shapesRef.current, renderSelectionIds(), !transformRef.current && !dragRef.current);
      }
      constrainCamera(threeRef.current, normalizedWorkspace);
      threeRef.current.needsRender = true;
    }
    setSnap((current) => (current === normalizedSnap ? current : normalizedSnap));
    setWorkspace((current) => (
      workplaneSettingsFingerprint(current, normalizedSnap) === fingerprint ? current : normalizedWorkspace
    ));
    onWorkspaceSettingsChange?.({ workspace: normalizedWorkspace, snap: normalizedSnap });
  }, [onWorkspaceSettingsChange]);

  useLayoutEffect(() => {
    const nextKey = workspaceSettingsKey ?? null;
    const keyChanged = workspaceSettingsKeyRef.current !== nextKey;
    if (keyChanged) {
      workspaceSettingsKeyRef.current = nextKey;
      lastWorkspaceSettingsSyncRef.current = "";
    }
    const shouldUseSavedDefault = nextKey === "local-workplane" || (initialSnap === undefined && initialWorkspace === undefined);
    const savedDefault = shouldUseSavedDefault ? readSavedWorkspaceDefault(nextKey) : null;
    const nextSnap = savedDefault?.snap ?? normalizeSnapGrid(initialSnap, DEFAULT_SNAP_GRID);
    const nextWorkspace = savedDefault?.workspace ?? normalizeWorkspaceSettings(initialWorkspace);
    const nextFingerprint = workplaneSettingsFingerprint(nextWorkspace, nextSnap);
    const currentFingerprint = workplaneSettingsFingerprint(workspaceRef.current, snapRef.current);
    // Ignore unchanged prop echoes. Also ignore stale parent props while local
    // settings are ahead (dimension edits used to get wiped on the next parent render).
    if (nextFingerprint === currentFingerprint) {
      lastWorkspaceSettingsSyncRef.current = nextFingerprint;
      pendingWorkspaceHydrationFingerprintRef.current = null;
      return;
    }
    if (!keyChanged && lastWorkspaceSettingsSyncRef.current === currentFingerprint) {
      return;
    }
    // Prop hydration must not echo back to the parent. Parent persistence creates
    // new object references even when the values are unchanged, which previously
    // caused this effect and its callback effect to update each other indefinitely.
    lastWorkspaceSettingsSyncRef.current = nextFingerprint;
    pendingWorkspaceHydrationFingerprintRef.current = nextFingerprint;
    snapRef.current = nextSnap;
    workspaceRef.current = nextWorkspace;
    setActiveDisplayQuality(nextWorkspace.displayQuality);
    if (threeRef.current) {
      rebuildWorkplane(threeRef.current, nextWorkspace);
      rebuildShapes(threeRef.current, shapesRef.current, renderSelectionIds(), !transformRef.current && !dragRef.current);
      constrainCamera(threeRef.current, nextWorkspace);
      threeRef.current.needsRender = true;
    }
    setSnap((current) => (current === nextSnap ? current : nextSnap));
    setWorkspace((current) => (
      workplaneSettingsFingerprint(current, nextSnap) === nextFingerprint ? current : nextWorkspace
    ));
  }, [initialSnap, initialWorkspace, workspaceSettingsKey]);

  useEffect(() => {
    const normalizedWorkspace = normalizeWorkspaceSettings(workspace);
    const normalizedSnap = normalizeSnapGrid(snap, DEFAULT_SNAP_GRID);
    const fingerprint = workplaneSettingsFingerprint(normalizedWorkspace, normalizedSnap);
    const hydrationDecision = workspaceHydrationSyncDecision(pendingWorkspaceHydrationFingerprintRef.current, fingerprint);
    pendingWorkspaceHydrationFingerprintRef.current = hydrationDecision.pendingFingerprint;
    if (!hydrationDecision.shouldSync) {
      return;
    }
    if (lastWorkspaceSettingsSyncRef.current === fingerprint) {
      return;
    }
    lastWorkspaceSettingsSyncRef.current = fingerprint;
    onWorkspaceSettingsChange?.({ workspace: normalizedWorkspace, snap: normalizedSnap });
  }, [onWorkspaceSettingsChange, snap, workspace]);

  const makeWorkspaceDefault = useCallback(() => {
    const normalizedWorkspace = normalizeWorkspaceSettings(workspace);
    const normalizedSnap = normalizeSnapGrid(snap, DEFAULT_SNAP_GRID);
    const key = workspaceSettingsKeyRef.current;
    if (key) {
      try {
        window.localStorage.setItem(
          `${WORKSPACE_DEFAULTS_STORAGE_PREFIX}${key}`,
          JSON.stringify({ workspace: normalizedWorkspace, snap: normalizedSnap }),
        );
      } catch {
        // Project persistence below is still attempted if browser storage is unavailable.
      }
    }
    saveGlobalWorkspaceDefaults(normalizedWorkspace, normalizedSnap);
    applyWorkspaceSettings(normalizedWorkspace, normalizedSnap);
  }, [applyWorkspaceSettings, snap, workspace]);

  useEffect(() => {
    const openWorkspaceSettings = () => setSettingsOpen(true);
    window.addEventListener("sketchforge:open-workspace-settings", openWorkspaceSettings);
    return () => window.removeEventListener("sketchforge:open-workspace-settings", openWorkspaceSettings);
  }, []);

  useEffect(() => {
    const refreshHotkeys = () => setHotkeys(loadHotkeyBindings());
    window.addEventListener(HOTKEYS_CHANGED_EVENT, refreshHotkeys);
    return () => window.removeEventListener(HOTKEYS_CHANGED_EVENT, refreshHotkeys);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const stored = window.localStorage.getItem("peakcad:shape-inspector-open");
      if (stored === "0") {
        setInspectorPanelOpen(false);
      }
    } catch {
      // Ignore storage read failures.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem("peakcad:shape-inspector-open", inspectorPanelOpen ? "1" : "0");
    } catch {
      // Ignore storage write failures.
    }
  }, [inspectorPanelOpen]);

  useEffect(() => {
    shapesRef.current = shapes;
    rebuildShapes(threeRef.current, shapes, renderSelectionIds(), !transformRef.current && !dragRef.current);
    refreshDragPreviewObjects(threeRef.current, dragRef.current);
    if (threeRef.current) {
      syncTransformOverlay(
        threeRef.current,
        previewShapesForDrag(shapes, dragRef.current),
        selectedIdsRef.current,
        transformOverlayRef,
        setTransformOverlay,
        workspaceRef.current.accuracy,
        Boolean(transformRef.current || dragRef.current),
      );
      syncAlignOverlay(threeRef.current, alignReferenceShapesRef.current, selectedIdsRef.current, alignModeRef.current, alignAnchorIdRef.current, alignHandlesRef.current, alignOverlayRef, setAlignOverlay);
      syncMirrorOverlay(threeRef.current, mirrorReferenceShapesRef.current, selectedIdsRef.current, mirrorModeRef.current, mirrorOverlayRef, setMirrorOverlay);
      threeRef.current.needsRender = true;
    }
  }, [shapes]);

  // Orange wireframe around the active CSG child (Alt-click / Features list).
  useEffect(() => {
    const state = threeRef.current;
    if (!state) return;
    const existing = state.helperLayer.getObjectByName("csg-feature-highlight");
    if (existing) {
      state.helperLayer.remove(existing);
      existing.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          const material = obj.material;
          if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
          else material.dispose();
        }
      });
    }
    if (!activeFeatureId) {
      state.needsRender = true;
      return;
    }
    const body = shapesRef.current.find((shape) =>
      shape.groupedShapes?.some((child) => child.id === activeFeatureId) || shape.id === activeFeatureId,
    );
    const feature = body?.groupedShapes?.find((child) => child.id === activeFeatureId);
    if (!body || !feature) {
      state.needsRender = true;
      return;
    }
    const width = Math.max(MIN_SHAPE_SIZE, shapeWidth(feature));
    const depth = Math.max(MIN_SHAPE_SIZE, shapeDepth(feature));
    const height = Math.max(MIN_SHAPE_SIZE, feature.height);
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const edges = new THREE.EdgesGeometry(geometry);
    geometry.dispose();
    const material = new THREE.LineBasicMaterial({ color: 0xc45c26, transparent: true, opacity: 0.95 });
    const lines = new THREE.LineSegments(edges, material);
    lines.position.set(feature.x, (feature.elevation ?? 0) + height / 2, feature.z);
    lines.rotation.set(
      THREE.MathUtils.degToRad(feature.rotationX ?? 0),
      THREE.MathUtils.degToRad(feature.rotation ?? 0),
      THREE.MathUtils.degToRad(feature.rotationZ ?? 0),
      "XYZ",
    );
    const group = new THREE.Group();
    group.name = "csg-feature-highlight";
    group.position.set(body.x, body.elevation ?? 0, body.z);
    group.rotation.set(
      THREE.MathUtils.degToRad(body.rotationX ?? 0),
      THREE.MathUtils.degToRad(body.rotation ?? 0),
      THREE.MathUtils.degToRad(body.rotationZ ?? 0),
      "XYZ",
    );
    group.add(lines);
    state.helperLayer.add(group);
    state.needsRender = true;
    return () => {
      const current = state.helperLayer.getObjectByName("csg-feature-highlight");
      if (!current) return;
      state.helperLayer.remove(current);
      current.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
          obj.geometry.dispose();
          const materialEntry = obj.material;
          if (Array.isArray(materialEntry)) materialEntry.forEach((entry) => entry.dispose());
          else materialEntry.dispose();
        }
      });
      state.needsRender = true;
    };
  }, [activeFeatureId, shapes]);

  useEffect(() => {
    alignReferenceShapesRef.current = alignReferenceShapes;
    if (threeRef.current) {
      syncAlignOverlay(threeRef.current, alignReferenceShapes, selectedIdsRef.current, alignModeRef.current, alignAnchorIdRef.current, alignHandlesRef.current, alignOverlayRef, setAlignOverlay);
      threeRef.current.needsRender = true;
    }
  }, [alignReferenceShapes]);

  useEffect(() => {
    mirrorReferenceShapesRef.current = mirrorReferenceShapes;
    if (threeRef.current) {
      syncMirrorOverlay(threeRef.current, mirrorReferenceShapes, selectedIdsRef.current, mirrorModeRef.current, mirrorOverlayRef, setMirrorOverlay);
      threeRef.current.needsRender = true;
    }
  }, [mirrorReferenceShapes]);

  useEffect(() => {
    rotationReadoutRef.current = rotationReadout;
  }, [rotationReadout]);

  useEffect(() => {
    editingRotationRef.current = editingRotation;
  }, [editingRotation]);

  useEffect(() => {
    const nextSelectedIdsKey = selectedIds.join("|");
    if (nextSelectedIdsKey !== selectedIdsKeyRef.current) {
      selectedIdsKeyRef.current = nextSelectedIdsKey;
      lastResizeAnchorRef.current = null;
      setHoverMeasureKey(null);
      setPinnedMeasureKey(null);
      setEditingDimension(null);
      // Bake any deferred post-drag rotation before the degree box goes away with selection.
      bakePendingRotationsRef.current();
      setEditingRotation(null);
      setRotationReadout(null);
      setActiveRotationWheel(false);
      setActiveTransformKind(null);
    }
    if (selectedIds.length === 0 && (transformRef.current || dragRef.current || marqueeRef.current)) {
      cancelActiveInteraction([]);
    }
    selectedIdsRef.current = selectedIds;
    rebuildShapes(threeRef.current, shapesRef.current, renderSelectionIds(selectedIds), !transformRef.current && !dragRef.current);
    refreshDragPreviewObjects(threeRef.current, dragRef.current);
    if (threeRef.current) {
      syncTransformOverlay(
        threeRef.current,
        previewShapesForDrag(shapesRef.current, dragRef.current),
        selectedIds,
        transformOverlayRef,
        setTransformOverlay,
        workspaceRef.current.accuracy,
        Boolean(transformRef.current || dragRef.current),
      );
      syncAlignOverlay(threeRef.current, alignReferenceShapesRef.current, selectedIds, alignModeRef.current, alignAnchorIdRef.current, alignHandlesRef.current, alignOverlayRef, setAlignOverlay);
      syncMirrorOverlay(threeRef.current, mirrorReferenceShapesRef.current, selectedIds, mirrorModeRef.current, mirrorOverlayRef, setMirrorOverlay);
      threeRef.current.needsRender = true;
    }
  }, [cancelActiveInteraction, selectedIds]);

  useEffect(() => {
    modifierActiveRef.current = modifierActive;
    modifierPreserveSelectionRef.current = modifierPreserveSelection;
    if (modifierActive) cancelActiveInteraction();
    if (!modifierActive) setHoverModifierEdgeId(null);
    rebuildShapes(threeRef.current, shapesRef.current, renderSelectionIds(), !transformRef.current && !dragRef.current);
    if (threeRef.current) threeRef.current.needsRender = true;
  }, [cancelActiveInteraction, modifierActive, modifierPreserveSelection, renderSelectionIds]);

  useEffect(() => {
    modifierPreviewActiveRef.current = modifierPreviewActive;
    rebuildShapes(threeRef.current, shapesRef.current, renderSelectionIds(), !transformRef.current && !dragRef.current);
    if (threeRef.current) threeRef.current.needsRender = true;
  }, [modifierPreviewActive, renderSelectionIds]);

  useEffect(() => {
    if (hoverModifierEdgeId !== null && !modifierEdges.some((edge) => edge.id === hoverModifierEdgeId)) {
      setHoverModifierEdgeId(null);
    }
  }, [hoverModifierEdgeId, modifierEdges]);

  useEffect(() => {
    alignModeRef.current = alignMode;
    alignAnchorIdRef.current = alignAnchorId;
    alignHandlesRef.current = alignHandles;
    if (alignMode) cancelActiveInteraction();
    if (threeRef.current) {
      syncAlignOverlay(threeRef.current, alignReferenceShapesRef.current, selectedIdsRef.current, alignMode, alignAnchorId, alignHandles, alignOverlayRef, setAlignOverlay);
      threeRef.current.needsRender = true;
    }
  }, [alignAnchorId, alignHandles, alignMode, cancelActiveInteraction]);

  useEffect(() => {
    mirrorModeRef.current = mirrorMode;
    if (mirrorMode) cancelActiveInteraction();
    if (threeRef.current) {
      syncMirrorOverlay(threeRef.current, mirrorReferenceShapesRef.current, selectedIdsRef.current, mirrorMode, mirrorOverlayRef, setMirrorOverlay);
      threeRef.current.needsRender = true;
    }
  }, [cancelActiveInteraction, mirrorMode]);

  const wasCircularPatternModeRef = useRef(false);
  useEffect(() => {
    circularPatternModeRef.current = circularPatternMode;
    onCircularPatternPivotPickRef.current = onCircularPatternPivotPick;
    // Cancel only on enter — preview/radius rebuilds must not kill Properties or gizmos.
    if (circularPatternMode && !wasCircularPatternModeRef.current) {
      cancelActiveInteraction();
    }
    wasCircularPatternModeRef.current = circularPatternMode;
  }, [cancelActiveInteraction, circularPatternMode, onCircularPatternPivotPick]);

  useEffect(() => {
    circularPatternCenterRef.current = circularPatternCenter;
    circularPatternRadiusRef.current = circularPatternRadius;
    if (threeRef.current) {
      syncCircularPatternOverlay(
        threeRef.current,
        circularPatternMode,
        circularPatternCenter,
        circularPatternRadius,
        circularPatternOverlayRef,
        setCircularPatternOverlay,
      );
      threeRef.current.needsRender = true;
    }
  }, [circularPatternCenter, circularPatternMode, circularPatternRadius]);

  useEffect(() => {
    sketchFacePickModeRef.current = sketchFacePickMode;
    onSketchPlanePickedRef.current = onSketchPlanePicked;
    onSketchFacePickRejectedRef.current = onSketchFacePickRejected;
    onSketchFacePickCancelRef.current = onSketchFacePickCancel;
    if (sketchFacePickMode) {
      cancelActiveInteraction();
      return;
    }
    sketchFaceHoverKeyRef.current = null;
    setSketchFaceHovering(false);
    setSketchFaceHoverBlocked(false);
    clearSketchFaceHighlight(threeRef.current);
  }, [cancelActiveInteraction, onSketchFacePickCancel, onSketchFacePickRejected, onSketchPlanePicked, sketchFacePickMode]);

  useEffect(() => {
    snapRef.current = snap;
  }, [snap]);

  useEffect(() => {
    rulerModeRef.current = rulerMode;
    if (rulerMode) cancelActiveInteraction();
  }, [cancelActiveInteraction, rulerMode]);

  useEffect(() => {
    rulerDeleteModeRef.current = rulerDeleteMode;
  }, [rulerDeleteMode]);

  useEffect(() => {
    rulerMoveModeRef.current = rulerMoveMode;
  }, [rulerMoveMode]);

  useEffect(() => {
    rulerModelRef.current = rulerModel;
    if (threeRef.current) {
      syncRulerOverlay(threeRef.current, rulerModel, rulerOverlayRef, setRulerOverlay, workspaceRef.current.accuracy);
      threeRef.current.needsRender = true;
    }
  }, [rulerModel]);

  useEffect(() => {
    placementElevationRef.current = placementElevation;
  }, [placementElevation]);

  useEffect(() => {
    workplaneModeRef.current = workplaneMode;
  }, [workplaneMode]);

  useEffect(() => {
    workspaceRef.current = workspace;
    rebuildWorkplane(threeRef.current, workspace);
    if (threeRef.current) {
      syncTransformOverlay(
        threeRef.current,
        shapesRef.current,
        selectedIdsRef.current,
        transformOverlayRef,
        setTransformOverlay,
        workspace.accuracy,
        Boolean(transformRef.current || dragRef.current),
      );
      syncRulerOverlay(threeRef.current, rulerModelRef.current, rulerOverlayRef, setRulerOverlay, workspace.accuracy);
      threeRef.current.needsRender = true;
    }
  }, [workspace]);

  useEffect(() => {
    const onThemeChange = () => {
      rebuildWorkplane(threeRef.current, workspaceRef.current);
      if (threeRef.current) threeRef.current.needsRender = true;
    };
    window.addEventListener(UI_THEME_CHANGED_EVENT, onThemeChange);
    return () => window.removeEventListener(UI_THEME_CHANGED_EVENT, onThemeChange);
  }, []);

  useEffect(() => {
    setSelectionHelpersVisible(threeRef.current, activeTransformKind !== "rotate");
  }, [activeTransformKind]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const state = createThreeScene(host);
    threeRef.current = state;
    rebuildWorkplane(state, workspaceRef.current);
    window.sketchforgeCaptureCanvas = (options) => captureSceneImage(state, options);
    window.sketchforgeCaptureProjectThumbnails = (options) => {
      try {
        return captureSceneImagesForThemes(state, workspaceRef.current.background, options);
      } catch {
        return null;
      }
    };
    window.sketchforgeCaptureView = (face = "current") => {
      if (face === "home") {
        resetCamera(state);
      } else if (face !== "current") {
        setCameraToViewFace(state, face);
      }
      syncViewCube(state, viewCubeRef.current);
      return captureSceneImage(state);
    };
    perfRef.current.lastSample = performance.now();
    resetCamera(state);
    if (viewNudgeAxesRef) {
      viewNudgeAxesRef.current = computeViewNudgeAxes(state.camera);
    }
    rebuildShapes(state, shapesRef.current, renderSelectionIds());

    const animate = () => {
      state.animationId = window.requestAnimationFrame(animate);
      const now = performance.now();
      const controlsChanged = state.controls.update();
      const cameraSettled = state.wasCameraMoving && !controlsChanged;
      if (!controlsChanged && !state.needsRender && !cameraSettled) {
        return;
      }
      constrainCamera(state, workspaceRef.current);
      // Future edits: keep this before any view cube or transform-overlay projection.
      // OrbitControls changes camera position/quaternion, but manual Vector3.project()
      // can read the previous matrix unless we force the matrix world current here.
      // Removing this brings back the one-frame-late handle/line lag during camera motion.
      state.camera.updateMatrixWorld();
      if (viewNudgeAxesRef) {
        viewNudgeAxesRef.current = computeViewNudgeAxes(state.camera);
      }
      if (now - state.lastViewCubeSync > 48 || cameraSettled || state.needsRender) {
        syncViewCube(state, viewCubeRef.current);
        state.lastViewCubeSync = now;
      }
      if (controlsChanged || cameraSettled || state.needsRender || now - state.lastOverlaySync > 96) {
        const previewShapes = previewShapesForDrag(shapesRef.current, dragRef.current);
        syncTransformOverlay(
          state,
          previewShapes,
          selectedIdsRef.current,
          transformOverlayRef,
          setTransformOverlay,
          workspaceRef.current.accuracy,
          Boolean(transformRef.current || dragRef.current),
        );
        syncAlignOverlay(state, alignReferenceShapesRef.current, selectedIdsRef.current, alignModeRef.current, alignAnchorIdRef.current, alignHandlesRef.current, alignOverlayRef, setAlignOverlay);
        syncMirrorOverlay(state, mirrorReferenceShapesRef.current, selectedIdsRef.current, mirrorModeRef.current, mirrorOverlayRef, setMirrorOverlay);
        syncCircularPatternOverlay(
          state,
          circularPatternModeRef.current,
          circularPatternCenterRef.current,
          circularPatternRadiusRef.current,
          circularPatternOverlayRef,
          setCircularPatternOverlay,
        );
        syncRulerOverlay(state, rulerModelRef.current, rulerOverlayRef, setRulerOverlay, workspaceRef.current.accuracy);
        state.lastOverlaySync = now;
      }
      const renderStart = performance.now();
      state.renderer.render(state.scene, state.camera);
      const frameMs = performance.now() - renderStart;
      const perf = perfRef.current;
      perf.frameMs = frameMs;
      perf.maxFrameMs = Math.max(perf.maxFrameMs, frameMs);
      perf.frames += 1;
      if (now - perf.lastSample >= 1000) {
        perf.fps = (perf.frames * 1000) / Math.max(1, now - perf.lastSample);
        perf.frames = 0;
        perf.lastSample = now;
        perf.maxFrameMs = frameMs;
      }
      state.wasCameraMoving = controlsChanged;
      state.needsRender = false;
    };

    animate();
    state.resize();
    const resizeObserver = new ResizeObserver(() => {
      state.resize();
    });
    resizeObserver.observe(host);
    window.addEventListener("resize", state.resize);

    return () => {
      transformRef.current = null;
      dragRef.current = null;
      marqueeRef.current = null;
      rulerPointDragRef.current = null;
      window.cancelAnimationFrame(state.animationId);
      // The cut-preview debounce is module scoped, so a pending one would fire after teardown and
      // rebuild overlays against a scene whose geometries and renderer are already disposed.
      cancelScheduledCutPreviewOverlays();
      resizeObserver.disconnect();
      window.removeEventListener("resize", state.resize);
      state.disposeInteractionListeners();
      state.controls.dispose();
      disposeChildren(state.workplaneLayer);
      disposeChildren(state.shapeLayer);
      disposeChildren(state.helperLayer);
      disposeChildren(state.modifierLayer);
      disposeChildren(state.xrayLayer);
      state.renderer.dispose();
      host.replaceChildren();
      if (window.sketchforgeCaptureCanvas) {
        delete window.sketchforgeCaptureCanvas;
      }
      if (window.sketchforgeCaptureProjectThumbnails) {
        delete window.sketchforgeCaptureProjectThumbnails;
      }
      if (window.sketchforgeCaptureView) {
        delete window.sketchforgeCaptureView;
      }
      threeRef.current = null;
    };
  }, []);

  useEffect(() => {
    window.sketchforgePerf = {
      get: () => {
        const state = threeRef.current;
        const info = state?.renderer.info.render;
        return {
          fps: Number(perfRef.current.fps.toFixed(1)),
          frameMs: Number(perfRef.current.frameMs.toFixed(2)),
          maxFrameMs: Number(perfRef.current.maxFrameMs.toFixed(2)),
          drawCalls: info?.calls ?? 0,
          triangles: info?.triangles ?? 0,
          points: info?.points ?? 0,
          lines: info?.lines ?? 0,
          shapeCount: shapesRef.current.filter((shape) => !shape.hidden).length,
        };
      },
    };
    return () => {
      delete window.sketchforgePerf;
    };
  }, []);

  const toRawPlanePoint = useCallback((clientX: number, clientY: number, plane: THREE.Plane) => {
    const state = threeRef.current;
    if (!state) {
      return null;
    }

    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);

    const hit = new THREE.Vector3();
    if (!state.raycaster.ray.intersectPlane(plane, hit)) {
      return null;
    }

    return hit;
  }, []);

  const toPlanePointAtY = useCallback((clientX: number, clientY: number, planeY = 0) => {
    const state = threeRef.current;
    const hit = toRawPlanePoint(clientX, clientY, planeY === 0 ? state?.dragPlane ?? new THREE.Plane(new THREE.Vector3(0, 1, 0), 0) : new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY));
    if (!state || !hit) {
      return null;
    }

    const step = snapStep(snapRef.current);
    const bounds = workspaceRef.current;
    return {
      x: clamp(snapValue(hit.x, step), -bounds.width / 2 + 6, bounds.width / 2 - 6),
      z: clamp(snapValue(hit.z, step), -bounds.depth / 2 + 6, bounds.depth / 2 - 6),
    };
  }, [toRawPlanePoint]);
  const toPlanePoint = useCallback((clientX: number, clientY: number) => toPlanePointAtY(clientX, clientY, 0), [toPlanePointAtY]);

  const storeRulerModel = useCallback((next: RulerModel) => {
    rulerModelRef.current = next;
    setRulerModel(next);
  }, []);

  useEffect(() => {
    const current = rulerModelRef.current;
    const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
    const shapeIds = new Set(shapeById.keys());
    const state = threeRef.current;
    const removedPointIds = new Set<string>();
    let metadataChanged = false;
    const updatedPoints = current.points.map((point) => {
      if (!point.attachment) return point;
      const attachedShape = shapeById.get(point.attachment.shapeId);
      if (!attachedShape || (state && !attachedShape.hidden && !rulerAttachmentMatchesTopology(state, point.attachment))) {
        removedPointIds.add(point.id);
        return point;
      }
      const object = state ? findShapeObject(state, point.attachment.shapeId) : null;
      const topologyKey = object?.userData.rulerTopologyKey as string | undefined;
      if (topologyKey && topologyKey !== point.attachment.topologyKey) {
        metadataChanged = true;
        return { ...point, attachment: { ...point.attachment, topologyKey } };
      }
      return point;
    });
    const invalidEdgeSegments = new Set<string>();
    const updatedSegments = current.segments.map((segment) => {
      if (!segment.edge) return segment;
      const attachedShape = shapeById.get(segment.edge.shapeId);
      if (!attachedShape || (state && !attachedShape.hidden && !rulerEdgeMatchesTopology(state, segment.edge))) {
        invalidEdgeSegments.add(segment.id);
        return segment;
      }
      const object = state ? findShapeObject(state, segment.edge.shapeId) : null;
      const topologyKey = object?.userData.rulerTopologyKey as string | undefined;
      if (topologyKey && topologyKey !== segment.edge.topologyKey) {
        metadataChanged = true;
        return { ...segment, edge: { ...segment.edge, topologyKey } };
      }
      return segment;
    });
    const provisionalSegments = updatedSegments.filter((segment) => (
      !removedPointIds.has(segment.startId)
      && !removedPointIds.has(segment.endId)
      && !invalidEdgeSegments.has(segment.id)
    ));
    current.segments.filter((segment) => invalidEdgeSegments.has(segment.id)).forEach((segment) => {
      [segment.startId, segment.endId].forEach((pointId) => {
        if (!provisionalSegments.some((candidate) => candidate.startId === pointId || candidate.endId === pointId)) removedPointIds.add(pointId);
      });
    });
    const segments = provisionalSegments.filter((segment) => !removedPointIds.has(segment.startId) && !removedPointIds.has(segment.endId));
    const points = updatedPoints.filter((point) => !removedPointIds.has(point.id));
    const hoverRemoved = Boolean(current.hover?.attachment && (
      !shapeIds.has(current.hover.attachment.shapeId)
      || (state && !shapeById.get(current.hover.attachment.shapeId)?.hidden && !rulerAttachmentMatchesTopology(state, current.hover.attachment))
    ));
    if (removedPointIds.size === 0 && invalidEdgeSegments.size === 0 && !hoverRemoved && !metadataChanged) return;
    if (rulerPointDragRef.current && removedPointIds.has(rulerPointDragRef.current.pointId)) rulerPointDragRef.current = null;
    storeRulerModel({
      points,
      segments,
      startPointId: current.startPointId && !removedPointIds.has(current.startPointId) ? current.startPointId : null,
      hover: hoverRemoved ? null : current.hover,
    });
  }, [shapes, storeRulerModel]);

  const setRulerActive = useCallback((active: boolean) => {
    rulerModeRef.current = active;
    setRulerMode(active);
    if (!active) {
      const current = rulerModelRef.current;
      storeRulerModel({ ...current, startPointId: null, hover: null });
    }
  }, [storeRulerModel]);

  const resolveRulerCandidate = useCallback(
    (clientX: number, clientY: number, ignoredPointId?: string): RulerCandidate | null => {
      const state = threeRef.current;
      if (!state) return null;

      const model = rulerModelRef.current;
      const rect = state.renderer.domElement.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const closestPoint = model.points.reduce<{ point: RulerPoint; distance: number } | null>((closest, point) => {
        if (point.id === ignoredPointId) return closest;
        const screen = projectToScreen(rulerPointWorld(state, point), state);
        const distance = Math.hypot(screen.x - localX, screen.y - localY);
        if (distance <= 12 && (!closest || distance < closest.distance)) {
          return { point, distance };
        }
        return closest;
      }, null);
      if (closestPoint) {
        const world = rulerPointWorld(state, closestPoint.point);
        return { x: world.x, y: world.y, z: world.z, pointId: closestPoint.point.id, attachment: closestPoint.point.attachment };
      }

      const closestSegment = model.segments.reduce<{ world: THREE.Vector3; distance: number } | null>((closest, segment) => {
        if (segment.startId === ignoredPointId || segment.endId === ignoredPointId) return closest;
        const start = model.points.find((point) => point.id === segment.startId);
        const end = model.points.find((point) => point.id === segment.endId);
        if (!start || !end) return closest;
        const edgePoints = segment.edge ? rulerEdgeWorldPoints(state, segment.edge) : [];
        const worldPoints = edgePoints.length >= 2 ? edgePoints : [rulerPointWorld(state, start), rulerPointWorld(state, end)];
        for (let index = 0; index + 1 < worldPoints.length; index += 1) {
          const a = projectToScreen(worldPoints[index], state);
          const b = projectToScreen(worldPoints[index + 1], state);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const amount = dx * dx + dy * dy > 0.001 ? clamp(((localX - a.x) * dx + (localY - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
          const distance = Math.hypot(localX - (a.x + dx * amount), localY - (a.y + dy * amount));
          if (distance <= 10 && (!closest || distance < closest.distance)) {
            closest = { world: worldPoints[index].clone().lerp(worldPoints[index + 1], amount), distance };
          }
        }
        return closest;
      }, null);

      if (closestSegment) {
        const existing = model.points.find((point) => rulerPointWorld(state, point).distanceTo(closestSegment.world) < 0.001);
        return { x: closestSegment.world.x, y: closestSegment.world.y, z: closestSegment.world.z, pointId: existing?.id };
      }

      const selectedShapeIds = selectedIdsRef.current.filter((id) => shapesRef.current.some((shape) => shape.id === id && !shape.hidden));
      const targetShapeIds = selectedShapeIds.length > 0 ? selectedShapeIds : shapesRef.current.filter((shape) => !shape.hidden).map((shape) => shape.id);
      const modelCandidate = pickModelRulerCandidate(state, targetShapeIds, clientX, clientY);
      if (modelCandidate) return modelCandidate;

      const raw = toRawPlanePoint(clientX, clientY, state.dragPlane);
      if (!raw) return null;
      const step = snapStep(snapRef.current);
      const bounds = workspaceRef.current;
      const snapped = {
        x: clamp(snapValue(raw.x, step), -bounds.width / 2, bounds.width / 2),
        y: 0,
        z: clamp(snapValue(raw.z, step), -bounds.depth / 2, bounds.depth / 2),
      };
      const existing = model.points.find((point) => Math.hypot(point.x - snapped.x, point.y, point.z - snapped.z) < 0.001 && !point.attachment);
      return { ...snapped, pointId: existing?.id };
    },
    [toRawPlanePoint],
  );

  const selectRulerCandidate = useCallback(
    (candidate: RulerCandidate) => {
      const current = rulerModelRef.current;
      const sameAttachment = (point: RulerPoint, attachment: RulerAttachment | undefined) => Boolean(
        attachment
        && point.attachment?.shapeId === attachment.shapeId
        && Math.hypot(
          point.attachment.normalized[0] - attachment.normalized[0],
          point.attachment.normalized[1] - attachment.normalized[1],
          point.attachment.normalized[2] - attachment.normalized[2],
        ) < 1e-5,
      );
      const findExisting = (value: Pick<RulerCandidate, "x" | "y" | "z" | "pointId" | "attachment">) => value.pointId
        ? current.points.find((point) => point.id === value.pointId)
        : current.points.find((point) => sameAttachment(point, value.attachment) || (!point.attachment && !value.attachment && Math.hypot(point.x - value.x, point.y - value.y, point.z - value.z) < 0.001));
      const makePoint = (value: Pick<RulerCandidate, "x" | "y" | "z" | "pointId" | "attachment">) => findExisting(value) ?? {
        id: `ruler-point-${++rulerIdRef.current}`,
        x: value.x,
        y: value.y,
        z: value.z,
        attachment: value.attachment,
      };

      if (candidate.edge && !current.startPointId) {
        const state = threeRef.current;
        const worldPoints = state ? rulerEdgeWorldPoints(state, candidate.edge) : [];
        if (worldPoints.length >= 2) {
          const firstAttachment: RulerAttachment = {
            shapeId: candidate.edge.shapeId,
            normalized: candidate.edge.normalizedPoints[0],
            kind: "vertex",
            topologyKey: candidate.edge.topologyKey,
          };
          const lastAttachment: RulerAttachment = {
            shapeId: candidate.edge.shapeId,
            normalized: candidate.edge.normalizedPoints[candidate.edge.normalizedPoints.length - 1],
            kind: "vertex",
            topologyKey: candidate.edge.topologyKey,
          };
          const start = makePoint({ x: worldPoints[0].x, y: worldPoints[0].y, z: worldPoints[0].z, attachment: firstAttachment });
          const endWorld = worldPoints[worldPoints.length - 1];
          const end = makePoint({ x: endWorld.x, y: endWorld.y, z: endWorld.z, attachment: lastAttachment });
          const points = [...current.points];
          if (!points.some((point) => point.id === start.id)) points.push(start);
          if (!points.some((point) => point.id === end.id)) points.push(end);
          const duplicate = current.segments.some((segment) => segment.edge?.key === candidate.edge?.key);
          const segments = duplicate ? current.segments : [...current.segments, {
            id: `ruler-segment-${++rulerIdRef.current}`,
            startId: start.id,
            endId: end.id,
            edge: candidate.edge,
          }];
          storeRulerModel({ points, segments, startPointId: null, hover: null });
          return;
        }
      }

      const existing = findExisting(candidate);
      const point = existing ?? makePoint(candidate);
      const points = existing ? current.points : [...current.points, point];
      if (!current.startPointId) {
        storeRulerModel({ ...current, points, startPointId: point.id, hover: { x: point.x, y: point.y, z: point.z, attachment: point.attachment } });
        return;
      }
      if (current.startPointId === point.id) {
        return;
      }

      const duplicate = current.segments.some(
        (segment) =>
          (segment.startId === current.startPointId && segment.endId === point.id) ||
          (segment.startId === point.id && segment.endId === current.startPointId),
      );
      const segments = duplicate
        ? current.segments
        : [...current.segments, { id: `ruler-segment-${++rulerIdRef.current}`, startId: current.startPointId, endId: point.id }];
      storeRulerModel({ points, segments, startPointId: null, hover: null });
    },
    [storeRulerModel],
  );

  const updateRulerHover = useCallback(
    (clientX: number, clientY: number) => {
      if (!rulerModeRef.current) {
        return;
      }
      const candidate = resolveRulerCandidate(clientX, clientY);
      const current = rulerModelRef.current;
      const hover = candidate;
      if ((!current.hover && !hover) || (current.hover && hover
        && current.hover.edge?.key === hover.edge?.key
        && Math.hypot(current.hover.x - hover.x, current.hover.y - hover.y, current.hover.z - hover.z) < 0.0001)) {
        return;
      }
      storeRulerModel({ ...current, hover });
    },
    [resolveRulerCandidate, storeRulerModel],
  );

  const removeRulerSegment = useCallback(
    (segmentId: string) => {
      const current = rulerModelRef.current;
      const segments = current.segments.filter((segment) => segment.id !== segmentId);
      const usedPointIds = new Set(segments.flatMap((segment) => [segment.startId, segment.endId]));
      const points = current.points.filter((point) => usedPointIds.has(point.id) || point.id === current.startPointId);
      storeRulerModel({ ...current, points, segments });
    },
    [storeRulerModel],
  );

  const removeRulerPoint = useCallback(
    (pointId: string) => {
      const current = rulerModelRef.current;
      const segments = current.segments.filter((segment) => segment.startId !== pointId && segment.endId !== pointId);
      const points = current.points.filter((point) => point.id !== pointId);
      storeRulerModel({
        ...current,
        points,
        segments,
        startPointId: current.startPointId === pointId ? null : current.startPointId,
      });
    },
    [storeRulerModel],
  );

  const setMarqueeFromState = useCallback((marquee: MarqueeState | null) => {
    if (!marquee) {
      setMarqueeRect(null);
      return;
    }
    const left = Math.min(marquee.startX, marquee.currentX);
    const top = Math.min(marquee.startY, marquee.currentY);
    setMarqueeRect({
      left,
      top,
      width: Math.abs(marquee.currentX - marquee.startX),
      height: Math.abs(marquee.currentY - marquee.startY),
    });
  }, []);

  const shapesInMarquee = useCallback((rect: { left: number; top: number; right: number; bottom: number }) => {
    const state = threeRef.current;
    if (!state) {
      return [];
    }
    return shapesRef.current
      .filter((shape) => !shape.hidden)
      .filter((shape) => {
        const bounds = shapeScreenBounds(state, shape);
        return bounds ? boundsIntersectRect(bounds, rect) : false;
      })
      .map((shape) => shape.id);
  }, []);

  const beginTransform = useCallback(
    (kind: TransformHandleKind, handleKey: string, event: ReactPointerEvent<Element>) => {
      if (kind === "rotate" && event.button !== 0) {
        return;
      }
      // Closing an open degree box (and baking) before starting another transform.
      bakePendingRotationsRef.current();
      setEditingRotation(null);
      const ids = selectedIdsRef.current;
      const frame = selectionFrameForShapes(shapesRef.current, ids);
      const shape = frame?.singleShape ?? shapesRef.current.find((entry) => entry.id === ids[0]);
      if (!frame || !shape || ids.length === 0 || ids.some((id) => shapesRef.current.find((entry) => entry.id === id)?.locked)) {
        return;
      }

      const resizeHandleKey = handleKey;
      const state = threeRef.current;
      const rotationAxis = resolveRotationAxis(handleKey, state, frame);
      const yBounds = selectionWorldYBounds(frame);
      const handlesLowerSide = handleKey === "bottom-height" || handleKey === "lower-shape";
      const yStart = handlesLowerSide ? yBounds.min : yBounds.max;
      const liftOffset = kind === "lift" ? Math.max(2, yBounds.height * 0.08) * (handlesLowerSide ? -1 : 1) : 0;
      const startWorldY = yStart + liftOffset;
      const overlay = transformOverlayRef.current;
      const wheel = kind === "rotate" ? (overlay?.rotationWheels[rotationAxis] ?? overlay?.rotationWheel ?? undefined) : undefined;
      const rotationPlane = kind === "rotate" ? overlay?.rotationPlanes[rotationAxis] : undefined;
      const rotationPlaneCenterData = kind === "rotate" ? overlay?.rotationPlaneCenters[rotationAxis] : undefined;
      const rotationPlaneCenter = rotationPlaneCenterData
        ? new THREE.Vector3(rotationPlaneCenterData.x, rotationPlaneCenterData.y, rotationPlaneCenterData.z)
        : frame.center.clone();
      const rect = state?.renderer.domElement.getBoundingClientRect();
      const localClientX = rect ? event.clientX - rect.left : event.clientX;
      const localClientY = rect ? event.clientY - rect.top : event.clientY;
      const axisVector = rotationAxisVectorForFrame(handleKey, frame, rotationAxis);
      const pivot = frame.center.clone();
      const rotationCenter = kind === "rotate" ? wheel ?? (state ? projectToScreen(pivot, state) : { x: localClientX, y: localClientY }) : undefined;
      const rotationStartPoint = kind === "rotate" && state ? rayPointOnRotationPlane(state, event.clientX, event.clientY, rotationPlaneCenter, axisVector) : null;
      const rotationStartVector = rotationStartPoint ? rotationStartPoint.sub(rotationPlaneCenter) : undefined;
      const scalePlane = kind === "scale" ? localResizePlaneForFrame(frame) : undefined;
      const scaleStartPoint = scalePlane ? toRawPlanePoint(event.clientX, event.clientY, scalePlane) ?? undefined : undefined;
      const scaleSigns = kind === "scale" ? resizeSignsForHandle(resizeHandleKey) : undefined;
      const scaleAnchorPoint = kind === "scale" && scaleSigns ? resizeAnchorPointForFrame(frame, scaleSigns) : undefined;
      if (kind === "scale" && !scaleStartPoint) {
        return;
      }
      rememberResizeAnchor(shape.id, kind, resizeHandleKey);
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setEditingRotation(null);
      setPinnedMeasureKey(measureKeyForHandle(kind, handleKey, transformOverlayRef.current));
      if (kind === "height") {
        setHoverMeasureKey(null);
      }
      setActiveRotationWheel(kind === "rotate");
      setActiveTransformKind(kind);
      setSelectionHelpersVisible(state ?? null, kind !== "rotate");
      if (kind === "rotate") {
        setRotationWheelAxis(rotationAxis);
        setPinnedRotationWheelView(wheel && rotationPlane ? { axis: rotationAxis, wheel: { ...wheel }, plane: { ...rotationPlane } } : null);
      } else {
        setPinnedRotationWheelView(null);
      }
      transformRef.current = {
        id: shape.id,
        ids: frame.ids,
        kind,
        handleKey: resizeHandleKey,
        rotationAxis,
        pointerId: event.pointerId,
        startShape: { ...shape },
        items: frame.ids
          .map((id) => shapesRef.current.find((entry) => entry.id === id))
          .filter((entry): entry is WorkplaneShape => Boolean(entry))
          .map((entry) => ({
            id: entry.id,
            startShape: { ...entry },
            startCenter: shapeCenter(entry),
            startQuaternion: quaternionForShape(entry),
          })),
        selectionFrame: frame,
        startScreenAngle: rotationCenter ? screenAngle(localClientX, localClientY, rotationCenter) : 0,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScreenY: state ? projectedScreenYAt(state, frame.center.x, frame.center.z, startWorldY) : event.clientY,
        startWorldY,
        handleWorldOffset: liftOffset,
        screenYPerWorldUnit: state ? projectedScreenYPerWorldUnitAt(state, frame.center.x, frame.center.z, startWorldY) : -3.2,
        scalePlaneY: kind === "scale" ? yBounds.min : 0,
        scalePlane,
        scaleSigns,
        scaleAnchorPoint,
        scaleStartPoint,
        rotationAxisVector: kind === "rotate" ? axisVector : undefined,
        rotationPivot: kind === "rotate" ? pivot : undefined,
        rotationPlaneCenter: kind === "rotate" ? rotationPlaneCenter : undefined,
        rotationStartVector: kind === "rotate" ? rotationStartVector : undefined,
        rotationScreenCenter: rotationCenter,
        rotationScreenSign: kind === "rotate" && state ? rotationScreenSign(axisVector, state.camera) : 1,
        rotationStartQuaternion: kind === "rotate" ? quaternionForShape(shape) : undefined,
        wheelCenter: wheel,
      };
      if (kind === "rotate" && state) {
        const renderRect = state.renderer.domElement.getBoundingClientRect();
        const localX = event.clientX - renderRect.left;
        const localY = event.clientY - renderRect.top;
        setRotationReadout(rotationReadoutAtPointer(wheel, localX, localY, 0));
      } else if (kind === "lift" && state) {
        const renderRect = state.renderer.domElement.getBoundingClientRect();
        setRotationReadout({
          x: event.clientX - renderRect.left + 22,
          y: event.clientY - renderRect.top - 34,
          text: formatMeasure(yBounds.min, workspaceRef.current.accuracy),
        });
      } else {
        setRotationReadout(null);
      }
      if (state) {
        clearCutPreviewOverlays(state);
        state.needsRender = true;
        state.controls.enabled = false;
      }
      onInteractionActiveChange?.(true);
    },
    [onInteractionActiveChange, rememberResizeAnchor, toRawPlanePoint],
  );

  const updateTransform = useCallback(
    (clientX: number, clientY: number, shiftKey = false, altKey = false) => {
      const transform = transformRef.current;
      if (!transform) {
        return false;
      }
      if (Math.hypot(clientX - transform.startClientX, clientY - transform.startClientY) > 3) {
        transform.hasMoved = true;
      }

      const shape = transform.startShape;
      const step = snapStep(snapRef.current);
      if (transform.kind === "height") {
        const state = threeRef.current;
        const yBounds = selectionWorldYBounds(transform.selectionFrame);
        const draggedWorldY = state
          ? projectedWorldYForScreenY(state, shape, transform.startScreenY + clientY - transform.startClientY, transform.startWorldY)
          : transform.startWorldY + (clientY - transform.startClientY) / transform.screenYPerWorldUnit;
        const resizingFromBottom = transform.handleKey === "bottom-height";
        const rawWorldHeight = resizingFromBottom ? yBounds.max - draggedWorldY : draggedWorldY - yBounds.min;
        const nextWorldHeight = clamp(yBounds.height + snapValue(rawWorldHeight - yBounds.height, step), MIN_SHAPE_SIZE, 180);
        const scaleY = nextWorldHeight / Math.max(MIN_SHAPE_SIZE, yBounds.height);
        transform.items.forEach((item) => {
          const localCenter = frameLocalPoint(transform.selectionFrame, item.startCenter);
          const nextCenterY = resizingFromBottom
            ? transform.selectionFrame.center.y + transform.selectionFrame.height / 2 - (transform.selectionFrame.height / 2 - localCenter.y) * scaleY
            : transform.selectionFrame.center.y - transform.selectionFrame.height / 2 + (localCenter.y + transform.selectionFrame.height / 2) * scaleY;
          const height = clamp(item.startShape.height * scaleY, MIN_SHAPE_SIZE, 180);
          let elevation = nextCenterY - height / 2;
          if (transform.items.length === 1) {
            const draftShape = { ...item.startShape, height, elevation };
            const draftFrame = selectionFrameForShapes([draftShape], [item.id]);
            if (draftFrame) {
              const draftBounds = selectionWorldYBounds(draftFrame);
              elevation += resizingFromBottom ? yBounds.max - draftBounds.max : yBounds.min - draftBounds.min;
            }
          }
          onUpdateShape(item.id, {
            height,
            elevation: cleanNearZero(clamp(elevation, MIN_ELEVATION, MAX_ELEVATION), 0.0005),
          });
        });
        return true;
      }

      if (transform.kind === "lift") {
        const state = threeRef.current;
        const yBounds = selectionWorldYBounds(transform.selectionFrame);
        const handleWorldY = state
          ? projectedWorldYForScreenY(state, shape, transform.startScreenY + clientY - transform.startClientY, transform.startWorldY)
          : transform.startWorldY + (clientY - transform.startClientY) / transform.screenYPerWorldUnit;
        const handlesLowerSide = transform.handleKey === "lower-shape";
        const rawBottom = handlesLowerSide ? handleWorldY - transform.handleWorldOffset : handleWorldY - yBounds.height - transform.handleWorldOffset;
        const nextBottom = cleanNearZero(
          clamp(yBounds.min + snapValue(rawBottom - yBounds.min, step), MIN_ELEVATION, MAX_ELEVATION),
          0.0005,
        );
        const delta = nextBottom - yBounds.min;
        transform.items.forEach((item) =>
          onUpdateShape(item.id, {
            elevation: cleanNearZero(
              clamp((item.startShape.elevation ?? 0) + delta, MIN_ELEVATION, MAX_ELEVATION),
              0.0005,
            ),
          }),
        );
        if (state) {
          const readoutPoint = projectToScreen(new THREE.Vector3(transform.selectionFrame.center.x, handleWorldY, transform.selectionFrame.center.z), state);
          setRotationReadout({
            x: readoutPoint.x + 28,
            y: readoutPoint.y - 30,
            text: formatMeasure(nextBottom, workspaceRef.current.accuracy),
          });
        }
        return true;
      }

      if (transform.kind === "scale") {
        const worldPoint = transform.scalePlane ? toRawPlanePoint(clientX, clientY, transform.scalePlane) : null;
        if (!worldPoint) {
          return true;
        }
        if (transform.items.length === 1) {
          const next = resizeShapeFromFrameHandle(transform, worldPoint, transform.handleKey, shiftKey, altKey, step);
          onUpdateShape(transform.id, next);
        } else {
          resizeSelectionFromHandle(transform, worldPoint, transform.handleKey, shiftKey, altKey, step).forEach(({ id, patch }) => onUpdateShape(id, patch));
        }
        return true;
      }

      const point = toPlanePoint(clientX, clientY);
      if (!point && transform.kind !== "rotate") {
        return true;
      }

      const state = threeRef.current;
      const rotationCenter = transform.rotationScreenCenter ?? transform.wheelCenter;
      if (!state || !rotationCenter) {
        return true;
      }
      const rect = state.renderer.domElement.getBoundingClientRect();
      const localClientX = clientX - rect.left;
      const localClientY = clientY - rect.top;
      const axisVector = (transform.rotationAxisVector ?? rotationAxisVectorForFrame(transform.handleKey, transform.selectionFrame, transform.rotationAxis)).clone().normalize();
      const pivot = transform.rotationPivot ?? transform.selectionFrame.center;
      // Screen-space angle around the billboarded wheel so drag matches the ring you see.
      const rawDelta =
        THREE.MathUtils.radToDeg(unwrapRadians(screenAngle(localClientX, localClientY, rotationCenter) - transform.startScreenAngle)) *
        (transform.rotationScreenSign ?? 1);
      const distance = transform.wheelCenter ? Math.hypot(localClientX - transform.wheelCenter.x, localClientY - transform.wheelCenter.y) : Number.POSITIVE_INFINITY;
      const innerRadius = transform.wheelCenter?.innerRadius ?? transform.wheelCenter?.radius ?? 0;
      const inIndexedRing = Boolean(transform.wheelCenter && distance <= innerRadius);
      let delta: number;
      if (shiftKey) {
        delta = Math.round(rawDelta / 45) * 45;
      } else if (inIndexedRing) {
        // Inner circle: snap to indexed steps (22.5°).
        delta = Math.round(rawDelta / ROTATION_SNAP_STEP) * ROTATION_SNAP_STEP;
      } else {
        // Outer free ring (and beyond): 1° increments (finer values via the degree input).
        delta = Math.round(rawDelta);
      }

      const deltaQuaternion = new THREE.Quaternion().setFromAxisAngle(axisVector, THREE.MathUtils.degToRad(delta));
      const rotationDelta = deltaQuaternion.clone();
      if (state) {
        const startPointerAngle = THREE.MathUtils.radToDeg(transform.startScreenAngle) + 90;
        setRotationReadout(rotationReadoutAtPointer(transform.wheelCenter, localClientX, localClientY, delta, startPointerAngle));
      }
      transform.items.forEach((item) => {
        const nextQuaternion = rotationDelta.clone().multiply(item.startQuaternion);
        const patch: Partial<WorkplaneShape> = rotationPatchFromQuaternion(nextQuaternion);
        if (transform.items.length > 1) {
          const nextCenter = pivot.clone().add(item.startCenter.clone().sub(pivot).applyQuaternion(rotationDelta));
          patch.x = snapPositionValue(nextCenter.x, step, -workspaceRef.current.width / 2 + 6, workspaceRef.current.width / 2 - 6);
          patch.z = snapPositionValue(nextCenter.z, step, -workspaceRef.current.depth / 2 + 6, workspaceRef.current.depth / 2 - 6);
          patch.elevation = snapPositionValue(nextCenter.y - item.startShape.height / 2, step, MIN_ELEVATION, MAX_ELEVATION);
        }
        onUpdateShape(item.id, patch);
      });
      return true;
    },
    [onUpdateShape, toPlanePoint, toRawPlanePoint],
  );

  const suppressLiftEditAfterDrag = useCallback(() => {
    suppressNextLiftEditRef.current = true;
    window.setTimeout(() => {
      suppressNextLiftEditRef.current = false;
    }, 250);
  }, []);

  const suppressRotationEditAfterDrag = useCallback(() => {
    suppressNextRotationEditRef.current = true;
    window.setTimeout(() => {
      suppressNextRotationEditRef.current = false;
    }, 250);
  }, []);

  const bakePendingRotations = useCallback(() => {
    const ids = pendingRotationBakeIdsRef.current;
    if (ids.length === 0) {
      return;
    }
    pendingRotationBakeIdsRef.current = [];
    pendingRotationBeforeByIdRef.current = {};
    ids.forEach((id) => onUpdateShape(id, { bakeTransform: true }));
  }, [onUpdateShape]);

  bakePendingRotationsRef.current = bakePendingRotations;

  const dismissRotationEdit = useCallback(() => {
    setEditingRotation(null);
    setActiveRotationWheel(false);
    bakePendingRotations();
  }, [bakePendingRotations]);

  useEffect(() => {
    if (!rotationEditApiRef) {
      return;
    }
    rotationEditApiRef.current = { dismiss: dismissRotationEdit };
    return () => {
      rotationEditApiRef.current = null;
    };
  }, [dismissRotationEdit, rotationEditApiRef]);

  const openRotationEditorAfterDrag = useCallback((transform: TransformDragState) => {
    const shape = shapesRef.current.find((entry) => entry.id === transform.id);
    if (!shape) {
      transform.ids.forEach((id) => onUpdateShape(id, { bakeTransform: true }));
      return;
    }
    pendingRotationBakeIdsRef.current = [...transform.ids];
    pendingRotationBeforeByIdRef.current = Object.fromEntries(transform.items.map((item) => [item.id, item.startShape]));
    const axis = transform.rotationAxis ?? resolveRotationAxis(transform.handleKey, threeRef.current, transform.selectionFrame);
    const readout = rotationReadoutRef.current;
    const overlay = transformOverlayRef.current;
    const overlayWidth = overlay?.width ?? 900;
    const overlayHeight = overlay?.height ?? 600;
    const fallbackX = transform.wheelCenter?.x ?? readout?.x ?? 80;
    const fallbackY = transform.wheelCenter ? transform.wheelCenter.y - 92 : readout?.y ?? 80;
    const currentValue = rotationValueForAxis(shape, axis);
    const value = String(Number(currentValue.toFixed(1)));
    setPinnedMeasureKey(transform.handleKey);
    setActiveRotationWheel(false);
    setPinnedRotationWheelView(null);
    setRotationReadout(null);
    setEditingRotation({
      axis,
      handleKey: transform.handleKey,
      x: clamp(fallbackX, 38, Math.max(38, overlayWidth - 38)),
      y: clamp(fallbackY, 38, Math.max(38, overlayHeight - 38)),
      value,
      initialValue: value,
    });
  }, [onUpdateShape]);

  const finishTransform = useCallback((event: ReactPointerEvent<Element>) => {
    const transform = transformRef.current;
    if (!transform) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(transform.pointerId)) {
      event.currentTarget.releasePointerCapture(transform.pointerId);
    }
    const openedRotationEditor = transform.kind === "rotate" && Boolean(transform.hasMoved);
    if (transform.kind === "lift") {
      setPinnedMeasureKey(getElevationMeasureKey(transformOverlayRef.current));
    }
    if (transform.kind === "lift" && transform.hasMoved) {
      suppressLiftEditAfterDrag();
    }
    if (openedRotationEditor) {
      // Keep the degree box; suppress the handle's click so it doesn't reopen.
      suppressRotationEditAfterDrag();
    }
    transformRef.current = null;
    setActiveTransformKind(null);
    if (!openedRotationEditor) {
      setActiveRotationWheel(false);
      setPinnedRotationWheelView(null);
      setRotationReadout(null);
    }
    if (threeRef.current) {
      syncCutPreviewOverlays(threeRef.current, shapesRef.current);
      setSelectionHelpersVisible(threeRef.current, true);
      threeRef.current.controls.enabled = true;
      threeRef.current.needsRender = true;
    }
    onInteractionActiveChange?.(false);
    // Defer bake until the degree box commits, cancels, or is dismissed (e.g. Duplicate).
    // Baking first then committing the pre-bake angle was re-rotating the same object.
    if (openedRotationEditor) {
      openRotationEditorAfterDrag(transform);
    }
  }, [onInteractionActiveChange, openRotationEditorAfterDrag, suppressLiftEditAfterDrag, suppressRotationEditAfterDrag]);

  const beginDimensionEdit = useCallback((mark: DimensionMark) => {
    const id = selectedIdsRef.current[0];
    if (id && (mark.axis === "width" || mark.axis === "depth" || mark.axis === "height")) {
      rememberResizeAnchor(id, mark.axis === "height" ? "height" : "scale", mark.handleKey);
    }
    bakePendingRotations();
    setEditingRotation(null);
    setActiveRotationWheel(false);
    setPinnedMeasureKey(mark.handleKey);
    setEditingDimension({ key: mark.key, axis: mark.axis, x: mark.labelX, y: mark.labelY, value: mark.label });
  }, [bakePendingRotations, rememberResizeAnchor]);

  const beginLiftEdit = useCallback((handleKey: string, x: number, y: number) => {
    if (suppressNextLiftEditRef.current) {
      suppressNextLiftEditRef.current = false;
      return;
    }
    const frame = selectionFrameForShapes(shapesRef.current, selectedIdsRef.current);
    if (!frame) {
      return;
    }
    const yBounds = selectionWorldYBounds(frame);
    const elevationMark = Object.values(transformOverlayRef.current?.dimensions ?? {})
      .flat()
      .find((entry) => entry.axis === "elevation");
    const editX = elevationMark?.labelX ?? x;
    const editY = elevationMark?.labelY ?? y;
    setPinnedMeasureKey(elevationMark?.handleKey ?? handleKey);
    setEditingRotation(null);
    setActiveRotationWheel(false);
    setRotationReadout(null);
    setEditingDimension({
      key: "elevation",
      axis: "elevation",
      x: clamp(editX, 44, Math.max(44, (transformOverlayRef.current?.width ?? 900) - 44)),
      y: clamp(editY, 34, Math.max(34, (transformOverlayRef.current?.height ?? 600) - 34)),
      value: formatMeasure(yBounds.min, workspaceRef.current.accuracy),
    });
  }, []);

  const commitDimensionEdit = useCallback(() => {
    const edit = editingDimension;
    const id = selectedIdsRef.current[0];
    const shape = shapesRef.current.find((entry) => entry.id === id);
    if (!edit || !shape) {
      setEditingDimension(null);
      return;
    }
    const value = Number.parseFloat(edit.value);
    if (edit.axis === "elevation") {
      if (Number.isFinite(value)) {
        const frame = selectionFrameForShapes(shapesRef.current, selectedIdsRef.current);
        const currentMin = frame ? selectionWorldYBounds(frame).min : shape.elevation ?? 0;
        const targetMin = cleanNearZero(clamp(value, MIN_ELEVATION, MAX_ELEVATION), 0.0005);
        const delta = targetMin - currentMin;
        selectedIdsRef.current.forEach((selectedId) => {
          const selectedShape = shapesRef.current.find((entry) => entry.id === selectedId);
          if (selectedShape) {
            onUpdateShape(selectedId, { elevation: cleanNearZero(clamp((selectedShape.elevation ?? 0) + delta, MIN_ELEVATION, MAX_ELEVATION), 0.0005) });
          }
        });
      }
      setEditingDimension(null);
      return;
    }
    if (Number.isFinite(value) && value > 0) {
      const nextValue = Math.max(MIN_SHAPE_SIZE, value);
      if (edit.axis === "width") {
        const patch: Partial<WorkplaneShape> =
          shape.kind === "cone"
            ? conePatchForFootprint(shape, nextValue, shapeDepth(shape))
            : { width: nextValue, size: resizedShapeSize(nextValue, shapeDepth(shape)) };
        onUpdateShape(id, patchWithResizeAnchor(shape, patch, edit.axis, lastResizeAnchorRef.current));
      } else if (edit.axis === "depth") {
        const patch: Partial<WorkplaneShape> =
          shape.kind === "cone"
            ? conePatchForFootprint(shape, shapeWidth(shape), nextValue)
            : { depth: nextValue, size: resizedShapeSize(shapeWidth(shape), nextValue) };
        onUpdateShape(id, patchWithResizeAnchor(shape, patch, edit.axis, lastResizeAnchorRef.current));
      } else {
        onUpdateShape(id, patchWithResizeAnchor(shape, { height: nextValue }, edit.axis, lastResizeAnchorRef.current));
      }
    }
    setEditingDimension(null);
  }, [editingDimension, onUpdateShape]);

  const cancelDimensionEdit = useCallback(() => {
    setEditingDimension(null);
  }, []);

  const beginRotationEdit = useCallback((handleKey: string, x: number, y: number) => {
    if (suppressNextRotationEditRef.current) {
      suppressNextRotationEditRef.current = false;
      return;
    }
    bakePendingRotations();
    const frame = selectionFrameForShapes(shapesRef.current, selectedIdsRef.current);
    const state = threeRef.current;
    const axis = resolveRotationAxis(handleKey, state, frame);
    const shape = selectedIdsRef.current.length === 1 ? shapesRef.current.find((entry) => entry.id === selectedIdsRef.current[0]) : null;
    const currentValue = shape ? rotationValueForAxis(shape, axis) : 0;
    const value = String(Number(currentValue.toFixed(1)));
    setPinnedMeasureKey(handleKey);
    setActiveRotationWheel(true);
    setRotationWheelAxis(axis);
    // Keep the ring live (not pinned) so it stays camera-facing while orbiting during numeric edit.
    setPinnedRotationWheelView(null);
    setRotationReadout(null);
    setEditingRotation({
      axis,
      handleKey,
      x: clamp(x, 38, Math.max(38, (transformOverlayRef.current?.width ?? 900) - 38)),
      y: clamp(y, 38, Math.max(38, (transformOverlayRef.current?.height ?? 600) - 38)),
      value,
      initialValue: value,
    });
  }, [bakePendingRotations]);

  const commitRotationEdit = useCallback(() => {
    const edit = editingRotationRef.current;
    if (!edit) {
      return;
    }
    // Clear first so a blur after Enter cannot double-commit.
    editingRotationRef.current = null;
    setEditingRotation(null);
    setActiveRotationWheel(false);
    const value = Number.parseFloat(edit.value);
    const pendingIds = new Set(pendingRotationBakeIdsRef.current);
    const pendingBefore = pendingRotationBeforeByIdRef.current;
    pendingRotationBakeIdsRef.current = [];
    pendingRotationBeforeByIdRef.current = {};
    if (Number.isFinite(value)) {
      selectedIdsRef.current.forEach((id) => {
        const shape = shapesRef.current.find((entry) => entry.id === id);
        if (!shape) {
          return;
        }
        if (Math.abs(rotationValueForAxis(shape, edit.axis) - value) > 0.0005) {
          onUpdateShape(id, {
            ...rotationPatchForAxis(edit.axis, value),
            bakeTransform: true,
            repeatDeltaBefore: pendingBefore[id],
          });
          pendingIds.delete(id);
          return;
        }
        if (pendingIds.has(id)) {
          onUpdateShape(id, { bakeTransform: true });
          pendingIds.delete(id);
        }
      });
    }
    pendingIds.forEach((id) => onUpdateShape(id, { bakeTransform: true }));
  }, [onUpdateShape]);

  const cancelRotationEdit = useCallback(() => {
    if (!editingRotationRef.current && pendingRotationBakeIdsRef.current.length === 0) {
      return;
    }
    editingRotationRef.current = null;
    setEditingRotation(null);
    setActiveRotationWheel(false);
    bakePendingRotations();
  }, [bakePendingRotations]);

  const pickShapesAt = useCallback((clientX: number, clientY: number) => {
    const state = threeRef.current;
    if (!state) {
      return [] as string[];
    }

    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);

    const hits: string[] = [];
    const seen = new Set<string>();
    const intersections = state.raycaster.intersectObjects(state.shapeLayer.children, true);
    intersections.forEach((entry) => {
      const id = entry.object.userData.shapeId;
      if (typeof id !== "string" || seen.has(id)) {
        return;
      }
      const shape = shapesRef.current.find((item) => item.id === id);
      if (!shape || shape.hidden) {
        return;
      }
      seen.add(id);
      hits.push(id);
    });
    if (hits.length > 0) {
      return hits;
    }

    // Soft fallback: nearby shape centers, nearest first (still supports cycling).
    const nearby: Array<{ id: string; distance: number }> = [];
    shapesRef.current.forEach((shape) => {
      if (shape.hidden) {
        return;
      }
      const center = new THREE.Vector3(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z).project(state.camera);
      const screenX = rect.left + ((center.x + 1) / 2) * rect.width;
      const screenY = rect.top + ((1 - center.y) / 2) * rect.height;
      const distance = Math.hypot(clientX - screenX, clientY - screenY);
      const hitRadius = clamp(Math.max(shapeWidth(shape), shapeDepth(shape)) * 2.6, 48, 112);
      if (distance <= hitRadius) {
        nearby.push({ id: shape.id, distance });
      }
    });
    nearby.sort((a, b) => a.distance - b.distance);
    return nearby.map((entry) => entry.id);
  }, []);

  const pickShape = useCallback((clientX: number, clientY: number) => pickShapesAt(clientX, clientY)[0] ?? null, [pickShapesAt]);

  /** Alt-click: pick a CSG child feature under a body (Tinkercad-like edit solids). */
  const pickCsgFeatureAt = useCallback((clientX: number, clientY: number): { bodyId: string; featureId: string } | null => {
    const state = threeRef.current;
    if (!state) return null;
    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hit = state.raycaster.intersectObjects(state.shapeLayer.children, true).find((entry) => {
      const id = entry.object.userData.shapeId;
      if (typeof id !== "string") return false;
      const shape = shapesRef.current.find((item) => item.id === id);
      return Boolean(shape && !shape.hidden && shape.groupedShapes?.length);
    });
    if (!hit || typeof hit.object.userData.shapeId !== "string") return null;
    const body = shapesRef.current.find((item) => item.id === hit.object.userData.shapeId);
    if (!body?.groupedShapes?.length) return null;

    const hitPoint = hit.point.clone();
    const inv = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(body.rotationX ?? 0),
        THREE.MathUtils.degToRad(body.rotation),
        THREE.MathUtils.degToRad(body.rotationZ ?? 0),
        "XYZ",
      ))
      .invert();
    const local = hitPoint
      .clone()
      .sub(new THREE.Vector3(body.x, (body.elevation ?? 0), body.z))
      .applyMatrix4(inv);

    let bestId: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const child of body.groupedShapes) {
      if (child.suppressed || child.csg?.suppressed || child.hidden) continue;
      const hw = shapeWidth(child) / 2;
      const hd = shapeDepth(child) / 2;
      const hh = child.height / 2;
      const cx = child.x;
      const cy = (child.elevation ?? 0) + hh;
      const cz = child.z;
      const dx = Math.max(Math.abs(local.x - cx) - hw, 0);
      const dy = Math.max(Math.abs(local.y - cy) - hh, 0);
      const dz = Math.max(Math.abs(local.z - cz) - hd, 0);
      const outside = Math.hypot(dx, dy, dz);
      const centerDist = Math.hypot(local.x - cx, local.y - cy, local.z - cz);
      const score = outside > 1e-6 ? outside + 0.01 : centerDist * 0.001;
      if (score < bestScore) {
        bestScore = score;
        bestId = child.id;
      }
    }
    return bestId ? { bodyId: body.id, featureId: bestId } : null;
  }, []);

  const pickSketchFaceAt = useCallback((clientX: number, clientY: number): SketchFacePickOutcome | null => {
    const state = threeRef.current;
    if (!state) return null;

    const faceHit = raycastSketchFaceHit(state, shapesRef.current, clientX, clientY);
    if (faceHit) {
      if (faceHit.classification.kind === "curved") {
        return {
          ok: false,
          reason: faceHit.classification.blockedReason
            ?? "That face is curved — pick a flat end, another flat face, or the workplane",
        };
      }
      if (faceHit.classification.plane) {
        return { ok: true, plane: faceHit.classification.plane };
      }
      return {
        ok: true,
        plane: sketchPlaneFromThreeVectors(faceHit.hit.point, faceHit.worldNormal, faceHit.shapeId),
      };
    }

    const elevation = placementElevationRef.current;
    const plane = defaultSketchPlane();
    // Keep UV = world XZ; elevate the plate when the placement workplane is raised.
    plane.origin = { x: 0, y: elevation, z: 0 };
    return { ok: true, plane };
  }, []);

  const updateSketchFaceHover = useCallback((clientX: number, clientY: number) => {
    const state = threeRef.current;
    if (!state || !sketchFacePickModeRef.current) return;
    const faceHit = raycastSketchFaceHit(state, shapesRef.current, clientX, clientY);
    sketchFaceHoverKeyRef.current = syncSketchFaceHighlight(state, faceHit, sketchFaceHoverKeyRef.current);
    setSketchFaceHovering(Boolean(faceHit));
    setSketchFaceHoverBlocked(Boolean(faceHit && faceHit.classification.kind === "curved"));
  }, []);

  const clearSketchFaceHover = useCallback(() => {
    sketchFaceHoverKeyRef.current = null;
    setSketchFaceHovering(false);
    setSketchFaceHoverBlocked(false);
    clearSketchFaceHighlight(threeRef.current);
  }, []);

  /** Prefer the next overlapping shape when re-clicking a stack that already includes the selection. */
  const resolveClickSelection = useCallback(
    (clientX: number, clientY: number, additive: boolean) => {
      const hits = pickShapesAt(clientX, clientY);
      if (hits.length === 0) {
        return null;
      }
      if (additive || hits.length === 1) {
        return hits[0];
      }
      const selected = selectedIdsRef.current;
      if (selected.length === 1) {
        const index = hits.indexOf(selected[0]);
        if (index >= 0) {
          return hits[(index + 1) % hits.length];
        }
      }
      return hits[0];
    },
    [pickShapesAt],
  );

  const pickModifierEdge = useCallback((clientX: number, clientY: number) => {
    const state = threeRef.current;
    if (!state) return null;
    return pickModifierEdgeFromScreen(state, modifierEdgesRef.current, clientX, clientY);
  }, []);

  const updateModifierEdgeHover = useCallback((clientX: number, clientY: number) => {
    const edgeId = pickModifierEdge(clientX, clientY);
    setHoverModifierEdgeId((current) => (current === edgeId ? current : edgeId));
  }, [pickModifierEdge]);

  const clearModifierEdgeHover = useCallback(() => {
    setHoverModifierEdgeId((current) => (current === null ? current : null));
  }, []);

  const pickTransformHandle = useCallback((clientX: number, clientY: number) => {
    const state = threeRef.current;
    if (!state || selectedIdsRef.current.length !== 1) {
      return null;
    }

    const rect = state.renderer.domElement.getBoundingClientRect();
    state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);

    const intersections = state.raycaster.intersectObjects(state.helperLayer.children, true);
    const hit = intersections.find((entry) => typeof entry.object.userData.transformHandle === "string");
    if (!hit) {
      return null;
    }

    return {
      id: hit.object.userData.shapeId as string,
      kind: hit.object.userData.transformHandle as TransformHandleKind,
      handleKey: (hit.object.userData.transformHandleKey as string | undefined) ?? (hit.object.userData.transformHandle as string),
      planeY: typeof hit.object.userData.transformPlaneY === "number" ? (hit.object.userData.transformPlaneY as number) : 0,
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = threeRef.current;
      if (!state) {
        return;
      }
      if (event.button !== 0 || event.ctrlKey || event.metaKey) {
        return;
      }
      const rect = state.renderer.domElement.getBoundingClientRect();

      // Alt+click picks a CSG feature inside a grouped body (inspector Features list).
      if (event.altKey && onSelectFeature) {
        const featureHit = pickCsgFeatureAt(event.clientX, event.clientY);
        if (featureHit) {
          event.preventDefault();
          onSelectShape(featureHit.bodyId);
          onSelectFeature(featureHit.featureId);
          return;
        }
      }

      if (modifierActive) {
        event.preventDefault();
        const edgeId = pickModifierEdge(event.clientX, event.clientY);
        if (edgeId !== null) onModifierEdgeToggle?.(edgeId, event.shiftKey);
        return;
      }

      if (sketchFacePickModeRef.current) {
        event.preventDefault();
        const outcome = pickSketchFaceAt(event.clientX, event.clientY);
        clearSketchFaceHover();
        if (!outcome) return;
        if (outcome.ok) {
          onSketchPlanePickedRef.current?.(outcome.plane);
        } else {
          onSketchFacePickRejectedRef.current?.(outcome.reason);
        }
        return;
      }

      if (circularPatternModeRef.current && !circularPatternCenterRef.current) {
        // Allow resize/height handles so dimensions stay editable; empty clicks pick the pivot.
        const patternHandle = pickTransformHandle(event.clientX, event.clientY);
        if (!patternHandle) {
          event.preventDefault();
          const id = pickShape(event.clientX, event.clientY);
          if (id) {
            onCircularPatternPivotPickRef.current?.(id);
          }
          return;
        }
      }

      if (rulerDeleteModeRef.current) {
        event.preventDefault();
        return;
      }

      if (rulerMoveModeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (rulerModeRef.current) {
        event.preventDefault();
        const candidate = resolveRulerCandidate(event.clientX, event.clientY);
        if (candidate) {
          selectRulerCandidate(candidate);
        }
        return;
      }

      if (workplaneModeRef.current) {
        event.preventDefault();
        const id = pickShape(event.clientX, event.clientY);
        if (id) {
          const frame = selectionFrameForShapes(shapesRef.current, [id]);
          const top = frame ? selectionWorldYBounds(frame).max : 0;
          onSetPlacementElevation(snapPositionValue(top, snapStep(snapRef.current), MIN_ELEVATION, MAX_ELEVATION), "shape");
          onSelectShape(id);
        } else {
          onSetPlacementElevation(0, "base");
        }
        onWorkplaneModeChange(false);
        return;
      }

      const handle = pickTransformHandle(event.clientX, event.clientY);
      if (handle) {
        const shape = shapesRef.current.find((entry) => entry.id === handle.id);
        const frame = selectionFrameForShapes(shapesRef.current, selectedIdsRef.current);
        const scalePlane = handle.kind === "scale" && frame ? localResizePlaneForFrame(frame) : undefined;
        const scaleStartPoint = scalePlane ? toRawPlanePoint(event.clientX, event.clientY, scalePlane) ?? undefined : undefined;
        const point = scalePlane ? scaleStartPoint : toPlanePoint(event.clientX, event.clientY);
        if (!shape || !frame || shape.locked || (!point && handle.kind !== "height" && handle.kind !== "lift" && handle.kind !== "rotate")) {
          return;
        }
        const yBounds = selectionWorldYBounds(frame);
        const handlesLowerSide = handle.handleKey === "bottom-height" || handle.handleKey === "lower-shape";
        const yStart = handlesLowerSide ? yBounds.min : yBounds.max;
        const liftOffset = handle.kind === "lift" ? Math.max(2, yBounds.height * 0.08) * (handlesLowerSide ? -1 : 1) : 0;
        const startWorldY = yStart + liftOffset;
        const overlay = transformOverlayRef.current;
        const rotationAxis = resolveRotationAxis(handle.handleKey, state, frame);
        const resizeHandleKey = handle.handleKey;
        const scaleSigns = handle.kind === "scale" ? resizeSignsForHandle(resizeHandleKey) : undefined;
        const scaleAnchorPoint = handle.kind === "scale" && scaleSigns ? resizeAnchorPointForFrame(frame, scaleSigns) : undefined;
        const wheel = handle.kind === "rotate" ? (overlay?.rotationWheels[rotationAxis] ?? overlay?.rotationWheel ?? undefined) : undefined;
        const rotationPlane = handle.kind === "rotate" ? overlay?.rotationPlanes[rotationAxis] : undefined;
        const rotationPlaneCenterData = handle.kind === "rotate" ? overlay?.rotationPlaneCenters[rotationAxis] : undefined;
        const rotationPlaneCenter = rotationPlaneCenterData
          ? new THREE.Vector3(rotationPlaneCenterData.x, rotationPlaneCenterData.y, rotationPlaneCenterData.z)
          : frame.center.clone();
        const localClientX = event.clientX - rect.left;
        const localClientY = event.clientY - rect.top;
        const axisVector = rotationAxisVectorForFrame(handle.handleKey, frame, rotationAxis);
        const pivot = frame.center.clone();
        const rotationCenter = handle.kind === "rotate" ? wheel ?? projectToScreen(pivot, state) : undefined;
        const rotationStartPoint = handle.kind === "rotate" ? rayPointOnRotationPlane(state, event.clientX, event.clientY, rotationPlaneCenter, axisVector) : null;
        const rotationStartVector = rotationStartPoint ? rotationStartPoint.sub(rotationPlaneCenter) : undefined;
        rememberResizeAnchor(handle.id, handle.kind, resizeHandleKey);
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setEditingRotation(null);
        setPinnedMeasureKey(measureKeyForHandle(handle.kind, handle.handleKey, transformOverlayRef.current));
        if (handle.kind === "height") {
          setHoverMeasureKey(null);
        }
        setActiveRotationWheel(handle.kind === "rotate");
        setActiveTransformKind(handle.kind);
        setSelectionHelpersVisible(state, handle.kind !== "rotate");
        if (handle.kind === "rotate") {
          setRotationWheelAxis(rotationAxis);
          setPinnedRotationWheelView(wheel && rotationPlane ? { axis: rotationAxis, wheel: { ...wheel }, plane: { ...rotationPlane } } : null);
        } else {
          setPinnedRotationWheelView(null);
        }
        transformRef.current = {
          id: handle.id,
          ids: frame.ids,
          kind: handle.kind,
          handleKey: resizeHandleKey,
          rotationAxis,
          pointerId: event.pointerId,
          startShape: { ...shape },
          items: frame.ids
            .map((id) => shapesRef.current.find((entry) => entry.id === id))
            .filter((entry): entry is WorkplaneShape => Boolean(entry))
            .map((entry) => ({
              id: entry.id,
              startShape: { ...entry },
              startCenter: shapeCenter(entry),
              startQuaternion: quaternionForShape(entry),
            })),
          selectionFrame: frame,
          startScreenAngle: rotationCenter ? screenAngle(localClientX, localClientY, rotationCenter) : 0,
          startClientX: event.clientX,
          startClientY: event.clientY,
          startScreenY: projectedScreenYAt(state, frame.center.x, frame.center.z, startWorldY),
          startWorldY,
          handleWorldOffset: liftOffset,
          screenYPerWorldUnit: projectedScreenYPerWorldUnitAt(state, frame.center.x, frame.center.z, startWorldY),
          scalePlaneY: handle.kind === "scale" ? handle.planeY : 0,
          scalePlane,
          scaleSigns,
          scaleAnchorPoint,
          scaleStartPoint,
          rotationAxisVector: handle.kind === "rotate" ? axisVector : undefined,
          rotationPivot: handle.kind === "rotate" ? pivot : undefined,
          rotationPlaneCenter: handle.kind === "rotate" ? rotationPlaneCenter : undefined,
          rotationStartVector: handle.kind === "rotate" ? rotationStartVector : undefined,
          rotationScreenCenter: rotationCenter,
          rotationScreenSign: handle.kind === "rotate" ? rotationScreenSign(axisVector, state.camera) : 1,
          rotationStartQuaternion: handle.kind === "rotate" ? quaternionForShape(shape) : undefined,
          wheelCenter: wheel,
        };
        if (handle.kind === "rotate") {
          const localX = event.clientX - rect.left;
          const localY = event.clientY - rect.top;
          setRotationReadout(rotationReadoutAtPointer(wheel, localX, localY, 0));
        } else if (handle.kind === "lift") {
          setRotationReadout({
            x: event.clientX - rect.left + 22,
            y: event.clientY - rect.top - 34,
            text: formatMeasure(yBounds.min, workspaceRef.current.accuracy),
          });
        } else {
          setRotationReadout(null);
        }
        clearCutPreviewOverlays(state);
        state.needsRender = true;
        state.controls.enabled = false;
        onInteractionActiveChange?.(true);
        return;
      }

      const additive = event.shiftKey;
      const id = resolveClickSelection(event.clientX, event.clientY, additive);
      if (!id) {
        const startX = event.clientX - rect.left;
        const startY = event.clientY - rect.top;
        event.preventDefault();
        setEditingRotation(null);
        setActiveRotationWheel(false);
        event.currentTarget.setPointerCapture(event.pointerId);
        marqueeRef.current = {
          pointerId: event.pointerId,
          startX,
          startY,
          currentX: startX,
          currentY: startY,
          additive,
          hasMoved: false,
        };
        setMarqueeFromState(marqueeRef.current);
        state.controls.enabled = false;
        onInteractionActiveChange?.(true);
        return;
      }

      const shape = shapesRef.current.find((entry) => entry.id === id);
      const selectedIdsSnapshot = selectedIdsRef.current;
      if (alignModeRef.current && selectedIdsSnapshot.includes(id)) {
        event.preventDefault();
        onAlignAnchorChange(id);
        return;
      }
      const dragPlaneY = shape ? shape.elevation ?? 0 : 0;
      const point = toPlanePointAtY(event.clientX, event.clientY, dragPlaneY);
      if (!point || !shape) {
        return;
      }

      event.preventDefault();
      const alreadySelected = selectedIdsSnapshot.includes(id);
      if (additive) {
        onSelectShape(id, "toggle");
        return;
      }
      // Keep a multi-selection when clicking a shape that is already part of it.
      // Only replace selection when clicking a shape outside the current set (or cycling).
      if (!alreadySelected) {
        onSelectShape(id);
      }
      if (shape.locked) {
        return;
      }
      setEditingRotation(null);
      setActiveRotationWheel(false);
      event.currentTarget.setPointerCapture(event.pointerId);
      const dragIds = alreadySelected && selectedIdsSnapshot.length > 1 ? selectedIdsSnapshot : [id];
      const items = dragIds
        .map((dragId) => {
          const dragShape = shapesRef.current.find((entry) => entry.id === dragId);
          if (!dragShape || dragShape.locked) {
            return null;
          }
          const helper = findSelectionHelper(state, dragId);
          return {
            id: dragId,
            startX: dragShape.x,
            startZ: dragShape.z,
            nextX: dragShape.x,
            nextZ: dragShape.z,
            visual: findShapeObject(state, dragId),
            helper,
            helperBox: helper ? helper.box.clone() : null,
            hadPreviewSimplified: false,
          };
        })
        .filter((item): item is DragItem => Boolean(item));
      if (items.length === 0) {
        return;
      }
      dragRef.current = {
        primaryId: id,
        offsetX: shape.x - point.x,
        offsetZ: shape.z - point.z,
        planeY: dragPlaneY,
        pointerId: event.pointerId,
        primaryStartX: shape.x,
        primaryStartZ: shape.z,
        items,
      };
      clearCutPreviewOverlays(state);
      state.needsRender = true;
      state.controls.enabled = false;
      onInteractionActiveChange?.(true);
    },
    [
      modifierActive,
      onAlignAnchorChange,
      onInteractionActiveChange,
      onModifierEdgeToggle,
      onSelectFeature,
      onSelectShape,
      onSetPlacementElevation,
      onWorkplaneModeChange,
      pickCsgFeatureAt,
      pickModifierEdge,
      pickShape,
      pickSketchFaceAt,
      clearSketchFaceHover,
      pickTransformHandle,
      resolveClickSelection,
      resolveRulerCandidate,
      selectRulerCandidate,
      setMarqueeFromState,
      toPlanePoint,
      toPlanePointAtY,
      toRawPlanePoint,
    ],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (modifierActiveRef.current) {
        updateModifierEdgeHover(event.clientX, event.clientY);
        return;
      }
      if (sketchFacePickModeRef.current) {
        updateSketchFaceHover(event.clientX, event.clientY);
        return;
      }
      if (rulerModeRef.current) {
        updateRulerHover(event.clientX, event.clientY);
        return;
      }
      if (rulerMoveModeRef.current) return;
      const transform = transformRef.current;
      if (transform) {
        updateTransform(event.clientX, event.clientY, event.shiftKey, event.altKey);
        if (threeRef.current) {
          threeRef.current.needsRender = true;
        }
        return;
      }

      const marquee = marqueeRef.current;
      if (marquee) {
        const state = threeRef.current;
        if (!state) {
          return;
        }
        const rect = state.renderer.domElement.getBoundingClientRect();
        marquee.currentX = event.clientX - rect.left;
        marquee.currentY = event.clientY - rect.top;
        marquee.hasMoved = marquee.hasMoved || Math.hypot(marquee.currentX - marquee.startX, marquee.currentY - marquee.startY) > 5;
        setMarqueeFromState(marquee);
        return;
      }

      const drag = dragRef.current;
      if (!drag) {
        return;
      }

      const point = toPlanePointAtY(event.clientX, event.clientY, drag.planeY);
      if (!point) {
        return;
      }

      const primaryNextX = clamp(point.x + drag.offsetX, -workspaceRef.current.width / 2 + 6, workspaceRef.current.width / 2 - 6);
      const primaryNextZ = clamp(point.z + drag.offsetZ, -workspaceRef.current.depth / 2 + 6, workspaceRef.current.depth / 2 - 6);
      let deltaX = primaryNextX - drag.primaryStartX;
      let deltaZ = primaryNextZ - drag.primaryStartZ;

      // Shift locks move to one screen axis (horizontal or vertical in the current view).
      if (event.shiftKey) {
        const camera = threeRef.current?.camera;
        if (camera) {
          const axes = computeViewNudgeAxes(camera);
          const alongRight = deltaX * axes.rightX + deltaZ * axes.rightZ;
          const alongUp = deltaX * axes.upX + deltaZ * axes.upZ;
          if (Math.abs(alongRight) >= Math.abs(alongUp)) {
            deltaX = alongRight * axes.rightX;
            deltaZ = alongRight * axes.rightZ;
          } else {
            deltaX = alongUp * axes.upX;
            deltaZ = alongUp * axes.upZ;
          }
        } else if (Math.abs(deltaX) >= Math.abs(deltaZ)) {
          deltaZ = 0;
        } else {
          deltaX = 0;
        }
      }

      drag.items.forEach((item) => {
        item.nextX = clamp(item.startX + deltaX, -workspaceRef.current.width / 2 + 6, workspaceRef.current.width / 2 - 6);
        item.nextZ = clamp(item.startZ + deltaZ, -workspaceRef.current.depth / 2 + 6, workspaceRef.current.depth / 2 - 6);
        if (threeRef.current) applyDragItemPreview(threeRef.current, item);
      });
      if (threeRef.current) {
        const previewShapes = previewShapesForDrag(shapesRef.current, drag);
        updateSelectedGroundFootprintPreviews(threeRef.current, drag);
        markShadowsDirty(threeRef.current);
        syncTransformOverlay(
          threeRef.current,
          previewShapes,
          selectedIdsRef.current,
          transformOverlayRef,
          setTransformOverlay,
          workspaceRef.current.accuracy,
          true,
        );
        threeRef.current.lastOverlaySync = performance.now();
        threeRef.current.needsRender = true;
      }
    },
    [setMarqueeFromState, toPlanePointAtY, updateModifierEdgeHover, updateRulerHover, updateSketchFaceHover, updateTransform],
  );

  const handlePointerLeave = useCallback(() => {
    if (modifierActiveRef.current) clearModifierEdgeHover();
    if (sketchFacePickModeRef.current) clearSketchFaceHover();
  }, [clearModifierEdgeHover, clearSketchFaceHover]);

  const handleLostPointerCapture = useCallback(() => {
    if (transformRef.current || dragRef.current || marqueeRef.current) {
      cancelActiveInteraction();
    }
  }, [cancelActiveInteraction]);

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = threeRef.current;
      const transform = transformRef.current;
      if (transform) {
        if (event.currentTarget.hasPointerCapture(transform.pointerId)) {
          event.currentTarget.releasePointerCapture(transform.pointerId);
        }
        if (transform.kind === "lift") {
          setPinnedMeasureKey(getElevationMeasureKey(transformOverlayRef.current));
        }
        if (transform.kind === "lift" && transform.hasMoved) {
          suppressLiftEditAfterDrag();
        }
        const openedRotationEditor = transform.kind === "rotate" && Boolean(transform.hasMoved);
        if (openedRotationEditor) {
          suppressRotationEditAfterDrag();
        }
        transformRef.current = null;
        setActiveTransformKind(null);
        if (!openedRotationEditor) {
          setActiveRotationWheel(false);
          setPinnedRotationWheelView(null);
          setRotationReadout(null);
        }
        if (state) {
          syncCutPreviewOverlays(state, shapesRef.current);
          setSelectionHelpersVisible(state, true);
          state.controls.enabled = true;
          state.needsRender = true;
        }
        onInteractionActiveChange?.(false);
        if (openedRotationEditor) {
          openRotationEditorAfterDrag(transform);
        }
        return;
      }

      const marquee = marqueeRef.current;
      if (marquee) {
        if (event.currentTarget.hasPointerCapture(marquee.pointerId)) {
          event.currentTarget.releasePointerCapture(marquee.pointerId);
        }
        marqueeRef.current = null;
        setMarqueeFromState(null);
        if (marquee.hasMoved) {
          const rect = {
            left: Math.min(marquee.startX, marquee.currentX),
            right: Math.max(marquee.startX, marquee.currentX),
            top: Math.min(marquee.startY, marquee.currentY),
            bottom: Math.max(marquee.startY, marquee.currentY),
          };
          const selected = shapesInMarquee(rect);
          if (marquee.additive) {
            const merged = [...selectedIdsRef.current];
            selected.forEach((id) => {
              if (!merged.includes(id)) {
                merged.push(id);
              }
            });
            onSelectShape(merged);
          } else {
            onSelectShape(selected);
          }
        } else if (!marquee.additive) {
          onSelectShape(null);
        }
        if (state) {
          state.controls.enabled = true;
        }
        onInteractionActiveChange?.(false);
        return;
      }

      const drag = dragRef.current;
      if (!drag) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }

      let movedShape = false;
      drag.items.forEach((item) => {
        if (item.visual && item.hadPreviewSimplified) {
          setComplexEdgeVisibility(item.visual, true);
        }
        const shape = shapesRef.current.find((entry) => entry.id === item.id);
        if (shape && (shape.x !== item.nextX || shape.z !== item.nextZ)) {
          movedShape = true;
          onUpdateShape(item.id, { x: item.nextX, z: item.nextZ });
        }
      });

      dragRef.current = null;
      if (state) {
        // A moved shape triggers the shapes effect, which rebuilds this preview.
        // Running it here as well makes cylinder/hole CSG execute twice on release.
        if (!movedShape) {
          syncCutPreviewOverlays(state, shapesRef.current);
        }
        state.controls.enabled = true;
        state.needsRender = true;
      }
      onInteractionActiveChange?.(false);
    },
    [onInteractionActiveChange, onSelectShape, onUpdateShape, openRotationEditorAfterDrag, rememberResizeAnchor, setMarqueeFromState, shapesInMarquee, suppressLiftEditAfterDrag, suppressRotationEditAfterDrag],
  );

  const clearAssetPlacementPreview = useCallback(() => {
    const state = threeRef.current;
    if (!state) {
      return;
    }
    clearAssetPlacementPreviewObject(state);
    state.needsRender = true;
  }, []);

  const updateAssetPlacementPreview = useCallback(
    (clientX: number, clientY: number) => {
      const state = threeRef.current;
      const asset = getShapeAssetDrag();
      if (!state || !asset || rulerMoveModeRef.current) {
        return;
      }
      const point = toPlanePoint(clientX, clientY);
      const elevation = placementElevationRef.current;
      const x = point?.x ?? 0;
      const z = point?.z ?? 0;
      syncAssetPlacementPreview(state, asset, x, z, elevation);
      state.needsRender = true;
    },
    [toPlanePoint],
  );

  const handleAssetDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      if (!getShapeAssetDrag() && !event.dataTransfer.types.includes("application/x-sketchforge-shape")) {
        return;
      }
      setAssetDragOver(true);
      updateAssetPlacementPreview(event.clientX, event.clientY);
    },
    [updateAssetPlacementPreview],
  );

  const handleAssetDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!getShapeAssetDrag() && !event.dataTransfer.types.includes("application/x-sketchforge-shape")) {
        return;
      }
      setAssetDragOver(true);
      updateAssetPlacementPreview(event.clientX, event.clientY);
    },
    [updateAssetPlacementPreview],
  );

  const handleAssetDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) {
        return;
      }
      setAssetDragOver(false);
      clearAssetPlacementPreview();
    },
    [clearAssetPlacementPreview],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setAssetDragOver(false);
      clearAssetPlacementPreview();
      if (rulerMoveModeRef.current) return;
      const raw = event.dataTransfer.getData("application/x-sketchforge-shape");
      const asset = (raw ? parseDroppedShapeAsset(raw) : null) ?? getShapeAssetDrag();
      endShapeAssetDrag();
      if (!asset) {
        return;
      }
      const point = toPlanePoint(event.clientX, event.clientY);
      onAddShape(asset, point ? { ...point, elevation: placementElevationRef.current } : { x: 0, z: 0, elevation: placementElevationRef.current });
    },
    [clearAssetPlacementPreview, onAddShape, toPlanePoint],
  );

  useEffect(() => {
    const onDragEnd = () => {
      setAssetDragOver(false);
      clearAssetPlacementPreview();
      endShapeAssetDrag();
    };
    window.addEventListener("dragend", onDragEnd);
    return () => window.removeEventListener("dragend", onDragEnd);
  }, [clearAssetPlacementPreview]);

  const resetView = useCallback(() => {
    const state = threeRef.current;
    if (state) {
      resetCamera(state);
      state.needsRender = true;
    }
  }, []);

  const applyViewCubeFace = useCallback((face: ViewCubeFace) => {
    const state = threeRef.current;
    if (!state) {
      return;
    }
    setCameraToViewFace(state, face);
    syncViewCube(state, viewCubeRef.current);
  }, []);

  const onViewCubePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    viewCubeDragRef.current = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      dragged: false,
      face: viewCubeFaceFromTarget(event.target),
      capturer: null,
    };
  }, []);

  const onViewCubePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = viewCubeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const state = threeRef.current;
    if (!state) {
      return;
    }
    const deltaX = event.clientX - drag.lastX;
    const deltaY = event.clientY - drag.lastY;
    if (!drag.dragged) {
      if (Math.hypot(deltaX, deltaY) < 4) {
        return;
      }
      // Capture only after the pointer actually moves so face clicks still work.
      drag.dragged = true;
      drag.capturer = event.currentTarget;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    orbitCameraByPointerDelta(state, deltaX, deltaY);
    syncViewCube(state, viewCubeRef.current);
  }, []);

  const onViewCubePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = viewCubeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.capturer?.hasPointerCapture(event.pointerId)) {
      drag.capturer.releasePointerCapture(event.pointerId);
    }
    const face = drag.face;
    const wasDrag = drag.dragged;
    viewCubeDragRef.current = null;
    if (!wasDrag && face) {
      applyViewCubeFace(face);
    }
  }, [applyViewCubeFace]);

  const zoomCamera = useCallback((scale: number) => {
    const state = threeRef.current;
    if (!state) {
      return;
    }

    const offset = state.camera.position.clone().sub(state.controls.target);
    const distance = clamp(offset.length() * scale, 22, 4200);
    offset.setLength(distance);
    state.camera.position.copy(state.controls.target).add(offset);
    state.camera.updateProjectionMatrix();
    state.controls.update();
    state.needsRender = true;
  }, []);

  const toggleRulerTools = useCallback(() => {
    const next = !rulerToolsOpen;
    setRulerToolsOpen(next);
    if (next) {
      setXrayControlsOpen(false);
    }
    setRulerActive(false);
    rulerDeleteModeRef.current = false;
    setRulerDeleteMode(false);
    rulerMoveModeRef.current = false;
    setRulerMoveMode(false);
    if (next) {
      onWorkplaneModeChange(false);
    }
  }, [onWorkplaneModeChange, rulerToolsOpen, setRulerActive]);

  const activateRulerAdd = useCallback(() => {
    rulerDeleteModeRef.current = false;
    setRulerDeleteMode(false);
    rulerMoveModeRef.current = false;
    setRulerMoveMode(false);
    setRulerActive(true);
    onWorkplaneModeChange(false);
  }, [onWorkplaneModeChange, setRulerActive]);

  const activateRulerDelete = useCallback(() => {
    setRulerActive(false);
    rulerMoveModeRef.current = false;
    setRulerMoveMode(false);
    rulerDeleteModeRef.current = true;
    setRulerDeleteMode(true);
    onWorkplaneModeChange(false);
  }, [onWorkplaneModeChange, setRulerActive]);

  const activateRulerMove = useCallback(() => {
    setRulerActive(false);
    rulerDeleteModeRef.current = false;
    setRulerDeleteMode(false);
    rulerMoveModeRef.current = true;
    setRulerMoveMode(true);
    onWorkplaneModeChange(false);
    onSelectShape(null);
  }, [onSelectShape, onWorkplaneModeChange, setRulerActive]);

  const collapseCameraControls = useCallback(() => {
    setCameraControlsCollapsed(true);
    setRulerToolsOpen(false);
    setXrayControlsOpen(false);
    setRulerActive(false);
    rulerDeleteModeRef.current = false;
    setRulerDeleteMode(false);
    rulerMoveModeRef.current = false;
    setRulerMoveMode(false);
    rulerPointDragRef.current = null;
  }, [setRulerActive]);

  const xrayBounds = useMemo(() => xrayHeightBounds(shapes), [shapes]);

  useEffect(() => {
    setXrayHeight((current) => Math.min(xrayBounds.max, Math.max(xrayBounds.min, current)));
  }, [xrayBounds.max, xrayBounds.min]);

  useEffect(() => {
    applyXrayClipping(threeRef.current, xrayEnabled, xrayHeight);
  }, [xrayEnabled, xrayHeight]);

  const toggleXrayEnabled = useCallback(() => {
    setXrayEnabled((enabled) => {
      const next = !enabled;
      if (next) {
        setXrayControlsOpen(true);
        setRulerToolsOpen(false);
        const bounds = xrayHeightBounds(shapesRef.current);
        setXrayHeight((current) => {
          if (current > bounds.min && current < bounds.max) {
            return current;
          }
          return Math.round(bounds.min + (bounds.max - bounds.min) * 0.55);
        });
      }
      return next;
    });
  }, []);

  const handleRulerPointPointerDown = useCallback(
    (event: ReactPointerEvent<SVGCircleElement>, pointId: string) => {
      if (event.button !== 0) {
        return;
      }
      if (rulerDeleteModeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        removeRulerPoint(pointId);
        return;
      }
      if (rulerMoveModeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        rulerPointDragRef.current = { pointId, pointerId: event.pointerId };
        return;
      }
      if (!rulerModeRef.current) {
        return;
      }
      const point = rulerModelRef.current.points.find((candidate) => candidate.id === pointId);
      if (!point) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const state = threeRef.current;
      const world = state ? rulerPointWorld(state, point) : new THREE.Vector3(point.x, point.y, point.z);
      selectRulerCandidate({ x: world.x, y: world.y, z: world.z, pointId, attachment: point.attachment });
    },
    [removeRulerPoint, selectRulerCandidate],
  );

  const handleRulerPointPointerMove = useCallback(
    (event: ReactPointerEvent<SVGCircleElement>, pointId: string) => {
      const drag = rulerPointDragRef.current;
      if (!rulerMoveModeRef.current || !drag || drag.pointId !== pointId || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const candidate = resolveRulerCandidate(event.clientX, event.clientY, pointId);
      if (!candidate) return;
      const current = rulerModelRef.current;
      storeRulerModel({
        ...current,
        points: current.points.map((point) => point.id === pointId ? {
          ...point,
          x: candidate.x,
          y: candidate.y,
          z: candidate.z,
          attachment: candidate.attachment,
        } : point),
        segments: current.segments.map((segment) => segment.startId === pointId || segment.endId === pointId ? { ...segment, edge: undefined } : segment),
        hover: candidate,
      });
    },
    [resolveRulerCandidate, storeRulerModel],
  );

  const handleRulerPointPointerUp = useCallback(
    (event: ReactPointerEvent<SVGCircleElement>, pointId: string) => {
      const drag = rulerPointDragRef.current;
      if (!drag || drag.pointId !== pointId || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      rulerPointDragRef.current = null;
      const current = rulerModelRef.current;
      storeRulerModel({ ...current, hover: null });
    },
    [storeRulerModel],
  );

  const handleRulerSegmentPointerDown = useCallback(
    (event: ReactPointerEvent<SVGElement>, segmentId: string) => {
      if (event.button !== 0) {
        return;
      }
      if (rulerDeleteModeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        removeRulerSegment(segmentId);
        return;
      }
      if (!rulerModeRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const candidate = resolveRulerCandidate(event.clientX, event.clientY);
      if (candidate) {
        selectRulerCandidate(candidate);
      }
    },
    [removeRulerSegment, resolveRulerCandidate, selectRulerCandidate],
  );

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || isHotkeyRecordingActive()) {
        return;
      }

      const action = matchHotkeyAction(event, hotkeys, ["escape", "cameraHome", "zoomIn", "zoomOut"]);
      if (!action) return;

      if (action === "escape" && (sketchFacePickModeRef.current || rulerToolsOpen || xrayControlsOpen || rulerModeRef.current || rulerDeleteModeRef.current || rulerMoveModeRef.current)) {
        event.preventDefault();
        if (sketchFacePickModeRef.current) {
          clearSketchFaceHover();
          onSketchFacePickCancelRef.current?.();
          return;
        }
        setRulerActive(false);
        rulerDeleteModeRef.current = false;
        setRulerDeleteMode(false);
        rulerMoveModeRef.current = false;
        setRulerMoveMode(false);
        rulerPointDragRef.current = null;
        setRulerToolsOpen(false);
        setXrayControlsOpen(false);
        return;
      }
      if (action === "cameraHome") {
        event.preventDefault();
        resetView();
        return;
      }
      if (action === "zoomIn") {
        event.preventDefault();
        zoomCamera(0.72);
        return;
      }
      if (action === "zoomOut") {
        event.preventDefault();
        zoomCamera(1.28);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearSketchFaceHover, hotkeys, resetView, rulerToolsOpen, setRulerActive, xrayControlsOpen, zoomCamera]);

  return (
    <main className="workplane-stage">
      <div className="workplane-canvas-host">
      <div
        className="view-cube"
        aria-label="View orientation cube — drag to orbit, click a face to snap"
        onPointerDown={onViewCubePointerDown}
        onPointerMove={onViewCubePointerMove}
        onPointerUp={onViewCubePointerUp}
        onPointerCancel={onViewCubePointerUp}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="view-cube-inner" ref={viewCubeRef}>
          <button type="button" className="cube-face cube-top" data-view-cube-face="bottom" aria-label="Bottom view">BOTTOM</button>
          <button type="button" className="cube-face cube-bottom" data-view-cube-face="top" aria-label="Top view">TOP</button>
          <button type="button" className="cube-face cube-front" data-view-cube-face="front" aria-label="Front view">FRONT</button>
          <button type="button" className="cube-face cube-back" data-view-cube-face="back" aria-label="Back view">BACK</button>
          <button type="button" className="cube-face cube-right" data-view-cube-face="right" aria-label="Right view">RIGHT</button>
          <button type="button" className="cube-face cube-left" data-view-cube-face="left" aria-label="Left view">LEFT</button>
        </div>
      </div>

      <div className={`camera-controls ${cameraControlsCollapsed ? "collapsed" : ""}`} aria-label="Camera controls">
        {cameraControlsCollapsed ? (
          <PeakTipButton className="camera-controls-toggle" label="Show controls" description={TOOL_DESCRIPTIONS.showControls} aria-expanded={false} onClick={() => setCameraControlsCollapsed(false)}>
            <ChevronRight size={24} strokeWidth={2.25} aria-hidden="true" />
          </PeakTipButton>
        ) : (
          <>
            <PeakTipButton className="camera-controls-toggle" label="Hide controls" description={TOOL_DESCRIPTIONS.hideControls} aria-expanded={true} onClick={collapseCameraControls}>
              <ChevronLeft size={24} strokeWidth={2.25} aria-hidden="true" />
            </PeakTipButton>
            <PeakTipButton label="Home" description={TOOL_DESCRIPTIONS.cameraHome} onClick={resetView}>
              <Home size={24} strokeWidth={2.25} />
            </PeakTipButton>
            <PeakTipButton label="Zoom in" description={TOOL_DESCRIPTIONS.zoomIn} onClick={() => zoomCamera(0.7)}>
              <Plus size={28} strokeWidth={2.15} />
            </PeakTipButton>
            <PeakTipButton label="Zoom out" description={TOOL_DESCRIPTIONS.zoomOut} onClick={() => zoomCamera(1.35)}>
              <Minus size={28} strokeWidth={2.15} />
            </PeakTipButton>
            <div className="ruler-control-group">
              <PeakTipButton
                className={`ruler-trigger ${rulerToolsOpen ? "active" : ""}`}
                label="Ruler tools"
                description={TOOL_DESCRIPTIONS.rulerTools}
                aria-expanded={rulerToolsOpen}
                aria-controls="ruler-tool-popover"
                onClick={toggleRulerTools}
              >
                <Ruler size={26} strokeWidth={2.2} aria-hidden="true" />
              </PeakTipButton>
              {rulerToolsOpen ? (
                <div id="ruler-tool-popover" className="ruler-tool-popover" aria-label="Ruler actions">
                  <PeakTipButton className={rulerMode ? "active" : ""} label="Add measurement" description={TOOL_DESCRIPTIONS.addMeasurement} aria-pressed={rulerMode} onClick={activateRulerAdd}>
                    <Plus size={21} strokeWidth={2.4} aria-hidden="true" />
                  </PeakTipButton>
                  <PeakTipButton className={rulerMoveMode ? "active" : ""} label="Move measurement points" description={TOOL_DESCRIPTIONS.moveMeasurement} aria-pressed={rulerMoveMode} onClick={activateRulerMove}>
                    <MousePointer2 size={20} strokeWidth={2.25} aria-hidden="true" />
                  </PeakTipButton>
                  <PeakTipButton className={`ruler-delete-button ${rulerDeleteMode ? "active" : ""}`} label="Delete measurement part" description={TOOL_DESCRIPTIONS.deleteMeasurement} aria-pressed={rulerDeleteMode} onClick={activateRulerDelete}>
                    <X size={20} strokeWidth={2.4} aria-hidden="true" />
                  </PeakTipButton>
                </div>
              ) : null}
            </div>
            <div className="xray-control-group">
              <PeakTipButton
                className={`xray-trigger ${xrayEnabled || xrayControlsOpen ? "active" : ""}`}
                label="Interior X-ray"
                description={TOOL_DESCRIPTIONS.xray}
                aria-pressed={xrayEnabled}
                aria-expanded={xrayControlsOpen}
                aria-controls="xray-tool-popover"
                onClick={() => {
                  if (xrayEnabled || xrayControlsOpen) {
                    setXrayEnabled(false);
                    setXrayControlsOpen(false);
                    return;
                  }
                  toggleXrayEnabled();
                }}
              >
                <ScanEye size={24} strokeWidth={2.2} aria-hidden="true" />
              </PeakTipButton>
              {xrayControlsOpen ? (
                <div id="xray-tool-popover" className="xray-tool-popover" aria-label="Interior X-ray controls">
                  <PeakTipButton className={xrayEnabled ? "active" : ""} label={xrayEnabled ? "Turn off X-ray" : "Turn on X-ray"} description={TOOL_DESCRIPTIONS.xrayToggle} aria-pressed={xrayEnabled} onClick={toggleXrayEnabled}>
                    <ScanEye size={18} strokeWidth={2.3} aria-hidden="true" />
                  </PeakTipButton>
                  <label className="xray-height-control">
                    <span className="xray-height-label">Cut</span>
                    <input
                      type="range"
                      min={xrayBounds.min}
                      max={xrayBounds.max}
                      step={0.5}
                      value={Math.min(xrayBounds.max, Math.max(xrayBounds.min, xrayHeight))}
                      disabled={!xrayEnabled}
                      aria-label="Cutting plane height"
                      onChange={(event) => setXrayHeight(Number(event.target.value))}
                    />
                    <span className="xray-height-value">{formatMeasure(xrayHeight, workspace.accuracy)}</span>
                  </label>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>

      <section className={`workplane-wrap ${workplaneMode ? "placing-workplane" : ""} ${sketchFacePickMode ? "sketch-face-pick-mode" : ""} ${sketchFacePickMode && sketchFaceHovering ? "sketch-face-hover" : ""} ${sketchFacePickMode && sketchFaceHoverBlocked ? "sketch-face-hover-blocked" : ""} ${rulerMode ? "ruler-mode" : ""} ${rulerDeleteMode ? "ruler-delete-mode" : ""} ${rulerMoveMode ? "ruler-move-mode" : ""} ${modifierActive ? "modifier-edge-pick" : ""}`} aria-label="Workplane">
        <div className="workplane-plane">
          <div
            className="three-workplane-host"
            ref={hostRef}
            onDragOver={handleAssetDragOver}
            onDragEnter={handleAssetDragEnter}
            onDragLeave={handleAssetDragLeave}
            onDrop={handleDrop}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onPointerLeave={handlePointerLeave}
            onLostPointerCapture={handleLostPointerCapture}
          />
          <WorkplaneEmptyCoach
            visible={
              !shapes.some((shape) => !shape.hidden)
              && !assetDragOver
              && !workplaneMode
              && !sketchFacePickMode
              && !alignMode
              && !mirrorMode
              && !modifierActive
              && !circularPatternMode
              && !rulerMode
              && !rulerDeleteMode
              && !rulerMoveMode
              && !transformOverlay
              && !marqueeRect
            }
          />
          {marqueeRect ? <div className="selection-marquee" style={marqueeRect} /> : null}
          {transformOverlay && !alignMode && !mirrorMode && !rulerMode && !rulerDeleteMode && !rulerMoveMode && !modifierActive ? (
            <TransformOverlay
              box={transformOverlay}
              measureKey={pinnedMeasureKey ?? hoverMeasureKey}
              editingDimension={editingDimension}
              editingRotation={editingRotation}
              rotationReadout={rotationReadout}
              showRotationWheel={activeRotationWheel}
              hideSelectionChrome={activeTransformKind === "rotate"}
              hideDimensionMarks={activeTransformKind === "scale"}
              rotationWheelAxis={rotationWheelAxis}
              pinnedRotationWheelView={pinnedRotationWheelView}
              onBeginTransform={beginTransform}
              onMoveTransform={updateTransform}
              onFinishTransform={finishTransform}
              onHoverMeasure={setHoverMeasureKey}
              onPinMeasure={setPinnedMeasureKey}
              onBeginDimensionEdit={beginDimensionEdit}
              onBeginLiftEdit={beginLiftEdit}
              onDropSelectionToWorkplane={onDropToWorkplane}
              onEditingDimensionChange={(value) => setEditingDimension((current) => (current ? { ...current, value } : current))}
              onCommitDimensionEdit={commitDimensionEdit}
              onCancelDimensionEdit={cancelDimensionEdit}
              onBeginRotationEdit={beginRotationEdit}
              onEditingRotationChange={(value) => {
                setEditingRotation((current) => {
                  if (!current) {
                    return current;
                  }
                  const next = { ...current, value };
                  editingRotationRef.current = next;
                  return next;
                });
              }}
              onCommitRotationEdit={commitRotationEdit}
              onCancelRotationEdit={cancelRotationEdit}
            />
          ) : null}
          {alignOverlay ? <AlignOverlay overlay={alignOverlay} onAlign={onAlignSelection} onPreview={onAlignPreview} onPreviewClear={onAlignPreviewClear} /> : null}
          {circularPatternOverlay ? <CircularPatternOverlay overlay={circularPatternOverlay} /> : null}
          {mirrorOverlay ? <MirrorOverlay overlay={mirrorOverlay} onMirror={onMirrorSelection} onPreview={onMirrorPreview} onPreviewClear={onMirrorPreviewClear} /> : null}
          {rulerOverlay && (rulerOverlay.points.length > 0 || rulerOverlay.hover) ? (
            <RulerOverlay
              overlay={rulerOverlay}
              startPointId={rulerModel.startPointId}
              active={rulerMode || rulerMoveMode}
              deleteMode={rulerDeleteMode}
              moveMode={rulerMoveMode}
              onPointPointerDown={handleRulerPointPointerDown}
              onPointPointerMove={handleRulerPointPointerMove}
              onPointPointerUp={handleRulerPointPointerUp}
              onSegmentPointerDown={handleRulerSegmentPointerDown}
            />
          ) : null}
        </div>
      </section>

      {inspectorDockTop ? <div className="inspector-column-dock inspector-column-dock--top">{inspectorDockTop}</div> : null}
      {inspectorDock ? <div className="inspector-column-dock">{inspectorDock}</div> : null}

      <div className="grid-settings">
        <SnapGridControl snap={snap} snapOpen={snapOpen} onSnapChange={setSnap} onSnapOpenChange={setSnapOpen} />
      </div>

      <div className="workplane-viewport-bar" aria-label="Workplane controls">
        <WorkplaneDimensionsControl workspace={workspace} onChange={applyWorkspaceSettings} />
        {onSnapSelection ? (
          <PeakTipButton
            className={`workplane-viewport-bar-snap ${selectedIds.length > 0 ? "" : "disabled"}`}
            label="Snap"
            description={TOOL_DESCRIPTIONS.snap}
            disabled={selectedIds.length === 0}
            onClick={onSnapSelection}
          >
            <ToolbarSnapGridIcon />
          </PeakTipButton>
        ) : null}
      </div>

      {settingsOpen ? (
        <WorkspaceSettingsModal
          workspace={workspace}
          snap={snap}
          onWorkspaceChange={applyWorkspaceSettings}
          onSnapChange={setSnap}
          onMakeDefault={makeWorkspaceDefault}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      </div>

      {selectedShape && !rulerMode && !rulerDeleteMode && !rulerMoveMode ? (
        <div className={`shape-inspector-shell ${inspectorPanelOpen ? "open" : "collapsed"}`}>
          <PeakTipButton
            className="shape-inspector-tab"
            label={inspectorPanelOpen ? "Hide panel" : "Show panel"}
            description={inspectorPanelOpen ? "Hide the shape settings panel." : "Show the shape settings panel for the selection."}
            aria-label={inspectorPanelOpen ? "Hide shape settings panel" : "Show shape settings panel"}
            aria-expanded={inspectorPanelOpen}
            onClick={() => setInspectorPanelOpen((open) => !open)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {inspectorPanelOpen ? <ChevronRight size={18} strokeWidth={2.5} aria-hidden="true" /> : <ChevronLeft size={18} strokeWidth={2.5} aria-hidden="true" />}
          </PeakTipButton>
          <ShapeInspector
            shape={selectedShape}
            sceneShapes={shapes}
            workspace={workspace}
            onUpdate={(patch, options) => onUpdateShape(selectedShape.id, patchWithResizeAnchor(selectedShape, patch, options?.resizeAxis, lastResizeAnchorRef.current))}
            onClose={() => {
              if (activeFeatureId && onSelectFeature) {
                onSelectFeature(null);
                return;
              }
              onSelectShape(null);
            }}
            onEditSketch={onEditSketch}
            onEditSketchDimension={onEditSketchDimension}
            canSeparateParts={canSeparateParts}
            onSeparateParts={onSeparateParts}
            activeFeatureId={activeFeatureId}
            onSelectFeature={onSelectFeature}
            onSuppressFeature={onSuppressFeature}
            onReorderFeature={onReorderFeature}
            onUpdateFeature={onUpdateFeature}
            onInteractionActiveChange={onInteractionActiveChange}
          />
        </div>
      ) : null}
    </main>
  );
}

function resolveHostSize(host: HTMLElement) {
  return {
    width: Math.max(1, Math.floor(host.clientWidth)),
    height: Math.max(1, Math.floor(host.clientHeight)),
    isValid: host.clientWidth >= 2 && host.clientHeight >= 2,
  };
}

function createThreeScene(host: HTMLDivElement): ThreeState {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: shouldPreserveDrawingBufferForLocalAutomation() });
  renderer.setPixelRatio(resolvePixelRatio(window.devicePixelRatio || 1));
  const initialSize = resolveHostSize(host);
  // Keep CSS (width/height: 100%) in charge of layout; only sync the drawing buffer.
  // updateStyle=true can lock the canvas to a 0-height first paint and leave the
  // workplane stranded as a thin strip until a window resize happens.
  renderer.setSize(initialSize.width, initialSize.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = DEFAULT_WORKSPACE.showShadows;
  renderer.shadowMap.type = hardwareProfile().highEnd ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(resolveViewportBackground(DEFAULT_LIGHT_VIEWPORT_BACKGROUND));

  const camera = new THREE.PerspectiveCamera(38, initialSize.width / initialSize.height, 0.1, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.58;
  controls.zoomSpeed = 0.72;
  controls.panSpeed = 0.65;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  controls.mouseButtons = {
    LEFT: null,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.minDistance = 18;
  controls.maxDistance = 4200;
  controls.minPolarAngle = 0.06;
  controls.maxPolarAngle = Math.PI - 0.06;
  controls.target.copy(CAMERA_TARGET);

  const ambient = new THREE.HemisphereLight("#ffffff", "#d6edf5", 2.1);
  scene.add(ambient);

  const key = new THREE.DirectionalLight("#ffffff", 3.1);
  key.position.set(70, 130, 75);
  key.castShadow = true;
  key.shadow.autoUpdate = true;
  key.shadow.camera.left = -130;
  key.shadow.camera.right = 130;
  key.shadow.camera.top = 130;
  key.shadow.camera.bottom = -130;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 400;
  key.shadow.mapSize.set(hardwareProfile().shadowMapSize, hardwareProfile().shadowMapSize);
  key.shadow.bias = -0.00008;
  key.shadow.normalBias = 0.045;
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  const fill = new THREE.DirectionalLight("#c8f4ff", 1.2);
  fill.position.set(-95, 45, -60);
  scene.add(fill);

  const workplaneLayer = new THREE.Group();
  workplaneLayer.name = "Workplane";
  const shapeLayer = new THREE.Group();
  shapeLayer.name = "Shapes";
  const helperLayer = new THREE.Group();
  helperLayer.name = "SelectionHelpers";
  const modifierLayer = new THREE.Group();
  modifierLayer.name = "EdgeModifier";
  const xrayLayer = new THREE.Group();
  xrayLayer.name = "XrayCuttingPlane";
  scene.add(workplaneLayer, shapeLayer, helperLayer, modifierLayer, xrayLayer);

  const raycaster = new THREE.Raycaster();
  raycaster.params.Line = { threshold: 1.15 };
  const pointer = new THREE.Vector2();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const clippingPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 40);

  let hadValidSize = initialSize.isValid;
  const resize = () => {
    const next = resolveHostSize(host);
    // Ignore collapsed hosts (display:none / zero layout). Shrinking the buffer
    // to 1×1 here left the workplane blank when the editor was shown again.
    if (!next.isValid) {
      return;
    }
    renderer.setPixelRatio(resolvePixelRatio(window.devicePixelRatio || 1));
    renderer.setSize(next.width, next.height, false);
    camera.aspect = next.width / next.height;
    camera.updateProjectionMatrix();
    // First time the host gets a real layout, snap home so a zero-size init
    // cannot leave the camera/frustum looking past an invisible workplane.
    if (!hadValidSize) {
      resetCamera(state);
      hadValidSize = true;
    }
    state.needsRender = true;
  };

  const state = {
    renderer,
    scene,
    camera,
    controls,
    keyLight: key,
    workplaneLayer,
    shapeLayer,
    helperLayer,
    modifierLayer,
    xrayLayer,
    clippingPlane,
    xrayEnabled: false,
    xrayHeight: 40,
    raycaster,
    pointer,
    dragPlane,
    animationId: 0,
    needsRender: true,
    wasCameraMoving: false,
    lastOverlaySync: 0,
    lastViewCubeSync: 0,
    rotationHandleSides: null,
    disposeInteractionListeners: () => {},
    resize,
  };
  const requestRender = () => {
    state.needsRender = true;
  };
  const configureSketchForgeMouseButtons = (event: PointerEvent) => {
    controls.mouseButtons.LEFT = event.button === 0 && (event.ctrlKey || event.metaKey) ? THREE.MOUSE.PAN : null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  };
  const resetSketchForgeMouseButtons = () => {
    controls.mouseButtons.LEFT = null;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  };
  const preventContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };
  controls.addEventListener("change", requestRender);
  renderer.domElement.addEventListener("pointerdown", configureSketchForgeMouseButtons, { capture: true });
  renderer.domElement.addEventListener("pointerup", resetSketchForgeMouseButtons);
  renderer.domElement.addEventListener("pointercancel", resetSketchForgeMouseButtons);
  renderer.domElement.addEventListener("contextmenu", preventContextMenu);
  renderer.domElement.addEventListener("wheel", requestRender, { passive: true });
  renderer.domElement.addEventListener("pointerdown", requestRender);
  state.disposeInteractionListeners = () => {
    controls.removeEventListener("change", requestRender);
    renderer.domElement.removeEventListener("pointerdown", configureSketchForgeMouseButtons, { capture: true });
    renderer.domElement.removeEventListener("pointerup", resetSketchForgeMouseButtons);
    renderer.domElement.removeEventListener("pointercancel", resetSketchForgeMouseButtons);
    renderer.domElement.removeEventListener("contextmenu", preventContextMenu);
    renderer.domElement.removeEventListener("wheel", requestRender);
    renderer.domElement.removeEventListener("pointerdown", requestRender);
  };
  rebuildWorkplane(state, DEFAULT_WORKSPACE);
  return state;
}

function resetCamera(state: ThreeState) {
  state.controls.enabled = true;
  state.camera.up.set(0, 1, 0);
  state.camera.position.copy(CAMERA_HOME);
  state.controls.target.copy(CAMERA_TARGET);
  state.camera.lookAt(CAMERA_TARGET);
  state.camera.updateProjectionMatrix();
  state.controls.update();
  state.needsRender = true;
}

function viewCubeFaceFromTarget(target: EventTarget | null): ViewCubeFace | null {
  const element = target instanceof Element ? target.closest("[data-view-cube-face]") : null;
  const face = element?.getAttribute("data-view-cube-face");
  if (face === "top" || face === "bottom" || face === "front" || face === "back" || face === "right" || face === "left") {
    return face;
  }
  return null;
}

function setCameraToViewFace(state: ThreeState, face: ViewCubeFace) {
  const offset = state.camera.position.clone().sub(state.controls.target);
  const distance = clamp(offset.length(), 22, 4200);
  const directionByFace: Record<ViewCubeFace, THREE.Vector3> = {
    top: new THREE.Vector3(0, 1, 0),
    bottom: new THREE.Vector3(0, -1, 0),
    front: new THREE.Vector3(0, 0, 1),
    back: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    left: new THREE.Vector3(-1, 0, 0),
  };
  const direction = directionByFace[face].clone().normalize();

  state.camera.up.set(0, 1, 0);
  state.camera.position.copy(state.controls.target).add(direction.multiplyScalar(distance));
  state.camera.lookAt(state.controls.target);
  state.camera.updateProjectionMatrix();
  state.controls.update();
  state.needsRender = true;
}

const VIEW_CUBE_ORBIT_RADIANS_PER_PX = 0.0075;

function orbitCameraByPointerDelta(state: ThreeState, deltaX: number, deltaY: number) {
  const offset = state.camera.position.clone().sub(state.controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta -= deltaX * VIEW_CUBE_ORBIT_RADIANS_PER_PX;
  spherical.phi = clamp(
    spherical.phi - deltaY * VIEW_CUBE_ORBIT_RADIANS_PER_PX,
    0.08,
    Math.PI - 0.08,
  );
  spherical.makeSafe();
  offset.setFromSpherical(spherical);
  state.camera.up.set(0, 1, 0);
  state.camera.position.copy(state.controls.target).add(offset);
  state.camera.lookAt(state.controls.target);
  state.camera.updateProjectionMatrix();
  state.controls.update();
  state.needsRender = true;
}

function constrainCamera(state: ThreeState, workspace: WorkspaceSettings) {
  const target = state.controls.target;
  const previousTarget = target.clone();
  target.x = clamp(target.x, -workspace.width / 2, workspace.width / 2);
  target.y = clamp(target.y, CAMERA_MIN_TARGET_Y, CAMERA_MAX_TARGET_Y);
  target.z = clamp(target.z, -workspace.depth / 2, workspace.depth / 2);

  const targetShift = target.clone().sub(previousTarget);
  if (targetShift.lengthSq() > 0) {
    state.camera.position.add(targetShift);
    state.camera.updateProjectionMatrix();
  }
}

function syncViewCube(state: ThreeState, cube: HTMLDivElement | null) {
  if (!cube) {
    return;
  }

  const offset = state.camera.position.clone().sub(state.controls.target);
  const horizontalDistance = Math.max(0.001, Math.hypot(offset.x, offset.z));
  const pitch = THREE.MathUtils.radToDeg(Math.atan2(offset.y, horizontalDistance));
  const yaw = THREE.MathUtils.radToDeg(Math.atan2(offset.x, offset.z));
  cube.style.transform = `rotateX(${-pitch}deg) rotateY(${-yaw}deg)`;
}

function rebuildWorkplane(state: ThreeState | null, workspace: WorkspaceSettings) {
  if (!state) {
    return;
  }

  disposeChildren(state.workplaneLayer);
  state.scene.background = new THREE.Color(resolveViewportBackground(workspace.background));
  state.renderer.shadowMap.enabled = workspace.showShadows;
  state.controls.zoomSpeed = 0.28 + workspace.zoomSpeed * 0.09;

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(workspace.width, workspace.depth),
    new THREE.MeshStandardMaterial({
      color: resolveWorkplaneBaseColor(),
      transparent: true,
      opacity: 0.68,
      roughness: 0.92,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  base.name = "WorkplaneBase";
  base.rotation.x = -Math.PI / 2;
  base.receiveShadow = workspace.showShadows;
  state.workplaneLayer.add(base);

  if (workspace.showGrid) {
    state.workplaneLayer.add(createGridLines(workspace.width, workspace.depth, workspace.gridBlockSize));
  }
}

function createGridLines(width = WORKPLANE_WIDTH, depth = WORKPLANE_DEPTH, blockSize = DEFAULT_WORKSPACE.gridBlockSize) {
  const group = new THREE.Group();
  const palette = workplaneGridPalette();
  const minor = new THREE.LineBasicMaterial({ ...palette.minor, transparent: true, depthWrite: false });
  const major = new THREE.LineBasicMaterial({ ...palette.major, transparent: true, depthWrite: false });
  const axis = new THREE.LineBasicMaterial({ ...palette.axis, transparent: true, depthWrite: false });
  const minorPoints: number[] = [];
  const majorPoints: number[] = [];
  const axisPoints: number[] = [];
  const borderPoints: number[] = [];
  const pushLine = (points: number[], from: [number, number, number], to: [number, number, number]) => {
    points.push(...from, ...to);
  };
  const step = clamp(blockSize, MIN_GRID_BLOCK_SIZE, MAX_GRID_BLOCK_SIZE);
  const majorEvery = 4;
  for (const { coordinate: centeredX, index } of interiorWorkplaneGridCoordinates(width, step)) {
    const points = centeredX === 0 ? axisPoints : index % majorEvery === 0 ? majorPoints : minorPoints;
    pushLine(points, [centeredX, WORKPLANE_LINE_ELEVATION, -depth / 2], [centeredX, WORKPLANE_LINE_ELEVATION, depth / 2]);
  }

  for (const { coordinate: centeredZ, index } of interiorWorkplaneGridCoordinates(depth, step)) {
    const points = centeredZ === 0 ? axisPoints : index % majorEvery === 0 ? majorPoints : minorPoints;
    pushLine(points, [-width / 2, WORKPLANE_LINE_ELEVATION, centeredZ], [width / 2, WORKPLANE_LINE_ELEVATION, centeredZ]);
  }

  const border = new THREE.LineBasicMaterial({ ...palette.border, transparent: true, depthWrite: false });
  pushLine(borderPoints, [-width / 2, WORKPLANE_LINE_ELEVATION, -depth / 2], [width / 2, WORKPLANE_LINE_ELEVATION, -depth / 2]);
  pushLine(borderPoints, [width / 2, WORKPLANE_LINE_ELEVATION, -depth / 2], [width / 2, WORKPLANE_LINE_ELEVATION, depth / 2]);
  pushLine(borderPoints, [width / 2, WORKPLANE_LINE_ELEVATION, depth / 2], [-width / 2, WORKPLANE_LINE_ELEVATION, depth / 2]);
  pushLine(borderPoints, [-width / 2, WORKPLANE_LINE_ELEVATION, depth / 2], [-width / 2, WORKPLANE_LINE_ELEVATION, -depth / 2]);

  group.add(linesFromPoints(minorPoints, minor));
  group.add(linesFromPoints(majorPoints, major));
  group.add(linesFromPoints(axisPoints, axis));
  group.add(linesFromPoints(borderPoints, border));

  return group;
}

function linesFromPoints(points: number[], material: THREE.LineBasicMaterial) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = 1;
  return lines;
}

type CutPreviewShapeFrame = {
  shape: WorkplaneShape;
  worldBounds: THREE.Box3;
};

function shapeCutPreviewFrames(state: ThreeState, shapes: WorkplaneShape[]) {
  return shapes.reduce<Record<string, CutPreviewShapeFrame>>((frames, shape) => {
    const object = findShapeObject(state, shape.id);
    if (!object) {
      return frames;
    }
    object.updateMatrixWorld(true);
    const worldBounds = new THREE.Box3().setFromObject(object);
    if (!worldBounds.isEmpty()) {
      frames[shape.id] = { shape, worldBounds };
    }
    return frames;
  }, {});
}

type CutPreviewBrushCacheEntry = {
  signature: string;
  brush: Brush;
};

const cutPreviewBrushCache = new WeakMap<THREE.Object3D, CutPreviewBrushCacheEntry>();
const cutPreviewEvaluator = new Evaluator();
cutPreviewEvaluator.useGroups = false;
cutPreviewEvaluator.attributes = ["position", "normal"];

function cutPreviewObjectSignature(root: THREE.Object3D) {
  const parts: string[] = [];
  root.updateMatrixWorld(true);
  const inverseRoot = root.matrixWorld.clone().invert();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.visible || !(child.geometry instanceof THREE.BufferGeometry)) {
      return;
    }
    const relativeMatrix = inverseRoot.clone().multiply(child.matrixWorld);
    parts.push(child.geometry.uuid, ...relativeMatrix.elements.map((value) => value.toFixed(5)));
  });
  return parts.join(":");
}

function cutPreviewBrushFromObject(root: THREE.Object3D) {
  const signature = cutPreviewObjectSignature(root);
  const cached = cutPreviewBrushCache.get(root);
  if (cached?.signature === signature) {
    cached.brush.matrixAutoUpdate = false;
    cached.brush.matrix.copy(root.matrixWorld);
    cached.brush.matrixWorld.copy(root.matrixWorld);
    return cached.brush;
  }

  const positions: number[] = [];
  const point = new THREE.Vector3();
  const inverseRoot = root.matrixWorld.clone().invert();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.visible || !(child.geometry instanceof THREE.BufferGeometry)) {
      return;
    }

    const position = child.geometry.getAttribute("position");
    if (!position) {
      return;
    }
    const index = child.geometry.getIndex();
    const count = index?.count ?? position.count;
    const relativeMatrix = inverseRoot.clone().multiply(child.matrixWorld);
    const mirrored = relativeMatrix.determinant() < 0;
    for (let offset = 0; offset + 2 < count; offset += 3) {
      const triangle = [0, 1, 2].map((corner) => {
        const vertexIndex = index ? index.getX(offset + corner) : offset + corner;
        return point
          .set(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex))
          .applyMatrix4(relativeMatrix)
          .toArray();
      });
      if (mirrored) {
        [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
      }
      positions.push(...triangle[0], ...triangle[1], ...triangle[2]);
    }
  });

  if (positions.length < 9) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const brush = new Brush(geometry);
  brush.matrixAutoUpdate = false;
  brush.matrix.copy(root.matrixWorld);
  brush.matrixWorld.copy(root.matrixWorld);
  if (cached) {
    cached.brush.geometry.dispose();
  }
  cutPreviewBrushCache.set(root, { signature, brush });
  return brush;
}

function cutPreviewActualIntersectionGeometry(state: ThreeState, solid: WorkplaneShape, hole: WorkplaneShape) {
  const solidObject = findShapeObject(state, solid.id);
  const holeObject = findShapeObject(state, hole.id);
  if (!solidObject || !holeObject) {
    return null;
  }

  const solidBrush = cutPreviewBrushFromObject(solidObject);
  const holeBrush = cutPreviewBrushFromObject(holeObject);
  if (!solidBrush || !holeBrush) {
    return null;
  }

  // Equal-height cylinders have coplanar caps. Feeding those surfaces directly
  // to three-bvh-csg can turn a few hundred input triangles into hundreds of
  // thousands of preview triangles. A tiny local expansion preserves the
  // visible cut while keeping the preview topology bounded.
  const holeScale = new THREE.Matrix4().makeScale(
    (shapeWidth(hole) + CUT_PREVIEW_PADDING * 2) / Math.max(MIN_SHAPE_SIZE, shapeWidth(hole)),
    (hole.height + CUT_PREVIEW_PADDING * 2) / Math.max(MIN_SHAPE_SIZE, hole.height),
    (shapeDepth(hole) + CUT_PREVIEW_PADDING * 2) / Math.max(MIN_SHAPE_SIZE, shapeDepth(hole)),
  );
  const paddedHoleMatrix = holeBrush.matrix.clone().multiply(holeScale);
  // Never mutate the WeakMap-cached brush matrix — padding would accumulate across previews.
  const savedMatrix = holeBrush.matrix.clone();
  const savedMatrixWorld = holeBrush.matrixWorld.clone();
  holeBrush.matrix.copy(paddedHoleMatrix);
  holeBrush.matrixWorld.copy(paddedHoleMatrix);

  try {
    const result = cutPreviewEvaluator.evaluate(solidBrush, holeBrush, HOLLOW_INTERSECTION);
    const position = result.geometry.getAttribute("position");
    if (!position || position.count < 3) {
      result.geometry.dispose();
      return null;
    }
    const geometry = result.geometry.clone();
    geometry.applyMatrix4(result.matrixWorld);
    result.geometry.dispose();
    geometry.computeVertexNormals();
    return geometry;
  } catch {
    return null;
  } finally {
    holeBrush.matrix.copy(savedMatrix);
    holeBrush.matrixWorld.copy(savedMatrixWorld);
  }
}

function addCutPreviewOverlays(state: ThreeState, holeFrame: CutPreviewShapeFrame, solidFrames: CutPreviewShapeFrame[]) {
  solidFrames.forEach((solidFrame) => {
    if (!holeFrame.worldBounds.intersectsBox(solidFrame.worldBounds)) {
      return;
    }

    const geometry = cutPreviewActualIntersectionGeometry(state, solidFrame.shape, holeFrame.shape);
    if (!geometry) {
      return;
    }
    const preview = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: "#30363a",
        transparent: true,
        opacity: 0.34,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    preview.name = "CutPreviewOverlay";
    preview.renderOrder = 18;
    preview.userData.cutPreview = true;
    preview.raycast = () => undefined;
    state.shapeLayer.add(preview);
  });
}

let cutPreviewSyncTimer: ReturnType<typeof setTimeout> | null = null;
let cutPreviewSyncGeneration = 0;

/** Drop any pending CSG cut-preview so it cannot hitch a drag/transform frame. */
function cancelScheduledCutPreviewOverlays() {
  cutPreviewSyncGeneration += 1;
  if (cutPreviewSyncTimer !== null) {
    clearTimeout(cutPreviewSyncTimer);
    cutPreviewSyncTimer = null;
  }
}

function clearCutPreviewOverlays(state: ThreeState) {
  cancelScheduledCutPreviewOverlays();
  const overlays: THREE.Object3D[] = [];
  state.shapeLayer.traverse((child) => {
    if (child.userData.cutPreview) {
      overlays.push(child);
    }
  });
  overlays.forEach((overlay) => {
    overlay.parent?.remove(overlay);
    disposeObject(overlay);
  });
}

function syncCutPreviewOverlays(state: ThreeState, shapes: WorkplaneShape[]) {
  // Drop any pending debounce, then rebuild overlays now.
  cancelScheduledCutPreviewOverlays();
  const overlays: THREE.Object3D[] = [];
  state.shapeLayer.traverse((child) => {
    if (child.userData.cutPreview) {
      overlays.push(child);
    }
  });
  overlays.forEach((overlay) => {
    overlay.parent?.remove(overlay);
    disposeObject(overlay);
  });
  const visibleShapes = shapes.filter((shape) => !shape.hidden);
  const holeCount = visibleShapes.reduce((count, shape) => count + (shape.hole ? 1 : 0), 0);
  if (holeCount === 0) {
    applyXrayClipping(state, state.xrayEnabled, state.xrayHeight);
    return;
  }
  const cutFrames = shapeCutPreviewFrames(state, visibleShapes);
  const solidFrames = visibleShapes
    .filter((shape) => !shape.hole)
    .map((shape) => cutFrames[shape.id])
    .filter((frame): frame is CutPreviewShapeFrame => Boolean(frame));

  if (solidFrames.length === 0) {
    applyXrayClipping(state, state.xrayEnabled, state.xrayHeight);
    return;
  }

  visibleShapes.forEach((shape) => {
    if (!shape.hole) {
      return;
    }
    const holeFrame = cutFrames[shape.id];
    if (holeFrame) {
      addCutPreviewOverlays(state, holeFrame, solidFrames);
    }
  });
  applyXrayClipping(state, state.xrayEnabled, state.xrayHeight);
}

/** Debounce CSG cut-preview so fingerprint rebuilds don't hitch the main thread. */
function scheduleCutPreviewOverlays(state: ThreeState, shapes: WorkplaneShape[]) {
  const generation = ++cutPreviewSyncGeneration;
  if (cutPreviewSyncTimer !== null) {
    clearTimeout(cutPreviewSyncTimer);
  }
  cutPreviewSyncTimer = setTimeout(() => {
    cutPreviewSyncTimer = null;
    if (generation !== cutPreviewSyncGeneration) return;
    syncCutPreviewOverlays(state, shapes);
    state.needsRender = true;
  }, 48);
}

function shapeRenderFingerprint(shape: WorkplaneShape, showEdges: boolean) {
  const quality = getActiveDisplayQuality();
  return `${projectShapesFingerprint([shape])}|edges:${showEdges ? 1 : 0}${shapeTessellationFingerprint(shape, quality)}`;
}

function rebuildShapes(state: ThreeState | null, shapes: WorkplaneShape[], selectedIds: string[], showCutPreviews = true) {
  if (!state) {
    return;
  }

  const selected = new Set(selectedIds);
  const visibleShapes = shapes.filter((shape) => !shape.hidden);
  const existingById = new Map<string, THREE.Object3D>();
  for (const child of [...state.shapeLayer.children]) {
    const shapeId = child.userData.shapeId as string | undefined;
    if (shapeId) {
      existingById.set(shapeId, child);
    }
  }

  const keepIds = new Set<string>();
  visibleShapes.forEach((shape) => {
    const showEdges = selected.has(shape.id);
    const fingerprint = shapeRenderFingerprint(shape, showEdges);
    const existing = existingById.get(shape.id);
    if (existing && existing.userData.renderFingerprint === fingerprint) {
      keepIds.add(shape.id);
      return;
    }
    if (existing) {
      state.shapeLayer.remove(existing);
      disposeObject(existing);
      existingById.delete(shape.id);
    }
    const object = createShapeObject(shape, showEdges, () => {
      state.needsRender = true;
    });
    object.userData.renderFingerprint = fingerprint;
    state.shapeLayer.add(object);
    keepIds.add(shape.id);
  });

  for (const [shapeId, object] of existingById) {
    if (!keepIds.has(shapeId)) {
      state.shapeLayer.remove(object);
      disposeObject(object);
    }
  }

  if (showCutPreviews) {
    scheduleCutPreviewOverlays(state, visibleShapes);
  } else {
    // Cancel pending CSG + remove overlays so hole drags stay as light as solid drags.
    clearCutPreviewOverlays(state);
  }

  rebuildSelectionHelpers(state, shapes, selectedIds);
  applyXrayClipping(state, state.xrayEnabled, state.xrayHeight);
}

function applyMaterialClipping(material: THREE.Material | THREE.Material[], planes: THREE.Plane[], enableDoubleSide: boolean) {
  const materials = Array.isArray(material) ? material : [material];
  for (const mat of materials) {
    if (!mat) {
      continue;
    }
    mat.clippingPlanes = planes;
    mat.clipShadows = planes.length > 0;
    if ("side" in mat) {
      const meshMat = mat as THREE.MeshStandardMaterial;
      if (enableDoubleSide) {
        if (meshMat.userData._xrayPrevSide === undefined) {
          meshMat.userData._xrayPrevSide = meshMat.side;
        }
        meshMat.side = THREE.DoubleSide;
      } else if (meshMat.userData._xrayPrevSide !== undefined) {
        meshMat.side = meshMat.userData._xrayPrevSide;
        delete meshMat.userData._xrayPrevSide;
      }
    }
    mat.needsUpdate = true;
  }
}

function syncXrayHelper(state: ThreeState, enabled: boolean, height: number) {
  disposeChildren(state.xrayLayer);
  if (!enabled) {
    return;
  }

  const size = Math.max(WORKPLANE_WIDTH, WORKPLANE_DEPTH) * 1.15;
  const geometry = new THREE.PlaneGeometry(size, size);
  const fill = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: "#17b7e5",
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.y = height;
  fill.name = "XrayPlaneFill";
  fill.renderOrder = 980;

  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color: "#079bc6",
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  outline.rotation.x = -Math.PI / 2;
  outline.position.y = height;
  outline.name = "XrayPlaneOutline";
  outline.renderOrder = 981;

  state.xrayLayer.add(fill, outline);
}

function applyXrayClipping(state: ThreeState | null, enabled: boolean, height: number) {
  if (!state) {
    return;
  }

  state.xrayEnabled = enabled;
  state.xrayHeight = height;
  // Keep geometry below the plane; discard everything above (drop-down cut).
  state.clippingPlane.normal.set(0, -1, 0);
  state.clippingPlane.constant = height;
  const planes = enabled ? [state.clippingPlane] : [];

  const applyToLayer = (layer: THREE.Group) => {
    layer.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Line)) {
        return;
      }
      applyMaterialClipping(object.material, planes, enabled && object instanceof THREE.Mesh);
    });
  };

  applyToLayer(state.shapeLayer);
  applyToLayer(state.helperLayer);
  applyToLayer(state.modifierLayer);
  syncXrayHelper(state, enabled, height);
  state.needsRender = true;
}

function modifierEdgeMaterialStyle(active: boolean, hovered: boolean, previewActive: boolean) {
  const subduedSelectedPreviewEdge = previewActive && active && !hovered;
  return {
    color: active ? (hovered ? "#ffbf45" : "#ff8a1d") : hovered ? "#84edff" : "#17b7e5",
    opacity: subduedSelectedPreviewEdge ? 0.18 : active || hovered ? 1 : 0.72,
    linewidth: active || hovered ? 3 : 1,
  };
}

function modifierEdgeAppearance(line: THREE.Line, active: boolean, hovered: boolean, previewActive: boolean) {
  const style = modifierEdgeMaterialStyle(active, hovered, previewActive);
  const material = line.material as THREE.LineBasicMaterial;
  material.color.set(style.color);
  material.opacity = style.opacity;
  material.linewidth = style.linewidth;
  line.renderOrder = hovered ? 1003 : active ? 1002 : 1001;
}

function rebuildModifierEdges(state: ThreeState | null, edges: CadModifierEdge[], selectedIds: number[], previewActive = false, hoverId: number | null = null) {
  if (!state) return;
  const selected = new Set(selectedIds);
  const drawable = edges.filter((edge) => edge.points.length >= 6);

  // Moving the pointer across a part only changes colour and draw order. Disposing and rebuilding
  // every edge geometry for that made hovering a filleted part with hundreds of edges allocate a
  // fresh BufferGeometry per edge per mouse move. Reuse the lines whenever the edge data is the
  // same array we built them from, so stale points can never be shown.
  const built = state.modifierLayer.userData.modifierEdgeSource as CadModifierEdge[] | undefined;
  if (built === edges && state.modifierLayer.children.length === drawable.length) {
    const byId = new Map<number, THREE.Line>();
    for (const child of state.modifierLayer.children) {
      if (child instanceof THREE.Line && typeof child.userData.modifierEdgeId === "number") {
        byId.set(child.userData.modifierEdgeId, child);
      }
    }
    if (drawable.every((edge) => byId.has(edge.id))) {
      for (const edge of drawable) {
        modifierEdgeAppearance(byId.get(edge.id)!, selected.has(edge.id), hoverId === edge.id, previewActive);
      }
      state.needsRender = true;
      return;
    }
  }

  disposeChildren(state.modifierLayer);
  state.modifierLayer.userData.modifierEdgeSource = edges;
  edges.forEach((edge) => {
    if (edge.points.length < 6) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(edge.points, 3));
    const material = new THREE.LineBasicMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    const line = new THREE.Line(geometry, material);
    line.userData.modifierEdgeId = edge.id;
    modifierEdgeAppearance(line, selected.has(edge.id), hoverId === edge.id, previewActive);
    state.modifierLayer.add(line);
  });
  applyXrayClipping(state, state.xrayEnabled, state.xrayHeight);
  state.needsRender = true;
}

function rebuildSelectionHelpers(state: ThreeState | null, shapes: WorkplaneShape[], selectedIds: string[]) {
  if (!state) {
    return;
  }

  disposeChildren(state.helperLayer);
  selectedIds.forEach((id) => {
    const shape = shapes.find((entry) => entry.id === id && !entry.hidden);
    if (!shape) {
      return;
    }
    const shadow = createSelectedGroundFootprint(shape);
    if (shadow) {
      state.helperLayer.add(shadow);
    }
  });
}

function setSelectionHelpersVisible(state: ThreeState | null, visible: boolean) {
  if (!state || state.helperLayer.visible === visible) {
    return;
  }
  state.helperLayer.visible = visible;
  state.needsRender = true;
}

function formatMeasure(value: number, accuracy: MeasurementAccuracy = DEFAULT_WORKSPACE.accuracy) {
  const zeroThreshold = 0.5 * 10 ** -accuracy;
  return cleanNearZero(value, zeroThreshold).toFixed(accuracy);
}

function makeDimensionMark(
  key: string,
  handleKey: string,
  axis: DimensionMark["axis"],
  label: string,
  fromWorld: THREE.Vector3,
  toWorld: THREE.Vector3,
  outwardWorld: THREE.Vector3,
  project: (point: THREE.Vector3) => { x: number; y: number },
): DimensionMark {
  const from = project(fromWorld);
  const to = project(toWorld);
  const outwardAxis = outwardWorld.clone();
  outwardAxis.normalize();

  const railOffset = 5.8;
  const extensionOverrun = 1.4;
  const labelOffset = 3.2;
  // Keep footprint size readouts below the green rotate bows so they stay clickable.
  const screenLabelNudgeY = axis === "width" || axis === "depth" ? 26 : 0;
  const railFrom = project(fromWorld.clone().add(outwardAxis.clone().multiplyScalar(railOffset)));
  const railTo = project(toWorld.clone().add(outwardAxis.clone().multiplyScalar(railOffset)));
  const extensionFrom = project(fromWorld.clone().add(outwardAxis.clone().multiplyScalar(railOffset + extensionOverrun)));
  const extensionTo = project(toWorld.clone().add(outwardAxis.clone().multiplyScalar(railOffset + extensionOverrun)));
  const labelPoint = project(
    fromWorld
      .clone()
      .lerp(toWorld, 0.5)
      .add(outwardAxis.clone().multiplyScalar(railOffset + labelOffset)),
  );

  return {
    key,
    handleKey,
    axis,
    label,
    x1: railFrom.x,
    y1: railFrom.y,
    x2: railTo.x,
    y2: railTo.y,
    e1x1: from.x,
    e1y1: from.y,
    e1x2: extensionFrom.x,
    e1y2: extensionFrom.y,
    e2x1: to.x,
    e2y1: to.y,
    e2x2: extensionTo.x,
    e2y2: extensionTo.y,
    labelX: labelPoint.x,
    labelY: labelPoint.y + screenLabelNudgeY,
  };
}

function updateTransformOverlayIfChanged(
  overlayRef: MutableRefObject<TransformOverlayState | null>,
  setOverlay: Dispatch<SetStateAction<TransformOverlayState | null>>,
  next: TransformOverlayState,
) {
  if (overlayRef.current && JSON.stringify(overlayRef.current) === JSON.stringify(next)) {
    return;
  }
  overlayRef.current = next;
  setOverlay(next);
}

function syncTransformOverlay(
  state: ThreeState,
  shapes: WorkplaneShape[],
  selectedIds: string[],
  overlayRef: MutableRefObject<TransformOverlayState | null>,
  setOverlay: Dispatch<SetStateAction<TransformOverlayState | null>>,
  accuracy: MeasurementAccuracy,
  keepVisibleDuringInteraction = false,
) {
  if (selectedIds.length < 1) {
    if (overlayRef.current) {
      overlayRef.current = null;
      setOverlay(null);
    }
    return;
  }

  const frame = selectionFrameForShapes(shapes, selectedIds);
  if (!frame) {
    if (overlayRef.current) {
      overlayRef.current = null;
      setOverlay(null);
    }
    return;
  }

  const rect = state.renderer.domElement.getBoundingClientRect();
  // Future edits: do not remove this. The transform overlay is projected with
  // Vector3.project(), outside Three's renderer. With OrbitControls damping, the
  // camera matrix can otherwise be one frame stale, making handles/lines trail.
  state.camera.updateMatrixWorld();
  const corners = selectionFrameCorners(frame);
  const projectedCorners = corners.map((corner) => {
    const cameraSpace = corner.clone().applyMatrix4(state.camera.matrixWorldInverse);
    const projected = corner.clone().project(state.camera);
    return { cameraSpace, projected };
  });
  const nearPlane = state.camera instanceof THREE.PerspectiveCamera ? state.camera.near : 0.1;
  const selectionRadius = Math.max(MIN_SHAPE_SIZE, Math.sqrt(frame.width ** 2 + frame.height ** 2 + frame.depth ** 2) / 2);
  const cameraDistance = state.camera.position.distanceTo(frame.center);
  // When zoomed into/through a selected object, the projected overlay can span
  // thousands of pixels even before any corner crosses the near plane. Hide it
  // at that depth instead of drawing misleading dashed lines across the scene.
  const cameraInsideSelection = cameraDistance < selectionRadius * 1.12;
  const projectionInvalid = projectedCorners.some(({ cameraSpace, projected }) => cameraSpace.z > -nearPlane * 1.5 || !Number.isFinite(projected.x) || !Number.isFinite(projected.y));
  const projectedSpanTooLarge = (() => {
    const xs = projectedCorners.map(({ projected }) => ((projected.x + 1) / 2) * rect.width);
    const ys = projectedCorners.map(({ projected }) => ((1 - projected.y) / 2) * rect.height);
    return Math.max(...xs) - Math.min(...xs) > rect.width * 4 || Math.max(...ys) - Math.min(...ys) > rect.height * 4;
  })();
  const overlayTooClose = projectionInvalid || (!keepVisibleDuringInteraction && (cameraInsideSelection || projectedSpanTooLarge));
  if (overlayTooClose) {
    if (overlayRef.current) {
      overlayRef.current = null;
      setOverlay(null);
    }
    return;
  }
  const project = (point: THREE.Vector3) => {
    const projected = point.clone().project(state.camera);
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
    };
  };

  const worldMinY = Math.min(...corners.map((corner) => corner.y));
  const worldMaxY = Math.max(...corners.map((corner) => corner.y));
  const worldMinX = Math.min(...corners.map((corner) => corner.x));
  const worldMaxX = Math.max(...corners.map((corner) => corner.x));
  const worldMinZ = Math.min(...corners.map((corner) => corner.z));
  const worldMaxZ = Math.max(...corners.map((corner) => corner.z));
  const worldCenterX = (worldMinX + worldMaxX) / 2;
  const worldCenterY = (worldMinY + worldMaxY) / 2;
  const worldCenterZ = (worldMinZ + worldMaxZ) / 2;
  const worldCenter = new THREE.Vector3(worldCenterX, worldCenterY, worldCenterZ);
  const worldHeight = Math.max(MIN_SHAPE_SIZE, worldMaxY - worldMinY);
  const liftOffset = Math.max(2, worldHeight * 0.08);
  const verticalBase = new THREE.Vector3(worldCenterX, worldMinY, worldCenterZ);
  const verticalTop = new THREE.Vector3(worldCenterX, worldMaxY, worldCenterZ);
  const showLowerHandles = state.camera.position.y < frame.center.y;
  const liftHandle = new THREE.Vector3(worldCenterX, showLowerHandles ? worldMinY - liftOffset : worldMaxY + liftOffset, worldCenterZ);
  const xFootAxis = frame.xAxis.clone().normalize();
  const zFootAxis = frame.zAxis.clone().normalize();
  const localBottomY = frame.min.y;
  const localTopY = frame.max.y;
  const footprintWorld = {
    nearLeft: framePoint(frame, frame.min.x, localBottomY, frame.max.z),
    nearRight: framePoint(frame, frame.max.x, localBottomY, frame.max.z),
    farRight: framePoint(frame, frame.max.x, localBottomY, frame.min.z),
    farLeft: framePoint(frame, frame.min.x, localBottomY, frame.min.z),
    near: framePoint(frame, 0, localBottomY, frame.max.z),
    right: framePoint(frame, frame.max.x, localBottomY, 0),
    far: framePoint(frame, 0, localBottomY, frame.min.z),
    left: framePoint(frame, frame.min.x, localBottomY, 0),
  };
  const bottomCenterWorld = framePoint(frame, 0, localBottomY, 0);
  const topCenterWorld = framePoint(frame, 0, localTopY, 0);
  const bottom = {
    nearLeft: project(footprintWorld.nearLeft),
    nearRight: project(footprintWorld.nearRight),
    farRight: project(footprintWorld.farRight),
    farLeft: project(footprintWorld.farLeft),
  };
  const mid = {
    near: project(footprintWorld.near),
    right: project(footprintWorld.right),
    far: project(footprintWorld.far),
    left: project(footprintWorld.left),
  };
  const bottomCenterPoint = project(bottomCenterWorld);
  const topPoint = project(topCenterWorld);
  const heightPoint = project(showLowerHandles ? bottomCenterWorld : topCenterWorld);
  const liftPoint = project(liftHandle);
  const centerPoint = project(frame.center);
  const footprintGuides = [
    { x1: bottom.nearLeft.x, y1: bottom.nearLeft.y, x2: bottom.nearRight.x, y2: bottom.nearRight.y },
    { x1: bottom.nearRight.x, y1: bottom.nearRight.y, x2: bottom.farRight.x, y2: bottom.farRight.y },
    { x1: bottom.farRight.x, y1: bottom.farRight.y, x2: bottom.farLeft.x, y2: bottom.farLeft.y },
    { x1: bottom.farLeft.x, y1: bottom.farLeft.y, x2: bottom.nearLeft.x, y2: bottom.nearLeft.y },
  ];
  const widthLabel = formatMeasure(frame.width, accuracy);
  const depthLabel = formatMeasure(frame.depth, accuracy);
  const heightLabel = formatMeasure(frame.height, accuracy);
  const nearOut = zFootAxis;
  const farOut = zFootAxis.clone().multiplyScalar(-1);
  const rightOut = xFootAxis;
  const leftOut = xFootAxis.clone().multiplyScalar(-1);
  const heightHandleKey = showLowerHandles ? "bottom-height" : "top-height";
  const liftHandleKey = showLowerHandles ? "lower-shape" : "lift-shape";
  const workplaneAnchor = new THREE.Vector3(worldCenterX, 0, worldCenterZ);
  const liftLabel = formatMeasure(worldMinY, accuracy);
  const makeFootprintDimensionMark = (handleKey: string, axis: "width" | "depth") => {
    if (axis === "width") {
      const useFarSide = handleKey.includes("far") || handleKey.includes("left");
      return makeDimensionMark(
        `${handleKey}-width`,
        handleKey,
        "width",
        widthLabel,
        useFarSide ? footprintWorld.farLeft : footprintWorld.nearLeft,
        useFarSide ? footprintWorld.farRight : footprintWorld.nearRight,
        useFarSide ? farOut : nearOut,
        project,
      );
    }
    const useLeftSide = handleKey.includes("left") || handleKey.includes("far");
    return makeDimensionMark(
      `${handleKey}-depth`,
      handleKey,
      "depth",
      depthLabel,
      useLeftSide ? footprintWorld.nearLeft : footprintWorld.nearRight,
      useLeftSide ? footprintWorld.farLeft : footprintWorld.farRight,
      useLeftSide ? leftOut : rightOut,
      project,
    );
  };
  const footprintHandleKeys = ["near-left", "near-right", "far-right", "far-left", "near-mid", "right-mid", "far-mid", "left-mid"];
  const footprintDimensionMarks = Object.fromEntries(
    footprintHandleKeys.map((handleKey) => {
      const axes = new Set<"width" | "depth">();
      if (handleKey.includes("left") || handleKey.includes("right")) {
        axes.add("width");
      }
      if (handleKey.includes("near") || handleKey.includes("far")) {
        axes.add("depth");
      }
      return [handleKey, Array.from(axes).map((axis) => makeFootprintDimensionMark(handleKey, axis))];
    }),
  );
  const dimensionMarks = {
    ...footprintDimensionMarks,
    [heightHandleKey]: [makeDimensionMark("height", heightHandleKey, "height", heightLabel, bottomCenterWorld, topCenterWorld, rightOut, project)],
    [liftHandleKey]: [makeDimensionMark("elevation", liftHandleKey, "elevation", liftLabel, workplaneAnchor, verticalBase, rightOut, project)],
  };
  const screenOffsetFromCenter = (point: { x: number; y: number }, distance: number) => {
    const dx = point.x - centerPoint.x;
    const dy = point.y - centerPoint.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    return {
      x: point.x + (dx / length) * distance,
      y: point.y + (dy / length) * distance,
    };
  };
  const rotationSides = rotationHandleSidesForCamera(state, worldCenter);
  const sidePoint = (side: RotationHandleSide, y: number) => {
    if (side === "right") {
      return new THREE.Vector3(worldMaxX, y, worldCenterZ);
    }
    if (side === "left") {
      return new THREE.Vector3(worldMinX, y, worldCenterZ);
    }
    if (side === "near") {
      return new THREE.Vector3(worldCenterX, y, worldMaxZ);
    }
    return new THREE.Vector3(worldCenterX, y, worldMinZ);
  };
  const wheelNudge = Math.max(10, Math.max(frame.width, frame.depth, frame.height) * 0.12);
  const yawPivot = new THREE.Vector3(worldCenterX, worldMinY, worldCenterZ);
  // Yaw sits on the oriented selection footprint (not world AABB), so the icon tracks a real box edge.
  const footprintYawEdge = (side: RotationHandleSide) => {
    if (side === "near") {
      return { mid: footprintWorld.near, start: footprintWorld.nearLeft, end: footprintWorld.nearRight };
    }
    if (side === "far") {
      return { mid: footprintWorld.far, start: footprintWorld.farLeft, end: footprintWorld.farRight };
    }
    if (side === "right") {
      return { mid: footprintWorld.right, start: footprintWorld.nearRight, end: footprintWorld.farRight };
    }
    return { mid: footprintWorld.left, start: footprintWorld.nearLeft, end: footprintWorld.farLeft };
  };
  const toCameraFlat = state.camera.position.clone().sub(bottomCenterWorld);
  toCameraFlat.y = 0;
  let yawSide: RotationHandleSide = rotationSides.y;
  if (toCameraFlat.lengthSq() > 0.0001) {
    toCameraFlat.normalize();
    const xHorizontal = new THREE.Vector3(xFootAxis.x, 0, xFootAxis.z);
    const zHorizontal = new THREE.Vector3(zFootAxis.x, 0, zFootAxis.z);
    if (xHorizontal.lengthSq() > 0.0001 && zHorizontal.lengthSq() > 0.0001) {
      xHorizontal.normalize();
      zHorizontal.normalize();
      yawSide = dominantRotationSide(toCameraFlat.dot(xHorizontal), toCameraFlat.dot(zHorizontal), state.rotationHandleSides?.y);
      if (state.rotationHandleSides) {
        state.rotationHandleSides = { ...state.rotationHandleSides, y: yawSide };
      }
    }
  }
  const yawEdge = footprintYawEdge(yawSide);
  const rotateBottomWorld = yawEdge.mid;
  const rotateBottom = screenOffsetFromCenter(project(rotateBottomWorld), ROTATION_FACE_SCREEN_OFFSET + 10);
  const yawEdgeStart = project(yawEdge.start);
  const yawEdgeEnd = project(yawEdge.end);
  let yawIconAngle = (Math.atan2(yawEdgeEnd.y - yawEdgeStart.y, yawEdgeEnd.x - yawEdgeStart.x) * 180) / Math.PI;
  // Keep the arc bow on the outside of the selection box (SVG +Y after rotate).
  {
    const outwardX = rotateBottom.x - centerPoint.x;
    const outwardY = rotateBottom.y - centerPoint.y;
    const bowX = -Math.sin((yawIconAngle * Math.PI) / 180);
    const bowY = Math.cos((yawIconAngle * Math.PI) / 180);
    if (bowX * outwardX + bowY * outwardY < 0) {
      yawIconAngle += 180;
    }
  }
  const tiltAxis = cameraFacingTiltAxis(state, frame);
  const tiltAxisVector = tiltAxis === "x" ? xFootAxis : zFootAxis;
  const tiltHandleWorld = new THREE.Vector3(liftHandle.x, liftHandle.y, liftHandle.z);
  const tiltTangent = rotationHandleTangent(tiltAxisVector, frame.center, tiltHandleWorld, tiltAxis === "x" ? zFootAxis : xFootAxis);
  const xFaceCenter = wheelCenterTowardCamera(state.camera, frame.center, sidePoint(rotationSides.x, worldCenterY), wheelNudge);
  const zFaceCenter = wheelCenterTowardCamera(state.camera, frame.center, sidePoint(rotationSides.z, worldCenterY), wheelNudge);
  const yFaceCenter = wheelCenterTowardCamera(state.camera, yawPivot, verticalBase, wheelNudge);
  const rotateHandles: Array<{ key: string; className: string; x: number; y: number; angle: number; title?: string }> = [
    {
      key: "rotate-tilt",
      className: `screen-tilt axis-${tiltAxis}`,
      x: liftPoint.x,
      y: liftPoint.y - ROTATION_TILT_ABOVE_LIFT_OFFSET,
      angle: rotationHandleIconAngle(project, tiltHandleWorld, tiltTangent),
      title: tiltAxis === "x" ? "Rotate (tilt X)" : "Rotate (tilt Z)",
    },
    {
      key: "rotate-bottom",
      className: "screen-bottom axis-y",
      x: rotateBottom.x,
      y: rotateBottom.y,
      angle: yawIconAngle,
      title: "Rotate (yaw)",
    },
  ];
  const planeRadius = 154;
  /** Screen-space circle so the protractor stays readable from every camera angle. */
  const makeBillboardPlaneView = (centerWorld: THREE.Vector3): RotationPlaneView => {
    const screenCenter = project(centerWorld);
    const unit = planeRadius / 100;
    return {
      x: screenCenter.x,
      y: screenCenter.y,
      a: unit,
      b: 0,
      c: 0,
      d: unit,
    };
  };
  const makeWheel = (centerWorld: THREE.Vector3) => {
    const screenCenter = project(centerWorld);
    return { x: screenCenter.x, y: screenCenter.y, ...rotationWheelRadiiFromPlaneRadius(planeRadius) };
  };
  const makeWorldPoint = (point: THREE.Vector3) => ({ x: point.x, y: point.y, z: point.z });
  const rotationWheels: Record<RotationAxis, RotationWheelView> = {
    x: makeWheel(xFaceCenter),
    y: makeWheel(yFaceCenter),
    z: makeWheel(zFaceCenter),
  };
  const rotationPlaneCenters: Record<RotationAxis, { x: number; y: number; z: number }> = {
    x: makeWorldPoint(xFaceCenter),
    y: makeWorldPoint(yFaceCenter),
    z: makeWorldPoint(zFaceCenter),
  };
  // Display rings face the camera. Drag math uses screen angle around the wheel (plus axis sign).
  const rotationPlanes: Record<RotationAxis, RotationPlaneView> = {
    x: makeBillboardPlaneView(xFaceCenter),
    y: makeBillboardPlaneView(yFaceCenter),
    z: makeBillboardPlaneView(zFaceCenter),
  };

  const next = {
    id: frame.ids.join("|"),
    width: rect.width,
    height: rect.height,
    guides: [
      { x1: topPoint.x, y1: topPoint.y, x2: bottomCenterPoint.x, y2: bottomCenterPoint.y },
      ...footprintGuides,
    ],
    handles: [
      { key: "near-left", className: "corner", kind: "scale" as const, x: bottom.nearLeft.x, y: bottom.nearLeft.y, title: "Resize" },
      { key: "near-right", className: "corner", kind: "scale" as const, x: bottom.nearRight.x, y: bottom.nearRight.y, title: "Resize" },
      { key: "far-right", className: "corner", kind: "scale" as const, x: bottom.farRight.x, y: bottom.farRight.y, title: "Resize" },
      { key: "far-left", className: "corner", kind: "scale" as const, x: bottom.farLeft.x, y: bottom.farLeft.y, title: "Resize" },
      { key: "near-mid", className: "edge dark", kind: "scale" as const, x: mid.near.x, y: mid.near.y, title: "Resize" },
      { key: "right-mid", className: "edge dark", kind: "scale" as const, x: mid.right.x, y: mid.right.y, title: "Resize" },
      { key: "far-mid", className: "edge dark", kind: "scale" as const, x: mid.far.x, y: mid.far.y, title: "Resize" },
      { key: "left-mid", className: "edge dark", kind: "scale" as const, x: mid.left.x, y: mid.left.y, title: "Resize" },
      { key: heightHandleKey, className: "height-top", kind: "height" as const, x: heightPoint.x, y: heightPoint.y, title: "Height" },
      { key: liftHandleKey, className: showLowerHandles ? "height-lift lower" : "height-lift", kind: "lift" as const, x: liftPoint.x, y: liftPoint.y, title: "Lift (double-click to drop to workplane)" },
    ],
    rotateHandles,
    dimensions: dimensionMarks,
    rotationWheel: rotationWheels.y,
    rotationWheels,
    rotationPlaneCenters,
    rotationPlanes,
  };

  updateTransformOverlayIfChanged(overlayRef, setOverlay, next);
}

function syncAlignOverlay(
  state: ThreeState,
  shapes: WorkplaneShape[],
  selectedIds: string[],
  alignMode: boolean,
  alignAnchorId: string | null,
  statuses: AlignHandleStatus[],
  overlayRef: MutableRefObject<AlignOverlayState | null>,
  setOverlay: Dispatch<SetStateAction<AlignOverlayState | null>>,
) {
  const clear = () => {
    if (overlayRef.current) {
      overlayRef.current = null;
      setOverlay(null);
    }
  };

  if (!alignMode || selectedIds.length < 2) {
    clear();
    return;
  }

  const selectedFrame = selectionFrameForShapes(shapes, selectedIds);
  const anchorFrame = alignAnchorId && selectedIds.includes(alignAnchorId) ? selectionFrameForShapes(shapes, [alignAnchorId]) : null;
  const frame = anchorFrame ?? selectedFrame;
  if (!frame) {
    clear();
    return;
  }

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.camera.updateMatrixWorld();
  const corners = selectionFrameCorners(frame);
  const projectedCorners = corners.map((corner) => {
    const cameraSpace = corner.clone().applyMatrix4(state.camera.matrixWorldInverse);
    const projected = corner.clone().project(state.camera);
    return { cameraSpace, projected };
  });
  const nearPlane = state.camera instanceof THREE.PerspectiveCamera ? state.camera.near : 0.1;
  if (projectedCorners.some(({ cameraSpace, projected }) => cameraSpace.z > -nearPlane * 1.5 || !Number.isFinite(projected.x) || !Number.isFinite(projected.y))) {
    clear();
    return;
  }

  const project = (point: THREE.Vector3) => {
    const projected = point.clone().project(state.camera);
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
    };
  };
  const worldMinY = Math.min(...corners.map((corner) => corner.y));
  const worldMaxY = Math.max(...corners.map((corner) => corner.y));
  const worldMinX = Math.min(...corners.map((corner) => corner.x));
  const worldMaxX = Math.max(...corners.map((corner) => corner.x));
  const worldMinZ = Math.min(...corners.map((corner) => corner.z));
  const worldMaxZ = Math.max(...corners.map((corner) => corner.z));
  const worldCenterX = (worldMinX + worldMaxX) / 2;
  const worldCenterY = (worldMinY + worldMaxY) / 2;
  const worldCenterZ = (worldMinZ + worldMaxZ) / 2;
  const offset = Math.max(8, Math.max(worldMaxX - worldMinX, worldMaxY - worldMinY, worldMaxZ - worldMinZ) * 0.16);
  const statusByKey = new Map(statuses.map((status) => [`${status.axis}:${status.target}`, status]));

  const guidePoints = {
    x0: project(new THREE.Vector3(worldMinX, worldMinY, worldMaxZ + offset)),
    x1: project(new THREE.Vector3(worldMaxX, worldMinY, worldMaxZ + offset)),
    z0: project(new THREE.Vector3(worldMaxX + offset, worldMinY, worldMinZ)),
    z1: project(new THREE.Vector3(worldMaxX + offset, worldMinY, worldMaxZ)),
    y0: project(new THREE.Vector3(worldMinX - offset, worldMinY, worldMaxZ + offset)),
    y1: project(new THREE.Vector3(worldMinX - offset, worldMaxY, worldMaxZ + offset)),
  };

  const makeHandle = (axis: AlignAxis, target: AlignTarget, point: THREE.Vector3) => {
    const status = statusByKey.get(`${axis}:${target}`);
    if (!status) {
      return null;
    }
    const screen = project(point);
    return {
      ...status,
      key: `${axis}-${target}`,
      x: screen.x,
      y: screen.y,
    };
  };

  const handles = [
    makeHandle("x", "min", new THREE.Vector3(worldMinX, worldMinY, worldMaxZ + offset)),
    makeHandle("x", "center", new THREE.Vector3(worldCenterX, worldMinY, worldMaxZ + offset)),
    makeHandle("x", "max", new THREE.Vector3(worldMaxX, worldMinY, worldMaxZ + offset)),
    makeHandle("z", "min", new THREE.Vector3(worldMaxX + offset, worldMinY, worldMinZ)),
    makeHandle("z", "center", new THREE.Vector3(worldMaxX + offset, worldMinY, worldCenterZ)),
    makeHandle("z", "max", new THREE.Vector3(worldMaxX + offset, worldMinY, worldMaxZ)),
    makeHandle("y", "min", new THREE.Vector3(worldMinX - offset, worldMinY, worldMaxZ + offset)),
    makeHandle("y", "center", new THREE.Vector3(worldMinX - offset, worldCenterY, worldMaxZ + offset)),
    makeHandle("y", "max", new THREE.Vector3(worldMinX - offset, worldMaxY, worldMaxZ + offset)),
  ].filter((handle): handle is AlignOverlayState["handles"][number] => Boolean(handle));

  const next = {
    guides: [
      { key: "x", x1: guidePoints.x0.x, y1: guidePoints.x0.y, x2: guidePoints.x1.x, y2: guidePoints.x1.y },
      { key: "z", x1: guidePoints.z0.x, y1: guidePoints.z0.y, x2: guidePoints.z1.x, y2: guidePoints.z1.y },
      { key: "y", x1: guidePoints.y0.x, y1: guidePoints.y0.y, x2: guidePoints.y1.x, y2: guidePoints.y1.y },
    ],
    handles,
  };

  overlayRef.current = next;
  setOverlay(next);
}

function syncCircularPatternOverlay(
  state: ThreeState,
  active: boolean,
  center: { x: number; z: number } | null | undefined,
  radius: number,
  overlayRef: MutableRefObject<CircularPatternOverlayState | null>,
  setOverlay: Dispatch<SetStateAction<CircularPatternOverlayState | null>>,
) {
  const clear = () => {
    if (overlayRef.current) {
      overlayRef.current = null;
      setOverlay(null);
    }
  };

  if (!active || !center) {
    clear();
    return;
  }

  const centerPoint = new THREE.Vector3(center.x, 0.05, center.z);
  const rimPoint = new THREE.Vector3(center.x + Math.max(radius, 0.01), 0.05, center.z);
  const screenCenter = projectToScreen(centerPoint, state);
  const screenRim = projectToScreen(rimPoint, state);
  if (![screenCenter.x, screenCenter.y, screenRim.x, screenRim.y].every(Number.isFinite)) {
    clear();
    return;
  }

  const next: CircularPatternOverlayState = {
    cx: screenCenter.x,
    cy: screenCenter.y,
    radiusPx: Math.hypot(screenRim.x - screenCenter.x, screenRim.y - screenCenter.y),
  };
  const previous = overlayRef.current;
  if (
    previous
    && Math.abs(previous.cx - next.cx) < 0.5
    && Math.abs(previous.cy - next.cy) < 0.5
    && Math.abs(previous.radiusPx - next.radiusPx) < 0.5
  ) {
    return;
  }
  overlayRef.current = next;
  setOverlay(next);
}

function syncMirrorOverlay(
  state: ThreeState,
  shapes: WorkplaneShape[],
  selectedIds: string[],
  mirrorMode: boolean,
  overlayRef: MutableRefObject<MirrorOverlayState | null>,
  setOverlay: Dispatch<SetStateAction<MirrorOverlayState | null>>,
) {
  const clear = () => {
    if (overlayRef.current) {
      overlayRef.current = null;
      setOverlay(null);
    }
  };

  if (!mirrorMode || selectedIds.length < 1) {
    clear();
    return;
  }

  const frame = selectionFrameForShapes(shapes, selectedIds);
  if (!frame) {
    clear();
    return;
  }

  const rect = state.renderer.domElement.getBoundingClientRect();
  state.camera.updateMatrixWorld();
  const corners = selectionFrameCorners(frame);
  const projectedCorners = corners.map((corner) => {
    const cameraSpace = corner.clone().applyMatrix4(state.camera.matrixWorldInverse);
    const projected = corner.clone().project(state.camera);
    return { cameraSpace, projected };
  });
  const nearPlane = state.camera instanceof THREE.PerspectiveCamera ? state.camera.near : 0.1;
  if (projectedCorners.some(({ cameraSpace, projected }) => cameraSpace.z > -nearPlane * 1.5 || !Number.isFinite(projected.x) || !Number.isFinite(projected.y))) {
    clear();
    return;
  }

  const project = (point: THREE.Vector3) => {
    const projected = point.clone().project(state.camera);
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((1 - projected.y) / 2) * rect.height,
    };
  };
  const screenAngle = (from: THREE.Vector3, to: THREE.Vector3) => {
    const a = project(from);
    const b = project(to);
    return THREE.MathUtils.radToDeg(Math.atan2(b.y - a.y, b.x - a.x));
  };
  const worldMinY = Math.min(...corners.map((corner) => corner.y));
  const worldMaxY = Math.max(...corners.map((corner) => corner.y));
  const worldMinX = Math.min(...corners.map((corner) => corner.x));
  const worldMaxX = Math.max(...corners.map((corner) => corner.x));
  const worldMinZ = Math.min(...corners.map((corner) => corner.z));
  const worldMaxZ = Math.max(...corners.map((corner) => corner.z));
  const worldCenterX = (worldMinX + worldMaxX) / 2;
  const worldCenterY = (worldMinY + worldMaxY) / 2;
  const worldCenterZ = (worldMinZ + worldMaxZ) / 2;
  const width = Math.max(MIN_SHAPE_SIZE, worldMaxX - worldMinX);
  const height = Math.max(MIN_SHAPE_SIZE, worldMaxY - worldMinY);
  const depth = Math.max(MIN_SHAPE_SIZE, worldMaxZ - worldMinZ);
  const offset = Math.max(10, Math.max(width, height, depth) * 0.2);
  const step = Math.max(10, Math.max(width, height, depth) * 0.28);

  const xWorld = new THREE.Vector3(worldCenterX, worldMinY, worldMaxZ + offset);
  const zWorld = new THREE.Vector3(worldMaxX + offset, worldMinY, worldCenterZ);
  const yWorld = new THREE.Vector3(worldMinX - offset, worldCenterY, worldMaxZ + offset);
  const xScreen = project(xWorld);
  const zScreen = project(zWorld);
  const yScreen = project(yWorld);
  const xGuideA = new THREE.Vector3(worldMinX, worldMinY, worldMaxZ + offset);
  const xGuideB = new THREE.Vector3(worldMaxX, worldMinY, worldMaxZ + offset);
  const zGuideA = new THREE.Vector3(worldMaxX + offset, worldMinY, worldMinZ);
  const zGuideB = new THREE.Vector3(worldMaxX + offset, worldMinY, worldMaxZ);
  const yGuideA = new THREE.Vector3(worldMinX - offset, worldMinY, worldMaxZ + offset);
  const yGuideB = new THREE.Vector3(worldMinX - offset, worldMaxY, worldMaxZ + offset);
  const xA = project(xGuideA);
  const xB = project(xGuideB);
  const zA = project(zGuideA);
  const zB = project(zGuideB);
  const yA = project(yGuideA);
  const yB = project(yGuideB);

  const next = {
    guides: [
      { key: "x", x1: xA.x, y1: xA.y, x2: xB.x, y2: xB.y },
      { key: "z", x1: zA.x, y1: zA.y, x2: zB.x, y2: zB.y },
      { key: "y", x1: yA.x, y1: yA.y, x2: yB.x, y2: yB.y },
    ],
    handles: [
      {
        axis: "x" as const,
        key: "mirror-x",
        x: xScreen.x,
        y: xScreen.y,
        angle: screenAngle(xWorld.clone().add(new THREE.Vector3(-step, 0, 0)), xWorld.clone().add(new THREE.Vector3(step, 0, 0))),
        title: "Mirror left-right",
      },
      {
        axis: "z" as const,
        key: "mirror-z",
        x: zScreen.x,
        y: zScreen.y,
        angle: screenAngle(zWorld.clone().add(new THREE.Vector3(0, 0, -step)), zWorld.clone().add(new THREE.Vector3(0, 0, step))),
        title: "Mirror front-back",
      },
      {
        axis: "y" as const,
        key: "mirror-y",
        x: yScreen.x,
        y: yScreen.y,
        angle: screenAngle(yWorld.clone().add(new THREE.Vector3(0, -step, 0)), yWorld.clone().add(new THREE.Vector3(0, step, 0))),
        title: "Mirror top-bottom",
      },
    ],
  };

  overlayRef.current = next;
  setOverlay(next);
}

function findShapeObject(state: ThreeState, id: string) {
  return state.shapeLayer.children.find((child) => child.userData.shapeId === id) ?? null;
}

function findSelectionHelper(state: ThreeState, id: string) {
  const helper = state.helperLayer.children.find((child) => child.userData.shapeId === id);
  return helper instanceof THREE.Box3Helper ? helper : null;
}

function findSelectedGroundFootprint(state: ThreeState, id: string) {
  return state.helperLayer.children.find((child) => child.name === "SelectedGroundFootprint" && child.userData.shapeId === id) ?? null;
}

function applyDragItemPreview(state: ThreeState, item: DragItem) {
  if (!item.visual || !item.visual.parent) {
    item.visual = findShapeObject(state, item.id);
  }
  if (!item.helper || !item.helper.parent) {
    item.helper = findSelectionHelper(state, item.id);
    item.helperBox = item.helper ? item.helper.box.clone() : null;
  }

  if (item.visual) {
    if (!item.hadPreviewSimplified) {
      setComplexEdgeVisibility(item.visual, false);
      item.hadPreviewSimplified = true;
    }
    item.visual.position.x = item.nextX;
    item.visual.position.z = item.nextZ;
    item.visual.updateMatrixWorld(true);
  }

  if (item.helper && item.helperBox) {
    item.helper.box.copy(item.helperBox);
    item.helper.box.translate(new THREE.Vector3(item.nextX - item.startX, 0, item.nextZ - item.startZ));
    item.helper.updateMatrixWorld(true);
  }
}

function refreshDragPreviewObjects(state: ThreeState | null, drag: DragState | null) {
  if (!state || !drag) return;
  drag.items.forEach((item) => applyDragItemPreview(state, item));
  updateSelectedGroundFootprintPreviews(state, drag);
  markShadowsDirty(state);
  state.needsRender = true;
}

function updateSelectedGroundFootprintPreviews(state: ThreeState, drag: DragState) {
  drag.items.forEach((item) => {
    const footprint = findSelectedGroundFootprint(state, item.id);
    if (!footprint) {
      return;
    }
    footprint.position.x = item.nextX - item.startX;
    footprint.position.z = item.nextZ - item.startZ;
    footprint.updateMatrixWorld(true);
  });
}

function createSelectedGroundFootprint(shape: WorkplaneShape) {
  const frame = selectionFrameForShapes([shape], [shape.id]);
  if (!frame) {
    return null;
  }

  const group = new THREE.Group();
  group.name = "SelectedGroundFootprint";
  group.userData.shapeId = shape.id;
  // Contact shadow on the workplane — always present so drag can slide it with the object.
  const y = 0.05;
  const footprint = [
    framePoint(frame, frame.min.x, frame.min.y, frame.min.z),
    framePoint(frame, frame.max.x, frame.min.y, frame.min.z),
    framePoint(frame, frame.max.x, frame.min.y, frame.max.z),
    framePoint(frame, frame.min.x, frame.min.y, frame.max.z),
  ].map((point) => new THREE.Vector3(point.x, y, point.z));
  const fillGeometry = new THREE.BufferGeometry();
  fillGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([
        footprint[0].x, footprint[0].y, footprint[0].z,
        footprint[1].x, footprint[1].y, footprint[1].z,
        footprint[2].x, footprint[2].y, footprint[2].z,
        footprint[0].x, footprint[0].y, footprint[0].z,
        footprint[2].x, footprint[2].y, footprint[2].z,
        footprint[3].x, footprint[3].y, footprint[3].z,
      ]),
      3,
    ),
  );
  fillGeometry.computeVertexNormals();
  const fill = new THREE.Mesh(
    fillGeometry,
    new THREE.MeshBasicMaterial({
      color: "#6d7c84",
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  fill.renderOrder = -1;
  group.add(fill);

  const points = [...footprint, footprint[0].clone()];
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color: "#00aeea", transparent: true, opacity: 0.92 }),
  );
  outline.userData.shapeId = shape.id;
  group.add(outline);

  return group;
}

function createTransformHandles(box: THREE.Box3, id: string) {
  const group = new THREE.Group();
  group.name = "SketchForgeTransformHandles";
  group.userData.shapeId = id;

  const handleMaterial = new THREE.MeshBasicMaterial({ color: "#e8eef1" });
  const darkMaterial = new THREE.MeshBasicMaterial({ color: "#273849" });
  const dashMaterial = new THREE.LineDashedMaterial({ color: "#2c3339", dashSize: 2.2, gapSize: 2.4, transparent: true, opacity: 0.72 });
  const handleGeometry = new THREE.BoxGeometry(2.6, 2.6, 2.6);
  const dotGeometry = new THREE.BoxGeometry(1.7, 1.7, 1.7);

  const center = box.getCenter(new THREE.Vector3());
  const topY = box.max.y + 1.4;
  const x0 = box.min.x;
  const x1 = box.max.x;
  const z0 = box.min.z;
  const z1 = box.max.z;
  const xm = center.x;
  const zm = center.z;

  const cornerPoints = [
    { key: "far-left", kind: "scale" as const, point: new THREE.Vector3(x0, box.min.y + 1.3, z0) },
    { key: "far-right", kind: "scale" as const, point: new THREE.Vector3(x1, box.min.y + 1.3, z0) },
    { key: "near-left", kind: "scale" as const, point: new THREE.Vector3(x0, box.min.y + 1.3, z1) },
    { key: "near-right", kind: "scale" as const, point: new THREE.Vector3(x1, box.min.y + 1.3, z1) },
    { key: "far-left", kind: "scale" as const, point: new THREE.Vector3(x0, topY, z0) },
    { key: "far-right", kind: "scale" as const, point: new THREE.Vector3(x1, topY, z0) },
    { key: "near-left", kind: "scale" as const, point: new THREE.Vector3(x0, topY, z1) },
    { key: "near-right", kind: "scale" as const, point: new THREE.Vector3(x1, topY, z1) },
    { key: "top-height", kind: "height" as const, point: new THREE.Vector3(xm, box.max.y + 7, zm) },
  ];

  cornerPoints.forEach(({ key, kind, point }) => {
    const handle = new THREE.Mesh(handleGeometry, handleMaterial);
    handle.position.copy(point);
    handle.userData.shapeId = id;
    handle.userData.transformHandle = kind;
    handle.userData.transformHandleKey = key;
    handle.userData.transformPlaneY = point.y;
    group.add(handle);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(handleGeometry), new THREE.LineBasicMaterial({ color: "#2d3439", transparent: true, opacity: 0.86 }));
    outline.position.copy(point);
    outline.userData.shapeId = id;
    outline.userData.transformHandle = handle.userData.transformHandle;
    outline.userData.transformHandleKey = key;
    outline.userData.transformPlaneY = point.y;
    group.add(outline);
  });

  [
    { key: "far-mid", point: new THREE.Vector3(xm, topY, z0) },
    { key: "near-mid", point: new THREE.Vector3(xm, topY, z1) },
    { key: "left-mid", point: new THREE.Vector3(x0, topY, zm) },
    { key: "right-mid", point: new THREE.Vector3(x1, topY, zm) },
    { key: "far-mid", point: new THREE.Vector3(xm, box.min.y + 1.3, z0) },
    { key: "near-mid", point: new THREE.Vector3(xm, box.min.y + 1.3, z1) },
    { key: "left-mid", point: new THREE.Vector3(x0, box.min.y + 1.3, zm) },
    { key: "right-mid", point: new THREE.Vector3(x1, box.min.y + 1.3, zm) },
  ].forEach(({ key, point }) => {
    const dot = new THREE.Mesh(dotGeometry, darkMaterial);
    dot.position.copy(point);
    dot.userData.shapeId = id;
    dot.userData.transformHandle = "scale";
    dot.userData.transformHandleKey = key;
    dot.userData.transformPlaneY = point.y;
    group.add(dot);
  });

  [
    [new THREE.Vector3(xm, box.max.y + 7, zm), new THREE.Vector3(xm, box.min.y + 1.3, zm)],
  ].forEach(([from, to]) => {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geometry, dashMaterial);
    line.computeLineDistances();
    group.add(line);
  });

  return group;
}

function clearAssetPlacementPreviewObject(state: ThreeState) {
  const existing = state.scene.getObjectByName(ASSET_PLACEMENT_PREVIEW_NAME);
  if (!existing) {
    return;
  }
  state.scene.remove(existing);
  disposeObject(existing);
}

/** Live 3D ghost while dragging a palette shape onto the workplane. */
function syncAssetPlacementPreview(
  state: ThreeState,
  asset: ShapeAsset,
  x: number,
  z: number,
  elevation: number,
) {
  let preview = state.scene.getObjectByName(ASSET_PLACEMENT_PREVIEW_NAME);
  const needsRebuild =
    !preview
    || preview.userData.assetKind !== asset.kind
    || preview.userData.assetColor !== asset.color
    || preview.userData.assetHole !== Boolean(asset.hole);

  if (needsRebuild) {
    clearAssetPlacementPreviewObject(state);
    const draft = makeShapeFromAsset(asset, { x, z, elevation });
    preview = createShapeObject(draft, false);
    preview.name = ASSET_PLACEMENT_PREVIEW_NAME;
    preview.userData.assetKind = asset.kind;
    preview.userData.assetColor = asset.color;
    preview.userData.assetHole = Boolean(asset.hole);
    preview.userData.previewHeight = draft.height;
    preview.userData.shapeId = undefined;
    preview.traverse((child) => {
      child.userData.shapeId = undefined;
      if (child instanceof THREE.LineSegments || child instanceof THREE.Line) {
        child.visible = false;
        return;
      }
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => {
        if (!material || Array.isArray(material)) {
          return;
        }
        material.transparent = true;
        material.opacity = Math.min(0.82, "opacity" in material && typeof material.opacity === "number" ? material.opacity : 1);
        material.depthWrite = true;
      });
    });
    state.scene.add(preview);
  } else if (preview) {
    const height = typeof preview.userData.previewHeight === "number" ? preview.userData.previewHeight : 20;
    preview.position.set(x, elevation + height / 2, z);
    preview.updateMatrixWorld(true);
  }
  markShadowsDirty(state);
}

function createShapeObject(shape: WorkplaneShape, showEdges = false, onTextureReady?: () => void) {
  const group = new THREE.Group();
  group.name = shape.name;
  group.userData.shapeId = shape.id;
  group.userData.hole = Boolean(shape.hole);
  group.userData.showEdges = showEdges;
  group.userData.rulerDimensions = [shapeWidth(shape), shape.height, shapeDepth(shape)] satisfies [number, number, number];
  group.userData.rulerTopologyKey = rulerShapeTopologyKey(shape);
  group.position.set(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z);
  group.rotation.set(
    THREE.MathUtils.degToRad(shape.rotationX ?? 0),
    THREE.MathUtils.degToRad(shape.rotation),
    THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
  );
  group.scale.set(mirrorSign(shape.mirrorX), mirrorSign(shape.mirrorY), mirrorSign(shape.mirrorZ));

  if (shape.groupedShapes?.length && (!shape.importedMesh || shape.importedMesh.positions.length < 9)) {
    const content = new THREE.Group();
    shape.groupedShapes
      .filter((child) => !child.hidden && !child.suppressed && !child.csg?.suppressed)
      .forEach((child) => {
        const childShape = shape.hole ? { ...child, hole: true, color: "#b8c2cc" } : child;
        const childObject = createShapeObject(childShape, showEdges, onTextureReady);
        content.add(childObject);
      });
    const contentBox = new THREE.Box3().setFromObject(content);
    const contentSize = contentBox.getSize(new THREE.Vector3());
    content.scale.set(
      shapeWidth(shape) / Math.max(0.001, contentSize.x),
      shape.height / Math.max(0.001, contentSize.y),
      shapeDepth(shape) / Math.max(0.001, contentSize.z),
    );
    content.position.y = -shape.height / 2;
    group.add(content);
    group.traverse((child) => {
      child.userData.shapeId = shape.id;
    });
    return group;
  }

  // Solids use FrontSide so a true CSG cavity shows interior walls (not a see-through shell).
  // DoubleSide only for hole cutters, odd mirror flips, or open/non-manifold json previews.
  const flippedWinding = mirroredAxisCount(shape) % 2 === 1;
  const openJsonPreview = Boolean(shape.importedMesh?.sourceFormat === "json" && !shape.groupedShapes?.length && !shape.hole);
  const material = new THREE.MeshStandardMaterial({
    color: shape.hole ? "#b7c0c9" : shape.color,
    transparent: Boolean(shape.hole),
    opacity: shape.hole ? (shape.sketchFinish || shape.sketchProfile ? 0.42 : shape.importedMesh ? 0.34 : 0.52) : 1,
    depthWrite: !shape.hole,
    roughness: shape.hole ? 0.88 : 0.57,
    metalness: 0.02,
    side: shape.hole || flippedWinding || openJsonPreview ? THREE.DoubleSide : THREE.FrontSide,
    // Push faces slightly back so crease lines stay visible (avoids washed-out coplanar edges).
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const size = Math.min(width, depth);
  const height = shape.height;

  switch (shape.kind) {
    case "box":
      addMesh(
        group,
        shape.radius && shape.radius > 0
          ? new RoundedBoxGeometry(width, height, depth, Math.max(1, resolveShapeSteps(shape.kind, shape.steps) ?? 16), shape.radius)
          : new THREE.BoxGeometry(width, height, depth),
        shape.imagePlate && !shape.hole ? createImagePlateMaterials(shape, material, onTextureReady) : material,
        shape,
      );
      break;
    case "cylinder":
      addMesh(
        group,
        new THREE.CylinderGeometry(1, 1, height, resolveShapeSides(shape.kind, shape.sides) ?? 192, shape.segments ?? 1),
        material,
        shape,
        undefined,
        undefined,
        new THREE.Vector3(width / 2, 1, depth / 2),
      );
      break;
    case "sphere": {
      const { widthSegments, heightSegments } = sphereTessellation(resolveShapeSteps(shape.kind, shape.steps));
      addMesh(group, new THREE.SphereGeometry(1, widthSegments, heightSegments), material, shape, undefined, undefined, new THREE.Vector3(width / 2, height / 2, depth / 2));
      break;
    }
    case "cone": {
      addMesh(
        group,
        new THREE.CylinderGeometry(coneUnitTopScale(shape), coneUnitBaseScale(shape), height, resolveShapeSides(shape.kind, shape.sides) ?? 192),
        material,
        shape,
        undefined,
        undefined,
        new THREE.Vector3(width / 2, 1, depth / 2),
      );
      break;
    }
    case "pyramid":
      addMesh(group, createPyramidGeometry(width, height, depth, shape.sides ?? 4), material, shape);
      break;
    case "roof":
      addMesh(group, createRoofGeometry(width, height, depth, shape.leftAngle, shape.rightAngle), material, shape);
      break;
    case "roundRoof":
      addMesh(group, createRoundRoofGeometry(width, height, depth, resolveShapeSides(shape.kind, shape.sides) ?? 128), material, shape);
      break;
    case "halfSphere":
      addMesh(group, createHalfSphereGeometry(width, height, depth, resolveShapeSteps(shape.kind, shape.steps) ?? 56), material, shape);
      break;
    case "torus":
      addMesh(group, createTorusGeometry(width, height, depth, shape.radius, resolveShapeSteps(shape.kind, shape.steps) ?? 64), material, shape);
      break;
    case "ring":
      addMesh(group, createHollowCylinderGeometry(width, height, depth, shape.bevel ?? 4, resolveHollowCylinderSegments()), material, shape);
      break;
    case "tube":
      addMesh(group, createHollowCylinderGeometry(width, height, depth, shape.bevel ?? 4, resolveHollowCylinderSegments()), material, shape);
      break;
    case "wedge":
      addMesh(group, createWedgeGeometry(width, height, depth), material, shape);
      break;
    case "polygon":
      addMesh(group, new THREE.CylinderGeometry(1, 1, height, shape.sides ?? 6), material, shape, undefined, undefined, new THREE.Vector3(width / 2, 1, depth / 2));
      break;
    case "icosahedron":
      addMesh(group, new THREE.IcosahedronGeometry(size / 2, resolveIcosahedronDetail()), material, shape);
      break;
    case "text":
      addTextShape(group, material, shape);
      break;
    case "mesh":
    case "thread":
      if (shape.importedMesh) {
        const preserveEdgeSize = preservesEdgeTreatmentSize(shape);
        addMesh(
          group,
          preserveEdgeSize ? getPreservedImportedMeshGeometry(shape) : getImportedMeshGeometry(shape.importedMesh),
          material,
          shape,
          undefined,
          undefined,
          preserveEdgeSize ? undefined : new THREE.Vector3(
            width / Math.max(0.001, shape.importedMesh.baseWidth),
            height / Math.max(0.001, shape.importedMesh.baseHeight),
            depth / Math.max(0.001, shape.importedMesh.baseDepth),
          ),
        );
      } else if (shape.kind === "thread") {
        addMesh(
          group,
          new THREE.CylinderGeometry(1, 1, height, resolveShapeSides("thread", shape.sides) ?? 128, 1),
          material,
          shape,
          undefined,
          undefined,
          new THREE.Vector3(width / 2, 1, depth / 2),
        );
      } else {
        addMesh(group, new THREE.BoxGeometry(size, Math.max(3, height * 0.35), size * 0.72), material, shape);
      }
      break;
    case "scribble":
      addMesh(group, new THREE.TorusKnotGeometry(size * 0.22, size * 0.055, 120, 12), material, shape);
      break;
    case "sketch":
    default:
      addMesh(group, new THREE.BoxGeometry(size, Math.max(3, height * 0.35), size * 0.72), material, shape);
      break;
  }

  group.traverse((child) => {
    child.userData.shapeId = shape.id;
  });

  return group;
}

function createImagePlateMaterials(shape: WorkplaneShape, sideMaterial: THREE.MeshStandardMaterial, onTextureReady?: () => void) {
  const sideMaterials = Array.from({ length: 5 }, (_, index) => (index === 0 ? sideMaterial : sideMaterial.clone()));
  const topMaterial = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: 0.64,
    metalness: 0,
    transparent: true,
    alphaTest: 0.02,
    side: THREE.FrontSide,
  });

  const plate = shape.imagePlate;
  if (plate?.dataUrl) {
    const cached = imagePlateTextureCache.get(plate);
    if (cached) {
      topMaterial.map = cached;
      topMaterial.needsUpdate = true;
    } else {
      const texture = imageTextureLoader.load(plate.dataUrl, () => {
        texture.needsUpdate = true;
        topMaterial.needsUpdate = true;
        onTextureReady?.();
      });
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = hardwareProfile().maxAnisotropy;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      // Same opt-out convention as cached geometry: shared across rebuilds, so teardown of any one
      // mesh must not dispose it.
      texture.userData.cached = true;
      imagePlateTextureCache.set(plate, texture);
      topMaterial.map = texture;
    }
  }

  return [
    sideMaterials[0],
    sideMaterials[1],
    topMaterial,
    sideMaterials[2],
    sideMaterials[3],
    sideMaterials[4],
  ];
}

function addMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  shape: WorkplaneShape,
  position?: THREE.Vector3,
  rotation?: THREE.Euler,
  scale?: THREE.Vector3,
) {
  const prepared = geometry.userData.cached ? geometry : putGeometryOnBase(geometry);
  const mesh = new THREE.Mesh(prepared, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  if (position) {
    mesh.position.copy(position);
  }
  mesh.position.y -= shape.height / 2;
  if (rotation) {
    mesh.rotation.copy(rotation);
  }
  if (scale) {
    mesh.scale.copy(scale);
  }
  group.add(mesh);

  // Sharp solids keep idle edge accents; curved solids only outline when selected so facets stay quiet.
  const curvedSurface =
    shape.kind === "cylinder"
    || shape.kind === "cone"
    || shape.kind === "sphere"
    || shape.kind === "torus"
    || shape.kind === "halfSphere"
    || shape.kind === "roundRoof"
    || shape.kind === "tube"
    || shape.kind === "ring"
    || shape.kind === "thread";
  const sharpDetailEdges =
    shape.kind === "mesh"
    || Boolean(shape.importedMesh)
    || ["pyramid", "roof", "wedge"].includes(shape.kind);
  // Flat-faced primitives (box, polygon, …) need quiet crease lines when idle — lighting alone washes them out.
  const roundedBox = shape.kind === "box" && Boolean(shape.radius && shape.radius > 0);
  const facetedSolid = !curvedSurface && !roundedBox;
  const showIdleEdges = sharpDetailEdges || facetedSolid;
  const importedTriangleCount = shape.importedMesh?.triangleCount ?? 0;
  const skipHeavyImportedEdges = Boolean(shape.importedMesh) && importedTriangleCount > IMPORTED_SELECTED_EDGE_TRIANGLE_LIMIT;
  if ((group.userData.showEdges || showIdleEdges) && !skipHeavyImportedEdges) {
    const selectedOutline = Boolean(group.userData.showEdges);
    const selectedRoundedBox = selectedOutline && shape.kind === "box" && Boolean(shape.radius && shape.radius > 0);
    const edgeColor = selectedOutline
      ? "#00aeea"
      : shape.hole
        ? "#697989"
        : sharpDetailEdges
          ? "#141b21"
          : darkenHex(shape.color, 0.42);
    const edgeOpacity = selectedRoundedBox
      ? 0
      : selectedOutline
        ? curvedSurface
          ? 0.55
          : 0.98
        : shape.hole
          ? 0.44
          : sharpDetailEdges
            ? 0.32
            : shape.kind === "text"
              ? 0.86
              : 0.36;
    if (selectedOutline && shape.importedMesh && shape.cadDisplayEdgesVersion === 2 && Boolean(shape.cadDisplayEdges?.length)) {
      addCadDisplayEdges(group, shape, edgeColor, edgeOpacity);
    } else {
      const selectedThreshold = shape.importedMesh ? NORMAL_IMPORTED_SELECTION_EDGE_ANGLE : curvedSurface ? 28 : 1;
      // Keep polygon side creases visible even at higher side counts (dihedral ≈ 360/n).
      const polygonSides = shape.kind === "polygon" ? Math.max(3, shape.sides ?? 6) : 0;
      const idleThreshold = shape.importedMesh
        ? IMPORTED_MESH_EDGE_ANGLE
        : sharpDetailEdges
          ? 18
          : polygonSides > 0
            ? Math.max(6, Math.min(20, (360 / polygonSides) * 0.45))
            : 20;
      const edges = new THREE.LineSegments(
        getEdgesGeometry(shape, prepared, selectedOutline ? selectedThreshold : idleThreshold),
        new THREE.LineBasicMaterial({
          color: edgeColor,
          transparent: true,
          opacity: edgeOpacity,
          depthWrite: false,
        }),
      );
      edges.userData.complexEdge = sharpDetailEdges || curvedSurface || facetedSolid;
      edges.renderOrder = selectedOutline ? 2 : 1;
      edges.position.copy(mesh.position);
      edges.rotation.copy(mesh.rotation);
      edges.scale.copy(mesh.scale);
      group.add(edges);
    }
  }
}

function addCadDisplayEdges(group: THREE.Group, shape: WorkplaneShape, color: string, opacity: number) {
  if (!shape.cadDisplayEdges?.length) return;
  const material = new THREE.LineBasicMaterial({ color, depthWrite: false, transparent: true, opacity });
  shape.cadDisplayEdges.forEach((edge) => {
    if (edge.points.length < 6) return;
    const positions = resizedImportedCoordinates(shape, edge.points);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const line = new THREE.Line(geometry, material);
    line.position.y -= shape.height / 2;
    line.renderOrder = 1003;
    line.userData.complexEdge = true;
    group.add(line);
  });
}

function getImportedMeshCache(mesh: NonNullable<WorkplaneShape["importedMesh"]>) {
  const cached = importedGeometryCache.get(mesh);
  if (cached) {
    return cached;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  if (mesh.indices && mesh.indices.length >= 3) {
    geometry.setIndex(mesh.indices);
  }
  if (mesh.normals && mesh.normals.length === mesh.positions.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  putGeometryOnBase(geometry);
  geometry.userData.cached = true;
  const next = { geometry, edges: new Map<number, THREE.EdgesGeometry>() };
  importedGeometryCache.set(mesh, next);
  return next;
}

function getImportedMeshGeometry(mesh: NonNullable<WorkplaneShape["importedMesh"]>) {
  return getImportedMeshCache(mesh).geometry;
}

function getPreservedImportedMeshGeometry(shape: WorkplaneShape) {
  const cached = preservedImportedGeometryCache.get(shape);
  if (cached) return cached;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(resizedImportedMeshPositions(shape), 3));
  geometry.computeVertexNormals();
  putGeometryOnBase(geometry);
  geometry.userData.cached = true;
  preservedImportedGeometryCache.set(shape, geometry);
  return geometry;
}

function getEdgesGeometry(shape: WorkplaneShape, geometry: THREE.BufferGeometry, threshold: number) {
  if (!shape.importedMesh || preservesEdgeTreatmentSize(shape)) {
    return new THREE.EdgesGeometry(geometry, threshold);
  }

  const cache = getImportedMeshCache(shape.importedMesh);
  const cached = cache.edges.get(threshold);
  if (cached) {
    return cached;
  }

  const edges = new THREE.EdgesGeometry(cache.geometry, threshold);
  edges.userData.cached = true;
  cache.edges.set(threshold, edges);
  return edges;
}

function setComplexEdgeVisibility(object: THREE.Object3D, visible: boolean) {
  object.traverse((child) => {
    if (child.userData.complexEdge) {
      child.visible = visible;
    }
  });
}

function addTextShape(group: THREE.Group, material: THREE.MeshStandardMaterial, shape: WorkplaneShape) {
  const text = (shape.text ?? "TEXT").trim() || " ";
  const bevel = clamp(shape.bevel ?? 0, 0, 8);
  const fontName = shape.font ?? DEFAULT_TEXT_FONT;
  const geometry = new TextGeometry(text, {
    font: resolveTextFont(fontName),
    size: 20,
    depth: shape.height,
    curveSegments: textFontCurveSegments(fontName),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel * 0.22,
    bevelSize: bevel * 0.16,
    bevelSegments: Math.max(1, shape.segments ?? 0),
  });

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (box) {
    const textWidth = Math.max(1, box.max.x - box.min.x);
    const textDepth = Math.max(1, box.max.y - box.min.y);
    const scale = Math.min(shapeWidth(shape) / textWidth, shapeDepth(shape) / textDepth);
    geometry.scale(scale, scale, 1);
  }

  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  const rotatedBox = geometry.boundingBox;
  if (rotatedBox) {
    geometry.translate(
      -(rotatedBox.min.x + rotatedBox.max.x) / 2,
      -rotatedBox.min.y,
      -(rotatedBox.min.z + rotatedBox.max.z) / 2,
    );
  }

  addMesh(group, geometry, material, shape);
}

function putGeometryOnBase(geometry: THREE.BufferGeometry) {
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const minY = geometry.boundingBox?.min.y ?? 0;
  geometry.translate(0, -minY, 0);
  return geometry;
}

function createRoofGeometry(width: number, height: number, depth: number, leftAngle?: number, rightAngle?: number) {
  const w = width / 2;
  const d = depth / 2;
  const { ridgeX } = roofAnglesFromProfile(width, height, leftAngle, rightAngle);
  const vertices = new Float32Array([
    -w, 0, -d, w, 0, -d, ridgeX, height, -d,
    -w, 0, d, w, 0, d, ridgeX, height, d,
  ]);
  const indices = [
    0, 2, 1,
    3, 4, 5,
    0, 1, 4, 0, 4, 3,
    0, 3, 5, 0, 5, 2,
    1, 2, 5, 1, 5, 4,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  return geometry.toNonIndexed();
}

function createWedgeGeometry(width: number, height: number, depth: number) {
  const w = width / 2;
  const d = depth / 2;
  const vertices = new Float32Array([
    -w, 0, -d, w, 0, -d, w, height, -d,
    -w, 0, d, w, 0, d, w, height, d,
  ]);
  const indices = [
    0, 2, 1,
    3, 4, 5,
    0, 1, 4, 0, 4, 3,
    1, 2, 5, 1, 5, 4,
    0, 3, 5, 0, 5, 2,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  return geometry.toNonIndexed();
}

function createPyramidGeometry(width: number, height: number, depth: number, sides = 4) {
  const count = Math.max(3, Math.round(sides));
  if (count !== 4) {
    const radius = Math.min(width, depth) / 2;
    const geometry = new THREE.ConeGeometry(radius, height, count);
    geometry.translate(0, height / 2, 0);
    return geometry.toNonIndexed();
  }

  const w = width / 2;
  const d = depth / 2;
  const vertices = new Float32Array([
    -w, 0, -d, w, 0, -d, w, 0, d, -w, 0, d,
    0, height, 0,
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    0, 4, 1,
    1, 4, 2,
    2, 4, 3,
    3, 4, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  return geometry.toNonIndexed();
}

function createTorusGeometry(width: number, height: number, depth: number, tubeRadiusOverride?: number, steps = 64) {
  const maxTubeRadius = Math.max(0.1, Math.min(width, depth) / 2 - 0.2);
  const tubeRadius = clamp(tubeRadiusOverride ?? height / 2, 0.1, maxTubeRadius);
  const majorRadius = Math.max(0.2, Math.min(width, depth) / 2 - tubeRadius);
  const radialSegments = Math.max(8, Math.round(steps));
  const tubularSegments = Math.max(24, Math.round(steps) * 4);
  const geometry = new THREE.TorusGeometry(majorRadius, tubeRadius, radialSegments, tubularSegments);
  geometry.rotateX(Math.PI / 2);
  const outerDiameter = (majorRadius + tubeRadius) * 2;
  geometry.scale(
    width / Math.max(0.001, outerDiameter),
    height / Math.max(0.001, tubeRadius * 2),
    depth / Math.max(0.001, outerDiameter),
  );
  return geometry.toNonIndexed();
}

function createHollowCylinderGeometry(width: number, height: number, depth: number, thickness: number, segments = 256) {
  const outerX = width / 2;
  const outerZ = depth / 2;
  const safeThickness = clamp(thickness, 0.1, Math.max(0.1, Math.min(outerX, outerZ) - 0.1));
  const innerX = Math.max(0.1, outerX - safeThickness);
  const innerZ = Math.max(0.1, outerZ - safeThickness);
  const count = Math.max(12, Math.round(segments));
  const positions: number[] = [];
  const point = (rx: number, rz: number, y: number, index: number): [number, number, number] => {
    const angle = (index / count) * Math.PI * 2;
    return [Math.cos(angle) * rx, y, Math.sin(angle) * rz];
  };
  const addTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => positions.push(...a, ...b, ...c);
  const addQuad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]) => {
    addTri(a, b, c);
    addTri(a, c, d);
  };

  for (let index = 0; index < count; index += 1) {
    const next = index + 1;
    const ob0 = point(outerX, outerZ, 0, index);
    const ob1 = point(outerX, outerZ, 0, next);
    const ot0 = point(outerX, outerZ, height, index);
    const ot1 = point(outerX, outerZ, height, next);
    const ib0 = point(innerX, innerZ, 0, index);
    const ib1 = point(innerX, innerZ, 0, next);
    const it0 = point(innerX, innerZ, height, index);
    const it1 = point(innerX, innerZ, height, next);

    addQuad(ob0, ot0, ot1, ob1);
    addQuad(ib1, it1, it0, ib0);
    addQuad(ot0, it0, it1, ot1);
    addQuad(ob0, ob1, ib1, ib0);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function createRoundRoofGeometry(width: number, height: number, depth: number, sides = 128) {
  const radius = width / 2;
  const segments = Math.max(4, Math.round(sides));
  const shape = new THREE.Shape();
  shape.moveTo(-radius, 0);
  shape.absarc(0, 0, radius, Math.PI, 0, true);
  shape.lineTo(-radius, 0);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: segments });
  geometry.translate(0, 0, -depth / 2);
  geometry.scale(1, height / Math.max(0.001, radius), 1);
  return geometry.toNonIndexed();
}

function createHalfSphereGeometry(width: number, height: number, depth: number, steps = 56) {
  const lon = Math.max(8, Math.round(steps) * 2);
  const lat = Math.max(4, Math.round(steps / 2));
  const rx = width / 2;
  const rz = depth / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const point = (latIndex: number, lonIndex: number): [number, number, number] => {
    const theta = (latIndex / lat) * (Math.PI / 2);
    const phi = ((lonIndex % lon) / lon) * Math.PI * 2;
    const ring = Math.sin(theta);
    return [Math.cos(phi) * rx * ring, Math.cos(theta) * height, Math.sin(phi) * rz * ring];
  };
  const normal = ([x, y, z]: [number, number, number]): [number, number, number] => {
    const vector = new THREE.Vector3(x / Math.max(0.001, rx * rx), y / Math.max(0.001, height * height), z / Math.max(0.001, rz * rz)).normalize();
    return [vector.x, vector.y, vector.z];
  };
  const addTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    positions.push(...a, ...b, ...c);
    normals.push(...normal(a), ...normal(b), ...normal(c));
  };
  const addCapTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    positions.push(...a, ...b, ...c);
    normals.push(0, -1, 0, 0, -1, 0, 0, -1, 0);
  };

  const top: [number, number, number] = [0, height, 0];
  for (let xStep = 0; xStep < lon; xStep += 1) {
    addTri(top, point(1, xStep + 1), point(1, xStep));
  }

  for (let yStep = 1; yStep < lat; yStep += 1) {
    for (let xStep = 0; xStep < lon; xStep += 1) {
      const next = xStep + 1;
      const a = point(yStep, xStep);
      const b = point(yStep, next);
      const c = point(yStep + 1, next);
      const d = point(yStep + 1, xStep);
      addTri(a, c, d);
      addTri(a, b, c);
    }
  }

  const capY = 0;
  const bottomCenter: [number, number, number] = [0, capY, 0];
  const capPoint = (lonIndex: number): [number, number, number] => {
    const phi = ((lonIndex % lon) / lon) * Math.PI * 2;
    return [Math.cos(phi) * rx, capY, Math.sin(phi) * rz];
  };
  for (let xStep = 0; xStep < lon; xStep += 1) {
    addCapTri(bottomCenter, capPoint(xStep), capPoint(xStep + 1));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

function disposeChildren(group: THREE.Group) {
  while (group.children.length > 0) {
    const child = group.children[group.children.length - 1];
    if (child) {
      group.remove(child);
      disposeObject(child);
    }
  }
}

const SKETCH_FACE_HIGHLIGHT_NAME = "SketchFacePickHighlight";
const SKETCH_FACE_NORMAL_DOT = 0.985;
const SKETCH_FACE_PLANE_EPS = 0.12;
const SKETCH_FACE_OFFSET = 0.18;

type SketchFacePickOutcome =
  | { ok: true; plane: SketchPlane }
  | { ok: false; reason: string };

type SketchFaceRaycastHit = {
  hit: THREE.Intersection;
  mesh: THREE.Mesh;
  worldNormal: THREE.Vector3;
  shapeId: string;
  key: string;
  classification: SketchFaceClassification;
};

function raycastSketchFaceHit(
  state: ThreeState,
  shapes: WorkplaneShape[],
  clientX: number,
  clientY: number,
): SketchFaceRaycastHit | null {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  state.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  state.raycaster.setFromCamera(state.pointer, state.camera);

  const meshHit = state.raycaster
    .intersectObjects(state.shapeLayer.children, true)
    .find((entry) => {
      if (!(entry.object instanceof THREE.Mesh) || !entry.face) return false;
      const id = entry.object.userData.shapeId;
      if (typeof id !== "string") return false;
      const shape = shapes.find((item) => item.id === id);
      return Boolean(shape && !shape.hidden && !shape.hole && !shape.locked);
    });

  if (!meshHit?.face || !(meshHit.object instanceof THREE.Mesh)) return null;

  const worldNormal = meshHit.face.normal.clone();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshHit.object.matrixWorld);
  worldNormal.applyMatrix3(normalMatrix).normalize();
  if (worldNormal.dot(state.raycaster.ray.direction) > 0) {
    worldNormal.negate();
  }
  const shapeId = meshHit.object.userData.shapeId as string;
  const shape = shapes.find((item) => item.id === shapeId);
  if (!shape) return null;

  const hitPoint = { x: meshHit.point.x, y: meshHit.point.y, z: meshHit.point.z };
  const normal = { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z };
  const nearbyNormals = shape.importedMesh || shape.groupedShapes
    ? collectNearbyTriangleNormals(meshHit.object, meshHit.point, 3.5)
    : undefined;
  const classification = classifySketchFaceHit(shape, hitPoint, normal, nearbyNormals);
  const planeD = worldNormal.dot(meshHit.point);
  const key = [
    shapeId,
    classification.kind,
    classification.analytic?.type ?? "mesh",
    worldNormal.x.toFixed(3),
    worldNormal.y.toFixed(3),
    worldNormal.z.toFixed(3),
    planeD.toFixed(2),
  ].join("|");
  return { hit: meshHit, mesh: meshHit.object, worldNormal, shapeId, key, classification };
}

function collectCoplanarFaceHighlightPositions(
  mesh: THREE.Mesh,
  hitPointWorld: THREE.Vector3,
  worldNormal: THREE.Vector3,
): Float32Array | null {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!position) return null;

  const index = geometry.getIndex();
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
  if (triangleCount < 1) return null;

  const localA = new THREE.Vector3();
  const localB = new THREE.Vector3();
  const localC = new THREE.Vector3();
  const worldA = new THREE.Vector3();
  const worldB = new THREE.Vector3();
  const worldC = new THREE.Vector3();
  const edgeB = new THREE.Vector3();
  const edgeC = new THREE.Vector3();
  const triNormal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const offset = worldNormal.clone().multiplyScalar(SKETCH_FACE_OFFSET);
  const verts: number[] = [];

  for (let t = 0; t < triangleCount; t += 1) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    localA.fromBufferAttribute(position, ia);
    localB.fromBufferAttribute(position, ib);
    localC.fromBufferAttribute(position, ic);
    worldA.copy(localA).applyMatrix4(mesh.matrixWorld);
    worldB.copy(localB).applyMatrix4(mesh.matrixWorld);
    worldC.copy(localC).applyMatrix4(mesh.matrixWorld);
    edgeB.copy(worldB).sub(worldA);
    edgeC.copy(worldC).sub(worldA);
    triNormal.copy(edgeB).cross(edgeC);
    if (triNormal.lengthSq() < 1e-12) continue;
    triNormal.normalize();
    if (Math.abs(triNormal.dot(worldNormal)) < SKETCH_FACE_NORMAL_DOT) continue;
    centroid.copy(worldA).add(worldB).add(worldC).multiplyScalar(1 / 3);
    const planeDist = Math.abs(
      (centroid.x - hitPointWorld.x) * worldNormal.x
      + (centroid.y - hitPointWorld.y) * worldNormal.y
      + (centroid.z - hitPointWorld.z) * worldNormal.z,
    );
    if (planeDist > SKETCH_FACE_PLANE_EPS) continue;
    verts.push(
      worldA.x + offset.x, worldA.y + offset.y, worldA.z + offset.z,
      worldB.x + offset.x, worldB.y + offset.y, worldB.z + offset.z,
      worldC.x + offset.x, worldC.y + offset.y, worldC.z + offset.z,
    );
  }

  return verts.length >= 9 ? new Float32Array(verts) : null;
}

function clearSketchFaceHighlight(state: ThreeState | null) {
  if (!state) return;
  const existing = state.helperLayer.getObjectByName(SKETCH_FACE_HIGHLIGHT_NAME);
  if (!existing) return;
  state.helperLayer.remove(existing);
  disposeObject(existing);
  state.needsRender = true;
}

function syncSketchFaceHighlight(state: ThreeState, faceHit: SketchFaceRaycastHit | null, previousKey: string | null) {
  if (!faceHit) {
    clearSketchFaceHighlight(state);
    return null;
  }
  if (previousKey === faceHit.key && state.helperLayer.getObjectByName(SKETCH_FACE_HIGHLIGHT_NAME)) {
    return faceHit.key;
  }

  clearSketchFaceHighlight(state);
  const analytic = faceHit.classification.analytic;
  const positions = analytic?.type === "disc-cap"
    ? discCapHighlightPositions(analytic.origin, analytic.normal, analytic.radius, 48, SKETCH_FACE_OFFSET)
    : analytic?.type === "barrel"
      ? barrelHighlightPositions(analytic.surface, 48, 12, SKETCH_FACE_OFFSET)
      : collectCoplanarFaceHighlightPositions(faceHit.mesh, faceHit.hit.point, faceHit.worldNormal);
  if (!positions) return null;

  const blocked = faceHit.classification.kind === "curved";
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: blocked ? "#c45c26" : "#2f9e5d",
      transparent: true,
      opacity: blocked ? 0.34 : 0.42,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  mesh.name = SKETCH_FACE_HIGHLIGHT_NAME;
  mesh.renderOrder = 40;
  mesh.raycast = () => undefined;
  state.helperLayer.add(mesh);
  state.needsRender = true;
  return faceHit.key;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh | THREE.LineSegments;
    if ("geometry" in mesh && mesh.geometry) {
      if (!mesh.geometry.userData.cached) {
        mesh.geometry.dispose();
      }
    }
    if ("material" in mesh && mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => {
        const map = "map" in material ? (material.map as THREE.Texture | null) : null;
        if (map && !map.userData.cached) {
          map.dispose();
        }
        material.dispose();
      });
    }
  });
}

function darkenHex(hex: string, amount: number) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean.length === 3 ? clean.split("").map((char) => char + char).join("") : clean, 16);
  const r = Math.max(0, Math.floor(((value >> 16) & 255) * (1 - amount)));
  const g = Math.max(0, Math.floor(((value >> 8) & 255) * (1 - amount)));
  const b = Math.max(0, Math.floor((value & 255) * (1 - amount)));
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
