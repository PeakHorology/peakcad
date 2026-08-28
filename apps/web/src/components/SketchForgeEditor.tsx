"use client";

import { Download, X } from "lucide-react";
import type manifoldModule from "manifold-3d";
import type { ManifoldToplevel } from "manifold-3d";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ADDITION, Brush, Evaluator, HOLLOW_INTERSECTION, INTERSECTION, SUBTRACTION, type CSGOperation } from "three-bvh-csg";
import * as THREE from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { manifoldModuleSource } from "@/generated/manifoldModuleSource";
import { manifoldWasmBase64 } from "@/generated/manifoldWasmBase64";
import {
  modifierQualityForDisplay,
  resolveHollowCylinderSegments,
  resolveIcosahedronDetail,
  resolveShapeSides,
  resolveShapeSteps,
  setActiveDisplayQuality,
} from "@/lib/displayTessellation";
import { roofAnglesFromProfile } from "@/lib/roofGeometry";
import { sphereTessellation } from "@/lib/sphereTessellation";
import { DEFAULT_TEXT_FONT, resolveTextFont, textFontCurveSegments } from "@/lib/textFonts";
import {
  ToolbarExportIcon,
  ToolbarImportIcon,
} from "./icons";
import { WorkplaneViewport } from "./WorkplaneViewport";
import { SketchWorkspace, type SketchMeasurement, type SketchSelection, type SketchTool } from "./SketchWorkspace";
import { EdgeModifierPanel } from "./workplane/EdgeModifierPanel";
import { CircularPatternPanel } from "./workplane/CircularPatternPanel";
import { ExportSuccessOverlay, type ExportSuccessPayload } from "./workplane/ExportSuccessOverlay";
import { InlineValueDialog } from "./workplane/InlineValueDialog";
import { ActiveToolChip } from "./workplane/ActiveToolChip";
import {
  canonicalizeShape,
  cleanNearZero,
  cleanRotationDegrees,
  fallbackSolidColor,
  mirroredAxisCount,
  mirrorSign,
  normalizeDegrees,
  preservesEdgeTreatmentSize,
  resizedImportedMeshPositions,
  serializeShapesForSync,
  coneUnitBaseScale,
  coneUnitTopScale,
  shapeDepth,
  shapeWidth,
  withHoleMode,
  workplaneShapesEqual,
} from "@/lib/workplaneShapes";
import {
  type BooleanCleanupOptions,
  bumpCsgVersion,
  cleanupBooleanPositions,
  csgTreeContainsId,
  faceHoleCutDepthMm,
  faceHoleOvershootMm,
  findCsgBodyOwningLeaf,
  findShapeInTree,
  inferCsgOp,
  markCsgClean,
  migrateShapesCsg,
  reorderCsgChild,
  replaceLeafInCsgTree,
  setCsgChildSuppressed,
  shouldExpandGroupForBoolean,
  withCsgMeta,
} from "@/lib/csgTree";
import type { CsgOp } from "@/types/sketchforge";
import { bakeCadMetadataForShapeTransform, cadBrepTransformForShape, cadModifierPrimitiveForAnalyticBox, cadModifierPrimitiveForAnalyticCylinder, cadModifierPrimitiveForBakedShape } from "@/lib/cadBakeMetadata";
import { hasOneToOneCadComponentMapping } from "@/lib/cadModifierGroups";
import {
  CAD_MODIFIER_MAX_SHARP_ANGLE,
  cadModifierRequestTimeoutMs,
  cadModifierTimeoutMessage,
  cadModifierWorkerFailureMessage,
  type CadModifierRequestPhase,
} from "@/lib/cadModifierRuntime";
import { hardwareProfile } from "@/lib/desktopHardware";
import { meshDataToTransfer, runManifoldBooleanInWorker, warmManifoldBooleanWorker } from "@/lib/manifoldBooleanClient";
import { cloneWorkplaneShapeSnapshot, compactEdgeTreatmentHistory, edgeTreatmentAppliedFrame, restoreShapeBeforeEdgeTreatment } from "@/lib/edgeTreatmentHistory";
import { appendEditorHistorySnapshot, editorHistoryEntry, expandHistoryShapes, historyShapeNeedsRemesh, hydrateEditorHistoryState, projectShapesFingerprint, type EditorHistoryEntry, type EditorHistoryState } from "@/lib/editorHistory";
import { snapShapeFootprintToVisibleGrid, visibleGridStep } from "@/lib/gridSnap";
import { createLocalId } from "@/lib/localIds";
import {
  CIRCULAR_PATTERN_DEFAULT_COUNT,
  circularPatternCopyId,
  circularPatternInstances,
  circularPatternRadiusFromShape,
  circularPatternWouldClamp,
  clampCircularPatternCount,
  clampCircularPatternRadius,
  clampCircularPatternRotation,
  patternSeatElevationOnPivot,
  resolveCircularPatternSourceId,
  type CircularPatternCenter,
  type CircularPatternRotationStep,
} from "@/lib/circularPattern";
import {
  cloneSketchPlane,
  defaultSketchPlane,
  isDefaultSketchPlane,
  isFaceHostedSketch,
  mergeSketchPlanes,
  resolveSketchPlane,
  sketchBasisMatrix,
} from "@/lib/sketchPlane";
import {
  prepareFaceSketchReference,
  worldTrianglesFromMeshData,
} from "@/lib/sketchFaceReference";
import { barrelFaceLoop, classifySketchFaceHit, discCapFaceLoop } from "@/lib/sketchFaceClassify";
import {
  barrelHoleCutDepthMm,
  barrelThroughDepthMm,
  isCylinderSketchPlane,
  wrapCircleRadialCylinder,
  wrapUvLoopRadialPrism,
} from "@/lib/sketchCylinder";
import { HOTKEYS_CHANGED_EVENT, isHotkeyRecordingActive, loadHotkeyBindings, matchHotkeyAction } from "@/lib/hotkeys";
import {
  arcSketchGeometry,
  circleSketchGeometry,
  DEFAULT_SKETCH_POLYGON_SIDES,
  ellipseSketchGeometry,
  MAX_SKETCH_POLYGON_SIDES,
  MIN_SKETCH_POLYGON_SIDES,
  offsetLineSketchGeometry,
  rectangleSketchGeometry,
  regularPolygonSketchGeometry,
  roundedRectangleSketchGeometry,
  slotSketchGeometry,
  squareSketchGeometry,
  starSketchGeometry,
} from "@/lib/sketchDrawShapes";
import { resolveSketchRevolveAxis, shapeFromSketchRevolve, type SketchRevolveAxis } from "@/lib/sketchRevolve";
import {
  bakeSketchExtrusionBrep,
  bakeSketchRevolveBrep,
  withBakedSketchBrepStep,
} from "@/lib/sketchBrep";
import {
  buildStepExportPreflight,
  selectionSupportsOcctCsg,
  shapeExportQualityLabel,
  shapeHasExactBrepSource,
  type StepPreflightRow,
} from "@/lib/stepQuality";
import { fingerprintsForEdgeIds, matchRecipeEdgeIds } from "@/lib/edgeTreatmentRematch";
import { promoteWorkplaneSketchToPrimitive } from "@/lib/sketchPrimitivePromote";
import {
  addConstraints,
  addLinearDimension,
  beginEditSketchSession,
  boxEdgesForProjection,
  cloneSketchDoc,
  closedProfilesFromLegacy,
  createEmptySketchDoc,
  ensureSketchDocOnShape,
  filletCorner,
  chamferCorner,
  mirrorEntities,
  mergeProfileIntoDoc,
  projectEdgesOntoSketch,
  rectangularPattern,
  removeConstraint,
  resolveEditableSketchShape,
  setDrivingDimensionValue,
  shapeHasEditableSketch,
  sketchDocToProfile,
  sketchProfileToDoc,
  solveSketchDoc,
  trimEntity,
  type SketchDefinitionStatus,
  type SketchDoc,
  type SketchFocusMode,
  type SketchSnapResult,
} from "@/lib/sketch";
import { SketchPalette } from "@/components/workplane/SketchPalette";
import {
  applyRepeatActionToDuplicate,
  computeShapeRepeatDelta,
  createDuplicateForRepeat,
  DEFAULT_SHAPE_REPEAT_DELTA,
  hasShapeRepeatDelta,
  snapshotShapesForRepeat,
  type ShapeRepeatAction,
  type ShapeRepeatDelta,
} from "@/lib/shapeRepeat";
import { DEFAULT_VIEW_NUDGE_AXES, viewNudgeDelta, type ViewNudgeAxes } from "@/lib/viewNudge";
import { downloadBlobFile, downloadTextFile, type DownloadResult } from "@/lib/downloadFile";
import { projectExportFileName } from "@/lib/exportNames";
import { makeShapeFromAsset, sceneShape } from "@/lib/shapeCatalog";
import { BlueprintExportModal } from "@/components/workplane/BlueprintExportModal";
import { EditorTopBar } from "@/components/workplane/EditorTopBar";
import type { BlueprintExportFormat } from "@/lib/blueprintExport";
import { EditorModeStrip, EditorViewportToolbar } from "@/components/workplane/EditorViewportToolbar";
import { SketchCreateMenu } from "@/components/workplane/SketchCreateMenu";
import { SketchFinishToolbar, SketchToolSidebar, SketchUtilitySidebar } from "@/components/workplane/SketchToolSidebar";
import { ShapeSidebar } from "@/components/workplane/ShapeSidebar";
import { importedShapeFromStl, importExtensionSupported } from "@/lib/stlImport";
import { importedShapeFrom3mf } from "@/lib/threeMfImport";
import { to3mf } from "@/lib/threeMfExport";
import { importedShapeFromSvg, invalidSvgMeshReason } from "@/lib/svgImport";
import { DEFAULT_SNAP_GRID, normalizeSnapGrid, normalizeWorkspaceSettings } from "@/lib/workplaneSettings";
import {
  SKETCHFORGE_MCP_POLL_MS,
  SKETCHFORGE_MCP_ROUTE,
  type SketchForgeMcpCommand,
  type SketchForgeMcpSceneSummary,
  type SketchForgeMcpShapeSummary,
  type SketchForgeMcpViewFace,
} from "@/lib/sketchforgeMcpProtocol";
import type { CadModifierComponentMesh, CadModifierDisplayEdge, CadModifierEdge, CadModifierKind, CadModifierMeshPart, CadModifierPrimitivePart, CadModifierQuality, CadModifierWorkerRequest, CadModifierWorkerResponse } from "@/lib/cadModifierTypes";
import { nearestMetricThreadForDiameter, type MetricThreadDesignation } from "@/lib/metricThreads";
import { canSeparateThreadScrew, createThreadShape, DEFAULT_THREAD_DESIGNATION, separateThreadScrewParts } from "@/lib/threadShape";
import type { AlignAxis, AlignHandleStatus, AlignTarget, GridSize, ShapeAsset, SketchImage, SketchPlane, SketchPoint, SketchProfile, SketchSegment, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export { importedShapeFromStl, importedShapeFromSvg, importedShapeFrom3mf };

type TopPanel = "import" | "export" | "tips" | null;
type ExportFormat = "stl" | "obj" | "3mf";
type ToolbarMode = "geometry" | "sketch";
type ValueDialogState =
  | { kind: "sketch-fillet" | "sketch-chamfer"; pointId: string }
  | { kind: "sketch-pattern"; entityIds: string[] }
  | null;

const SKETCH_TOOL_CHIP_LABELS: Partial<Record<SketchTool, string>> = {
  line: "Line",
  bezier: "Bezier",
  smooth: "Smooth curve",
  circle: "Circle",
  ellipse: "Ellipse",
  square: "Square",
  rectangle: "Rectangle",
  roundRect: "Rounded rect",
  slot: "Slot",
  triangle: "Triangle",
  polygon: "Polygon",
  star: "Star",
  arc: "Arc",
  offset: "Offset",
  refine: "Refine points",
  erase: "Erase",
  measure: "Measure",
  dimension: "Dimension",
  trim: "Trim",
  fillet: "Fillet corner",
  chamfer: "Chamfer corner",
  mirror: "Mirror",
  pattern: "Pattern",
  "constrain-h": "Horizontal constraint",
  "constrain-v": "Vertical constraint",
  "constrain-equal": "Equal constraint",
  "constrain-parallel": "Parallel constraint",
  "constrain-perp": "Perpendicular constraint",
  "constrain-tangent": "Tangent constraint",
  "constrain-symmetry": "Symmetry constraint",
};

/** Routine coaching/status text that shouldn't demand full toast attention. */
function isQuietNotice(message: string): boolean {
  if (!message) return false;
  if (message.startsWith("Tip:")) return true;
  const quietExact = new Set(["Sketch undo", "Sketch redo", "Ready"]);
  if (quietExact.has(message)) return true;
  const quietPrefixes = [
    "Polygon: click the center",
    "Click a face to sketch",
    "Select highlighted edges",
    "Edge treatment preview ready",
    "Sketch selection cleared",
    "Selected ",
    "Sketch image selected",
    "Feature selected",
  ];
  return quietPrefixes.some((prefix) => message.startsWith(prefix));
}
type Vec3 = [number, number, number];
type MeshData = { name: string; vertices: Vec3[]; faces: [number, number, number][] };
type Cuboid = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
type ShapeUpdatePatch = Partial<WorkplaneShape> & { bakeTransform?: boolean; repeatDeltaBefore?: WorkplaneShape };
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
type CadModifierWorkerPayload = WithoutRequestId<CadModifierWorkerRequest>;
type EdgeModifierSession = {
  kind: CadModifierKind;
  edges: CadModifierEdge[];
  selectedEdgeIds: number[];
  amount: number;
  sharpAngle: number;
  chamferAngle: number;
  quality: CadModifierQuality;
  tangentChain: boolean;
  preserveEdgeSize: boolean;
  busy: boolean;
  prepared: boolean;
  error: string | null;
  preview: WorkplaneShape | null;
  componentPreviews: EdgeModifierComponentPreview[];
};

type EdgeModifierComponentPreview = {
  owner: number;
  shape: WorkplaneShape;
};
type CircularPatternSession = {
  sourceIds: string[];
  pivotId: string | null;
  center: CircularPatternCenter | null;
  radius: number;
  count: number;
  rotation: CircularPatternRotationStep;
  preview: WorkplaneShape[] | null;
};
type EdgeFeatureRevertOption = {
  id: string;
  entryId: string;
  path: number[];
  label: string;
  targetName: string;
  createdAt: number;
  removesNewerCount: number;
};
type ManifoldSolid = ReturnType<ManifoldToplevel["Manifold"]["cube"]>;
type GroupBuildResult = {
  group: WorkplaneShape | null;
  booleanSelection: WorkplaneShape[];
  hasSolid: boolean;
  hasHole: boolean;
  hasImportedMesh: boolean;
  consumed: boolean;
  failureNotice: string;
  /** Shown when exact OCCT boolean was eligible but mesh fallback was used. */
  qualityNotice?: string;
};
type IntersectionAttempt =
  | { status: "success"; group: WorkplaneShape }
  | { status: "empty" }
  | { status: "unsupported" };
type IntersectionBuildResult = {
  group: WorkplaneShape | null;
  empty: boolean;
  failureNotice: string;
};
type BooleanAutomationMode = "before" | "after" | "ungroup";
type BooleanAutomationResult = {
  ok: boolean;
  caseId: string;
  label: string;
  mode: BooleanAutomationMode;
  notice: string;
  shapeCount: number;
  selectedCount: number;
  triangleCount?: number;
  groupedCount?: number;
  groupId?: string;
  error?: string;
};
const SHARED_CLIPBOARD_STORAGE_KEY = "sketchForge.clipboard";
const SYSTEM_CLIPBOARD_PREFIX = "SKETCHFORGE3D/1\n";
declare global {
  interface Window {
    __sketchforgeBooleanTest?: BooleanAutomationResult;
    __sketchforgeBooleanTestImage?: string;
    sketchforgeCaptureCanvas?: (options?: { hideOverlays?: boolean }) => string;
    sketchforgeCaptureView?: (face?: SketchForgeMcpViewFace) => Promise<string> | string;
    sketchforgeCaptureProjectThumbnails?: (options?: { hideOverlays?: boolean }) => { light: string; dark: string } | null;
  }
}

/** Face-hole cutters overshoot along the cut normal only (not XY grow). */
const POINT_TOLERANCE = 0.0001;
/** Residual-inside test inset — never baked into cutter geometry. */
const CUTTER_RESIDUAL_INSET = 0.01;
const MIN_SHAPE_DIMENSION = 0.01;
const MAX_SKETCH_HISTORY_ENTRIES = hardwareProfile().sketchHistoryEntries;
const MODEL_DIMENSION_PRECISION = 3;
const IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT = hardwareProfile().booleanTriangleLimit;
const COPLANAR_BOOLEAN_RESCUE_DEGREES = 0.02;
const NORMAL_SELECTION_CAD_EDGE_MIN_ANGLE = 60;
const MIN_EDGE_MODIFIER_AMOUNT = 0.001;
const SEPARATE_PARTS_VERTEX_TOLERANCE = 0.0005;
let manifoldRuntimePromise: Promise<ManifoldToplevel> | null = null;

function emptySketchProfile(): SketchProfile {
  return { points: [], segments: [], images: [] };
}

function cloneSketchProfile(profile: SketchProfile): SketchProfile {
  return {
    points: profile.points.map((point) => ({
      ...point,
      handleIn: point.handleIn ? { ...point.handleIn } : undefined,
      handleOut: point.handleOut ? { ...point.handleOut } : undefined,
    })),
    segments: profile.segments.map((segment) => ({ ...segment })),
    images: (profile.images ?? []).map((image) => ({ ...image })),
    sketchPlane: profile.sketchPlane ? cloneSketchPlane(profile.sketchPlane) : undefined,
    faceReferenceLoops: profile.faceReferenceLoops?.map((loop) => loop.map((point) => ({ ...point }))),
  };
}

type SketchClipboard = {
  points: SketchPoint[];
  segments: SketchProfile["segments"];
  images: NonNullable<SketchProfile["images"]>;
};

const SKETCH_PASTE_OFFSET = 4;

function sketchClipboardFromSelection(profile: SketchProfile, selection: SketchSelection): SketchClipboard | null {
  if (!selection) return null;
  const pointIds = new Set<string>();
  const segmentIds = new Set<string>();
  const imageIds = new Set<string>();
  if (selection.kind === "point") pointIds.add(selection.id);
  else if (selection.kind === "segment") segmentIds.add(selection.id);
  else if (selection.kind === "image") imageIds.add(selection.id);
  else {
    selection.pointIds.forEach((id) => pointIds.add(id));
    selection.segmentIds.forEach((id) => segmentIds.add(id));
    (selection.imageIds ?? []).forEach((id) => imageIds.add(id));
  }
  for (const segment of profile.segments) {
    if (!segmentIds.has(segment.id)) continue;
    pointIds.add(segment.startId);
    pointIds.add(segment.endId);
  }
  const points = profile.points
    .filter((point) => pointIds.has(point.id))
    .map((point) => ({
      ...point,
      handleIn: point.handleIn ? { ...point.handleIn } : undefined,
      handleOut: point.handleOut ? { ...point.handleOut } : undefined,
    }));
  const segments = profile.segments
    .filter((segment) => segmentIds.has(segment.id) && pointIds.has(segment.startId) && pointIds.has(segment.endId))
    .map((segment) => ({ ...segment }));
  const images = (profile.images ?? []).filter((image) => imageIds.has(image.id)).map((image) => ({ ...image }));
  if (points.length === 0 && images.length === 0) return null;
  return { points, segments, images };
}

function pasteSketchClipboardIntoProfile(profile: SketchProfile, clipboard: SketchClipboard, offset = SKETCH_PASTE_OFFSET) {
  const idMap = new Map<string, string>();
  clipboard.points.forEach((point) => idMap.set(point.id, createLocalId("sketch-point")));
  const points = clipboard.points.map((point) => ({
    ...point,
    id: idMap.get(point.id)!,
    x: point.x + offset,
    z: point.z + offset,
    handleIn: point.handleIn ? { x: point.handleIn.x + offset, z: point.handleIn.z + offset } : undefined,
    handleOut: point.handleOut ? { x: point.handleOut.x + offset, z: point.handleOut.z + offset } : undefined,
  }));
  const segments = clipboard.segments.map((segment) => ({
    ...segment,
    id: createLocalId("sketch-segment"),
    startId: idMap.get(segment.startId)!,
    endId: idMap.get(segment.endId)!,
  }));
  const images = clipboard.images.map((image) => ({
    ...image,
    id: createLocalId("sketch-image"),
    x: image.x + offset,
    z: image.z + offset,
  }));
  const next: SketchProfile = {
    ...profile,
    points: [...profile.points, ...points],
    segments: [...profile.segments, ...segments],
    images: [...(profile.images ?? []), ...images],
  };
  const selection: SketchSelection =
    points.length === 1 && segments.length === 0 && images.length === 0
      ? { kind: "point", id: points[0].id }
      : segments.length === 1 && points.length <= 2 && images.length === 0
        ? { kind: "segment", id: segments[0].id }
        : images.length === 1 && points.length === 0 && segments.length === 0
          ? { kind: "image", id: images[0].id }
          : {
              kind: "multiple",
              pointIds: points.map((point) => point.id),
              segmentIds: segments.map((segment) => segment.id),
              imageIds: images.map((image) => image.id),
            };
  return { profile: next, selection };
}

type OrderedSketchStep = { segment: SketchProfile["segments"][number]; from: SketchPoint; to: SketchPoint };
type OrderedSketchPath = { points: SketchPoint[]; steps: OrderedSketchStep[]; closed: boolean };

function orderedSketchPaths(profile: SketchProfile): OrderedSketchPath[] {
  const pointById = new Map(profile.points.map((point) => [point.id, point]));
  const adjacency = new Map<string, Array<{ pointId: string; segment: SketchProfile["segments"][number] }>>();
  profile.points.forEach((point) => adjacency.set(point.id, []));
  const validSegments = profile.segments.filter((segment) => {
    if (!pointById.has(segment.startId) || !pointById.has(segment.endId) || segment.startId === segment.endId) return;
    adjacency.get(segment.startId)?.push({ pointId: segment.endId, segment });
    adjacency.get(segment.endId)?.push({ pointId: segment.startId, segment });
    return true;
  });
  const unvisited = new Set(validSegments.map((segment) => segment.id));
  const paths: OrderedSketchPath[] = [];
  while (unvisited.size > 0) {
    const seedId = unvisited.values().next().value as string | undefined;
    const seed = validSegments.find((segment) => segment.id === seedId);
    if (!seed) break;
    const componentIds = new Set<string>();
    const queue = [seed.startId, seed.endId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id || componentIds.has(id)) continue;
      componentIds.add(id);
      adjacency.get(id)?.forEach((entry) => queue.push(entry.pointId));
    }
    const startId = [...componentIds].find((id) => (adjacency.get(id)?.filter((entry) => unvisited.has(entry.segment.id)).length ?? 0) === 1) ?? seed.startId;
    const first = pointById.get(startId);
    if (!first) {
      unvisited.delete(seed.id);
      continue;
    }
    const points = [first];
    const steps: OrderedSketchStep[] = [];
    let currentId = startId;
    for (let guard = 0; guard <= validSegments.length; guard += 1) {
      const edge = adjacency.get(currentId)?.find((entry) => unvisited.has(entry.segment.id));
      if (!edge) break;
      const from = pointById.get(currentId);
      const to = pointById.get(edge.pointId);
      if (!from || !to) break;
      unvisited.delete(edge.segment.id);
      steps.push({ segment: edge.segment, from, to });
      currentId = to.id;
      if (currentId === startId) break;
      points.push(to);
    }
    paths.push({ points, steps, closed: currentId === startId && steps.length >= 3 });
  }
  return paths;
}

function withSmoothSketchHandles(profile: SketchProfile) {
  const next = cloneSketchProfile(profile);
  const points = new Map(next.points.map((point) => [point.id, point]));
  orderedSketchPaths(next).forEach((path) => {
    path.points.forEach((sourcePoint, index) => {
      const point = points.get(sourcePoint.id);
      if (!point) return;
      const previous = path.closed ? path.points[(index - 1 + path.points.length) % path.points.length] : path.points[Math.max(0, index - 1)];
      const following = path.closed ? path.points[(index + 1) % path.points.length] : path.points[Math.min(path.points.length - 1, index + 1)];
      const tangentX = (following.x - previous.x) / 6;
      const tangentZ = (following.z - previous.z) / 6;
      point.handleIn = { x: point.x - tangentX, z: point.z - tangentZ };
      point.handleOut = { x: point.x + tangentX, z: point.z + tangentZ };
      point.mode = "smooth";
    });
  });
  return next;
}

/** True when a single closed path is an axis-aligned rectangle of line segments in UV. */
function axisAlignedRectFromClosedPath(path: OrderedSketchPath): { width: number; depth: number; centerX: number; centerZ: number } | null {
  if (!path.closed || path.points.length !== 4 || path.steps.length !== 4) {
    return null;
  }
  if (path.steps.some((step) => step.segment.kind !== "line")) {
    return null;
  }
  const xs = path.points.map((point) => point.x);
  const zs = path.points.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const width = maxX - minX;
  const depth = maxZ - minZ;
  if (width < 0.01 || depth < 0.01) {
    return null;
  }
  const onCorner = (point: { x: number; z: number }) => (
    (Math.abs(point.x - minX) < 1e-4 || Math.abs(point.x - maxX) < 1e-4)
    && (Math.abs(point.z - minZ) < 1e-4 || Math.abs(point.z - maxZ) < 1e-4)
  );
  if (!path.points.every(onCorner)) {
    return null;
  }
  // Must occupy all four corners (no collapsed/degenerate diamond).
  const cornerKeys = new Set(path.points.map((point) => `${Math.abs(point.x - minX) < 1e-4 ? "0" : "1"},${Math.abs(point.z - minZ) < 1e-4 ? "0" : "1"}`));
  if (cornerKeys.size !== 4) {
    return null;
  }
  return {
    width,
    depth,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

/** True when a closed path is a circle (4-bezier sketch circle or regular polygon on a circle). */
function circleFromClosedPath(path: OrderedSketchPath): { radius: number; centerX: number; centerZ: number } | null {
  if (!path.closed || path.points.length < 4) {
    return null;
  }
  const centerX = path.points.reduce((sum, point) => sum + point.x, 0) / path.points.length;
  const centerZ = path.points.reduce((sum, point) => sum + point.z, 0) / path.points.length;
  const radii = path.points.map((point) => Math.hypot(point.x - centerX, point.z - centerZ));
  const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  if (radius < 0.01) {
    return null;
  }
  const radialSpread = Math.max(...radii) - Math.min(...radii);
  if (radialSpread > Math.max(0.05, radius * 0.02)) {
    return null;
  }
  // Sketch circles are four cubics; polygons/line rings need enough sides to stay round.
  const curved = path.steps.every((step) => step.segment.kind === "bezier" || step.segment.kind === "smooth");
  if (curved && path.points.length === 4) {
    return { radius, centerX, centerZ };
  }
  if (!curved && path.steps.every((step) => step.segment.kind === "line") && path.points.length >= 12) {
    return { radius, centerX, centerZ };
  }
  return null;
}

function bakeSketchExtrusionGeometry(geometry: THREE.BufferGeometry) {
  // Weld ExtrudeGeometry triangle soups so Manifold/CSG get shared edges instead of open shells.
  const merged = mergeVertices(geometry, 1e-4);
  if (merged !== geometry) {
    geometry.dispose();
  }
  // Keep indexed form when possible — duplicated soups break Manifold and inflate CSG cost.
  if (!merged.index) {
    merged.computeVertexNormals();
    return merged;
  }
  merged.computeVertexNormals();
  return merged;
}

/** Reverse triangle winding so FrontSide materials show the exterior after a reflection. */
function flipGeometryWinding(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      index.setX(i + 1, c);
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
    return;
  }
  const position = geometry.getAttribute("position");
  if (!position || position.count < 3) return;
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  for (let i = 0; i + 2 < position.count; i += 3) {
    ax.fromBufferAttribute(position, i);
    ay.fromBufferAttribute(position, i + 1);
    az.fromBufferAttribute(position, i + 2);
    position.setXYZ(i + 1, az.x, az.y, az.z);
    position.setXYZ(i + 2, ay.x, ay.y, ay.z);
  }
  position.needsUpdate = true;
}

function importedMeshPayloadFromGeometry(geometry: THREE.BufferGeometry, width: number, depth: number, height: number) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const positions = Array.from(position.array as ArrayLike<number>);
  const normals = normal ? Array.from(normal.array as ArrayLike<number>) : undefined;
  const index = geometry.getIndex();
  const indices = index ? Array.from(index.array as ArrayLike<number>) : undefined;
  const triangleCount = indices
    ? Math.floor(indices.length / 3)
    : Math.floor(positions.length / 9);
  return {
    positions,
    ...(indices && indices.length >= 3 ? { indices } : {}),
    normals,
    baseWidth: width,
    baseDepth: depth,
    baseHeight: height,
    triangleCount,
    sourceFormat: "json" as const,
  };
}

function pointInSketchPolygon(point: THREE.Vector2, polygon: THREE.Vector2[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = currentPoint.y > point.y !== previousPoint.y > point.y;
    if (crosses && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Densify a closed sketch path into UV polyline samples (x=U, z=V). */
function densifyClosedPathUv(path: OrderedSketchPath, curveSegments = 16): Array<{ x: number; z: number }> {
  const samples: Array<{ x: number; z: number }> = [];
  path.steps.forEach(({ segment, from, to }) => {
    const forward = segment.startId === from.id;
    const control1 = forward ? from.handleOut : from.handleIn;
    const control2 = forward ? to.handleIn : to.handleOut;
    if (segment.kind !== "line" && control1 && control2) {
      const count = Math.max(4, curveSegments);
      for (let i = 0; i < count; i += 1) {
        const t = i / count;
        const mt = 1 - t;
        const x = mt * mt * mt * from.x
          + 3 * mt * mt * t * control1.x
          + 3 * mt * t * t * control2.x
          + t * t * t * to.x;
        const z = mt * mt * mt * from.z
          + 3 * mt * mt * t * control1.z
          + 3 * mt * t * t * control2.z
          + t * t * t * to.z;
        samples.push({ x, z });
      }
    } else {
      samples.push({ x: from.x, z: from.z });
    }
  });
  return samples;
}

function shapeFromSketchProfile(
  profile: SketchProfile,
  height: number,
  existing?: WorkplaneShape | null,
  options?: { cutIntoFace?: boolean },
) {
  const closedPaths = orderedSketchPaths(profile).filter((path) => path.closed);
  if (closedPaths.length === 0) return null;
  const plane = resolveSketchPlane(profile.sketchPlane ?? existing?.sketchPlane);
  const profilePoints = closedPaths.flatMap((path) => path.points);
  const minX = Math.min(...profilePoints.map((point) => point.x));
  const maxX = Math.max(...profilePoints.map((point) => point.x));
  const minZ = Math.min(...profilePoints.map((point) => point.z));
  const maxZ = Math.max(...profilePoints.map((point) => point.z));
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const width = Math.max(0.01, maxX - minX);
  const depth = Math.max(0.01, maxZ - minZ);
  const safeHeight = Math.max(0.01, height);
  // Tinkercad-like: bake at exact sketch dimensions. Cut-axis overshoot for face holes
  // is applied below via faceHoleOvershootMm — never grow the profile in-plane.
  const cutIntoFace = options?.cutIntoFace ?? (
    isFaceHostedSketch(plane, profile.faceReferenceLoops ?? existing?.sketchProfile?.faceReferenceLoops)
    && Boolean(existing?.hole)
  );

  // Barrel sketches: wrap UV into a radial prism / cylinder instead of planar extrude.
  if (isCylinderSketchPlane(plane)) {
    const surface = plane.surface;
    const pathByKey = new Map(
      closedPaths.map((path) => [path.points.map((point) => point.id).join("|"), path]),
    );
    const findPathByPointIds = (pointIds: string[]) => {
      const key = pointIds.join("|");
      if (pathByKey.has(key)) return pathByKey.get(key)!;
      // Point order may differ — match by set equality.
      const wanted = new Set(pointIds);
      return closedPaths.find((path) => (
        path.points.length === wanted.size && path.points.every((point) => wanted.has(point.id))
      )) ?? null;
    };
    const nestedProfiles = closedProfilesFromLegacy({
      points: profile.points,
      segments: profile.segments,
      sketchPlane: plane,
    });
    const geometries: THREE.BufferGeometry[] = [];
    for (const nested of nestedProfiles) {
      const outerPath = findPathByPointIds(nested.pointIds);
      if (!outerPath) continue;
      const holePaths = nested.holePointIdLoops
        .map((ids) => findPathByPointIds(ids))
        .filter((path): path is OrderedSketchPath => Boolean(path));
      const simpleCircle = holePaths.length === 0 ? circleFromClosedPath(outerPath) : null;
      let part: THREE.BufferGeometry | null = null;
      if (simpleCircle) {
        part = wrapCircleRadialCylinder(
          simpleCircle.centerX,
          simpleCircle.centerZ,
          simpleCircle.radius,
          surface,
          safeHeight,
          cutIntoFace,
        );
      } else {
        const outerSamples = densifyClosedPathUv(outerPath, 20);
        const holeSamples = holePaths.map((path) => densifyClosedPathUv(path, 20));
        part = wrapUvLoopRadialPrism(outerSamples, surface, safeHeight, cutIntoFace, holeSamples);
      }
      if (part) geometries.push(part);
    }
    let geometry: THREE.BufferGeometry | null = null;
    if (geometries.length === 1) {
      geometry = geometries[0];
    } else if (geometries.length > 1) {
      // Separate UV islands (e.g. two barrel holes) — concatenate triangle soups.
      const positions: number[] = [];
      const indices: number[] = [];
      for (const part of geometries) {
        const pos = part.getAttribute("position");
        const index = part.getIndex();
        const base = positions.length / 3;
        for (let i = 0; i < pos.count; i += 1) {
          positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        }
        if (index) {
          for (let i = 0; i < index.count; i += 1) indices.push(base + index.getX(i));
        } else {
          for (let i = 0; i < pos.count; i += 1) indices.push(base + i);
        }
        part.dispose();
      }
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
    }
    if (!geometry) return null;

    geometry.computeBoundingBox();
    const geometryBox = geometry.boundingBox;
    const worldMinX = geometryBox?.min.x ?? 0;
    const worldMaxX = geometryBox?.max.x ?? 0;
    const worldMinY = geometryBox?.min.y ?? 0;
    const worldMaxY = geometryBox?.max.y ?? safeHeight;
    const worldMinZ = geometryBox?.min.z ?? 0;
    const worldMaxZ = geometryBox?.max.z ?? 0;
    const meshCenterX = (worldMinX + worldMaxX) / 2;
    const meshCenterZ = (worldMinZ + worldMaxZ) / 2;
    const meshElevation = worldMinY;
    const meshWidth = Math.max(0.01, worldMaxX - worldMinX);
    const meshDepth = Math.max(0.01, worldMaxZ - worldMinZ);
    const meshHeight = Math.max(0.01, worldMaxY - worldMinY);
    geometry.translate(-meshCenterX, -meshElevation, -meshCenterZ);
    const meshGeometry = bakeSketchExtrusionGeometry(geometry);
    const importedMesh = importedMeshPayloadFromGeometry(meshGeometry, meshWidth, meshDepth, meshHeight);
    meshGeometry.dispose();

    const nextProfile = cloneSketchProfile(profile);
    nextProfile.sketchPlane = cloneSketchPlane(plane);
    const sketchId = existing?.sketchId ?? createLocalId("sketch");
    const sketchDoc = sketchProfileToDoc(nextProfile, sketchId);
    if (existing?.sketchDoc?.constraints?.length) {
      sketchDoc.constraints = existing.sketchDoc.constraints.map((c) => ({
        ...c,
        entityIds: [...c.entityIds],
        pointIds: c.pointIds ? [...c.pointIds] : undefined,
      }));
    }
    if (existing?.sketchDoc?.dimensions?.length) {
      sketchDoc.dimensions = existing.sketchDoc.dimensions.map((d) => ({
        ...d,
        entityIds: [...d.entityIds],
        pointIds: d.pointIds ? [...d.pointIds] : undefined,
      }));
    }
    const profiles = closedProfilesFromLegacy(nextProfile);
    return canonicalizeShape({
      id: existing?.id ?? createLocalId("sketch-extrusion"),
      name: existing?.name ?? "Sketch extrusion",
      kind: "mesh",
      color: existing?.color ?? "#d41721",
      hole: Boolean(existing?.hole),
      x: meshCenterX,
      z: meshCenterZ,
      elevation: meshElevation,
      size: Math.max(meshWidth, meshDepth),
      width: meshWidth,
      depth: meshDepth,
      height: meshHeight,
      rotation: 0,
      rotationX: 0,
      rotationZ: 0,
      importedMesh,
      sketchProfile: nextProfile,
      sketchDoc,
      sketchId,
      sketchProfileIds: existing?.sketchProfileIds?.length ? existing.sketchProfileIds : profiles.map((p) => p.id),
      sketchPlane: cloneSketchPlane(plane),
      sketchFinish: "extrude",
      sketchRevolveAxis: undefined,
    } satisfies WorkplaneShape);
  }

  let geometry: THREE.BufferGeometry;
  const simpleRect = closedPaths.length === 1 ? axisAlignedRectFromClosedPath(closedPaths[0]) : null;
  const simpleCircle = !simpleRect && closedPaths.length === 1 ? circleFromClosedPath(closedPaths[0]) : null;
  if (simpleRect) {
    // BoxGeometry is manifold (indexed, shared verts) — much cleaner hole cutters than ExtrudeGeometry soups.
    geometry = new THREE.BoxGeometry(simpleRect.width, safeHeight, simpleRect.depth);
    geometry.translate(simpleRect.centerX, safeHeight / 2, simpleRect.centerZ);
  } else if (simpleCircle) {
    // CylinderGeometry stays manifold under face transforms; ExtrudeGeometry circles often fail Manifold.
    const radius = simpleCircle.radius;
    const radialSegments = Math.min(96, Math.max(32, Math.ceil(radius * 4)));
    geometry = new THREE.CylinderGeometry(radius, radius, safeHeight, radialSegments, 1, false);
    geometry.translate(simpleCircle.centerX, safeHeight / 2, simpleCircle.centerZ);
  } else {
    const outlineRecords = closedPaths.map((path) => {
      const outline = new THREE.Shape();
      const toLocal = (x: number, z: number) => ({ x: x - centerX, y: -(z - centerZ) });
      const first = toLocal(path.points[0].x, path.points[0].z);
      outline.moveTo(first.x, first.y);
      path.steps.forEach(({ segment, from, to }) => {
        const forward = segment.startId === from.id;
        const control1 = forward ? from.handleOut : from.handleIn;
        const control2 = forward ? to.handleIn : to.handleOut;
        const end = toLocal(to.x, to.z);
        if (segment.kind !== "line" && control1 && control2) {
          const c1 = toLocal(control1.x, control1.z);
          const c2 = toLocal(control2.x, control2.z);
          outline.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
        } else {
          outline.lineTo(end.x, end.y);
        }
      });
      outline.closePath();
      const polygon = outline.extractPoints(16).shape;
      return { outline, polygon, area: Math.abs(THREE.ShapeUtils.area(polygon)) };
    });
    const sortedOutlines = [...outlineRecords].sort((a, b) => b.area - a.area);
    const outlines: THREE.Shape[] = [];
    sortedOutlines.forEach((record) => {
      const sample = record.polygon[0];
      const parent = sample
        ? sortedOutlines
            .filter((candidate) => candidate !== record && candidate.area > record.area && pointInSketchPolygon(sample, candidate.polygon))
            .sort((a, b) => a.area - b.area)[0]
        : undefined;
      if (parent) parent.outline.holes.push(record.outline);
      else outlines.push(record.outline);
    });
    const hasCurves = profile.segments.some((segment) => segment.kind === "bezier" || segment.kind === "smooth");
    const longestHandle = profile.points.reduce((longest, point) => Math.max(
      longest,
      point.handleIn ? Math.hypot(point.handleIn.x - point.x, point.handleIn.z - point.z) : 0,
      point.handleOut ? Math.hypot(point.handleOut.x - point.x, point.handleOut.z - point.z) : 0,
    ), 0);
    const curveScale = Math.max(width, depth, longestHandle * 2);
    // Even line-only profiles need a few segments so ExtrudeGeometry caps stay clean under transform.
    const curveSegments = hasCurves ? Math.min(256, Math.max(32, Math.ceil(curveScale * 1.25))) : 8;
    geometry = new THREE.ExtrudeGeometry(outlines, { depth: safeHeight, bevelEnabled: false, steps: 1, curveSegments });
    geometry.rotateX(-Math.PI / 2);
    // Local frame after rotateX: +X=U, +Y=extrusion, +Z=V.
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(centerX, 0, centerZ));
  }

  const basis = sketchBasisMatrix(plane);
  geometry.applyMatrix4(basis);
  // sketchBasisMatrix maps U/N/(N×U) which is left-handed (det < 0), so transforms flip
  // winding. Standalone sketches hid this with DoubleSide; after Join the body uses
  // FrontSide and walls vanish. Restore outward winding so bosses stay solid opaque.
  if (basis.determinant() < 0) {
    flipGeometryWinding(geometry);
  }

  // Face holes: extrude along +normal first, then pull so the cutter spans the
  // host with overshoot past BOTH skins (entrance + exit). Old pull (height+os)
  // parked the cutter entirely inside and short of the sketch face, which left
  // coplanar entrance skins and "offset" blind holes when height ≈ host length.
  if (cutIntoFace) {
    const n = plane.normal;
    const os = faceHoleOvershootMm(safeHeight);
    // Geometry currently occupies [origin, origin + height*n].
    // Target: [origin - (height - os)*n, origin + os*n] so os sticks out past the
    // sketch face and the far end reaches height - os past the face (through-all
    // when height = thickness + 2*os).
    const pull = Math.max(0, safeHeight - os);
    geometry.translate(-n.x * pull, -n.y * pull, -n.z * pull);
  }

  geometry.computeBoundingBox();
  const geometryBox = geometry.boundingBox;
  const worldMinX = geometryBox?.min.x ?? 0;
  const worldMaxX = geometryBox?.max.x ?? 0;
  const worldMinY = geometryBox?.min.y ?? 0;
  const worldMaxY = geometryBox?.max.y ?? safeHeight;
  const worldMinZ = geometryBox?.min.z ?? 0;
  const worldMaxZ = geometryBox?.max.z ?? 0;
  const meshCenterX = (worldMinX + worldMaxX) / 2;
  const meshCenterZ = (worldMinZ + worldMaxZ) / 2;
  const meshElevation = worldMinY;
  const meshWidth = Math.max(0.01, worldMaxX - worldMinX);
  const meshDepth = Math.max(0.01, worldMaxZ - worldMinZ);
  const meshHeight = Math.max(0.01, worldMaxY - worldMinY);

  // Bake into local mesh frame: XZ centered at 0, minY at 0 (matches putGeometryOnBase).
  geometry.translate(-meshCenterX, -meshElevation, -meshCenterZ);

  const meshGeometry = bakeSketchExtrusionGeometry(geometry);
  const importedMesh = importedMeshPayloadFromGeometry(meshGeometry, meshWidth, meshDepth, meshHeight);
  meshGeometry.dispose();

  const nextProfile = cloneSketchProfile(profile);
  nextProfile.sketchPlane = cloneSketchPlane(plane);
  const sketchId = existing?.sketchId ?? createLocalId("sketch");
  const sketchDoc = sketchProfileToDoc(nextProfile, sketchId);
  if (existing?.sketchDoc?.constraints?.length) {
    sketchDoc.constraints = existing.sketchDoc.constraints.map((c) => ({
      ...c,
      entityIds: [...c.entityIds],
      pointIds: c.pointIds ? [...c.pointIds] : undefined,
    }));
  }
  if (existing?.sketchDoc?.dimensions?.length) {
    sketchDoc.dimensions = existing.sketchDoc.dimensions.map((d) => ({
      ...d,
      entityIds: [...d.entityIds],
      pointIds: d.pointIds ? [...d.pointIds] : undefined,
    }));
  }
  const profiles = closedProfilesFromLegacy(nextProfile);

  const meshShape = canonicalizeShape({
    id: existing?.id ?? createLocalId("sketch-extrusion"),
    name: existing?.name ?? "Sketch extrusion",
    kind: "mesh",
    color: existing?.color ?? "#d41721",
    hole: Boolean(existing?.hole),
    x: meshCenterX,
    z: meshCenterZ,
    elevation: meshElevation,
    size: Math.max(meshWidth, meshDepth),
    width: meshWidth,
    depth: meshDepth,
    height: meshHeight,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh,
    sketchProfile: nextProfile,
    sketchDoc,
    sketchId,
    sketchProfileIds: existing?.sketchProfileIds?.length ? existing.sketchProfileIds : profiles.map((p) => p.id),
    sketchPlane: cloneSketchPlane(plane),
    sketchFinish: "extrude",
    sketchRevolveAxis: undefined,
  } satisfies WorkplaneShape);
  // Workplane rect/circle → analytic box/cylinder for exact STEP (face-hosted stays mesh).
  return promoteWorkplaneSketchToPrimitive(
    meshShape,
    closedPaths.map((path) => ({ closed: path.closed, points: path.points })),
  );
}

/** Background OCCT bake for mesh sketch features (analytic primitives skip). */
async function bakeSketchFeatureBrepStep(shape: WorkplaneShape): Promise<string | null> {
  if (!shape.sketchProfile) return null;
  const plane = resolveSketchPlane(shape.sketchPlane ?? shape.sketchProfile.sketchPlane);
  // Workplane analytic box/cylinder already export exact — skip bake.
  // Face-hosted and freeform profiles still need OCCT bake for true STEP.
  if (
    isDefaultSketchPlane(plane)
    && (shape.kind === "box" || shape.kind === "cylinder" || shape.kind === "sphere" || shape.kind === "cone")
  ) {
    return null;
  }
  const closed = orderedSketchPaths(shape.sketchProfile).filter((path) => path.closed);
  if (closed.length === 0) return null;
  // Match mesh tessellation densification so freeform beziers bake reliably.
  const closedPaths = closed.map((path) => ({ points: densifyClosedPathUv(path, 20) }));
  if (shape.sketchFinish === "revolve" && shape.sketchRevolveAxis) {
    const baked = await bakeSketchRevolveBrep(shape.sketchProfile, shape.sketchRevolveAxis, {
      plane,
      closedPaths,
    });
    return baked?.brepStep ?? null;
  }
  const faceHosted = isFaceHostedSketch(plane, shape.sketchProfile.faceReferenceLoops);
  const baked = await bakeSketchExtrusionBrep(shape.sketchProfile, shape.height, {
    plane,
    cutIntoFace: Boolean(shape.hole && faceHosted),
    closedPaths,
  });
  return baked?.brepStep ?? null;
}

/**
 * Attach exact STEP when a sketch mesh is still bakeable.
 * Call before Group/boolean so OCCT is eligible instead of racing async bake.
 */
async function ensureExactBrepSources(shapes: WorkplaneShape[]): Promise<WorkplaneShape[]> {
  return Promise.all(shapes.map(async (shape) => {
    if (shapeHasExactBrepSource(shape)) return shape;
    if (!shape.sketchProfile || !shape.importedMesh) return shape;
    try {
      const brepStep = await bakeSketchFeatureBrepStep(shape);
      return brepStep ? withBakedSketchBrepStep(shape, brepStep) : shape;
    } catch {
      return shape;
    }
  }));
}

function cleanModelDimension(value: number) {
  return Math.max(MIN_SHAPE_DIMENSION, Number(value.toFixed(MODEL_DIMENSION_PRECISION)));
}

function meshYawDegrees(shape: WorkplaneShape) {
  const isRoundPrimitive = !shape.importedMesh && (shape.kind === "cylinder" || shape.kind === "cone");
  const isCircular = Math.abs(shapeWidth(shape) - shapeDepth(shape)) < 0.0005;
  // A circular cylinder/cone is invariant around Y. Ignoring that purely visual
  // yaw keeps its tessellated export at the requested diameter after grouping.
  return isRoundPrimitive && isCircular ? 0 : shape.rotation;
}

function parseClipboardShapes(serialized: string) {
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((shape: Partial<WorkplaneShape>) => {
      const { name, kind, color } = shape;
      if (typeof name !== "string" || typeof kind !== "string" || typeof color !== "string") {
        return [];
      }
      return [canonicalizeShape(sceneShape({ ...shape, name, kind, color }))];
    });
  } catch {
    return [];
  }
}

function readSharedClipboard() {
  if (typeof window === "undefined") {
    return [];
  }
  return parseClipboardShapes(window.localStorage.getItem(SHARED_CLIPBOARD_STORAGE_KEY) ?? "[]");
}

async function readSystemClipboard() {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
    return [];
  }
  try {
    const value = await navigator.clipboard.readText();
    return value.startsWith(SYSTEM_CLIPBOARD_PREFIX)
      ? parseClipboardShapes(value.slice(SYSTEM_CLIPBOARD_PREFIX.length))
      : [];
  } catch {
    return [];
  }
}

function copyTextWithSelectionFallback(value: string) {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return;
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {
    // The modern Clipboard API below may still succeed.
  }
  textarea.remove();
  previousFocus?.focus({ preventScroll: true });
}

function writeSharedClipboard(shapes: WorkplaneShape[]) {
  if (typeof window === "undefined") {
    return;
  }
  const serialized = serializeShapesForSync(shapes);
  try {
    window.localStorage.setItem(SHARED_CLIPBOARD_STORAGE_KEY, serialized);
  } catch {
    // The system clipboard can still carry large models if local storage is full.
  }
  const systemPayload = `${SYSTEM_CLIPBOARD_PREFIX}${serialized}`;
  copyTextWithSelectionFallback(systemPayload);
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(systemPayload).catch(() => {
      // Same-origin tabs still have the local-storage fallback.
    });
  }
}

function base64ToUint8Array(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importBundledManifoldModule() {
  const blobUrl = URL.createObjectURL(new Blob([manifoldModuleSource], { type: "text/javascript" }));
  try {
    return (await import(/* webpackIgnore: true */ blobUrl)) as { default: typeof manifoldModule };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function getManifoldRuntime() {
  const assetBase = typeof window === "undefined" ? "/" : new URL(".", window.location.href).href;
  const isFileBuild = typeof window !== "undefined" && window.location.protocol === "file:";
  const manifoldScriptUrl = new URL("manifold.js", assetBase).href;
  const runtimeModule = isFileBuild
    ? importBundledManifoldModule().then((module) => module.default)
    : import(/* webpackIgnore: true */ manifoldScriptUrl).then((module) => (module as { default: typeof manifoldModule }).default);
  manifoldRuntimePromise ??= runtimeModule
    .then((module) => {
      if (isFileBuild) {
        return (module as unknown as (config: { wasmBinary: Uint8Array }) => Promise<ManifoldToplevel>)({
          wasmBinary: base64ToUint8Array(manifoldWasmBase64),
        });
      }
      return module({
        locateFile: ((file: string) => (file.endsWith(".wasm") ? new URL("manifold.wasm", assetBase).href : new URL(file, assetBase).href)) as () => string,
      });
    })
    .then((runtime) => {
      runtime.setup();
      return runtime;
    });
  return manifoldRuntimePromise;
}
function stlBoxTrianglePositions(width: number, depth: number, height: number) {
  const x = width / 2;
  const z = depth / 2;
  const vertices: Vec3[] = [
    [-x, 0, -z],
    [x, 0, -z],
    [x, 0, z],
    [-x, 0, z],
    [-x, height, -z],
    [x, height, -z],
    [x, height, z],
    [-x, height, z],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 5, 1],
    [0, 4, 5],
    [1, 6, 2],
    [1, 5, 6],
    [2, 7, 3],
    [2, 6, 7],
    [3, 4, 0],
    [3, 7, 4],
  ];
  return faces.flatMap((face) => face.flatMap((index) => vertices[index]));
}

function automationSolidBox(overrides: Partial<WorkplaneShape> = {}) {
  return sceneShape({
    id: "solid-cube",
    name: "Solid cube",
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    width: 28,
    depth: 28,
    height: 28,
    ...overrides,
  });
}

function automationHoleBox(overrides: Partial<WorkplaneShape> = {}) {
  return sceneShape({
    id: "hole-cube",
    name: "Hole cube",
    kind: "box",
    color: "#b8c2cc",
    hole: true,
    x: 0,
    z: 0,
    elevation: -4,
    width: 13,
    depth: 40,
    height: 36,
    ...overrides,
  });
}

function automationImportedStlBox(overrides: Partial<WorkplaneShape> = {}) {
  const width = overrides.width ?? 28;
  const depth = overrides.depth ?? 28;
  const height = overrides.height ?? 28;
  return sceneShape({
    id: "imported-stl-cube",
    name: "Imported STL cube",
    kind: "mesh",
    color: "#0098c7",
    x: 0,
    z: 0,
    width,
    depth,
    height,
    importedMesh: {
      positions: stlBoxTrianglePositions(width, depth, height),
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: 12,
      sourceFormat: "stl",
    },
    ...overrides,
  });
}

function automationHoleStlBox(overrides: Partial<WorkplaneShape> = {}) {
  return automationImportedStlBox({
    id: "hole-stl",
    name: "Hole STL",
    color: "#b8c2cc",
    hole: true,
    elevation: -4,
    width: 13,
    depth: 40,
    height: 38,
    ...overrides,
  });
}

function automationImportedStlFromShapes(id: string, name: string, color: string, parts: WorkplaneShape[], overrides: Partial<WorkplaneShape> = {}) {
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];
  parts.forEach((part) => appendMeshData(vertices, faces, meshForShape(part)));
  const bounds = boundsForCuboids([{ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }, ...parts.map(meshAabb)]);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const depth = Math.max(1, bounds.maxZ - bounds.minZ);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const positions: number[] = [];
  faces.forEach(([ai, bi, ci]) => {
    [vertices[ai], vertices[bi], vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x - centerX, y - bounds.minY, z - centerZ);
    });
  });

  return sceneShape({
    id,
    name,
    kind: "mesh",
    color,
    x: centerX,
    z: centerZ,
    elevation: bounds.minY,
    width,
    depth,
    height,
    importedMesh: {
      positions,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: faces.length,
      sourceFormat: "stl",
    },
    ...overrides,
  });
}

function automationRaspberryPiStl(overrides: Partial<WorkplaneShape> = {}) {
  const parts: WorkplaneShape[] = [
    sceneShape({ id: "raspi-board", name: "Board", kind: "box", color: "#1f9f5f", width: 70, depth: 48, height: 3, elevation: 0 }),
    sceneShape({ id: "raspi-soc", name: "Main chip", kind: "box", color: "#30343b", x: -8, z: 0, width: 15, depth: 15, height: 3.2, elevation: 3 }),
    sceneShape({ id: "raspi-memory", name: "Memory chip", kind: "box", color: "#2b2e34", x: 10, z: 1, width: 11, depth: 13, height: 2.8, elevation: 3 }),
    sceneShape({ id: "raspi-usb-a", name: "USB block", kind: "box", color: "#b9c1c9", x: 23, z: -13, width: 17, depth: 11, height: 9, elevation: 3 }),
    sceneShape({ id: "raspi-usb-b", name: "USB block", kind: "box", color: "#b9c1c9", x: 23, z: 4, width: 17, depth: 11, height: 9, elevation: 3 }),
    sceneShape({ id: "raspi-ethernet", name: "Ethernet jack", kind: "box", color: "#c4c9ce", x: 23, z: 18, width: 18, depth: 13, height: 11, elevation: 3 }),
    sceneShape({ id: "raspi-hdmi", name: "HDMI", kind: "box", color: "#c9c0b2", x: -15, z: -22, width: 16, depth: 5, height: 4, elevation: 3 }),
    sceneShape({ id: "raspi-camera", name: "Camera connector", kind: "box", color: "#2b2e34", x: -28, z: 4, width: 5, depth: 20, height: 3, elevation: 3 }),
    sceneShape({ id: "raspi-mount-a", name: "Mount", kind: "cylinder", color: "#1f9f5f", x: -29, z: -17, width: 6, depth: 6, height: 3.4, elevation: 0, sides: 32 }),
    sceneShape({ id: "raspi-mount-b", name: "Mount", kind: "cylinder", color: "#1f9f5f", x: 29, z: -17, width: 6, depth: 6, height: 3.4, elevation: 0, sides: 32 }),
    sceneShape({ id: "raspi-mount-c", name: "Mount", kind: "cylinder", color: "#1f9f5f", x: -29, z: 17, width: 6, depth: 6, height: 3.4, elevation: 0, sides: 32 }),
    sceneShape({ id: "raspi-mount-d", name: "Mount", kind: "cylinder", color: "#1f9f5f", x: 29, z: 17, width: 6, depth: 6, height: 3.4, elevation: 0, sides: 32 }),
    ...Array.from({ length: 14 }, (_, index) =>
      sceneShape({
        id: `raspi-pin-${index}`,
        name: "GPIO pin",
        kind: "box",
        color: "#e2b94f",
        x: -29 + index * 4,
        z: 23,
        width: 1.6,
        depth: 2.6,
        height: 6,
        elevation: 3,
      }),
    ),
  ];
  return automationImportedStlFromShapes("raspberry-pi-stl", "Raspberry Pi-like STL", "#0098c7", parts, overrides);
}

const booleanAutomationShapeConfigs: Record<
  string,
  {
    name: string;
    kind: WorkplaneShape["kind"];
    color: string;
    width?: number;
    depth?: number;
    height?: number;
    props?: Partial<WorkplaneShape>;
  }
> = {
  cube: { name: "Cube", kind: "box", color: "#d41721" },
  cylinder: { name: "Cylinder", kind: "cylinder", color: "#d97813", props: { sides: 96, segments: 1 } },
  sphere: { name: "Sphere", kind: "sphere", color: "#0098c7", props: { steps: 28, sides: 56 } },
  cone: { name: "Cone", kind: "cone", color: "#6e2786", props: { sides: 96, topRadius: 0, baseRadius: 14 } },
  pyramid: { name: "Pyramid", kind: "pyramid", color: "#f2cf10", props: { sides: 4 } },
  wedge: { name: "Wedge", kind: "wedge", color: "#33983d" },
  text: { name: "Text", kind: "text", color: "#cf101b", width: 34, depth: 18, height: 28, props: { text: "T", font: "Sans" } },
  "round-roof": { name: "Round Roof", kind: "roundRoof", color: "#67c4ce", props: { sides: 64 } },
  "half-sphere": { name: "Half Sphere", kind: "halfSphere", color: "#c9009a", props: { steps: 32 } },
  torus: { name: "Torus", kind: "torus", color: "#0098c7", width: 34, depth: 34, height: 8, props: { sides: 96 } },
  tube: { name: "Tube", kind: "tube", color: "#ce7013", width: 34, depth: 34, height: 28, props: { bevel: 6, sides: 96 } },
};

function automationShape(key: string, overrides: Partial<WorkplaneShape> = {}) {
  const config = booleanAutomationShapeConfigs[key];
  if (!config) {
    return null;
  }

  const width = overrides.width ?? config.width ?? 28;
  const depth = overrides.depth ?? config.depth ?? 28;
  const height = overrides.height ?? config.height ?? 28;
  return sceneShape({
    id: `${overrides.hole ? "hole" : "solid"}-${key}`,
    name: config.name,
    kind: config.kind,
    color: config.color,
    x: 0,
    z: 0,
    width,
    depth,
    height,
    size: Math.max(width, depth),
    ...config.props,
    ...overrides,
  });
}

function automationHoleShape(key: string, overrides: Partial<WorkplaneShape> = {}) {
  const shape = automationShape(key, {
    hole: true,
    color: "#b8c2cc",
    elevation: key === "torus" ? 18 : -3,
    rotation: 27,
    width: key === "text" ? 32 : key === "torus" || key === "tube" ? 34 : 24,
    depth: key === "text" ? 17 : key === "torus" || key === "tube" ? 34 : 24,
    height: key === "torus" ? 12 : 34,
    ...overrides,
  });
  return shape ? withHoleMode(shape, true) : null;
}

function automationNormalGroupedObject(overrides: Partial<WorkplaneShape> = {}) {
  const cube = automationShape("cube", { id: "normal-group-cube", x: -9, width: 18, depth: 24, height: 26 });
  const cylinder = automationShape("cylinder", { id: "normal-group-cylinder", x: 10, width: 20, depth: 20, height: 28 });
  if (!cube || !cylinder) {
    return null;
  }
  const group = groupedShape([cube, cylinder]);
  return group ? { ...group, id: "normal-group", name: "Normal grouped object", ...overrides } : null;
}

function automationSelectionOutlineRegressionShape() {
  const geometries: THREE.BufferGeometry[] = [
    new RoundedBoxGeometry(30, 20, 20, 8, 4).translate(-15, 10, 0),
    new THREE.BoxGeometry(16, 20, 20).translate(18, 10, 0),
  ];
  const positions: number[] = [];
  const normals: number[] = [];

  geometries.forEach((geometry) => {
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
    nonIndexed.computeVertexNormals();
    positions.push(...Array.from(nonIndexed.getAttribute("position").array as ArrayLike<number>));
    normals.push(...Array.from(nonIndexed.getAttribute("normal").array as ArrayLike<number>));
    if (nonIndexed !== geometry) {
      nonIndexed.dispose();
    }
    geometry.dispose();
  });

  return canonicalizeShape(
    sceneShape({
      id: "selection-outline-regression",
      name: "Selection outline regression",
      kind: "mesh",
      color: "#d41721",
      x: 0,
      z: 0,
      width: 56,
      depth: 20,
      height: 20,
      size: 56,
      importedMesh: {
        positions,
        normals,
        baseWidth: 56,
        baseDepth: 20,
        baseHeight: 20,
        triangleCount: Math.floor(positions.length / 9),
        sourceFormat: "json",
      },
      groupedShapes: [
        sceneShape({ id: "rounded-child", name: "Rounded child", kind: "box", color: "#d41721", x: -15, width: 30, depth: 20, height: 20, radius: 4 }),
        sceneShape({ id: "box-child", name: "Box child", kind: "box", color: "#d41721", x: 18, width: 16, depth: 20, height: 20 }),
      ],
    }),
  );
}

function booleanAutomationDynamicScene(caseId: string): { label: string; shapes: WorkplaneShape[] } | null {
  const requestedKeys = Object.keys(booleanAutomationShapeConfigs).filter((key) => key !== "cube" && key !== "cylinder");
  const allNormalKeys = Object.keys(booleanAutomationShapeConfigs);

  for (const key of requestedKeys) {
    if (caseId === `${key}-rot-hole`) {
      const solid = automationShape(key);
      return solid
        ? {
            label: `${solid.name} + rotated hole cube`,
            shapes: [solid, automationHoleBox({ rotation: 32 })],
          }
        : null;
    }

    if (caseId === `${key}-hole-cube`) {
      const hole = automationHoleShape(key);
      return hole
        ? {
            label: `${hole.name} hole + solid cube`,
            shapes: [automationSolidBox({ width: 36, depth: 36, height: 30 }), hole],
          }
        : null;
    }

    if (caseId === `${key}-hole-stl`) {
      const hole = automationHoleShape(key);
      return hole
        ? {
            label: `${hole.name} hole + imported STL`,
            shapes: [automationImportedStlBox({ width: 36, depth: 36, height: 30 }), hole],
          }
        : null;
    }
  }

  for (const key of allNormalKeys) {
    if (caseId === `hole-stl-${key}`) {
      const solid = automationShape(key, { width: key === "text" ? 42 : undefined, depth: key === "text" ? 20 : undefined });
      return solid
        ? {
            label: `rotated hole STL + ${solid.name}`,
            shapes: [
              solid,
              automationHoleStlBox({
                id: `hole-stl-${key}`,
                rotation: 29,
                rotationZ: 8,
              }),
            ],
          }
        : null;
    }

    if (caseId === `straight-hole-stl-${key}`) {
      const solid = automationShape(key, { width: key === "text" ? 42 : undefined, depth: key === "text" ? 20 : undefined });
      return solid
        ? {
            label: `non-rotated hole STL + ${solid.name}`,
            shapes: [
              solid,
              automationHoleStlBox({
                id: `straight-hole-stl-${key}`,
                rotation: 0,
                rotationZ: 0,
              }),
            ],
          }
        : null;
    }
  }

  return null;
}

function booleanAutomationScene(caseId: string): { label: string; shapes: WorkplaneShape[] } | null {
  const rotatedHole = () => automationHoleBox({ rotation: 32 });
  if (caseId === "selection-outline-regression") {
    return {
      label: "segmented rounded mesh selection outline",
      shapes: [automationSelectionOutlineRegressionShape()],
    };
  }
  if (caseId === "locked-align-pair") {
    return {
      label: "locked alignment reference pair",
      shapes: [
        sceneShape({ id: "locked-anchor", name: "Locked cube", kind: "box", color: "#d41721", x: 24, z: 10, width: 20, depth: 20, height: 20, locked: true }),
        sceneShape({ id: "moving-cube", name: "Moving cube", kind: "box", color: "#ef7f1a", x: -24, z: -18, width: 12, depth: 12, height: 12 }),
      ],
    };
  }
  if (caseId === "normal-group") {
    const group = groupedShape([
      sceneShape({ id: "modifier-base", name: "Base", kind: "box", color: "#d41721", width: 54, depth: 38, height: 7 }),
      sceneShape({ id: "modifier-upright", name: "Upright", kind: "box", color: "#d41721", x: 8, width: 14, depth: 14, height: 40, elevation: 4 }),
      sceneShape({ id: "modifier-rail", name: "Rail", kind: "box", color: "#d41721", x: -7, z: 5, width: 32, depth: 10, height: 13, elevation: 4 }),
    ]);
    return group ? { label: "overlapping normal solid group", shapes: [group] } : null;
  }
  if (caseId === "straight-hole-stl-group") {
    const group = automationNormalGroupedObject();
    return group
      ? {
          label: "normal grouped object + non-rotated hole STL",
          shapes: [group, automationHoleStlBox({ id: "straight-hole-stl-group", width: 24, depth: 42 })],
        }
      : null;
  }
  if (caseId === "straight-hole-stl-mixed-group") {
    const group = automationNormalGroupedObject({ x: 12 });
    const cube = automationShape("cube", { id: "mixed-solid-cube", x: -14, width: 24, depth: 26, height: 28 });
    return group && cube
      ? {
          label: "cube + normal grouped object + non-rotated hole STL",
          shapes: [cube, group, automationHoleStlBox({ id: "straight-hole-stl-mixed-group", width: 48, depth: 42 })],
        }
      : null;
  }
  if (caseId === "raspi-stl-hole") {
    return {
      label: "Raspberry Pi-like STL + non-rotated hole cube",
      shapes: [
        automationRaspberryPiStl(),
        automationHoleBox({ id: "raspi-hole-cube", x: -2, z: 2, width: 18, depth: 56, height: 20, elevation: -2, rotation: 0, rotationZ: 0 }),
      ],
    };
  }
  if (caseId === "raspi-stl-rot-hole") {
    return {
      label: "Raspberry Pi-like STL + rotated hole cube",
      shapes: [
        automationRaspberryPiStl(),
        automationHoleBox({ id: "raspi-rot-hole-cube", x: -2, z: 2, width: 18, depth: 56, height: 20, elevation: -2, rotation: 28, rotationZ: 8 }),
      ],
    };
  }
  if (caseId === "raspi-stl-hole-stl") {
    return {
      label: "Raspberry Pi-like STL + non-rotated hole STL",
      shapes: [
        automationRaspberryPiStl(),
        automationHoleStlBox({ id: "raspi-hole-stl", x: -2, z: 2, width: 18, depth: 56, height: 20, elevation: -2, rotation: 0, rotationZ: 0 }),
      ],
    };
  }
  if (caseId === "raspi-stl-rot-hole-stl") {
    return {
      label: "Raspberry Pi-like STL + rotated hole STL",
      shapes: [
        automationRaspberryPiStl(),
        automationHoleStlBox({ id: "raspi-rot-hole-stl", x: -2, z: 2, width: 18, depth: 56, height: 20, elevation: -2, rotation: 28, rotationZ: 8 }),
      ],
    };
  }
  const cases: Record<string, { label: string; shapes: WorkplaneShape[] }> = {
    "cube-hole": {
      label: "solid cube + non-rotated hole cube",
      shapes: [automationSolidBox(), automationHoleBox()],
    },
    "cube-rot-hole": {
      label: "solid cube + rotated hole cube",
      shapes: [automationSolidBox(), rotatedHole()],
    },
    "stl-hole": {
      label: "STL + non-rotated hole cube",
      shapes: [automationImportedStlBox(), automationHoleBox()],
    },
    "stl-rot-hole": {
      label: "STL + rotated hole cube",
      shapes: [automationImportedStlBox(), rotatedHole()],
    },
    "rot-stl-hole": {
      label: "rotated STL + hole cube",
      shapes: [automationImportedStlBox({ rotation: 28, rotationZ: 8 }), automationHoleBox()],
    },
    "rot-stl-rot-hole": {
      label: "rotated STL + rotated hole cube",
      shapes: [automationImportedStlBox({ rotation: 28, rotationZ: 8 }), rotatedHole()],
    },
    "cylinder-rot-hole": {
      label: "cylinder + rotated hole cube",
      shapes: [automationSolidBox({ id: "solid-cylinder", name: "Cylinder", kind: "cylinder", color: "#d97813", sides: 48 }), rotatedHole()],
    },
    "sphere-rot-hole": {
      label: "sphere + rotated hole cube",
      shapes: [automationSolidBox({ id: "solid-sphere", name: "Sphere", kind: "sphere", color: "#0098c7", sides: 48 }), rotatedHole()],
    },
    "cone-rot-hole": {
      label: "cone + rotated hole cube",
      shapes: [
        automationSolidBox({ id: "solid-cone", name: "Cone", kind: "cone", color: "#6e2786", sides: 64, topRadius: 0, baseRadius: 14 }),
        rotatedHole(),
      ],
    },
    "pyramid-rot-hole": {
      label: "pyramid + rotated hole cube",
      shapes: [automationSolidBox({ id: "solid-pyramid", name: "Pyramid", kind: "pyramid", color: "#f2cf10", sides: 4 }), rotatedHole()],
    },
  };
  return cases[caseId] ?? booleanAutomationDynamicScene(caseId);
}

function makeHouseScene(): WorkplaneShape[] {
  return [
    sceneShape({ name: "Grass base", kind: "box", color: "#4f9b58", x: 0, z: 0, width: 118, depth: 92, height: 1 }),
    sceneShape({ name: "House body", kind: "box", color: "#e7c49a", x: 0, z: 2, width: 52, depth: 42, height: 34, elevation: 1 }),
    sceneShape({ name: "Gable roof", kind: "roof", color: "#a83c32", x: 0, z: 2, width: 66, depth: 54, height: 23, elevation: 35 }),
    sceneShape({ name: "Chimney", kind: "box", color: "#7f3328", x: 17, z: -9, width: 8, depth: 8, height: 18, elevation: 45 }),
    sceneShape({ name: "Front door", kind: "box", color: "#6d4427", x: 0, z: -20.4, width: 12, depth: 1.4, height: 19, elevation: 1.5 }),
    sceneShape({ name: "Door knob", kind: "sphere", color: "#e0b23f", x: 4.2, z: -21.6, width: 2.2, depth: 2.2, height: 2.2, elevation: 11 }),
    sceneShape({ name: "Left front window", kind: "box", color: "#6fc8e8", x: -16, z: -20.7, width: 10, depth: 1.2, height: 8, elevation: 18 }),
    sceneShape({ name: "Right front window", kind: "box", color: "#6fc8e8", x: 16, z: -20.7, width: 10, depth: 1.2, height: 8, elevation: 18 }),
    sceneShape({ name: "Left side window", kind: "box", color: "#6fc8e8", x: -26.2, z: 8, width: 10, depth: 1.2, height: 8, elevation: 18, rotation: 90 }),
    sceneShape({ name: "Right side window", kind: "box", color: "#6fc8e8", x: 26.2, z: 8, width: 10, depth: 1.2, height: 8, elevation: 18, rotation: 90 }),
    sceneShape({ name: "Porch step", kind: "box", color: "#9d9b91", x: 0, z: -28, width: 24, depth: 10, height: 2, elevation: 1 }),
    sceneShape({ name: "Walkway", kind: "box", color: "#b8b4a8", x: 0, z: -50, width: 12, depth: 36, height: 0.8, elevation: 0.2 }),
    sceneShape({ name: "Tree trunk", kind: "cylinder", color: "#7b4a2b", x: -42, z: 22, width: 7, depth: 7, height: 18, elevation: 1, sides: 18 }),
    sceneShape({ name: "Tree crown", kind: "sphere", color: "#2f8e45", x: -42, z: 22, width: 24, depth: 24, height: 22, elevation: 18 }),
    sceneShape({ name: "Mailbox post", kind: "box", color: "#5a4b3d", x: 32, z: -42, width: 3, depth: 3, height: 12, elevation: 1 }),
    sceneShape({ name: "Mailbox", kind: "roundRoof", color: "#2e6ca8", x: 32, z: -42, width: 13, depth: 8, height: 7, elevation: 13, rotation: 90 }),
  ];
}

function makeBlockPerfScene(count = 500): WorkplaneShape[] {
  const safeCount = Math.max(1, Math.min(5000, Math.floor(count)));
  const columns = Math.ceil(Math.sqrt(safeCount));
  const spacing = 7;
  const offset = ((columns - 1) * spacing) / 2;
  const colors = ["#d41721", "#d97813", "#f2cf10", "#33983d", "#0098c7", "#294c93"];

  return Array.from({ length: safeCount }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return sceneShape({
      id: `perf-block-${index + 1}`,
      name: `Perf block ${index + 1}`,
      kind: "box",
      color: colors[index % colors.length],
      x: column * spacing - offset,
      z: row * spacing - offset,
      width: 5,
      depth: 5,
      height: 5,
    });
  });
}

function sanitizeName(name: string) {
  return name.replace(/[^a-z0-9_-]+/gi, "_") || "shape";
}

function meshDataToCadTransfer(mesh: MeshData) {
  const positions = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((vertex, index) => positions.set(vertex, index * 3));
  const indices = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach((face, index) => indices.set(face, index * 3));
  return { positions, indices };
}

function shapeFromCadMesh(
  source: WorkplaneShape,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  brep: string,
  step?: string,
): WorkplaneShape | null {
  if (positions.length < 9 || indices.length < 3) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    minZ = Math.min(minZ, positions[index + 2]);
    maxX = Math.max(maxX, positions[index]);
    maxY = Math.max(maxY, positions[index + 1]);
    maxZ = Math.max(maxZ, positions[index + 2]);
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const flattenedPositions: number[] = [];
  const flattenedNormals: number[] = [];
  for (let index = 0; index < indices.length; index += 1) {
    const vertex = indices[index] * 3;
    flattenedPositions.push(positions[vertex] - centerX, positions[vertex + 1] - minY, positions[vertex + 2] - centerZ);
    if (normals.length >= vertex + 3) flattenedNormals.push(normals[vertex], normals[vertex + 1], normals[vertex + 2]);
  }
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  return canonicalizeShape({
    ...source,
    kind: "mesh",
    x: cleanNearZero(centerX, 0.0005),
    z: cleanNearZero(centerZ, 0.0005),
    elevation: cleanNearZero(minY, 0.0005),
    width,
    depth,
    height,
    size: Math.max(width, depth),
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    mirrorX: undefined,
    mirrorY: undefined,
    mirrorZ: undefined,
    radius: undefined,
    importedMesh: {
      positions: flattenedPositions,
      normals: flattenedNormals.length === flattenedPositions.length ? flattenedNormals : undefined,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(indices.length / 3),
      sourceFormat: step ? "step" : "json",
      ...(step ? { brepStep: step } : {}),
    },
    imagePlate: undefined,
    cadBrep: brep,
    cadBrepFrame: {
      x: cleanNearZero(centerX, 0.0005),
      z: cleanNearZero(centerZ, 0.0005),
      elevation: cleanNearZero(minY, 0.0005),
      width,
      depth,
      height,
    },
    cadPrimitiveFrame: undefined,
  });
}

function cadEdgeEndpoint(edge: CadModifierEdge, end: "start" | "end") {
  const offset = end === "start" ? 0 : edge.points.length - 3;
  return new THREE.Vector3(edge.points[offset], edge.points[offset + 1], edge.points[offset + 2]);
}

function cadEdgeTangentAt(edge: CadModifierEdge, endpoint: THREE.Vector3) {
  const start = cadEdgeEndpoint(edge, "start");
  const end = cadEdgeEndpoint(edge, "end");
  if (endpoint.distanceToSquared(start) <= endpoint.distanceToSquared(end)) {
    const next = new THREE.Vector3(edge.points[3], edge.points[4], edge.points[5]);
    return next.sub(start).normalize();
  }
  const offset = Math.max(0, edge.points.length - 6);
  const previous = new THREE.Vector3(edge.points[offset], edge.points[offset + 1], edge.points[offset + 2]);
  return previous.sub(end).normalize();
}

function tangentCadEdgeChain(edges: CadModifierEdge[], startId: number, allowedIds: Set<number>) {
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const selected = new Set<number>([startId]);
  const queue = [startId];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  edges.forEach((edge) => {
    for (let index = 0; index + 2 < edge.points.length; index += 3) {
      minX = Math.min(minX, edge.points[index]);
      minY = Math.min(minY, edge.points[index + 1]);
      minZ = Math.min(minZ, edge.points[index + 2]);
      maxX = Math.max(maxX, edge.points[index]);
      maxY = Math.max(maxY, edge.points[index + 1]);
      maxZ = Math.max(maxZ, edge.points[index + 2]);
    }
  });
  const diagonal = [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)
    ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
    : 1;
  const tolerance = Math.max(1e-6, Math.min(0.01, diagonal * 1e-5));
  while (queue.length > 0) {
    const id = queue.shift() as number;
    const edge = edgeById.get(id);
    if (!edge) continue;
    const endpoints = [cadEdgeEndpoint(edge, "start"), cadEdgeEndpoint(edge, "end")];
    edges.forEach((candidate) => {
      if (selected.has(candidate.id) || !allowedIds.has(candidate.id)) return;
      const candidateEndpoints = [cadEdgeEndpoint(candidate, "start"), cadEdgeEndpoint(candidate, "end")];
      const shared = endpoints.find((point) => candidateEndpoints.some((other) => point.distanceTo(other) <= tolerance));
      if (!shared) return;
      const a = cadEdgeTangentAt(edge, shared);
      const b = cadEdgeTangentAt(candidate, shared);
      const deviation = (Math.acos(Math.max(-1, Math.min(1, Math.abs(a.dot(b))))) * 180) / Math.PI;
      if (deviation <= 16) {
        selected.add(candidate.id);
        queue.push(candidate.id);
      }
    });
  }
  return [...selected];
}

function selectableCadModifierEdge(edge: CadModifierEdge, sharpAngle: number) {
  return edge.display && edge.selectable && edge.manifold && !edge.boundary && edge.angle + 1e-3 >= sharpAngle;
}

function cadDisplayEdgesAfterTreatment(shape: WorkplaneShape, session: EdgeModifierSession) {
  const removed = new Set(session.selectedEdgeIds);
  const elevation = shape.elevation ?? 0;
  return session.edges
    .filter((edge) => {
      const effectiveAngle = Math.min(edge.angle, 180 - edge.angle);
      return edge.manifold
        && !edge.boundary
        && effectiveAngle + 1e-3 >= Math.max(session.sharpAngle, NORMAL_SELECTION_CAD_EDGE_MIN_ANGLE)
        && !removed.has(edge.id);
    })
    .map((edge) => ({
      points: edge.points.map((value, index) => {
        if (index % 3 === 0) return value - shape.x;
        if (index % 3 === 1) return value - elevation;
        return value - shape.z;
      }),
    }));
}

function cadDisplayEdgesForShape(shape: WorkplaneShape, edges: CadModifierDisplayEdge[]) {
  const elevation = shape.elevation ?? 0;
  return edges
    .filter((edge) => edge.points.length >= 6)
    .map((edge) => ({
      points: edge.points.map((value, index) => {
        if (index % 3 === 0) return value - shape.x;
        if (index % 3 === 1) return value - elevation;
        return value - shape.z;
      }),
    }));
}

function cadModifierComponentPreviews(sourceParts: WorkplaneShape[], components: CadModifierComponentMesh[] | undefined): EdgeModifierComponentPreview[] {
  if (!components?.length) return [];
  const previews: EdgeModifierComponentPreview[] = [];
  components.forEach((component) => {
    const source = sourceParts[component.owner] ?? sourceParts[0];
    if (!source) return;
    const shape = shapeFromCadMesh(source, component.positions, component.normals, component.indices, component.brep);
    if (!shape) return;
    previews.push({
      owner: component.owner,
      shape: canonicalizeShape({
        ...shape,
        cadDisplayEdges: cadDisplayEdgesForShape(shape, component.displayEdges),
        cadDisplayEdgesVersion: 2 as const,
      }),
    });
  });
  return previews;
}

function edgeTreatmentLabel(feature: NonNullable<WorkplaneShape["edgeTreatments"]>[number]) {
  const size = `${Number(feature.amount.toFixed(2))} mm`;
  return `${feature.kind === "fillet" ? "fillet" : "chamfer"} (${size}, ${feature.edgeCount} edge${feature.edgeCount === 1 ? "" : "s"})`;
}

function shapeWithEdgeTreatmentRecord(
  shape: WorkplaneShape,
  before: WorkplaneShape,
  feature: NonNullable<WorkplaneShape["edgeTreatments"]>[number],
  preserveEdgeSize: boolean,
  createdAt: number,
) {
  return canonicalizeShape({
    ...shape,
    edgeResizeMode: preserveEdgeSize ? "preserve" : "scale",
    edgeTreatments: [
      ...(before.edgeTreatments ?? []),
      {
        ...feature,
      },
    ],
    edgeTreatmentHistory: [
      ...compactEdgeTreatmentHistory(before.edgeTreatmentHistory),
      {
        id: createLocalId("edge-history"),
        createdAt,
        feature,
        before: cloneWorkplaneShapeSnapshot(before),
        appliedFrame: edgeTreatmentAppliedFrame(shape),
      },
    ],
  });
}

function bakedEdgeTreatmentPreview(shape: WorkplaneShape, base: WorkplaneShape) {
  if (!base.groupedShapes?.length) return shape;
  return canonicalizeShape({
    ...shape,
    groupedShapes: undefined,
    groupedBaseWidth: undefined,
    groupedBaseDepth: undefined,
    groupedBaseHeight: undefined,
  });
}

function shapeCenterDistance(a: WorkplaneShape, b: WorkplaneShape) {
  const ax = a.x;
  const ay = (a.elevation ?? 0) + a.height / 2;
  const az = a.z;
  const bx = b.x;
  const by = (b.elevation ?? 0) + b.height / 2;
  const bz = b.z;
  return Math.hypot(ax - bx, ay - by, az - bz);
}

function shapeDimensionDistance(a: WorkplaneShape, b: WorkplaneShape) {
  return Math.hypot(shapeWidth(a) - shapeWidth(b), a.height - b.height, shapeDepth(a) - shapeDepth(b));
}

function matchCadComponentsToSources(sourceParts: WorkplaneShape[], componentPreviews: EdgeModifierComponentPreview[]) {
  const candidates = componentPreviews.flatMap((component, componentIndex) =>
    sourceParts.map((source, sourceIndex) => ({
      component,
      componentIndex,
      sourceIndex,
      score: shapeCenterDistance(component.shape, source) + shapeDimensionDistance(component.shape, source) * 0.25,
    })),
  );
  candidates.sort((a, b) => a.score - b.score);

  const usedComponents = new Set<number>();
  const usedSources = new Set<number>();
  const ownerToSourceIndex = new Map<number, number>();
  candidates.forEach((candidate) => {
    if (usedComponents.has(candidate.componentIndex) || usedSources.has(candidate.sourceIndex)) return;
    usedComponents.add(candidate.componentIndex);
    usedSources.add(candidate.sourceIndex);
    ownerToSourceIndex.set(candidate.component.owner, candidate.sourceIndex);
  });
  return ownerToSourceIndex;
}

function groupedShapeWithComponentEdgeTreatment(
  base: WorkplaneShape,
  preview: WorkplaneShape,
  sourceParts: WorkplaneShape[],
  session: EdgeModifierSession,
  feature: NonNullable<WorkplaneShape["edgeTreatments"]>[number],
  createdAt: number,
) {
  if (
    !base.groupedShapes?.length ||
    !hasOneToOneCadComponentMapping(sourceParts.length, session.componentPreviews.map((component) => component.owner))
  ) {
    return null;
  }

  const edgeById = new Map(session.edges.map((edge) => [edge.id, edge]));
  const ownerEdgeCounts = new Map<number, number>();
  session.selectedEdgeIds.forEach((edgeId) => {
    const owner = edgeById.get(edgeId)?.owner;
    if (typeof owner !== "number") return;
    ownerEdgeCounts.set(owner, (ownerEdgeCounts.get(owner) ?? 0) + 1);
  });
  if (ownerEdgeCounts.size === 0) {
    return null;
  }

  const ownerToSourceIndex = matchCadComponentsToSources(sourceParts, session.componentPreviews);
  if (ownerToSourceIndex.size !== sourceParts.length) {
    return null;
  }
  const componentByOwner = new Map(session.componentPreviews.map((component) => [component.owner, component]));
  const updatedSources = [...sourceParts];
  let changed = false;

  ownerEdgeCounts.forEach((edgeCount, owner) => {
    const sourceIndex = ownerToSourceIndex.get(owner);
    const component = componentByOwner.get(owner);
    if (sourceIndex === undefined || !component) return;
    const source = sourceParts[sourceIndex];
    const ownerFeature = { ...feature, edgeCount };
    const retargeted = canonicalizeShape({
      ...component.shape,
      id: source.id,
      name: source.name,
      color: source.color,
      hole: source.hole || undefined,
      locked: source.locked,
      hidden: source.hidden,
      groupedShapes: source.groupedShapes,
      groupedBaseWidth: source.groupedBaseWidth,
      groupedBaseDepth: source.groupedBaseDepth,
      groupedBaseHeight: source.groupedBaseHeight,
    });
    updatedSources[sourceIndex] = shapeWithEdgeTreatmentRecord(retargeted, source, ownerFeature, session.preserveEdgeSize, createdAt);
    changed = true;
  });

  if (!changed) {
    return null;
  }

  const elevation = preview.elevation ?? 0;
  return canonicalizeShape({
    ...preview,
    edgeResizeMode: session.preserveEdgeSize ? "preserve" : "scale",
    edgeTreatments: base.edgeTreatments,
    edgeTreatmentHistory: base.edgeTreatmentHistory?.length ? compactEdgeTreatmentHistory(base.edgeTreatmentHistory) : undefined,
    groupedBaseWidth: shapeWidth(preview),
    groupedBaseDepth: shapeDepth(preview),
    groupedBaseHeight: preview.height,
    groupedShapes: updatedSources.map((shape) => cloneAsGroupChild(shape, preview.x, preview.z, elevation)),
  });
}

function edgeTreatmentFeatureCount(shape: WorkplaneShape): number {
  return (shape.edgeTreatments?.length ?? 0) + (shape.groupedShapes?.reduce((total, child) => total + edgeTreatmentFeatureCount(child), 0) ?? 0);
}

function reversibleEdgeTreatmentCount(shape: WorkplaneShape): number {
  return (shape.edgeTreatmentHistory?.length ?? 0) + (shape.groupedShapes?.reduce((total, child) => total + reversibleEdgeTreatmentCount(child), 0) ?? 0);
}

function edgeTreatmentHistoryOptions(shape: WorkplaneShape, path: number[] = [], targetName = shape.name): EdgeFeatureRevertOption[] {
  const ownHistory = shape.edgeTreatmentHistory ?? [];
  const ownOptions = ownHistory.map((entry, index) => ({
    id: `${path.length ? path.join(".") : "root"}:${entry.id}`,
    entryId: entry.id,
    path,
    label: edgeTreatmentLabel(entry.feature),
    targetName,
    createdAt: entry.createdAt,
    removesNewerCount: Math.max(0, ownHistory.length - index - 1),
  }));
  const childOptions = (shape.groupedShapes ?? []).flatMap((child, index) =>
    edgeTreatmentHistoryOptions(child, [...path, index], `${targetName} / ${child.name}`),
  );
  return [...ownOptions, ...childOptions].sort((a, b) => b.createdAt - a.createdAt);
}

function restoreOwnLastEdgeTreatment(shape: WorkplaneShape, entry: NonNullable<WorkplaneShape["edgeTreatmentHistory"]>[number]) {
  return restoreShapeBeforeEdgeTreatment(shape, entry);
}

async function restoreEdgeTreatmentInShape(shape: WorkplaneShape, path: number[], entryId: string): Promise<{ shape: WorkplaneShape; label: string } | null> {
  if (path.length === 0) {
    const entry = (shape.edgeTreatmentHistory ?? []).find((candidate) => candidate.id === entryId);
    return entry ? { shape: restoreOwnLastEdgeTreatment(shape, entry), label: edgeTreatmentLabel(entry.feature) } : null;
  }

  if (!shape.groupedShapes?.length) {
    return null;
  }

  const [childIndex, ...restPath] = path;
  const restoredChildren = restoreGroupedChildren(shape);
  const child = restoredChildren[childIndex];
  if (!child) {
    return null;
  }
  const restoredChild = await restoreEdgeTreatmentInShape(child, restPath, entryId);
  if (!restoredChild) {
    return null;
  }

  restoredChildren[childIndex] = restoredChild.shape;
  const rebuilt = await buildGroupedShapeFromSelection(restoredChildren);
  if (!rebuilt.group) {
    return null;
  }

  return {
    shape: canonicalizeShape({
      ...rebuilt.group,
      id: shape.id,
      name: shape.name,
      color: shape.color,
      hole: shape.hole || rebuilt.group.hole,
      locked: shape.locked,
      hidden: shape.hidden,
      edgeResizeMode: shape.edgeResizeMode,
      edgeTreatments: shape.edgeTreatments,
      edgeTreatmentHistory: shape.edgeTreatmentHistory?.length ? compactEdgeTreatmentHistory(shape.edgeTreatmentHistory) : undefined,
    }),
    label: restoredChild.label,
  };
}

function transformMesh(mesh: MeshData, shape: WorkplaneShape): MeshData {
  const centerY = shape.height / 2;
  const matrix = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(meshYawDegrees(shape)),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
  const mirrorX = mirrorSign(shape.mirrorX);
  const mirrorY = mirrorSign(shape.mirrorY);
  const mirrorZ = mirrorSign(shape.mirrorZ);
  const reversedWinding = mirroredAxisCount(shape) % 2 === 1;
  return {
    ...mesh,
    vertices: mesh.vertices.map(([x, y, z]) => {
      const vertex = new THREE.Vector3(x * mirrorX, (y - centerY) * mirrorY, z * mirrorZ).applyMatrix4(matrix);
      return [vertex.x + shape.x, vertex.y + (shape.elevation ?? 0) + centerY, vertex.z + shape.z] as Vec3;
    }),
    faces: reversedWinding ? mesh.faces.map(([a, b, c]) => [a, c, b] as [number, number, number]) : mesh.faces,
  };
}

function boxMesh(shape: WorkplaneShape): MeshData {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  const x = width / 2;
  const z = depth / 2;
  return {
    name: sanitizeName(shape.name),
    vertices: [
      [-x, 0, -z],
      [x, 0, -z],
      [x, 0, z],
      [-x, 0, z],
      [-x, height, -z],
      [x, height, -z],
      [x, height, z],
      [-x, height, z],
    ],
    faces: [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [1, 2, 6],
      [1, 6, 5],
      [2, 3, 7],
      [2, 7, 6],
      [3, 0, 4],
      [3, 4, 7],
    ],
  };
}

function cylinderMesh(shape: WorkplaneShape, sides = 96, topRadiusScale = 1): MeshData {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  const vertices: Vec3[] = [[0, 0, 0], [0, height, 0]];
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    vertices.push([(Math.cos(angle) * width) / 2, 0, (Math.sin(angle) * depth) / 2]);
    vertices.push([(Math.cos(angle) * width * topRadiusScale) / 2, height, (Math.sin(angle) * depth * topRadiusScale) / 2]);
  }
  const faces: [number, number, number][] = [];
  for (let i = 0; i < sides; i += 1) {
    const next = (i + 1) % sides;
    const b0 = 2 + i * 2;
    const t0 = b0 + 1;
    const b1 = 2 + next * 2;
    const t1 = b1 + 1;
    faces.push([0, b1, b0]);
    if (topRadiusScale > 0) {
      faces.push([1, t0, t1]);
      faces.push([b0, b1, t1], [b0, t1, t0]);
    } else {
      faces.push([b0, b1, t0]);
    }
  }
  return { name: sanitizeName(shape.name), vertices, faces };
}

function sphereMesh(shape: WorkplaneShape): MeshData {
  const { widthSegments: lon, heightSegments: lat } = sphereTessellation(shape.steps);
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  const vertices: Vec3[] = [];
  for (let yStep = 0; yStep <= lat; yStep += 1) {
    const theta = (yStep / lat) * Math.PI;
    const y = height / 2 + Math.cos(theta) * (height / 2);
    const ring = Math.sin(theta);
    for (let xStep = 0; xStep < lon; xStep += 1) {
      const phi = (xStep / lon) * Math.PI * 2;
      vertices.push([(Math.cos(phi) * width * ring) / 2, y, (Math.sin(phi) * depth * ring) / 2]);
    }
  }
  const faces: [number, number, number][] = [];
  for (let yStep = 0; yStep < lat; yStep += 1) {
    for (let xStep = 0; xStep < lon; xStep += 1) {
      const next = (xStep + 1) % lon;
      const a = yStep * lon + xStep;
      const b = yStep * lon + next;
      const c = (yStep + 1) * lon + next;
      const d = (yStep + 1) * lon + xStep;
      faces.push([a, d, c], [a, c, b]);
    }
  }
  return { name: sanitizeName(shape.name), vertices, faces };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function bufferGeometryToMeshData(name: string, geometry: THREE.BufferGeometry): MeshData {
  const prepared = geometry.index ? geometry.toNonIndexed() : geometry;
  prepared.computeVertexNormals();
  prepared.computeBoundingBox();
  const minY = prepared.boundingBox?.min.y ?? 0;
  if (Math.abs(minY) > 0.000001) {
    prepared.translate(0, -minY, 0);
    prepared.computeBoundingBox();
  }

  const position = prepared.getAttribute("position");
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];
  for (let i = 0; i < position.count; i += 1) {
    vertices.push([position.getX(i), position.getY(i), position.getZ(i)]);
  }
  for (let i = 0; i + 2 < position.count; i += 3) {
    faces.push([i, i + 1, i + 2]);
  }

  if (prepared !== geometry) {
    prepared.dispose();
  }
  geometry.dispose();
  return { name, vertices, faces };
}

function createBooleanRoofGeometry(width: number, height: number, depth: number, leftAngle?: number, rightAngle?: number) {
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
  return geometry;
}

function createBooleanWedgeGeometry(width: number, height: number, depth: number) {
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
  return geometry;
}

function createBooleanPyramidGeometry(width: number, height: number, depth: number, sides = 4) {
  const count = Math.max(3, Math.round(sides));
  if (count !== 4) {
    const radius = Math.min(width, depth) / 2;
    const geometry = new THREE.ConeGeometry(radius, height, count);
    geometry.translate(0, height / 2, 0);
    return geometry;
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
  return geometry;
}

function createBooleanRoundRoofGeometry(width: number, height: number, depth: number, sides = 64) {
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
  return geometry;
}

function createBooleanHalfSphereGeometry(width: number, height: number, depth: number, steps = 32) {
  const lon = Math.max(8, Math.round(steps) * 2);
  const lat = Math.max(4, Math.round(steps / 2));
  const rx = width / 2;
  const rz = depth / 2;
  const positions: number[] = [];
  const point = (latIndex: number, lonIndex: number): Vec3 => {
    const theta = (latIndex / lat) * (Math.PI / 2);
    const phi = ((lonIndex % lon) / lon) * Math.PI * 2;
    const ring = Math.sin(theta);
    return [Math.cos(phi) * rx * ring, Math.cos(theta) * height, Math.sin(phi) * rz * ring];
  };
  const addTri = (a: Vec3, b: Vec3, c: Vec3) => positions.push(...a, ...b, ...c);

  const top: Vec3 = [0, height, 0];
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

  const bottomCenter: Vec3 = [0, 0, 0];
  const capPoint = (lonIndex: number): Vec3 => {
    const phi = ((lonIndex % lon) / lon) * Math.PI * 2;
    return [Math.cos(phi) * rx, 0, Math.sin(phi) * rz];
  };
  for (let xStep = 0; xStep < lon; xStep += 1) {
    addTri(bottomCenter, capPoint(xStep), capPoint(xStep + 1));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function createBooleanTorusGeometry(width: number, height: number, depth: number, tubeRadiusOverride?: number, steps = 24) {
  const maxTubeRadius = Math.max(0.1, Math.min(width, depth) / 2 - 0.2);
  const tubeRadius = clampNumber(tubeRadiusOverride ?? height / 2, 0.1, maxTubeRadius);
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
  return geometry;
}

function createBooleanHollowCylinderGeometry(width: number, height: number, depth: number, thickness: number, segments = 96) {
  const outerX = width / 2;
  const outerZ = depth / 2;
  const safeThickness = clampNumber(thickness, 0.1, Math.max(0.1, Math.min(outerX, outerZ) - 0.1));
  const innerX = Math.max(0.1, outerX - safeThickness);
  const innerZ = Math.max(0.1, outerZ - safeThickness);
  const count = Math.max(12, Math.round(segments));
  const positions: number[] = [];
  const point = (rx: number, rz: number, y: number, index: number): Vec3 => {
    const angle = (index / count) * Math.PI * 2;
    return [Math.cos(angle) * rx, y, Math.sin(angle) * rz];
  };
  const addTri = (a: Vec3, b: Vec3, c: Vec3) => positions.push(...a, ...b, ...c);
  const addQuad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => {
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

function createBooleanTextGeometry(shape: WorkplaneShape) {
  const text = (shape.text ?? "TEXT").trim() || " ";
  const bevel = clampNumber(shape.bevel ?? 0, 0, 8);
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
  return geometry;
}

function geometryMeshForShape(shape: WorkplaneShape): MeshData | null {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  const size = Math.min(width, depth);
  let geometry: THREE.BufferGeometry | null = null;

  switch (shape.kind) {
    case "box":
      geometry = shape.radius && shape.radius > 0
        ? new RoundedBoxGeometry(width, height, depth, Math.max(1, resolveShapeSteps(shape.kind, shape.steps) ?? 16), shape.radius)
        : new THREE.BoxGeometry(width, height, depth);
      break;
    case "cylinder":
    case "thread":
      geometry = new THREE.CylinderGeometry(1, 1, height, resolveShapeSides(shape.kind, shape.sides) ?? 192, shape.segments ?? 1);
      geometry.scale(width / 2, 1, depth / 2);
      break;
    case "sphere":
      geometry = new THREE.SphereGeometry(
        1,
        sphereTessellation(resolveShapeSteps(shape.kind, shape.steps)).widthSegments,
        sphereTessellation(resolveShapeSteps(shape.kind, shape.steps)).heightSegments,
      );
      geometry.scale(width / 2, height / 2, depth / 2);
      break;
    case "cone": {
      geometry = new THREE.CylinderGeometry(coneUnitTopScale(shape), coneUnitBaseScale(shape), height, resolveShapeSides(shape.kind, shape.sides) ?? 192);
      geometry.scale(width / 2, 1, depth / 2);
      break;
    }
    case "pyramid":
      geometry = createBooleanPyramidGeometry(width, height, depth, shape.sides ?? 4);
      break;
    case "roof":
      geometry = createBooleanRoofGeometry(width, height, depth, shape.leftAngle, shape.rightAngle);
      break;
    case "roundRoof":
      geometry = createBooleanRoundRoofGeometry(width, height, depth, resolveShapeSides(shape.kind, shape.sides) ?? 128);
      break;
    case "halfSphere":
      geometry = createBooleanHalfSphereGeometry(width, height, depth, resolveShapeSteps(shape.kind, shape.steps) ?? 56);
      break;
    case "torus":
      geometry = createBooleanTorusGeometry(width, height, depth, shape.radius, resolveShapeSteps(shape.kind, shape.steps) ?? 64);
      break;
    case "ring":
    case "tube":
      geometry = createBooleanHollowCylinderGeometry(width, height, depth, shape.bevel ?? 4, resolveHollowCylinderSegments());
      break;
    case "wedge":
      geometry = createBooleanWedgeGeometry(width, height, depth);
      break;
    case "polygon":
      geometry = new THREE.CylinderGeometry(1, 1, height, shape.sides ?? 6);
      geometry.scale(width / 2, 1, depth / 2);
      break;
    case "icosahedron":
      geometry = new THREE.IcosahedronGeometry(size / 2, resolveIcosahedronDetail());
      geometry.translate(0, height / 2, 0);
      break;
    case "text":
      geometry = createBooleanTextGeometry(shape);
      break;
    case "scribble":
      geometry = new THREE.TorusKnotGeometry(size * 0.22, size * 0.055, 120, 12);
      geometry.translate(0, height / 2, 0);
      break;
    case "sketch":
    default:
      geometry = new THREE.BoxGeometry(size, Math.max(3, height * 0.35), size * 0.72);
      break;
  }

  return geometry ? bufferGeometryToMeshData(sanitizeName(shape.name), geometry) : null;
}

function meshForShape(shape: WorkplaneShape): MeshData {
  if ((shape.kind === "mesh" || shape.kind === "thread") && shape.importedMesh) {
    return importedMeshForShape(shape);
  }

  if (shape.groupedShapes?.length) {
    const vertices: Vec3[] = [];
    const faces: [number, number, number][] = [];
    shape.groupedShapes.filter((child) => !child.hidden).forEach((child) => {
      const childMesh = meshForShape(child);
      appendMeshData(vertices, faces, childMesh);
    });
    return transformMesh({ name: sanitizeName(shape.name), vertices, faces }, shape);
  }

  const raw =
    geometryMeshForShape(shape) ??
    (shape.kind === "cylinder" || shape.kind === "tube" || shape.kind === "ring" || shape.kind === "torus"
      ? cylinderMesh(shape, resolveShapeSides(shape.kind === "torus" ? "cylinder" : shape.kind, shape.sides) ?? 192)
      : shape.kind === "cone"
        ? cylinderMesh(shape, resolveShapeSides(shape.kind, shape.sides) ?? 192, shape.baseRadius ? (shape.topRadius ?? 0) / shape.baseRadius : 0)
        : shape.kind === "sphere" || shape.kind === "halfSphere"
          ? sphereMesh(shape)
          : shape.kind === "pyramid"
            ? cylinderMesh(shape, shape.sides ?? 4, 0)
            : boxMesh(shape));
  return transformMesh(raw, shape);
}

function appendMeshData(vertices: Vec3[], faces: [number, number, number][], mesh: MeshData) {
  const offset = vertices.length;
  for (let i = 0; i < mesh.vertices.length; i += 1) {
    vertices.push(mesh.vertices[i]);
  }
  for (let i = 0; i < mesh.faces.length; i += 1) {
    const [a, b, c] = mesh.faces[i];
    faces.push([a + offset, b + offset, c + offset]);
  }
}

function importedMeshForShape(shape: WorkplaneShape): MeshData {
  const mesh = shape.importedMesh;
  if (!mesh || mesh.positions.length < 9) {
    // Dirty/empty CSG caches must not silently become bounding boxes — that poisons
    // later Group/Export as if a real solid existed.
    throw new Error(`“${shape.name}” has no usable mesh. Remesh or rebuild the boolean body.`);
  }

  const resizedPositions = resizedImportedMeshPositions(shape);
  const vertices: Vec3[] = [];
  for (let i = 0; i < resizedPositions.length; i += 3) {
    vertices.push([resizedPositions[i], resizedPositions[i + 1], resizedPositions[i + 2]]);
  }

  const faces: [number, number, number][] = [];
  if (mesh.indices && mesh.indices.length >= 3) {
    for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
      const a = mesh.indices[i];
      const b = mesh.indices[i + 1];
      const c = mesh.indices[i + 2];
      if (a < vertices.length && b < vertices.length && c < vertices.length) {
        faces.push([a, b, c]);
      }
    }
  } else {
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      faces.push([i, i + 1, i + 2]);
    }
  }

  return transformMesh({ name: sanitizeName(shape.name), vertices, faces }, shape);
}

function shapeHasTransformToBake(shape: WorkplaneShape) {
  return (
    Math.abs(cleanRotationDegrees(shape.rotation ?? 0, 3)) > 0 ||
    Math.abs(cleanRotationDegrees(shape.rotationX ?? 0, 3)) > 0 ||
    Math.abs(cleanRotationDegrees(shape.rotationZ ?? 0, 3)) > 0 ||
    Boolean(shape.mirrorX || shape.mirrorY || shape.mirrorZ)
  );
}

function cadModifierPrimitiveForShape(shape: WorkplaneShape): CadModifierPrimitivePart | null {
  return cadModifierPrimitiveForBakedShape(shape)
    ?? cadModifierPrimitiveForAnalyticCylinder(shape)
    ?? (shapeHasTransformToBake(shape) ? cadModifierPrimitiveForAnalyticBox(shape) : null)
    ?? cadModifierPrimitiveForAnalyticBox(shape);
}

function bakeShapeTransformIntoMesh(shape: WorkplaneShape): WorkplaneShape {
  if (!shapeHasTransformToBake(shape)) {
    return shape;
  }

  const mesh = meshForShape(shape);
  if (mesh.vertices.length < 3 || mesh.faces.length < 1) {
    return shape;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  mesh.vertices.forEach(([x, y, z]) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  });

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return shape;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions: number[] = [];
  const bakedCadMetadata = bakeCadMetadataForShapeTransform(shape, { centerX, minY, centerZ, width, depth, height, yawDegrees: meshYawDegrees(shape) });

  mesh.faces.forEach(([ai, bi, ci]) => {
    [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x - centerX, y - minY, z - centerZ);
    });
  });

  return {
    ...shape,
    kind: "mesh",
    x: cleanNearZero(centerX, 0.0005),
    z: cleanNearZero(centerZ, 0.0005),
    elevation: cleanNearZero(minY, 0.0005),
    width,
    depth,
    height,
    size: Math.max(width, depth),
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    mirrorX: undefined,
    mirrorY: undefined,
    mirrorZ: undefined,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: mesh.faces.length,
      sourceFormat: "json",
    },
    ...bakedCadMetadata,
    imagePlate: undefined,
    groupedShapes: undefined,
    groupedBaseWidth: undefined,
    groupedBaseDepth: undefined,
    groupedBaseHeight: undefined,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Image could not be read"));
      }
    });
    reader.addEventListener("error", () => reject(new Error("Image could not be read")));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Image could not be decoded")));
    image.src = dataUrl;
  });
}

async function prepareImportedImage(file: File) {
  const sourceUrl = await readFileAsDataUrl(file);
  const image = await loadImageElement(sourceUrl);
  const pixelWidth = image.naturalWidth || image.width;
  const pixelHeight = image.naturalHeight || image.height;

  if (!pixelWidth || !pixelHeight) {
    throw new Error("Image has no readable dimensions");
  }

  const maxTextureSide = hardwareProfile().maxTextureSide;
  const textureScale = Math.min(1, maxTextureSide / Math.max(pixelWidth, pixelHeight));
  if (textureScale >= 1) {
    return {
      dataUrl: sourceUrl,
      mimeType: file.type || "image/png",
      pixelWidth,
      pixelHeight,
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(pixelWidth * textureScale));
  canvas.height = Math.max(1, Math.round(pixelHeight * textureScale));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Image could not be prepared");
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const mimeType = file.type === "image/jpeg" || file.type === "image/webp" ? file.type : "image/png";
  return {
    dataUrl: canvas.toDataURL(mimeType, 0.92),
    mimeType,
    pixelWidth,
    pixelHeight,
  };
}

function imagePlateDimensions(pixelWidth: number, pixelHeight: number) {
  const aspect = pixelWidth / Math.max(1, pixelHeight);
  const targetMax = 72;
  const minVisibleSide = 14;
  const maxAllowedSide = 110;
  let width = aspect >= 1 ? targetMax : targetMax * aspect;
  let depth = aspect >= 1 ? targetMax / aspect : targetMax;
  const minSide = Math.min(width, depth);

  if (minSide < minVisibleSide) {
    const boost = minVisibleSide / Math.max(0.001, minSide);
    width *= boost;
    depth *= boost;
  }

  const maxSide = Math.max(width, depth);
  if (maxSide > maxAllowedSide) {
    const shrink = maxAllowedSide / maxSide;
    width *= shrink;
    depth *= shrink;
  }

  return {
    width: Number(width.toFixed(2)),
    depth: Number(depth.toFixed(2)),
    height: 1.6,
  };
}

async function importedShapeFromImage(file: File): Promise<WorkplaneShape> {
  const imagePlate = await prepareImportedImage(file);
  const dimensions = imagePlateDimensions(imagePlate.pixelWidth, imagePlate.pixelHeight);
  return {
    id: createLocalId("uploaded-image"),
    name: file.name.replace(/\.[^.]+$/, "") || "Imported Image",
    kind: "box",
    color: "#f4f7f9",
    x: 10,
    z: -10,
    size: Math.max(dimensions.width, dimensions.depth),
    width: dimensions.width,
    depth: dimensions.depth,
    height: dimensions.height,
    elevation: 0,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    radius: 0,
    steps: 1,
    imagePlate,
    locked: false,
    hidden: false,
  };
}

function normalFor(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

/** Binary STL (little-endian). Much cheaper than ASCII string join for large meshes. */
function toStl(meshes: MeshData[]) {
  let triangleCount = 0;
  for (const mesh of meshes) triangleCount += mesh.faces.length;
  const bytes = new Uint8Array(84 + triangleCount * 50);
  const view = new DataView(bytes.buffer);
  const header = "PeakCAD binary STL";
  for (let i = 0; i < 80; i += 1) {
    bytes[i] = i < header.length ? header.charCodeAt(i) : 0;
  }
  view.setUint32(80, triangleCount, true);
  let offset = 84;
  for (const mesh of meshes) {
    for (const [ai, bi, ci] of mesh.faces) {
      const a = mesh.vertices[ai];
      const b = mesh.vertices[bi];
      const c = mesh.vertices[ci];
      const n = normalFor(a, b, c);
      view.setFloat32(offset, n[0], true); offset += 4;
      view.setFloat32(offset, n[1], true); offset += 4;
      view.setFloat32(offset, n[2], true); offset += 4;
      view.setFloat32(offset, a[0], true); offset += 4;
      view.setFloat32(offset, a[1], true); offset += 4;
      view.setFloat32(offset, a[2], true); offset += 4;
      view.setFloat32(offset, b[0], true); offset += 4;
      view.setFloat32(offset, b[1], true); offset += 4;
      view.setFloat32(offset, b[2], true); offset += 4;
      view.setFloat32(offset, c[0], true); offset += 4;
      view.setFloat32(offset, c[1], true); offset += 4;
      view.setFloat32(offset, c[2], true); offset += 4;
      view.setUint16(offset, 0, true); offset += 2;
    }
  }
  return bytes;
}

function toObj(meshes: MeshData[]) {
  const lines = ["# SketchForge OBJ export"];
  let offset = 1;
  meshes.forEach((mesh) => {
    lines.push(`o ${mesh.name}`);
    mesh.vertices.forEach(([x, y, z]) => lines.push(`v ${x} ${y} ${z}`));
    mesh.faces.forEach(([a, b, c]) => lines.push(`f ${a + offset} ${b + offset} ${c + offset}`));
    offset += mesh.vertices.length;
  });
  return lines.join("\n");
}

function shapeAabb(shape: WorkplaneShape): Cuboid {
  const halfWidth = shapeWidth(shape) / 2;
  const halfDepth = shapeDepth(shape) / 2;
  return {
    minX: shape.x - halfWidth,
    maxX: shape.x + halfWidth,
    minY: shape.elevation ?? 0,
    maxY: (shape.elevation ?? 0) + shape.height,
    minZ: shape.z - halfDepth,
    maxZ: shape.z + halfDepth,
  };
}

function boundsForShapes(shapes: WorkplaneShape[]): Cuboid {
  const bounds = shapes.map(meshAabb);
  return boundsForCuboids(bounds);
}

function boundsForCuboids(bounds: Cuboid[]): Cuboid {
  return {
    minX: Math.min(...bounds.map((box) => box.minX)),
    maxX: Math.max(...bounds.map((box) => box.maxX)),
    minY: Math.min(...bounds.map((box) => box.minY)),
    maxY: Math.max(...bounds.map((box) => box.maxY)),
    minZ: Math.min(...bounds.map((box) => box.minZ)),
    maxZ: Math.max(...bounds.map((box) => box.maxZ)),
  };
}

function dropPatchForShape(shape: WorkplaneShape, targetY: number): Partial<WorkplaneShape> {
  const bounds = meshAabb(shape);
  const delta = targetY - bounds.minY;
  const nextElevation = (shape.elevation ?? 0) + delta;
  return { elevation: Math.abs(nextElevation) < 0.0005 ? 0 : Number(nextElevation.toFixed(4)) };
}

function meshAabb(shape: WorkplaneShape): Cuboid {
  const mesh = meshForShape(shape);
  if (mesh.vertices.length === 0) {
    return shapeAabb(shape);
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  mesh.vertices.forEach(([x, y, z]) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  });

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return shapeAabb(shape);
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

const ALIGN_EPSILON = 0.0005;
const ALIGN_AXES: AlignAxis[] = ["x", "y", "z"];
const ALIGN_TARGETS: AlignTarget[] = ["min", "center", "max"];

function alignCoordinate(bounds: Cuboid, axis: AlignAxis, target: AlignTarget) {
  const min = axis === "x" ? bounds.minX : axis === "y" ? bounds.minY : bounds.minZ;
  const max = axis === "x" ? bounds.maxX : axis === "y" ? bounds.maxY : bounds.maxZ;
  if (target === "min") {
    return min;
  }
  if (target === "max") {
    return max;
  }
  return (min + max) / 2;
}

/** Design pivot — axis center for cones/frustums, not mesh-AABB midpoint. */
function shapeAlignCenter(shape: WorkplaneShape, axis: AlignAxis) {
  if (axis === "x") {
    return shape.x;
  }
  if (axis === "z") {
    return shape.z;
  }
  return (shape.elevation ?? 0) + shape.height / 2;
}

function alignCoordinateForShape(shape: WorkplaneShape, bounds: Cuboid, axis: AlignAxis, target: AlignTarget) {
  if (target === "center") {
    return shapeAlignCenter(shape, axis);
  }
  return alignCoordinate(bounds, axis, target);
}

function referenceAlignCoordinate(
  shapes: WorkplaneShape[],
  boundsById: Map<string, Cuboid>,
  anchorId: string | null,
  axis: AlignAxis,
  target: AlignTarget,
) {
  if (target === "center") {
    if (anchorId) {
      const anchor = shapes.find((shape) => shape.id === anchorId);
      if (anchor) {
        return shapeAlignCenter(anchor, axis);
      }
    }
    if (shapes.length === 0) {
      return 0;
    }
    return shapes.reduce((sum, shape) => sum + shapeAlignCenter(shape, axis), 0) / shapes.length;
  }
  const anchorBounds = anchorId ? boundsById.get(anchorId) ?? null : null;
  const referenceBounds = anchorBounds ?? boundsForCuboids(Array.from(boundsById.values()));
  return alignCoordinate(referenceBounds, axis, target);
}

function alignmentLabel(axis: AlignAxis, target: AlignTarget) {
  if (axis === "x") {
    return target === "min" ? "left" : target === "max" ? "right" : "center";
  }
  if (axis === "z") {
    return target === "min" ? "front" : target === "max" ? "back" : "middle";
  }
  return target === "min" ? "bottom" : target === "max" ? "top" : "middle";
}

function alignmentStatuses(selection: WorkplaneShape[], anchorId: string | null): AlignHandleStatus[] {
  if (selection.length < 2) {
    return [];
  }

  const boundsById = new Map(selection.map((shape) => [shape.id, meshAabb(shape)]));

  return ALIGN_AXES.flatMap((axis) =>
    ALIGN_TARGETS.map((target) => {
      const targetValue = referenceAlignCoordinate(selection, boundsById, anchorId, axis, target);
      const aligned = selection.every((shape) => {
        const bounds = boundsById.get(shape.id);
        return bounds ? Math.abs(alignCoordinateForShape(shape, bounds, axis, target) - targetValue) <= ALIGN_EPSILON : true;
      });
      const wouldMove = selection.some((shape) => {
        if (shape.locked || shape.id === anchorId) {
          return false;
        }
        const bounds = boundsById.get(shape.id);
        return bounds ? Math.abs(alignCoordinateForShape(shape, bounds, axis, target) - targetValue) > ALIGN_EPSILON : false;
      });
      const label = alignmentLabel(axis, target);
      return {
        axis,
        target,
        aligned,
        disabled: !wouldMove,
        title: aligned ? `Already aligned ${label}` : `Align ${label}`,
      };
    }),
  );
}

function alignedShapesForSelection(
  shapes: WorkplaneShape[],
  selectedIds: string[],
  selectedShapes: WorkplaneShape[],
  anchorId: string | null,
  axis: AlignAxis,
  target: AlignTarget,
) {
  const selected = new Set(selectedIds);
  const boundsById = new Map(selectedShapes.map((shape) => [shape.id, meshAabb(shape)]));
  const targetValue = referenceAlignCoordinate(selectedShapes, boundsById, anchorId, axis, target);
  let moved = 0;

  const nextShapes = shapes.map((shape) => {
    if (!selected.has(shape.id) || shape.locked || shape.id === anchorId) {
      return shape;
    }
    const bounds = boundsById.get(shape.id);
    if (!bounds) {
      return shape;
    }
    const delta = targetValue - alignCoordinateForShape(shape, bounds, axis, target);
    if (Math.abs(delta) <= ALIGN_EPSILON) {
      return shape;
    }
    moved += 1;
    if (axis === "x") {
      return { ...shape, x: cleanNearZero(Number((shape.x + delta).toFixed(4)), ALIGN_EPSILON) };
    }
    if (axis === "z") {
      return { ...shape, z: cleanNearZero(Number((shape.z + delta).toFixed(4)), ALIGN_EPSILON) };
    }
    return { ...shape, elevation: cleanNearZero(Number(((shape.elevation ?? 0) + delta).toFixed(4)), ALIGN_EPSILON) };
  });

  return { nextShapes, moved };
}

function effectiveAlignmentAnchorId(selection: WorkplaneShape[], requestedAnchorId: string | null) {
  return selection.find((shape) => shape.locked)?.id
    ?? (requestedAnchorId && selection.some((shape) => shape.id === requestedAnchorId) ? requestedAnchorId : null);
}

function mirrorAxisLabel(axis: AlignAxis) {
  return axis === "x" ? "left-right" : axis === "z" ? "front-back" : "top-bottom";
}

function mirrorFlagPatch(shape: WorkplaneShape, axis: AlignAxis) {
  if (axis === "x") {
    return { mirrorX: !shape.mirrorX };
  }
  if (axis === "z") {
    return { mirrorZ: !shape.mirrorZ };
  }
  return { mirrorY: !shape.mirrorY };
}

function reflectionMatrixForAxis(axis: AlignAxis) {
  return new THREE.Matrix4().makeScale(axis === "x" ? -1 : 1, axis === "y" ? -1 : 1, axis === "z" ? -1 : 1);
}

function mirroredShapePatch(shape: WorkplaneShape, axis: AlignAxis, pivot: number): Partial<WorkplaneShape> {
  const centerY = (shape.elevation ?? 0) + shape.height / 2;
  const nextCenter = axis === "x" ? 2 * pivot - shape.x : axis === "z" ? 2 * pivot - shape.z : 2 * pivot - centerY;
  const worldReflection = reflectionMatrixForAxis(axis);
  const localReflection = reflectionMatrixForAxis(axis);
  const currentRotation = new THREE.Matrix4().makeRotationFromQuaternion(quaternionForShape(shape));
  const nextRotationMatrix = worldReflection.multiply(currentRotation).multiply(localReflection);
  const nextQuaternion = new THREE.Quaternion().setFromRotationMatrix(nextRotationMatrix);
  const rotationPatch = rotationFromQuaternion(nextQuaternion);
  const positionPatch =
    axis === "x"
      ? { x: cleanNearZero(Number(nextCenter.toFixed(4)), ALIGN_EPSILON) }
      : axis === "z"
        ? { z: cleanNearZero(Number(nextCenter.toFixed(4)), ALIGN_EPSILON) }
        : { elevation: cleanNearZero(Number((nextCenter - shape.height / 2).toFixed(4)), ALIGN_EPSILON) };

  return {
    ...shape,
    ...positionPatch,
    ...rotationPatch,
    ...mirrorFlagPatch(shape, axis),
  };
}

function mirroredShapesForSelection(shapes: WorkplaneShape[], selectedIds: string[], selectedShapes: WorkplaneShape[], axis: AlignAxis) {
  if (selectedShapes.length === 0) {
    return { nextShapes: shapes, moved: 0 };
  }

  const selected = new Set(selectedIds);
  const selectionBounds = boundsForShapes(selectedShapes);
  const pivot = axis === "x" ? (selectionBounds.minX + selectionBounds.maxX) / 2 : axis === "z" ? (selectionBounds.minZ + selectionBounds.maxZ) / 2 : (selectionBounds.minY + selectionBounds.maxY) / 2;
  let moved = 0;
  const nextShapes = shapes.map((shape) => {
    if (!selected.has(shape.id) || shape.locked) {
      return shape;
    }
    moved += 1;
    return {
      ...shape,
      ...mirroredShapePatch(shape, axis, pivot),
    };
  });

  return { nextShapes, moved };
}

function geometryFromMeshData(mesh: MeshData) {
  const positions: number[] = [];
  mesh.faces.forEach(([ai, bi, ci]) => {
    [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x, y, z);
    });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function positionsFromGeometryDrawRange(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position");
  if (!position) {
    return [];
  }

  const positions: number[] = [];
  const drawStart = Math.max(0, Math.floor(geometry.drawRange.start || 0));
  if (geometry.index) {
    const index = geometry.index;
    const drawCount = Number.isFinite(geometry.drawRange.count) ? Math.max(0, Math.floor(geometry.drawRange.count)) : index.count - drawStart;
    const end = Math.min(index.count, drawStart + drawCount);
    for (let i = drawStart; i + 2 < end; i += 3) {
      for (let offset = 0; offset < 3; offset += 1) {
        const vertexIndex = index.getX(i + offset);
        positions.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
      }
    }
    return positions;
  }

  const drawCount = Number.isFinite(geometry.drawRange.count) ? Math.max(0, Math.floor(geometry.drawRange.count)) : position.count - drawStart;
  const end = Math.min(position.count, drawStart + drawCount);
  for (let i = drawStart; i + 2 < end; i += 3) {
    positions.push(
      position.getX(i),
      position.getY(i),
      position.getZ(i),
      position.getX(i + 1),
      position.getY(i + 1),
      position.getZ(i + 1),
      position.getX(i + 2),
      position.getY(i + 2),
      position.getZ(i + 2),
    );
  }
  return positions;
}

function boundsForPositions(positions: number[]): Cuboid | null {
  if (positions.length < 9) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  return [minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) ? { minX, maxX, minY, maxY, minZ, maxZ } : null;
}

function quantizedPointKey([x, y, z]: Vec3, tolerance: number) {
  return [x, y, z].map((value) => Math.round(value / tolerance)).join(",");
}

function triangleSignature(points: Vec3[], tolerance: number) {
  return points.map((point) => quantizedPointKey(point, tolerance)).sort().join("|");
}

function addSignature(signatures: Map<string, number>, signature: string) {
  signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
}

function meshSignatureMap(mesh: MeshData, tolerance: number) {
  const signatures = new Map<string, number>();
  mesh.faces.forEach(([ai, bi, ci]) => {
    addSignature(signatures, triangleSignature([mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]], tolerance));
  });
  return signatures;
}

function positionsSignatureMap(positions: number[], tolerance: number) {
  const signatures = new Map<string, number>();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    addSignature(
      signatures,
      triangleSignature(
        [
          [positions[i], positions[i + 1], positions[i + 2]],
          [positions[i + 3], positions[i + 4], positions[i + 5]],
          [positions[i + 6], positions[i + 7], positions[i + 8]],
        ],
        tolerance,
      ),
    );
  }
  return signatures;
}

function signatureMapsDiffer(a: Map<string, number>, b: Map<string, number>) {
  if (a.size !== b.size) {
    return true;
  }
  for (const [signature, count] of a) {
    if (b.get(signature) !== count) {
      return true;
    }
  }
  return false;
}

function positionsDifferFromMeshData(positions: number[], mesh: MeshData, tolerance = 0.0005) {
  if (Math.floor(positions.length / 9) !== mesh.faces.length) {
    return true;
  }
  return signatureMapsDiffer(positionsSignatureMap(positions, tolerance), meshSignatureMap(mesh, tolerance));
}

function geometryDiffersFromMeshData(geometry: THREE.BufferGeometry, mesh: MeshData, tolerance = 0.0005) {
  return positionsDifferFromMeshData(positionsFromGeometryDrawRange(geometry), mesh, tolerance);
}

function sortedEdgeKey(a: Vec3, b: Vec3, tolerance: number) {
  const ak = quantizedPointKey(a, tolerance);
  const bk = quantizedPointKey(b, tolerance);
  return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}

function edgeMidpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function addBoundaryEdge(edges: Map<string, { count: number; midpoint: Vec3 }>, a: Vec3, b: Vec3, tolerance: number) {
  const key = sortedEdgeKey(a, b, tolerance);
  const existing = edges.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    edges.set(key, { count: 1, midpoint: edgeMidpoint(a, b) });
  }
}

function positionsBoundaryEdges(positions: number[], tolerance = 0.0005) {
  const edges = new Map<string, { count: number; midpoint: Vec3 }>();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a: Vec3 = [positions[i], positions[i + 1], positions[i + 2]];
    const b: Vec3 = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const c: Vec3 = [positions[i + 6], positions[i + 7], positions[i + 8]];
    addBoundaryEdge(edges, a, b, tolerance);
    addBoundaryEdge(edges, b, c, tolerance);
    addBoundaryEdge(edges, c, a, tolerance);
  }
  return Array.from(edges.values()).filter((edge) => edge.count === 1);
}

function meshDataPositions(mesh: MeshData) {
  const positions: number[] = [];
  mesh.faces.forEach(([ai, bi, ci]) => {
    [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x, y, z);
    });
  });
  return positions;
}

function meshFaceComponents(mesh: MeshData, tolerance = SEPARATE_PARTS_VERTEX_TOLERANCE) {
  if (mesh.faces.length === 0) return [];
  const keysByFace = mesh.faces.map((face) => face.map((vertexIndex) => quantizedPointKey(mesh.vertices[vertexIndex], tolerance)));
  const facesByVertex = new Map<string, number[]>();
  keysByFace.forEach((keys, faceIndex) => {
    keys.forEach((key) => {
      const current = facesByVertex.get(key);
      if (current) {
        current.push(faceIndex);
      } else {
        facesByVertex.set(key, [faceIndex]);
      }
    });
  });

  const visited = new Uint8Array(mesh.faces.length);
  const components: number[][] = [];
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex += 1) {
    if (visited[faceIndex]) continue;
    const component: number[] = [];
    const queue = [faceIndex];
    visited[faceIndex] = 1;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      component.push(current);
      keysByFace[current].forEach((key) => {
        const neighbors = facesByVertex.get(key);
        if (!neighbors) return;
        facesByVertex.delete(key);
        neighbors.forEach((neighbor) => {
          if (visited[neighbor]) return;
          visited[neighbor] = 1;
          queue.push(neighbor);
        });
      });
    }
    components.push(component);
  }
  return components;
}

function meshComponentShape(source: WorkplaneShape, mesh: MeshData, faceIndices: number[], partIndex: number, totalParts: number): WorkplaneShape | null {
  const worldPositions: number[] = [];
  faceIndices.forEach((faceIndex) => {
    const face = mesh.faces[faceIndex];
    if (!face) return;
    face.forEach((vertexIndex) => {
      const vertex = mesh.vertices[vertexIndex];
      if (vertex) worldPositions.push(vertex[0], vertex[1], vertex[2]);
    });
  });

  const bounds = boundsForPositions(worldPositions);
  if (!bounds) return null;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, bounds.maxX - bounds.minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, bounds.maxY - bounds.minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, bounds.maxZ - bounds.minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions = worldPositions.map((value, index) => {
    if (index % 3 === 0) return value - centerX;
    if (index % 3 === 1) return value - bounds.minY;
    return value - centerZ;
  });

  return canonicalizeShape({
    id: createLocalId(`${source.id}-part`),
    name: totalParts > 1 ? `${source.name} Part ${partIndex + 1}` : source.name,
    kind: "mesh",
    color: source.color,
    hole: source.hole || undefined,
    x: cleanNearZero(centerX, 0.0005),
    z: cleanNearZero(centerZ, 0.0005),
    elevation: cleanNearZero(bounds.minY, 0.0005),
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    locked: false,
    hidden: source.hidden,
  });
}

function separateMeshParts(shape: WorkplaneShape) {
  const mesh = meshForShape(shape);
  const components = meshFaceComponents(mesh).filter((component) => component.length > 0);
  if (components.length <= 1) return [];
  return components
    .map((component, index) => meshComponentShape(shape, mesh, component, index, components.length))
    .filter((part): part is WorkplaneShape => Boolean(part));
}

function separablePartCount(shape: WorkplaneShape) {
  if (shape.locked || shape.hole) return 0;
  if (canSeparateThreadScrew(shape)) return 2;
  if (shape.groupedShapes?.length && !shape.importedMesh) return shape.groupedShapes.length;
  const mesh = meshForShape(shape);
  return meshFaceComponents(mesh).length;
}

function separateShapeParts(shape: WorkplaneShape) {
  if (shape.locked || shape.hole) return [];
  if (canSeparateThreadScrew(shape)) {
    return separateThreadScrewParts(shape);
  }
  if (shape.groupedShapes?.length && !shape.importedMesh) {
    const restored = restoreGroupedChildren(shape);
    return restored.length > 1 ? restored : [];
  }
  return separateMeshParts(shape);
}

function cutBoundaryEdgeCount(positions: number[], cutters: WorkplaneShape[]) {
  if (cutters.length === 0) {
    return 0;
  }
  return positionsBoundaryEdges(positions).filter((edge) => cutters.some((cutter) => pointInsideHoleShape(edge.midpoint, cutter))).length;
}

function introducesOpenCutBoundary(resultPositions: number[], sourceMesh: MeshData, cutters: WorkplaneShape[]) {
  const resultCutBoundaries = cutBoundaryEdgeCount(resultPositions, cutters);
  if (resultCutBoundaries === 0) {
    return false;
  }

  const sourceCutBoundaries = cutBoundaryEdgeCount(meshDataPositions(sourceMesh), cutters);
  return resultCutBoundaries > sourceCutBoundaries + Math.max(4, Math.floor(sourceCutBoundaries * 0.25));
}

function cuboidFromBox3(box: THREE.Box3): Cuboid {
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.y,
    maxY: box.max.y,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
}

function paddedCutterShape(shape: WorkplaneShape): WorkplaneShape {
  // Exact user dimensions (matches STEP export). Face-hosted sketch holes overshoot
  // along the cut normal at bake time via faceHoleOvershootMm — never grow XY.
  return shape;
}

function brushFromShape(shape: WorkplaneShape, cutter = false) {
  const brush = new Brush(geometryFromMeshData(meshForShape(cutter ? paddedCutterShape(shape) : shape)));
  brush.updateMatrixWorld(true);
  return brush;
}

function disposeBrush(brush: Brush | null | undefined) {
  try {
    brush?.geometry?.dispose();
  } catch {
    // Geometry may already be disposed by the evaluator.
  }
}

/** Evaluate CSG and dispose both input brushes (three-bvh-csg returns a new brush). */
function evaluateBrushDisposing(evaluator: Evaluator, a: Brush, b: Brush, operation: CSGOperation) {
  try {
    return evaluator.evaluate(a, b, operation);
  } finally {
    disposeBrush(a);
    disposeBrush(b);
  }
}

function positiveCuboid(cuboid: Cuboid) {
  return cuboid.maxX - cuboid.minX > 0.01 && cuboid.maxY - cuboid.minY > 0.01 && cuboid.maxZ - cuboid.minZ > 0.01;
}

function subtractCuboid(source: Cuboid, cutter: Cuboid): Cuboid[] {
  const overlap = {
    minX: Math.max(source.minX, cutter.minX),
    maxX: Math.min(source.maxX, cutter.maxX),
    minY: Math.max(source.minY, cutter.minY),
    maxY: Math.min(source.maxY, cutter.maxY),
    minZ: Math.max(source.minZ, cutter.minZ),
    maxZ: Math.min(source.maxZ, cutter.maxZ),
  };

  if (!positiveCuboid(overlap)) {
    return [source];
  }

  return [
    { ...source, maxX: overlap.minX },
    { ...source, minX: overlap.maxX },
    { minX: overlap.minX, maxX: overlap.maxX, minY: source.minY, maxY: source.maxY, minZ: source.minZ, maxZ: overlap.minZ },
    { minX: overlap.minX, maxX: overlap.maxX, minY: source.minY, maxY: source.maxY, minZ: overlap.maxZ, maxZ: source.maxZ },
    { minX: overlap.minX, maxX: overlap.maxX, minY: source.minY, maxY: overlap.minY, minZ: overlap.minZ, maxZ: overlap.maxZ },
    { minX: overlap.minX, maxX: overlap.maxX, minY: overlap.maxY, maxY: source.maxY, minZ: overlap.minZ, maxZ: overlap.maxZ },
  ].filter(positiveCuboid);
}

function cuboidsOverlap(a: Cuboid, b: Cuboid) {
  return (
    Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 0.01 &&
    Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > 0.01 &&
    Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 0.01
  );
}

function hasSolidHoleOverlap(solids: WorkplaneShape[], holes: WorkplaneShape[]) {
  const solidBounds = solids.map(meshAabb);
  const holeBounds = holes.map((hole) => meshAabb(paddedCutterShape(hole)));
  return solidBounds.some((solid) => holeBounds.some((hole) => cuboidsOverlap(solid, hole)));
}

/** Host extent along a unit-ish face normal (AABB slab) — used for through-cut defaults. */
function shapeThicknessAlongNormal(
  shape: WorkplaneShape,
  normal: { x: number; y: number; z: number },
) {
  const bounds = meshAabb(shape);
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const nx = normal.x / length;
  const ny = normal.y / length;
  const nz = normal.z / length;
  // True slab thickness: project all AABB corners onto the normal.
  let minDot = Number.POSITIVE_INFINITY;
  let maxDot = Number.NEGATIVE_INFINITY;
  const xs = [bounds.minX, bounds.maxX];
  const ys = [bounds.minY, bounds.maxY];
  const zs = [bounds.minZ, bounds.maxZ];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const d = x * nx + y * ny + z * nz;
        minDot = Math.min(minDot, d);
        maxDot = Math.max(maxDot, d);
      }
    }
  }
  return Math.max(0.5, Number((maxDot - minDot).toFixed(2)));
}

/**
 * Distance from a face origin into the solid along -normal (outward normal).
 * Prefer this over full AABB thickness when the sketch plane sits on one skin —
 * avoids half-depth cuts when origin is near mid-slab after a bad recenter.
 */
function shapeThicknessInwardFromFace(
  shape: WorkplaneShape,
  origin: { x: number; y: number; z: number },
  outwardNormal: { x: number; y: number; z: number },
) {
  const bounds = meshAabb(shape);
  const length = Math.hypot(outwardNormal.x, outwardNormal.y, outwardNormal.z) || 1;
  const nx = outwardNormal.x / length;
  const ny = outwardNormal.y / length;
  const nz = outwardNormal.z / length;
  let minDot = Number.POSITIVE_INFINITY;
  let maxDot = Number.NEGATIVE_INFINITY;
  const xs = [bounds.minX, bounds.maxX];
  const ys = [bounds.minY, bounds.maxY];
  const zs = [bounds.minZ, bounds.maxZ];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const d = x * nx + y * ny + z * nz;
        minDot = Math.min(minDot, d);
        maxDot = Math.max(maxDot, d);
      }
    }
  }
  const originDot = origin.x * nx + origin.y * ny + origin.z * nz;
  const slab = maxDot - minDot;
  // Outward face ≈ maxDot; inward distance from the sketch origin to the back skin.
  const inward = originDot - minDot;
  const outward = maxDot - originDot;
  // If the origin sits on the outer skin, inward ≈ full slab. If it's slightly
  // inside, still use the remaining solid behind the face.
  const thickness = Math.max(inward, outward) > slab * 0.1
    ? Math.max(inward, 0)
    : slab;
  return Math.max(0.5, Number(Math.min(slab, thickness || slab).toFixed(2)));
}

function overlapVolume(a: Cuboid, b: Cuboid) {
  const dx = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const dy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  const dz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (dx <= 0 || dy <= 0 || dz <= 0) return 0;
  return dx * dy * dz;
}

/** Pick the best overlapping non-hole solid for a sketch cutter when hostShapeId is missing/stale. */
function findOverlappingHostForHole(
  hole: WorkplaneShape,
  shapes: WorkplaneShape[],
  preferredId?: string | null,
): WorkplaneShape | null {
  const candidates = shapes.filter(
    (shape) => shape.id !== hole.id && !shape.hole && !shape.locked && !shape.hidden,
  );
  // Face-host links target body ids — prefer them even when AABB overlap is thin.
  if (preferredId) {
    const preferred = candidates.find((shape) => shape.id === preferredId);
    if (preferred) return preferred;
  }
  const holeBounds = meshAabb(paddedCutterShape(hole));
  let best: WorkplaneShape | null = null;
  let bestVolume = 0;
  for (const solid of candidates) {
    const volume = overlapVolume(meshAabb(solid), holeBounds);
    if (volume > bestVolume) {
      best = solid;
      bestVolume = volume;
    }
  }
  return bestVolume > 0.01 ? best : null;
}

/** Keep sketch→host links valid after Group mints new child ids / a new group id. */
function rewriteSketchHostIds(shape: WorkplaneShape, fromHostId: string, toHostId: string): WorkplaneShape {
  const rewritePlane = (plane?: SketchPlane | null) => {
    if (!plane?.hostShapeId || plane.hostShapeId !== fromHostId) return plane ?? undefined;
    return { ...plane, hostShapeId: toHostId };
  };
  const next: WorkplaneShape = {
    ...shape,
    sketchPlane: rewritePlane(shape.sketchPlane),
    sketchProfile: shape.sketchProfile
      ? {
          ...shape.sketchProfile,
          sketchPlane: rewritePlane(shape.sketchProfile.sketchPlane),
        }
      : shape.sketchProfile,
    sketchDoc: shape.sketchDoc
      ? {
          ...shape.sketchDoc,
          plane: rewritePlane(shape.sketchDoc.plane) ?? shape.sketchDoc.plane,
        }
      : shape.sketchDoc,
    groupedShapes: shape.groupedShapes?.map((child) => rewriteSketchHostIds(child, fromHostId, toHostId)),
  };
  return next;
}

function pointInsideCuboid(point: Vec3, cuboid: Cuboid, inset = -POINT_TOLERANCE) {
  const minX = cuboid.minX + inset;
  const maxX = cuboid.maxX - inset;
  const minY = cuboid.minY + inset;
  const maxY = cuboid.maxY - inset;
  const minZ = cuboid.minZ + inset;
  const maxZ = cuboid.maxZ - inset;
  return (
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ &&
    point[0] >= minX &&
    point[0] <= maxX &&
    point[1] >= minY &&
    point[1] <= maxY &&
    point[2] >= minZ &&
    point[2] <= maxZ
  );
}

function pointInsideHoleShape(point: Vec3, shape: WorkplaneShape, strictInterior = false) {
  if (shape.importedMesh || shape.groupedShapes?.length) {
    return pointInsideCuboid(point, meshAabb(shape), strictInterior ? CUTTER_RESIDUAL_INSET : -POINT_TOLERANCE);
  }

  const centerY = shape.height / 2;
  const inverse = new THREE.Matrix4()
    .makeRotationFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(shape.rotationX ?? 0),
        THREE.MathUtils.degToRad(shape.rotation),
        THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
        "XYZ",
      ),
    )
    .invert();
  const local = new THREE.Vector3(point[0] - shape.x, point[1] - (shape.elevation ?? 0) - centerY, point[2] - shape.z).applyMatrix4(inverse);
  const localY = local.y + centerY;
  const halfWidth = shapeWidth(shape) / 2;
  const halfDepth = shapeDepth(shape) / 2;
  if (strictInterior) {
    const yInset = Math.min(CUTTER_RESIDUAL_INSET, shape.height * 0.25);
    const xInset = Math.min(CUTTER_RESIDUAL_INSET, halfWidth * 0.25);
    const zInset = Math.min(CUTTER_RESIDUAL_INSET, halfDepth * 0.25);
    const innerHalfWidth = halfWidth - xInset;
    const innerHalfDepth = halfDepth - zInset;
    if (innerHalfWidth <= 0 || innerHalfDepth <= 0 || localY <= yInset || localY >= shape.height - yInset) {
      return false;
    }

    if (shape.kind === "cylinder" || shape.kind === "sphere" || shape.kind === "halfSphere" || shape.kind === "cone" || shape.kind === "torus" || shape.kind === "tube" || shape.kind === "ring") {
      const nx = local.x / Math.max(POINT_TOLERANCE, innerHalfWidth);
      const nz = local.z / Math.max(POINT_TOLERANCE, innerHalfDepth);
      return nx * nx + nz * nz < 1;
    }

    return Math.abs(local.x) < innerHalfWidth && Math.abs(local.z) < innerHalfDepth;
  }

  const insideHeight = localY >= -POINT_TOLERANCE && localY <= shape.height + POINT_TOLERANCE;
  if (!insideHeight) {
    return false;
  }

  if (shape.kind === "cylinder" || shape.kind === "sphere" || shape.kind === "halfSphere" || shape.kind === "cone" || shape.kind === "torus" || shape.kind === "tube" || shape.kind === "ring") {
    const nx = local.x / Math.max(POINT_TOLERANCE, halfWidth);
    const nz = local.z / Math.max(POINT_TOLERANCE, halfDepth);
    return nx * nx + nz * nz <= 1.0001;
  }

  return Math.abs(local.x) <= halfWidth + POINT_TOLERANCE && Math.abs(local.z) <= halfDepth + POINT_TOLERANCE;
}

function triangleCentroid([a, b, c]: Vec3[]): Vec3 {
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function triangleAabb([a, b, c]: Vec3[]): Cuboid {
  return {
    minX: Math.min(a[0], b[0], c[0]),
    maxX: Math.max(a[0], b[0], c[0]),
    minY: Math.min(a[1], b[1], c[1]),
    maxY: Math.max(a[1], b[1], c[1]),
    minZ: Math.min(a[2], b[2], c[2]),
    maxZ: Math.max(a[2], b[2], c[2]),
  };
}

function polygonAabb(points: Vec3[]): Cuboid {
  return points.reduce<Cuboid>(
    (bounds, [x, y, z]) => ({
      minX: Math.min(bounds.minX, x),
      maxX: Math.max(bounds.maxX, x),
      minY: Math.min(bounds.minY, y),
      maxY: Math.max(bounds.maxY, y),
      minZ: Math.min(bounds.minZ, z),
      maxZ: Math.max(bounds.maxZ, z),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    },
  );
}

function cuboidsTouch(a: Cuboid, b: Cuboid, tolerance = 0.0001) {
  return (
    Math.min(a.maxX, b.maxX) + tolerance >= Math.max(a.minX, b.minX) &&
    Math.min(a.maxY, b.maxY) + tolerance >= Math.max(a.minY, b.minY) &&
    Math.min(a.maxZ, b.maxZ) + tolerance >= Math.max(a.minZ, b.minZ)
  );
}

function triangleTouchesHoleShape(triangle: Vec3[], hole: WorkplaneShape, holeBounds: Cuboid) {
  const bounds = triangleAabb(triangle);
  if (!cuboidsTouch(bounds, holeBounds)) {
    return false;
  }

  const [a, b, c] = triangle;
  const samples = [a, b, c, triangleCentroid(triangle), midpoint(a, b), midpoint(b, c), midpoint(c, a)];
  if (samples.some((point) => pointInsideHoleShape(point, hole))) {
    return true;
  }

  // Imported STLs are often open triangle soups. A cutter can cross a small triangle
  // without catching any sampled point, so tiny overlapping triangles are clipped too.
  const triangleSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  const cutterSpan = Math.max(holeBounds.maxX - holeBounds.minX, holeBounds.maxY - holeBounds.minY, holeBounds.maxZ - holeBounds.minZ);
  return triangleSpan <= cutterSpan * 0.35;
}

function cutterTouchedTriangleCount(mesh: MeshData, cutters: WorkplaneShape[]) {
  const cutterInfo = cutters.map((cutter) => ({ shape: cutter, bounds: meshAabb(cutter) }));
  return mesh.faces.reduce((total, [ai, bi, ci]) => {
    const triangle = [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]];
    return total + (cutterInfo.some((cutter) => triangleTouchesHoleShape(triangle, cutter.shape, cutter.bounds)) ? 1 : 0);
  }, 0);
}

function isAxisAlignedBoxCutter(shape: WorkplaneShape) {
  const rotation = Math.abs(normalizeDegrees(shape.rotation));
  const rotationX = Math.abs(normalizeDegrees(shape.rotationX ?? 0));
  const rotationZ = Math.abs(normalizeDegrees(shape.rotationZ ?? 0));
  const straightY = rotation < 0.001 || Math.abs(rotation - 180) < 0.001 || Math.abs(rotation - 360) < 0.001;
  const straightX = rotationX < 0.001 || Math.abs(rotationX - 180) < 0.001 || Math.abs(rotationX - 360) < 0.001;
  const straightZ = rotationZ < 0.001 || Math.abs(rotationZ - 180) < 0.001 || Math.abs(rotationZ - 360) < 0.001;
  return shape.kind === "box" && straightX && straightY && straightZ;
}

type ClipPlane = { axis: 0 | 1 | 2; value: number; keepGreater: boolean };

function clipDistance(point: Vec3, plane: ClipPlane) {
  return plane.keepGreater ? point[plane.axis] - plane.value : plane.value - point[plane.axis];
}

function interpolateVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clipPolygonByPlane(polygon: Vec3[], plane: ClipPlane, keepInside: boolean) {
  if (polygon.length < 3) {
    return [];
  }

  const clipped: Vec3[] = [];
  const isKept = (distance: number) => (keepInside ? distance >= -0.0001 : distance <= 0.0001);

  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const currentDistance = clipDistance(current, plane);
    const nextDistance = clipDistance(next, plane);
    const currentKept = isKept(currentDistance);
    const nextKept = isKept(nextDistance);

    if (currentKept) {
      clipped.push(current);
    }

    if (currentKept !== nextKept) {
      const denom = currentDistance - nextDistance;
      const t = Math.abs(denom) > 0.000001 ? currentDistance / denom : 0;
      clipped.push(interpolateVec3(current, next, t));
    }
  }

  return clipped;
}

function subtractCuboidFromPolygon(polygon: Vec3[], cuboid: Cuboid) {
  const planes: ClipPlane[] = [
    { axis: 0, value: cuboid.minX, keepGreater: true },
    { axis: 0, value: cuboid.maxX, keepGreater: false },
    { axis: 1, value: cuboid.minY, keepGreater: true },
    { axis: 1, value: cuboid.maxY, keepGreater: false },
    { axis: 2, value: cuboid.minZ, keepGreater: true },
    { axis: 2, value: cuboid.maxZ, keepGreater: false },
  ];
  let pending = [polygon];
  const outsidePieces: Vec3[][] = [];

  for (const plane of planes) {
    const nextPending: Vec3[][] = [];
    pending.forEach((piece) => {
      const outside = clipPolygonByPlane(piece, plane, false);
      if (outside.length >= 3) {
        outsidePieces.push(outside);
      }

      const inside = clipPolygonByPlane(piece, plane, true);
      if (inside.length >= 3) {
        nextPending.push(inside);
      }
    });
    pending = nextPending;
    if (pending.length === 0) {
      break;
    }
  }

  return outsidePieces;
}

function triangulatePolygonToPositions(polygon: Vec3[], positions: number[]) {
  if (polygon.length < 3) {
    return;
  }

  const first = polygon[0];
  for (let i = 1; i < polygon.length - 1; i += 1) {
    const b = polygon[i];
    const c = polygon[i + 1];
    positions.push(first[0], first[1], first[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
}

function addQuadToPositions(positions: number[], a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  positions.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
}

type HoleWallSide = "minX" | "maxX" | "minZ" | "maxZ";
type HoleWallSegment = { a: Vec3; b: Vec3; minCross: number; maxCross: number; avgY: number; key: string };

function localCutWallBaseY(segments: HoleWallSegment[], minY: number, maxY: number) {
  const ys = segments
    .flatMap((segment) => [segment.a[1], segment.b[1], segment.avgY])
    .filter((value) => value >= minY - 0.001 && value <= maxY + 0.001)
    .sort((a, b) => a - b);
  if (ys.length < 2) {
    return minY;
  }

  let largestGap = 0;
  let gapIndex = -1;
  const minimumGap = Math.max(0.25, (maxY - minY) * 0.08);
  for (let i = 1; i < ys.length; i += 1) {
    const gap = ys[i] - ys[i - 1];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = i;
    }
  }

  if (gapIndex > 0 && largestGap > minimumGap) {
    return ys[gapIndex - 1];
  }

  return ys[Math.max(0, Math.floor(ys.length * 0.12))];
}

function clipSegmentToRect(a: Vec3, b: Vec3, crossAxis: 0 | 1 | 2, crossMin: number, crossMax: number, minY: number, maxY: number): [Vec3, Vec3] | null {
  let t0 = 0;
  let t1 = 1;
  const clipRange = (start: number, end: number, min: number, max: number) => {
    const delta = end - start;
    if (Math.abs(delta) < 0.000001) {
      return start >= min - 0.0001 && start <= max + 0.0001;
    }
    const ta = (min - start) / delta;
    const tb = (max - start) / delta;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
    return t0 <= t1 + 0.0001;
  };

  if (!clipRange(a[crossAxis], b[crossAxis], crossMin, crossMax) || !clipRange(a[1], b[1], minY, maxY)) {
    return null;
  }

  const start = interpolateVec3(a, b, Math.max(0, Math.min(1, t0)));
  const end = interpolateVec3(a, b, Math.max(0, Math.min(1, t1)));
  return Math.hypot(start[0] - end[0], start[1] - end[1], start[2] - end[2]) > 0.01 ? [start, end] : null;
}

function trianglePlaneSegment(triangle: Vec3[], axis: 0 | 1 | 2, plane: number): [Vec3, Vec3] | null {
  const points: Vec3[] = [];
  const addPoint = (point: Vec3) => {
    if (!points.some((existing) => Math.hypot(existing[0] - point[0], existing[1] - point[1], existing[2] - point[2]) < 0.0001)) {
      points.push(point);
    }
  };

  for (let i = 0; i < 3; i += 1) {
    const a = triangle[i];
    const b = triangle[(i + 1) % 3];
    const da = a[axis] - plane;
    const db = b[axis] - plane;

    if (Math.abs(da) <= 0.0001) {
      addPoint(a);
    }
    if (Math.abs(db) <= 0.0001) {
      addPoint(b);
    }
    if (da * db < -0.00000001) {
      addPoint(interpolateVec3(a, b, da / (da - db)));
    }
  }

  if (points.length < 2) {
    return null;
  }

  let best: [Vec3, Vec3] = [points[0], points[1]];
  let bestDistance = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const distance = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = [points[i], points[j]];
      }
    }
  }

  return bestDistance > 0.01 ? best : null;
}

function addLocalHoleWallSegments(positions: number[], sourceMesh: MeshData, hole: Cuboid, solidBounds: Cuboid, side: HoleWallSide) {
  const axis = side === "minX" || side === "maxX" ? 0 : 2;
  const crossAxis = axis === 0 ? 2 : 0;
  const plane =
    side === "minX"
      ? Math.max(hole.minX, solidBounds.minX)
      : side === "maxX"
        ? Math.min(hole.maxX, solidBounds.maxX)
        : side === "minZ"
          ? Math.max(hole.minZ, solidBounds.minZ)
          : Math.min(hole.maxZ, solidBounds.maxZ);
  const crossMin = axis === 0 ? Math.max(hole.minZ, solidBounds.minZ) : Math.max(hole.minX, solidBounds.minX);
  const crossMax = axis === 0 ? Math.min(hole.maxZ, solidBounds.maxZ) : Math.min(hole.maxX, solidBounds.maxX);
  const minY = Math.max(hole.minY, solidBounds.minY);
  const maxY = Math.min(hole.maxY, solidBounds.maxY);
  const crossLength = crossMax - crossMin;
  if (crossLength <= 0.01 || maxY - minY <= 0.01) {
    return;
  }

  const sideTolerance = Math.max(0.0001, Math.min(hole.maxX - hole.minX, hole.maxZ - hole.minZ) * 0.0001);
  const seen = new Set<string>();
  const segmentKey = (a: Vec3, b: Vec3) => {
    const toKey = (point: Vec3) => `${Math.round(point[0] * 1000)},${Math.round(point[1] * 1000)},${Math.round(point[2] * 1000)}`;
    const ak = toKey(a);
    const bk = toKey(b);
    return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
  };
  const segments: HoleWallSegment[] = [];

  sourceMesh.faces.forEach(([ai, bi, ci]) => {
    const triangle = [sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]];
    const bounds = polygonAabb(triangle);
    const minSide = axis === 0 ? bounds.minX : bounds.minZ;
    const maxSide = axis === 0 ? bounds.maxX : bounds.maxZ;
    const minCross = crossAxis === 0 ? bounds.minX : bounds.minZ;
    const maxCross = crossAxis === 0 ? bounds.maxX : bounds.maxZ;
    if (maxSide < plane - sideTolerance || minSide > plane + sideTolerance || maxCross < crossMin || minCross > crossMax || bounds.maxY < hole.minY || bounds.minY > hole.maxY) {
      return;
    }

    const rawSegment = trianglePlaneSegment(triangle, axis, plane);
    if (!rawSegment) {
      return;
    }
    const clipped = clipSegmentToRect(rawSegment[0], rawSegment[1], crossAxis, crossMin, crossMax, minY, maxY);
    if (!clipped) {
      return;
    }
    const [a, b] = clipped;
    if (Math.max(a[1], b[1]) <= minY + 0.01) {
      return;
    }
    const key = segmentKey(a, b);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    segments.push({
      a,
      b,
      minCross: Math.min(a[crossAxis], b[crossAxis]),
      maxCross: Math.max(a[crossAxis], b[crossAxis]),
      avgY: (a[1] + b[1]) / 2,
      key,
    });
  });

  const yTolerance = Math.max(0.03, (maxY - minY) * 0.01);
  const baseY = Math.max(minY, Math.min(maxY, localCutWallBaseY(segments, minY, maxY)));
  const minimumCrossSpan = Math.max(0.04, crossLength * 0.002);

  segments.forEach((segment) => {
    if (segment.maxCross - segment.minCross < minimumCrossSpan || Math.max(segment.a[1], segment.b[1]) - baseY <= yTolerance) {
      return;
    }
    const baseA: Vec3 = [segment.a[0], baseY, segment.a[2]];
    const baseB: Vec3 = [segment.b[0], baseY, segment.b[2]];
    addQuadToPositions(positions, segment.a, segment.b, baseB, baseA);
  });
}

function addBoxHoleInteriorFaces(positions: number[], hole: Cuboid, sourceMesh: MeshData, solidBounds: Cuboid) {
  const x0 = Math.max(hole.minX, solidBounds.minX);
  const x1 = Math.min(hole.maxX, solidBounds.maxX);
  const z0 = Math.max(hole.minZ, solidBounds.minZ);
  const z1 = Math.min(hole.maxZ, solidBounds.maxZ);
  if (x1 - x0 <= 0.01 || z1 - z0 <= 0.01) {
    return;
  }

  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "minX");
  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "maxX");
  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "minZ");
  addLocalHoleWallSegments(positions, sourceMesh, hole, solidBounds, "maxZ");
}

function cuboidsToMesh(name: string, cuboids: Cuboid[], centerX: number, centerZ: number, baseY = 0): MeshData {
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];

  const uniqueSorted = (values: number[]) =>
    values
      .slice()
      .sort((a, b) => a - b)
      .filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]) > 0.0001);

  const xs = uniqueSorted(cuboids.flatMap((cuboid) => [cuboid.minX, cuboid.maxX]));
  const ys = uniqueSorted(cuboids.flatMap((cuboid) => [cuboid.minY, cuboid.maxY]));
  const zs = uniqueSorted(cuboids.flatMap((cuboid) => [cuboid.minZ, cuboid.maxZ]));
  const filled = new Set<string>();
  const cellKey = (x: number, y: number, z: number) => `${x}:${y}:${z}`;

  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      for (let zi = 0; zi < zs.length - 1; zi += 1) {
        const cx = (xs[xi] + xs[xi + 1]) / 2;
        const cy = (ys[yi] + ys[yi + 1]) / 2;
        const cz = (zs[zi] + zs[zi + 1]) / 2;
        const inside = cuboids.some(
          (cuboid) =>
            cx > cuboid.minX + 0.0001 &&
            cx < cuboid.maxX - 0.0001 &&
            cy > cuboid.minY + 0.0001 &&
            cy < cuboid.maxY - 0.0001 &&
            cz > cuboid.minZ + 0.0001 &&
            cz < cuboid.maxZ - 0.0001,
        );
        if (inside) {
          filled.add(cellKey(xi, yi, zi));
        }
      }
    }
  }

  const isFilled = (x: number, y: number, z: number) => filled.has(cellKey(x, y, z));
  const addQuad = (points: Vec3[]) => {
    const offset = vertices.length;
    vertices.push(...points);
    faces.push([offset, offset + 1, offset + 2], [offset, offset + 2, offset + 3]);
  };

  for (let xi = 0; xi < xs.length - 1; xi += 1) {
    for (let yi = 0; yi < ys.length - 1; yi += 1) {
      for (let zi = 0; zi < zs.length - 1; zi += 1) {
        if (!isFilled(xi, yi, zi)) {
          continue;
        }

        const x0 = xs[xi] - centerX;
        const x1 = xs[xi + 1] - centerX;
        const y0 = ys[yi] - baseY;
        const y1 = ys[yi + 1] - baseY;
        const z0 = zs[zi] - centerZ;
        const z1 = zs[zi + 1] - centerZ;

        if (!isFilled(xi - 1, yi, zi)) addQuad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
        if (!isFilled(xi + 1, yi, zi)) addQuad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]);
        if (!isFilled(xi, yi - 1, zi)) addQuad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
        if (!isFilled(xi, yi + 1, zi)) addQuad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]);
        if (!isFilled(xi, yi, zi - 1)) addQuad([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]);
        if (!isFilled(xi, yi, zi + 1)) addQuad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
      }
    }
  }

  return { name, vertices, faces };
}

function shapeIsSketchOperand(shape: WorkplaneShape) {
  return Boolean(shape.sketchFinish || shape.sketchProfile);
}

function shapeIsSketchHoleMesh(shape: WorkplaneShape) {
  return Boolean(
    shape.hole
    && (
      shapeIsSketchOperand(shape)
      || (shape.kind === "mesh" && shape.importedMesh && (shape.sketchFinish || shape.sketchDoc || shape.sketchPlane))
    ),
  );
}

function booleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const sourceTriangleCount = solids.reduce((total, solid) => total + meshForShape(solid).faces.length, 0);
  const sourceMesh = mergedSolidMeshData(solids);
  // Solid SUBTRACTION only — never HOLLOW_SUBTRACTION (face-punch → fractured "crazy" meshes).
  const operations: CSGOperation[] = [SUBTRACTION];

  for (const operation of operations) {
    let result: Brush | null = null;
    try {
      const evaluator = new Evaluator();
      evaluator.useGroups = false;
      evaluator.attributes = ["position", "normal"];
      (evaluator as Evaluator & { useCDTClipping?: boolean }).useCDTClipping = true;
      result = brushFromShape(solids[0]);
      result.updateMatrixWorld(true);

      solids.slice(1).forEach((solid) => {
        result = evaluateBrushDisposing(evaluator, result!, brushFromShape(solid), ADDITION);
        result.updateMatrixWorld(true);
      });

      holes.forEach((hole) => {
        result = evaluateBrushDisposing(evaluator, result!, brushFromShape(hole, true), operation);
        result.updateMatrixWorld(true);
      });

      const group = resultGeometryToMeshShape(selection, solids, result.geometry, "grouped-boolean");
      if (!group?.importedMesh) {
        continue;
      }
      // Prefer volume/bounds signals over triangle-count ±1 (tiny valid cuts are real).
      if (looksLikeUnchangedBooleanResult(group, sourceTriangleCount, true)) {
        continue;
      }
      const resultPositions = positionsFromGeometryDrawRange(result.geometry);
      if (introducesOpenCutBoundary(resultPositions, sourceMesh, holes.map(paddedCutterShape))) {
        continue;
      }
      if (!isUsableBooleanGroup(group, sourceTriangleCount, false)) {
        continue;
      }
      return group;
    } catch {
      // Try the next CSG operation.
    } finally {
      disposeBrush(result);
    }
  }

  return null;
}

function resultGeometryToMeshShape(
  selection: WorkplaneShape[],
  solids: WorkplaneShape[],
  geometry: THREE.BufferGeometry,
  idPrefix: string,
): WorkplaneShape | null {
  const resultPositions = cleanupBooleanPositions(positionsFromGeometryDrawRange(geometry));
  const groupBounds = boundsForPositions(resultPositions);
  if (!groupBounds) {
    return null;
  }

  const centerX = (groupBounds.minX + groupBounds.maxX) / 2;
  const centerZ = (groupBounds.minZ + groupBounds.maxZ) / 2;
  const minY = groupBounds.minY;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxX - groupBounds.minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxY - groupBounds.minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxZ - groupBounds.minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions: number[] = [];

  for (let i = 0; i < resultPositions.length; i += 3) {
    positions.push(resultPositions[i] - centerX, resultPositions[i + 1] - minY, resultPositions[i + 2] - centerZ);
  }

  const firstSolid = solids[0];
  const hasHole = selection.some((shape) => shape.hole);
  const csgOp: CsgOp = hasHole
    ? "subtract"
    : idPrefix.includes("intersection")
      ? "intersect"
      : "union";

  return withCsgMeta({
    id: createLocalId(idPrefix),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  }, csgOp, 1, false);
}

function isUsableBooleanGroup(group: WorkplaneShape | null, sourceTriangleCount = 0, enforceMinimumTriangles = true) {
  if (!group?.importedMesh) {
    return false;
  }

  const positions = group.importedMesh.positions;
  const triangleCount = group.importedMesh.triangleCount;
  const dimensions = [group.width, group.height, group.depth, group.size, group.x, group.z, group.elevation ?? 0];
  if (positions.length < 9 || triangleCount < 1 || positions.some((value) => !Number.isFinite(value)) || dimensions.some((value) => !Number.isFinite(value))) {
    return false;
  }

  const minTriangles = enforceMinimumTriangles && sourceTriangleCount > 0 ? Math.max(2, Math.min(48, Math.floor(sourceTriangleCount * 0.004))) : 2;
  return triangleCount >= minTriangles && group.width > 0.01 && group.height > 0.01 && group.depth > 0.01;
}

function looksLikeUnchangedBooleanResult(group: WorkplaneShape | null, sourceTriangleCount: number, requireChanged = true) {
  if (!group?.importedMesh) {
    return true;
  }

  if (!requireChanged) {
    return false;
  }

  // Only treat exact same triangle count as a no-op. A ±1 change is often a real micro-cut.
  return group.importedMesh.triangleCount === sourceTriangleCount;
}

function shapeContainsImportedMesh(shape: WorkplaneShape): boolean {
  return Boolean(shape.importedMesh) || Boolean(shape.groupedShapes?.some(shapeContainsImportedMesh));
}

function shapeIsImportedHole(shape: WorkplaneShape): boolean {
  return Boolean(shape.hole) && shapeContainsImportedMesh(shape);
}

function coplanarRescueCutterShape(shape: WorkplaneShape): WorkplaneShape {
  if (!shapeIsImportedHole(shape) || hasNonZeroRotation(shape)) {
    return shape;
  }
  return {
    ...shape,
    rotation: shape.rotation + COPLANAR_BOOLEAN_RESCUE_DEGREES,
    rotationZ: (shape.rotationZ ?? 0) + COPLANAR_BOOLEAN_RESCUE_DEGREES,
  };
}

function cloneAsGroupChild(shape: WorkplaneShape, centerX: number, centerZ: number, minY: number, preserveId = false): WorkplaneShape {
  return {
    ...shape,
    id: preserveId ? shape.id : createLocalId(`${shape.id}-group-child`),
    x: shape.x - centerX,
    z: shape.z - centerZ,
    elevation: (shape.elevation ?? 0) - minY,
  };
}

function mergedSolidMeshData(solids: WorkplaneShape[]) {
  const mergedSolidMesh: MeshData = { name: "ImportedBooleanSource", vertices: [], faces: [] };

  solids.forEach((solid) => {
    appendMeshData(mergedSolidMesh.vertices, mergedSolidMesh.faces, meshForShape(solid));
  });

  return mergedSolidMesh;
}

function meshDataToManifoldMesh(runtime: ManifoldToplevel, mesh: MeshData) {
  const vertProperties = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach(([x, y, z], index) => {
    vertProperties[index * 3] = x;
    vertProperties[index * 3 + 1] = y;
    vertProperties[index * 3 + 2] = z;
  });

  const triVerts = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach(([a, b, c], index) => {
    triVerts[index * 3] = a;
    triVerts[index * 3 + 1] = b;
    triVerts[index * 3 + 2] = c;
  });

  const manifoldMesh = new runtime.Mesh({
    numProp: 3,
    vertProperties,
    triVerts,
    tolerance: 0.001,
  });
  manifoldMesh.merge();
  return manifoldMesh;
}

function boxBoundsToManifold(runtime: ManifoldToplevel, bounds: Cuboid, created: ManifoldSolid[]) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const depth = bounds.maxZ - bounds.minZ;
  if (width <= 0.0001 || height <= 0.0001 || depth <= 0.0001) {
    return null;
  }

  const box = runtime.Manifold.cube([width, height, depth]);
  created.push(box);
  const moved = box.translate([bounds.minX, bounds.minY, bounds.minZ]);
  if (moved !== box && moved) {
    created.push(moved);
  }
  return moved;
}

function trackManifold<T extends ManifoldSolid | null>(created: ManifoldSolid[], value: T): T {
  if (value) {
    created.push(value);
  }
  return value;
}

function manifoldTransformFromMatrix(matrix: THREE.Matrix4) {
  return matrix.elements as unknown as Parameters<ManifoldSolid["transform"]>[0];
}

function shapeRotationQuaternion(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(meshYawDegrees(shape)),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
}

function primitiveTransformMatrix(shape: WorkplaneShape, scale: THREE.Vector3, alignRotation?: THREE.Euler) {
  const center = new THREE.Vector3(shape.x, (shape.elevation ?? 0) + shape.height / 2, shape.z);
  const matrix = new THREE.Matrix4().compose(center, shapeRotationQuaternion(shape), new THREE.Vector3(1, 1, 1));
  if (alignRotation) {
    matrix.multiply(new THREE.Matrix4().makeRotationFromEuler(alignRotation));
  }
  matrix.multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
  return matrix;
}

function transformedPrimitiveManifold(runtime: ManifoldToplevel, primitive: ManifoldSolid, matrix: THREE.Matrix4, created: ManifoldSolid[]) {
  trackManifold(created, primitive);
  return trackManifold(created, primitive.transform(manifoldTransformFromMatrix(matrix)));
}

function primitiveManifoldForShape(runtime: ManifoldToplevel, shape: WorkplaneShape, created: ManifoldSolid[]) {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  if (width <= 0.0001 || depth <= 0.0001 || height <= 0.0001) {
    return null;
  }

  if (shape.kind === "box") {
    return transformedPrimitiveManifold(runtime, runtime.Manifold.cube(1, true), primitiveTransformMatrix(shape, new THREE.Vector3(width, height, depth)), created);
  }

  if (shape.kind === "sphere") {
    const { widthSegments } = sphereTessellation(resolveShapeSteps(shape.kind, shape.steps));
    return transformedPrimitiveManifold(
      runtime,
      runtime.Manifold.sphere(1, widthSegments),
      primitiveTransformMatrix(shape, new THREE.Vector3(width / 2, height / 2, depth / 2)),
      created,
    );
  }

  if (shape.kind === "cylinder" || shape.kind === "cone") {
    const sides = resolveShapeSides(shape.kind, shape.sides) ?? 192;
    const radiusLow = shape.kind === "cone" ? coneUnitBaseScale(shape) : 1;
    const radiusHigh = shape.kind === "cone" ? coneUnitTopScale(shape) : 1;
    return transformedPrimitiveManifold(
      runtime,
      runtime.Manifold.cylinder(1, radiusLow, radiusHigh, sides, true),
      primitiveTransformMatrix(shape, new THREE.Vector3(width / 2, depth / 2, height), new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ")),
      created,
    );
  }

  return null;
}

function shapeToManifoldSolid(runtime: ManifoldToplevel, shape: WorkplaneShape, created: ManifoldSolid[], useBoxPrimitive = false) {
  if (useBoxPrimitive && isAxisAlignedBoxCutter(shape)) {
    return primitiveManifoldForShape(runtime, shape, created) ?? boxBoundsToManifold(runtime, meshAabb(shape), created);
  }

  const primitive = primitiveManifoldForShape(runtime, shape, created);
  if (primitive) {
    return primitive;
  }

  const mesh = meshDataToManifoldMesh(runtime, meshForShape(shape));
  try {
    return runtime.Manifold.ofMesh(mesh);
  } finally {
    disposeManifold(mesh);
  }
}

function shapesToManifoldUnion(runtime: ManifoldToplevel, shapes: WorkplaneShape[], created: ManifoldSolid[], useBoxPrimitive = false) {
  const parts: ManifoldSolid[] = [];
  for (const shape of shapes) {
    const part = shapeToManifoldSolid(runtime, shape, created, useBoxPrimitive);
    if (!part || part.status() !== "NoError" || part.numTri() < 1) {
      disposeManifold(part);
      return null;
    }
    parts.push(part);
    created.push(part);
  }

  if (parts.length === 0) {
    return null;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  // Pairwise / tree union reduces coplanar scars on dense hubs (radial patterns).
  let level = parts;
  while (level.length > 1) {
    const next: ManifoldSolid[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 >= level.length) {
        next.push(level[i]);
        continue;
      }
      const merged = runtime.Manifold.union([level[i], level[i + 1]]);
      created.push(merged);
      if (merged.status() !== "NoError" || merged.numTri() < 1) {
        return null;
      }
      next.push(merged);
    }
    level = next;
  }
  return level[0];
}

function manifoldMeshToPositions(mesh: InstanceType<ManifoldToplevel["Mesh"]>) {
  const positions: number[] = [];
  const numProp = mesh.numProp;
  for (let i = 0; i < mesh.triVerts.length; i += 1) {
    const vertexIndex = mesh.triVerts[i];
    const offset = vertexIndex * numProp;
    positions.push(mesh.vertProperties[offset], mesh.vertProperties[offset + 1], mesh.vertProperties[offset + 2]);
  }
  return positions;
}

function positionsInteriorTriangleCount(positions: number[], cutters: WorkplaneShape[], strictInterior = false) {
  let count = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const centroid: Vec3 = [
      (positions[i] + positions[i + 3] + positions[i + 6]) / 3,
      (positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3,
      (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3,
    ];
    if (cutters.some((cutter) => pointInsideHoleShape(centroid, cutter, strictInterior))) {
      count += 1;
    }
  }
  return count;
}

function meshPositionsToGroupShape(
  selection: WorkplaneShape[],
  solids: WorkplaneShape[],
  positions: number[],
  idPrefix: string,
  cleanup?: BooleanCleanupOptions,
): WorkplaneShape | null {
  const cleaned = cleanupBooleanPositions(positions, undefined, cleanup);
  if (cleaned.length < 9) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < cleaned.length; i += 3) {
    const x = cleaned[i];
    const y = cleaned[i + 1];
    const z = cleaned[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return null;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const normalizedPositions: number[] = [];
  for (let i = 0; i < cleaned.length; i += 3) {
    normalizedPositions.push(cleaned[i] - centerX, cleaned[i + 1] - minY, cleaned[i + 2] - centerZ);
  }

  const firstSolid = solids[0];
  const hasHole = selection.some((shape) => shape.hole);
  const csgOp: CsgOp = hasHole ? "subtract" : idPrefix.includes("intersection") ? "intersect" : "union";
  return withCsgMeta({
    id: createLocalId(idPrefix),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions: normalizedPositions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(normalizedPositions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  }, csgOp, 1, false);
}

function refineBooleanManifoldSolid(
  runtime: ManifoldToplevel,
  solid: ManifoldSolid,
  created: ManifoldSolid[],
): ManifoldSolid {
  // Collapse near-coplanar surfaces left by dense unions (radial hub creases).
  const candidate = solid as ManifoldSolid & {
    simplify?: (tolerance?: number) => ManifoldSolid;
    setTolerance?: (tolerance: number) => ManifoldSolid;
  };
  let current = solid;
  try {
    if (typeof candidate.setTolerance === "function") {
      const loosened = candidate.setTolerance(0.01);
      if (loosened && loosened !== current) {
        created.push(loosened);
        if (loosened.status() === "NoError" && loosened.numTri() > 0) {
          current = loosened;
        }
      }
    }
  } catch {
    // Ignore.
  }
  try {
    const simplify = (current as ManifoldSolid & { simplify?: (tolerance?: number) => ManifoldSolid }).simplify;
    if (typeof simplify === "function") {
      const simplified = simplify.call(current, 0.01);
      if (simplified && simplified !== current) {
        created.push(simplified);
        if (simplified.status() === "NoError" && simplified.numTri() > 0) {
          return simplified;
        }
      }
    }
  } catch {
    // Older Manifold builds may not expose simplify.
  }
  void runtime;
  return current;
}

function disposeManifold(value: unknown) {
  (value as { delete?: () => void } | null)?.delete?.();
}

async function manifoldBooleanMeshShape(selection: WorkplaneShape[], options: { requireImported?: boolean; idPrefix?: string } = {}): Promise<WorkplaneShape | null> {
  // GROUPING SAFETY NOTE FOR FUTURE AGENTS:
  // Imported STL + hole grouping stays on exact boolean first. Rotated cutters
  // are validated against their real oriented volume, not their broad AABB.
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0 || (options.requireImported !== false && !selection.some((shape) => Boolean(shape.importedMesh)))) {
    return null;
  }

  const sourceMesh = mergedSolidMeshData(solids);
  const cutterTriangleCount = holes.reduce((total, hole) => total + meshForShape(hole).faces.length, 0);
  if (sourceMesh.faces.length + cutterTriangleCount > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return null;
  }
  const cutterShapes = holes.map(paddedCutterShape);
  const residualValidationShapes = holes;
  const sourceInteriorTriangles = cutterInteriorTriangleCount(sourceMesh, cutterShapes);
  const sourceTouchedTriangles = cutterTouchedTriangleCount(sourceMesh, cutterShapes);
  const sourceCutTriangles = Math.max(sourceInteriorTriangles, sourceTouchedTriangles);

  const finishFromPositions = (positions: number[]) => {
    const resultChanged = positionsDifferFromMeshData(positions, sourceMesh);
    if (!resultChanged) {
      return null;
    }
    const hasImportedOperand = selection.some((shape) => Boolean(shape.importedMesh));
    const canUseResidualInteriorValidation =
      !hasImportedOperand && holes.every((hole) => hole.kind === "box" && !hole.importedMesh && !hole.groupedShapes?.length);
    if (canUseResidualInteriorValidation) {
      const remainingInteriorTriangles = positionsInteriorTriangleCount(positions, residualValidationShapes, true);
      if (sourceCutTriangles > 0 && remainingInteriorTriangles > Math.max(12, Math.floor(sourceCutTriangles * 0.35))) {
        return null;
      }
    }

    const group = meshPositionsToGroupShape(selection, solids, positions, options.idPrefix ?? "grouped-manifold-cut");
    const usable = isUsableBooleanGroup(group, sourceMesh.faces.length);
    const changedEnough = sourceCutTriangles > 0 || !looksLikeUnchangedBooleanResult(group, sourceMesh.faces.length, true);
    if (!usable || !changedEnough) {
      return null;
    }
    return group;
  };

  try {
    const outcome = await runManifoldBooleanInWorker({
      op: "subtract",
      solids: solids.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
      cutters: cutterShapes.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
    });
    if (outcome.status === "ok") {
      return finishFromPositions(Array.from(outcome.positions));
    }
    if (outcome.status === "superseded") {
      // A newer boolean owns the result; recomputing here would overwrite it with stale geometry.
      return null;
    }
  } catch {
    // Fall through to main-thread Manifold.
  }

  const created: ManifoldSolid[] = [];
  let result: ManifoldSolid | null = null;

  try {
    const runtime = await getManifoldRuntime();
    const solid = shapesToManifoldUnion(runtime, solids, created, true);
    const cutterSolid = shapesToManifoldUnion(runtime, holes.map(paddedCutterShape), created, true);
    if (!solid || !cutterSolid) {
      return null;
    }

    result = solid.subtract(cutterSolid);
    created.push(result);
    if (result.status() !== "NoError" || result.numTri() < 1) {
      return null;
    }
    result = refineBooleanManifoldSolid(runtime, result, created);

    const outputMesh = result.getMesh();
    const positions = manifoldMeshToPositions(outputMesh);
    return finishFromPositions(positions);
  } catch {
    return null;
  } finally {
    Array.from(new Set(created)).forEach(disposeManifold);
  }
}

async function manifoldUnionMeshShape(selection: WorkplaneShape[]): Promise<WorkplaneShape | null> {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  // Live CSG: union any 2+ solids (primitives included) — not only selections that already have importedMesh.
  if (solids.length < 2) {
    return null;
  }

  // Tiny elevation break helps Manifold resolve dense radial overlaps; planarizeThinSolidPositions
  // collapses it again so the baked top stays a single flat face (no mid-hub ridge).
  // Skip stagger for small N — it only helps (and only scars) crowded coplanar unions.
  const solidsForUnion = solids.length >= 4
    ? solids.map((shape, index) => ({
      ...shape,
      elevation: (shape.elevation ?? 0) + (index % 2) * 0.01,
    }))
    : solids;
  // Only a staggered union needs the scar-removal cleanup, which moves real vertices.
  const unionCleanup: BooleanCleanupOptions = { staggeredUnion: solidsForUnion !== solids };

  const mergedSourceMesh = mergedSolidMeshData(solidsForUnion);
  if (mergedSourceMesh.faces.length > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return null;
  }

  try {
    const outcome = await runManifoldBooleanInWorker({
      op: "union",
      solids: solidsForUnion.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
    });
    if (outcome.status === "ok") {
      const group = meshPositionsToGroupShape(selection, solids, Array.from(outcome.positions), "grouped-manifold-union", unionCleanup);
      return isUsableBooleanGroup(group, mergedSourceMesh.faces.length, false) ? group : null;
    }
    if (outcome.status === "superseded") {
      // A newer boolean owns the result; recomputing here would overwrite it with stale geometry.
      return null;
    }
  } catch {
    // Fall through to main-thread Manifold.
  }

  const created: ManifoldSolid[] = [];
  let result: ManifoldSolid | null = null;
  try {
    const runtime = await getManifoldRuntime();
    result = shapesToManifoldUnion(runtime, solidsForUnion, created, true);
    if (!result) {
      return null;
    }
    if (result.status() !== "NoError" || result.numTri() < 1) {
      return null;
    }
    result = refineBooleanManifoldSolid(runtime, result, created);

    const outputMesh = result.getMesh();
    const positions = manifoldMeshToPositions(outputMesh);
    const group = meshPositionsToGroupShape(selection, solids, positions, "grouped-manifold-union", unionCleanup);
    return isUsableBooleanGroup(group, mergedSourceMesh.faces.length, false) ? group : null;
  } catch {
    return null;
  } finally {
    Array.from(new Set(created)).forEach(disposeManifold);
  }
}

function asIntersectionGroup(group: WorkplaneShape): WorkplaneShape {
  return {
    ...group,
    name: "Intersection",
    hole: false,
  };
}

async function manifoldIntersectionMeshShape(selection: WorkplaneShape[]): Promise<IntersectionAttempt> {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole && !shape.locked);
  if (solids.length === 0 || holes.length === 0) {
    return { status: "unsupported" };
  }

  const sourceTriangleCount = selection.reduce((total, shape) => total + meshForShape(shape).faces.length, 0);
  if (sourceTriangleCount > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return { status: "unsupported" };
  }

  const finishIntersection = (positions: number[]): IntersectionAttempt => {
    if (positions.length < 9) {
      return { status: "empty" };
    }
    const group = meshPositionsToGroupShape(selection, solids, positions, "grouped-manifold-intersection");
    return group && isUsableBooleanGroup(group, sourceTriangleCount, false)
      ? { status: "success", group: asIntersectionGroup(group) }
      : { status: "unsupported" };
  };

  try {
    const outcome = await runManifoldBooleanInWorker({
      op: "intersect",
      solids: solids.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
      cutters: holes.map((shape) => {
        const mesh = meshForShape(shape);
        return meshDataToTransfer(mesh.vertices, mesh.faces);
      }),
    });
    if (outcome.status === "ok") {
      return finishIntersection(Array.from(outcome.positions));
    }
    if (outcome.status === "superseded") {
      // A newer boolean owns the result; recomputing here would overwrite it with stale geometry.
      return { status: "unsupported" };
    }
  } catch {
    // Fall through to main-thread Manifold.
  }

  const created: ManifoldSolid[] = [];
  try {
    const runtime = await getManifoldRuntime();
    const solid = shapesToManifoldUnion(runtime, solids, created, true);
    const hole = shapesToManifoldUnion(runtime, holes, created, true);
    if (!solid || !hole) {
      return { status: "unsupported" };
    }

    const result = solid.intersect(hole);
    created.push(result);
    if (result.status() !== "NoError") {
      return { status: "unsupported" };
    }
    if (result.numTri() < 1) {
      return { status: "empty" };
    }

    const outputMesh = result.getMesh();
    const positions = manifoldMeshToPositions(outputMesh);
    return finishIntersection(positions);
  } catch {
    return { status: "unsupported" };
  } finally {
    Array.from(new Set(created)).forEach(disposeManifold);
  }
}

function bvhIntersectionMeshShape(selection: WorkplaneShape[], operation: CSGOperation, idPrefix: string): IntersectionAttempt {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole && !shape.locked);
  if (solids.length === 0 || holes.length === 0) {
    return { status: "unsupported" };
  }

  let solidResult: Brush | null = null;
  let holeResult: Brush | null = null;
  let result: Brush | null = null;
  try {
    const evaluator = new Evaluator();
    evaluator.useGroups = false;
    evaluator.attributes = ["position", "normal"];
    (evaluator as Evaluator & { useCDTClipping: boolean }).useCDTClipping = true;

    solidResult = brushFromShape(solids[0]);
    solids.slice(1).forEach((solid) => {
      solidResult = evaluateBrushDisposing(evaluator, solidResult!, brushFromShape(solid), ADDITION);
      solidResult.updateMatrixWorld(true);
    });

    holeResult = brushFromShape(holes[0]);
    holes.slice(1).forEach((hole) => {
      holeResult = evaluateBrushDisposing(evaluator, holeResult!, brushFromShape(hole), ADDITION);
      holeResult.updateMatrixWorld(true);
    });

    result = evaluateBrushDisposing(evaluator, solidResult, holeResult, operation);
    solidResult = null;
    holeResult = null;
    result.updateMatrixWorld(true);
    if (positionsFromGeometryDrawRange(result.geometry).length < 9) {
      return { status: "empty" };
    }

    const sourceTriangleCount = solids.reduce((total, solid) => total + meshForShape(solid).faces.length, 0);
    const group = resultGeometryToMeshShape(selection, solids, result.geometry, idPrefix);
    return group && isUsableBooleanGroup(group, sourceTriangleCount, false)
      ? { status: "success", group: asIntersectionGroup(group) }
      : { status: "unsupported" };
  } catch {
    return { status: "unsupported" };
  } finally {
    disposeBrush(solidResult);
    disposeBrush(holeResult);
    disposeBrush(result);
  }
}

async function buildIntersectionShapeFromSelection(groupable: WorkplaneShape[]): Promise<IntersectionBuildResult> {
  const booleanSelection = expandGroupsForBoolean(groupable);
  const solids = booleanSelection.filter((shape) => !shape.hole && !shape.locked);
  const holes = booleanSelection.filter((shape) => shape.hole && !shape.locked);
  if (solids.length === 0 || holes.length === 0) {
    return {
      group: null,
      empty: false,
      failureNotice: "Select at least one solid and one hole for Intersection",
    };
  }

  if (!hasSolidHoleOverlap(solids, holes)) {
    return { group: null, empty: true, failureNotice: "" };
  }

  const manifoldAttempt = await manifoldIntersectionMeshShape(booleanSelection);
  if (manifoldAttempt.status === "success") {
    return { group: manifoldAttempt.group, empty: false, failureNotice: "" };
  }
  if (manifoldAttempt.status === "empty") {
    return { group: null, empty: true, failureNotice: "" };
  }

  const exactAttempt = bvhIntersectionMeshShape(booleanSelection, INTERSECTION, "grouped-intersection");
  if (exactAttempt.status === "success") {
    return { group: exactAttempt.group, empty: false, failureNotice: "" };
  }
  const hasImportedMesh = booleanSelection.some((shape) => Boolean(shape.importedMesh));
  if (exactAttempt.status === "empty" && !hasImportedMesh) {
    return { group: null, empty: true, failureNotice: "" };
  }

  const hollowAttempt = bvhIntersectionMeshShape(booleanSelection, HOLLOW_INTERSECTION, "grouped-hollow-intersection");
  if (hollowAttempt.status === "success") {
    return { group: hollowAttempt.group, empty: false, failureNotice: "" };
  }
  if (hollowAttempt.status === "empty" || exactAttempt.status === "empty") {
    return { group: null, empty: true, failureNotice: "" };
  }

  return {
    group: null,
    empty: false,
    failureNotice: "Could not calculate this Intersection cleanly",
  };
}

function cutterInteriorTriangleCount(mesh: MeshData, cutters: WorkplaneShape[]) {
  return mesh.faces.reduce((total, [ai, bi, ci]) => {
    const centroid = triangleCentroid([mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]]);
    return total + (cutters.some((cutter) => pointInsideHoleShape(centroid, cutter)) ? 1 : 0);
  }, 0);
}

function geometryInteriorTriangleCount(geometry: THREE.BufferGeometry, cutters: WorkplaneShape[], strictInterior = false) {
  const positions = positionsFromGeometryDrawRange(geometry);
  let count = 0;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const centroid: Vec3 = [
      (positions[i] + positions[i + 3] + positions[i + 6]) / 3,
      (positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3,
      (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3,
    ];
    if (cutters.some((cutter) => pointInsideHoleShape(centroid, cutter, strictInterior))) {
      count += 1;
    }
  }
  return count;
}

function clearsImportedCutVolume(geometry: THREE.BufferGeometry, sourceInteriorTriangles: number, cutters: WorkplaneShape[]) {
  if (sourceInteriorTriangles <= 0 || cutters.length === 0) {
    return true;
  }

  const remainingInteriorTriangles = geometryInteriorTriangleCount(geometry, cutters, true);
  return remainingInteriorTriangles <= Math.max(4, Math.floor(sourceInteriorTriangles * 0.05));
}

function importedBooleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0 || !selection.some((shape) => Boolean(shape.importedMesh))) {
    return null;
  }

  const mergedSolidMesh = mergedSolidMeshData(solids);
  const sourceTriangleCount = mergedSolidMesh.faces.length;
  const cutterTriangleCount = holes.reduce((total, hole) => total + meshForShape(hole).faces.length, 0);
  if (sourceTriangleCount + cutterTriangleCount > IMPORTED_EXACT_BOOLEAN_TRIANGLE_LIMIT) {
    return null;
  }

  const cutterShapes = holes.map(paddedCutterShape);
  const hasSketchOperand = selection.some(shapeIsSketchOperand) || holes.some(shapeIsSketchHoleMesh);
  // Sketch extrusions bake orientation into mesh positions with zero Euler — don't treat them
  // as axis-aligned STL cutters (coplanar-rescue rotations break those meshes).
  const hasStraightImportedHole = holes.some(
    (hole) => shapeIsImportedHole(hole) && !hasNonZeroRotation(hole) && !shapeIsSketchOperand(hole) && !shapeIsSketchHoleMesh(hole),
  );
  const sourceInteriorTriangles = cutterInteriorTriangleCount(mergedSolidMesh, cutterShapes);
  const sourceTouchedTriangles = cutterTouchedTriangleCount(mergedSolidMesh, cutterShapes);
  const sourceCutTriangles = Math.max(sourceInteriorTriangles, sourceTouchedTriangles);
  // Solid SUBTRACTION only — never HOLLOW_SUBTRACTION (fail closed instead of face-punch meshes).
  const baseAttempts: Array<{ operation: CSGOperation; idPrefix: string; rescueCoplanar?: boolean }> = [
    { operation: SUBTRACTION, idPrefix: "grouped-import-cut" },
  ];
  const attempts = hasStraightImportedHole
    ? [
        ...baseAttempts,
        { operation: SUBTRACTION, idPrefix: "grouped-import-rescue-cut", rescueCoplanar: true },
      ]
    : baseAttempts;

  for (const attempt of attempts) {
    let result: Brush | null = null;
    try {
      const evaluator = new Evaluator();
      evaluator.useGroups = false;
      evaluator.attributes = ["position", "normal"];
      (evaluator as Evaluator & { useCDTClipping: boolean }).useCDTClipping = true;
      result = new Brush(geometryFromMeshData(mergedSolidMesh));
      result.updateMatrixWorld(true);

      const operationHoles = attempt.rescueCoplanar ? holes.map(coplanarRescueCutterShape) : holes;
      operationHoles.forEach((hole) => {
        result = evaluateBrushDisposing(evaluator, result!, brushFromShape(hole, true), attempt.operation);
        result.updateMatrixWorld(true);
      });

      const group = resultGeometryToMeshShape(selection, solids, result.geometry, attempt.idPrefix);
      const resultPositions = positionsFromGeometryDrawRange(result.geometry);
      const resultChanged = geometryDiffersFromMeshData(result.geometry, mergedSolidMesh);
      // Face-punch / open-shell cuts look like a hole outline with diagonal fans — reject them.
      const hasOpenCutBoundary = introducesOpenCutBoundary(
        resultPositions,
        mergedSolidMesh,
        operationHoles.map(paddedCutterShape),
      );
      const volumeCleared = hasSketchOperand || clearsImportedCutVolume(result.geometry, sourceCutTriangles, operationHoles);
      if (
        isUsableBooleanGroup(group, sourceTriangleCount, !hasSketchOperand) &&
        (sourceCutTriangles > 0 ? resultChanged : !looksLikeUnchangedBooleanResult(group, sourceTriangleCount, true)) &&
        !hasOpenCutBoundary &&
        volumeCleared
      ) {
        return group;
      }
    } catch {
      // Try the next boolean operation before giving up.
    } finally {
      disposeBrush(result);
    }
  }

  return null;
}

function boxedBooleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && shape.kind === "box" && !shape.locked);
  const holes = selection.filter((shape) => shape.hole && shape.kind === "box");
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const cutters = holes.map((hole) => shapeAabb(paddedCutterShape(hole)));
  const cuboids = solids.flatMap((solid) => cutters.reduce<Cuboid[]>((parts, cutter) => parts.flatMap((part) => subtractCuboid(part, cutter)), [shapeAabb(solid)]));
  if (cuboids.length === 0) {
    return null;
  }

  const groupBounds = boundsForCuboids(cuboids);
  const centerX = (groupBounds.minX + groupBounds.maxX) / 2;
  const centerZ = (groupBounds.minZ + groupBounds.maxZ) / 2;
  const width = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxX - groupBounds.minX);
  const minY = groupBounds.minY;
  const height = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxY - groupBounds.minY);
  const depth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxZ - groupBounds.minZ);
  const mesh = cuboidsToMesh("Group", cuboids, centerX, centerZ, minY);
  const positions = cleanupBooleanPositions(
    mesh.faces.flatMap(([ai, bi, ci]) => [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]]).flat(),
  );
  const firstSolid = solids[0];

  return withCsgMeta({
    id: createLocalId("grouped-boolean"),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  }, "subtract", 1, false);
}

function aabbBooleanMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole);
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const solidBounds = solids.map(meshAabb);
  const cutterBounds = holes.map((hole) => meshAabb(paddedCutterShape(hole)));
  const cuboids = solidBounds.flatMap((solid) => cutterBounds.reduce<Cuboid[]>((parts, cutter) => parts.flatMap((part) => subtractCuboid(part, cutter)), [solid]));
  if (cuboids.length === 0) {
    return null;
  }

  const groupBounds = boundsForCuboids(cuboids);
  const centerX = (groupBounds.minX + groupBounds.maxX) / 2;
  const centerZ = (groupBounds.minZ + groupBounds.maxZ) / 2;
  const width = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxX - groupBounds.minX);
  const minY = groupBounds.minY;
  const height = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxY - groupBounds.minY);
  const depth = Math.max(MIN_SHAPE_DIMENSION, groupBounds.maxZ - groupBounds.minZ);
  const mesh = cuboidsToMesh("Group", cuboids, centerX, centerZ, minY);
  const positions = mesh.faces.flatMap(([ai, bi, ci]) => [mesh.vertices[ai], mesh.vertices[bi], mesh.vertices[ci]]).flat();
  const firstSolid = solids[0];

  return {
    id: createLocalId("grouped-boolean"),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  };
}

function hollowClipMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection
    .filter((shape) => shape.hole)
    .map(paddedCutterShape)
    .map((shape) => ({ shape, bounds: meshAabb(shape) }));
  if (solids.length === 0 || holes.length === 0) {
    return null;
  }

  const sourceMesh = mergedSolidMeshData(solids);
  const sourceBounds = boundsForCuboids(solids.map(meshAabb));
  const canPlaneClip = holes.every((hole) => isAxisAlignedBoxCutter(hole.shape));
  const positions: number[] = [];
  let removedTriangles = 0;

  if (canPlaneClip) {
    sourceMesh.faces.forEach(([ai, bi, ci]) => {
      let fragments: Vec3[][] = [[sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]]];
      holes.forEach((hole) => {
        const nextFragments: Vec3[][] = [];
        fragments.forEach((fragment) => {
          if (!cuboidsTouch(polygonAabb(fragment), hole.bounds)) {
            nextFragments.push(fragment);
            return;
          }

          const clipped = subtractCuboidFromPolygon(fragment, hole.bounds);
          if (
            clipped.length !== 1 ||
            clipped[0].length !== fragment.length ||
            clipped[0].some((point, index) => point.some((value, axis) => Math.abs(value - fragment[index][axis]) > 0.0001))
          ) {
            removedTriangles += 1;
          }
          clipped.forEach((piece) => nextFragments.push(piece));
        });
        fragments = nextFragments;
      });

      fragments.forEach((fragment) => triangulatePolygonToPositions(fragment, positions));
    });

    holes.forEach((hole) => addBoxHoleInteriorFaces(positions, hole.bounds, sourceMesh, sourceBounds));
  } else {
    sourceMesh.faces.forEach(([ai, bi, ci]) => {
      const triangle = [sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]];

      if (holes.some((hole) => triangleTouchesHoleShape(triangle, hole.shape, hole.bounds))) {
        removedTriangles += 1;
        return;
      }

      triangle.forEach(([x, y, z]) => {
        positions.push(x, y, z);
      });
    });
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  if (removedTriangles === 0 || positions.length < 9 || ![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return null;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const normalizedPositions: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    normalizedPositions.push(positions[i] - centerX, positions[i + 1] - minY, positions[i + 2] - centerZ);
  }

  const firstSolid = solids[0];
  return {
    id: createLocalId("grouped-import-clip"),
    name: "Group",
    kind: "mesh",
    color: firstSolid.color,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions: normalizedPositions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: Math.floor(normalizedPositions.length / 9),
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: selection.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  };
}

function cutFullyConsumesSolids(selection: WorkplaneShape[]) {
  const solids = selection.filter((shape) => !shape.hole && !shape.locked);
  const holes = selection.filter((shape) => shape.hole).map(paddedCutterShape);
  if (solids.length === 0 || holes.length === 0) {
    return false;
  }

  const sourceMesh = mergedSolidMeshData(solids);
  if (sourceMesh.faces.length === 0 || !hasSolidHoleOverlap(solids, holes)) {
    return false;
  }

  return sourceMesh.faces.every(([ai, bi, ci]) => {
    const triangle = [sourceMesh.vertices[ai], sourceMesh.vertices[bi], sourceMesh.vertices[ci]];
    const centroid: Vec3 = [
      (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
      (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3,
      (triangle[0][2] + triangle[1][2] + triangle[2][2]) / 3,
    ];
    return holes.some((hole) => pointInsideHoleShape(centroid, hole));
  });
}

function mergedMeshShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const groupable = selection.filter((shape) => !shape.locked);
  if (groupable.length < 2) {
    return null;
  }

  // Keep imported STL/SVG groups as a baked mesh. The viewport child-group path rescales children to a wrapper box.
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];
  groupable.map(meshForShape).forEach((mesh) => {
    appendMeshData(vertices, faces, mesh);
  });

  if (vertices.length < 3 || faces.length < 1) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  vertices.forEach(([x, y, z]) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  });

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return null;
  }

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const rawWidth = Math.max(MIN_SHAPE_DIMENSION, maxX - minX);
  const rawHeight = Math.max(MIN_SHAPE_DIMENSION, maxY - minY);
  const rawDepth = Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ);
  const width = cleanModelDimension(rawWidth);
  const height = cleanModelDimension(rawHeight);
  const depth = cleanModelDimension(rawDepth);
  const positions: number[] = [];

  faces.forEach(([ai, bi, ci]) => {
    [vertices[ai], vertices[bi], vertices[ci]].forEach(([x, y, z]) => {
      positions.push(x - centerX, y - minY, z - centerZ);
    });
  });

  const firstSolid = groupable.find((shape) => !shape.hole) ?? groupable[0];
  const holeOnly = groupable.every((shape) => shape.hole);

  return {
    id: createLocalId("grouped-mesh"),
    name: "Group",
    kind: "mesh",
    color: holeOnly ? "#b8c2cc" : firstSolid.color,
    hole: holeOnly,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: rawWidth,
      baseDepth: rawDepth,
      baseHeight: rawHeight,
      triangleCount: faces.length,
      sourceFormat: "json",
    },
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: groupable.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  };
}

function groupedShape(selection: WorkplaneShape[]): WorkplaneShape | null {
  const groupable = selection.filter((shape) => !shape.locked);
  if (groupable.length < 2) {
    return null;
  }

  const groupBounds = boundsForShapes(groupable);
  const minX = groupBounds.minX;
  const maxX = groupBounds.maxX;
  const minY = groupBounds.minY;
  const maxY = groupBounds.maxY;
  const minZ = groupBounds.minZ;
  const maxZ = groupBounds.maxZ;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const width = cleanModelDimension(Math.max(MIN_SHAPE_DIMENSION, maxX - minX));
  const depth = cleanModelDimension(Math.max(MIN_SHAPE_DIMENSION, maxZ - minZ));
  const height = cleanModelDimension(Math.max(MIN_SHAPE_DIMENSION, maxY - minY));
  const firstSolid = groupable.find((shape) => !shape.hole) ?? groupable[0];
  const holeOnly = groupable.every((shape) => shape.hole);

  return withCsgMeta({
    id: createLocalId("group"),
    name: "Assembly",
    kind: "mesh",
    color: firstSolid.color,
    hole: holeOnly,
    x: centerX,
    z: centerZ,
    elevation: minY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    groupedBaseWidth: width,
    groupedBaseDepth: depth,
    groupedBaseHeight: height,
    groupedShapes: groupable.map((shape) => cloneAsGroupChild(shape, centerX, centerZ, minY)),
    locked: false,
    hidden: false,
  }, "assemble", 1, false);
}

function localGroupBounds(children: WorkplaneShape[]): Cuboid {
  return boundsForShapes(children);
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

function rotationFromQuaternion(quaternion: THREE.Quaternion) {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    rotationX: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.x)),
    rotation: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.y)),
    rotationZ: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.z)),
  };
}

function cleanShapePatch(patch: ShapeUpdatePatch): Partial<WorkplaneShape> {
  const { bakeTransform: _bakeTransform, repeatDeltaBefore: _repeatDeltaBefore, ...rest } = patch;
  const next = { ...rest };
  if (typeof next.rotation === "number") {
    next.rotation = cleanRotationDegrees(next.rotation, 1);
  }
  if (typeof next.rotationX === "number") {
    next.rotationX = cleanRotationDegrees(next.rotationX, 1);
  }
  if (typeof next.rotationZ === "number") {
    next.rotationZ = cleanRotationDegrees(next.rotationZ, 1);
  }
  return next;
}

function restoreGroupedChildren(group: WorkplaneShape, options?: { preserveIds?: boolean }): WorkplaneShape[] {
  const children = group.groupedShapes ?? [];
  if (children.length === 0) {
    return [];
  }

  const bounds = localGroupBounds(children);
  const baseWidth = group.groupedBaseWidth ?? Math.max(0.001, bounds.maxX - bounds.minX);
  const baseHeight = group.groupedBaseHeight ?? Math.max(0.001, bounds.maxY - bounds.minY);
  const baseDepth = group.groupedBaseDepth ?? Math.max(0.001, bounds.maxZ - bounds.minZ);
  const sx = shapeWidth(group) / Math.max(0.001, baseWidth);
  const sy = group.height / Math.max(0.001, baseHeight);
  const sz = shapeDepth(group) / Math.max(0.001, baseDepth);
  const groupQuaternion = quaternionForShape(group);
  const groupReflection = new THREE.Matrix4().makeScale(mirrorSign(group.mirrorX), mirrorSign(group.mirrorY), mirrorSign(group.mirrorZ));
  const groupCenter = new THREE.Vector3(group.x, (group.elevation ?? 0) + group.height / 2, group.z);

  return children.map((child) => {
    const width = shapeWidth(child) * sx;
    const depth = shapeDepth(child) * sz;
    const height = child.height * sy;
    const localCenter = new THREE.Vector3(
      child.x * sx * mirrorSign(group.mirrorX),
      (((child.elevation ?? 0) + child.height / 2) * sy - group.height / 2) * mirrorSign(group.mirrorY),
      child.z * sz * mirrorSign(group.mirrorZ),
    ).applyQuaternion(groupQuaternion);
    const worldCenter = groupCenter.clone().add(localCenter);
    const childRotationMatrix = new THREE.Matrix4()
      .makeRotationFromQuaternion(groupQuaternion)
      .multiply(groupReflection)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternionForShape(child)))
      .multiply(groupReflection);
    const childRotation = rotationFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(childRotationMatrix));
    const restored: WorkplaneShape = {
      ...child,
      id: options?.preserveIds ? child.id : createLocalId(`${child.id}-ungroup`),
      x: worldCenter.x,
      z: worldCenter.z,
      elevation: worldCenter.y - height / 2,
      width,
      depth,
      height,
      size: (width + depth) / 2,
      rotation: childRotation.rotation,
      rotationX: childRotation.rotationX,
      rotationZ: childRotation.rotationZ,
      mirrorX: Boolean(child.mirrorX) !== Boolean(group.mirrorX) || undefined,
      mirrorY: Boolean(child.mirrorY) !== Boolean(group.mirrorY) || undefined,
      mirrorZ: Boolean(child.mirrorZ) !== Boolean(group.mirrorZ) || undefined,
      hidden: group.hidden ? true : child.hidden,
    };
    // Preserve each child's own solid/hole role. Applying the parent group's hole
    // flag would turn every restored solid into a hole after Hole → Group → Ungroup.
    return canonicalizeShape(restored);
  });
}

function expandGroupsForBoolean(selection: WorkplaneShape[]): WorkplaneShape[] {
  return selection.flatMap((shape) => {
    if (shape.suppressed || shape.csg?.suppressed) return [];
    if (shouldExpandGroupForBoolean(shape)) {
      return restoreGroupedChildren(shape).filter((child) => !child.suppressed && !child.csg?.suppressed);
    }
    return [shape];
  });
}

/** Bake one world-space solid into a group-style mesh cache (suppress → single remaining feature). */
function bakeSolidAsGroupMesh(solid: WorkplaneShape): WorkplaneShape | null {
  const mesh = meshForShape(solid);
  if (!mesh.faces.length) return null;
  const positions: number[] = [];
  for (const face of mesh.faces) {
    const a = mesh.vertices[face[0]];
    const b = mesh.vertices[face[1]];
    const c = mesh.vertices[face[2]];
    if (!a || !b || !c) continue;
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  return meshPositionsToGroupShape([solid], [solid], positions, "grouped-single-feature");
}

/**
 * Evaluate a single CSG op on world-space operands without flattening nested bodies.
 * Nested evaluated children must already carry a fresh mesh cache.
 */
async function evaluateCsgOpOnOperands(
  operands: WorkplaneShape[],
  op: CsgOp,
  options?: { skipOcct?: boolean },
): Promise<WorkplaneShape | null> {
  const selection = operands
    .filter((shape) => !shape.suppressed && !shape.csg?.suppressed && !shape.locked)
    .map((shape) => (shape.hole ? rebuildSketchHoleCutterIfPossible(shape) : shape));
  if (selection.length === 0) return null;
  const skipOcct = Boolean(options?.skipOcct);

  if (op === "subtract") {
    const hasSolid = selection.some((shape) => !shape.hole);
    const hasHole = selection.some((shape) => shape.hole);
    if (!hasSolid || !hasHole) {
      // Suppressing all holes (or all solids) should leave the remaining active solids.
      const solids = selection.filter((shape) => !shape.hole);
      if (solids.length === 1) return bakeSolidAsGroupMesh(solids[0]);
      if (solids.length >= 2) {
        return (
          (skipOcct ? null : await occtBooleanMeshShape(solids, "union"))
          ?? await manifoldUnionMeshShape(solids)
          ?? (solids.some((shape) => Boolean(shape.importedMesh)) ? mergedMeshShape(solids) : null)
          ?? bakeSolidAsGroupMesh(solids[0])
        );
      }
      return null;
    }
    return (
      (skipOcct ? null : await occtBooleanMeshShape(selection, "subtract"))
      ?? await manifoldBooleanMeshShape(selection, { requireImported: false })
      ?? (canUseBoxBoolean(selection) ? boxedBooleanMeshShape(selection) : null)
      ?? booleanMeshShape(selection)
    );
  }

  if (op === "union") {
    const solids = selection.filter((shape) => !shape.hole);
    if (solids.length < 2) {
      return solids[0] ? bakeSolidAsGroupMesh(solids[0]) : null;
    }
    return (
      (skipOcct ? null : await occtBooleanMeshShape(solids, "union"))
      ?? await manifoldUnionMeshShape(solids)
      ?? (solids.some((shape) => Boolean(shape.importedMesh)) ? mergedMeshShape(solids) : null)
      ?? bakeSolidAsGroupMesh(solids[0])
    );
  }

  if (op === "intersect") {
    if (!skipOcct) {
      const occt = await occtBooleanMeshShape(selection, "intersect");
      if (occt) return occt;
    }
    const attempt = await manifoldIntersectionMeshShape(selection);
    if (attempt.status === "success") return attempt.group;
    return null;
  }

  return null;
}

/** Exact OCCT boolean when every operand has B-Rep; Manifold remains the progressive fallback. */
async function occtBooleanMeshShape(
  selection: WorkplaneShape[],
  op: "subtract" | "union" | "intersect",
): Promise<WorkplaneShape | null> {
  if (!selectionSupportsOcctCsg(selection)) return null;
  try {
    const { evaluateOcctBooleanOnWorldShapes } = await import("@/lib/stepExport");
    const result = await evaluateOcctBooleanOnWorldShapes(selection, op);
    if (!result) return null;
    const solids = selection.filter((shape) => !shape.hole);
    if (solids.length === 0) return null;
    const group = meshPositionsToGroupShape(selection, solids, result.positions, `occt-${op}`);
    if (!group?.importedMesh) return null;
    return {
      ...group,
      importedMesh: {
        ...group.importedMesh,
        brepStep: result.brepStep,
        sourceFormat: "step",
      },
    };
  } catch {
    return null;
  }
}

function expandGroupsForBoxBoolean(selection: WorkplaneShape[]): WorkplaneShape[] {
  return selection.flatMap((shape) => {
    if (shape.suppressed || shape.csg?.suppressed) return [];
    if (shouldExpandGroupForBoolean(shape)) {
      return restoreGroupedChildren(shape).filter((child) => !child.suppressed && !child.csg?.suppressed);
    }
    return [shape];
  });
}

/** Re-bake simple rect/circle sketch holes so Group uses CylinderGeometry/BoxGeometry cutters
 *  even when the live shape still has an older ExtrudeGeometry soup. */
function rebuildSketchHoleCutterIfPossible(shape: WorkplaneShape): WorkplaneShape {
  if (!shape.hole || !shape.sketchProfile) {
    return shape;
  }
  const closedPaths = orderedSketchPaths(shape.sketchProfile).filter((path) => path.closed);
  if (closedPaths.length !== 1) {
    return shape;
  }
  if (!axisAlignedRectFromClosedPath(closedPaths[0]) && !circleFromClosedPath(closedPaths[0])) {
    return shape;
  }
  const plane = resolveSketchPlane(shape.sketchPlane ?? shape.sketchProfile.sketchPlane);
  const originalBounds = meshAabb(shape);
  const normal = plane.normal;
  const extentAlongNormal =
    Math.abs(normal.x) * (originalBounds.maxX - originalBounds.minX)
    + Math.abs(normal.y) * (originalBounds.maxY - originalBounds.minY)
    + Math.abs(normal.z) * (originalBounds.maxZ - originalBounds.minZ);
  const faceHosted = isFaceHostedSketch(plane, shape.sketchProfile.faceReferenceLoops);
  const hasMeshExtent = Boolean(shape.importedMesh && shape.importedMesh.positions.length >= 9);
  // Face-hole `height` / mesh extent is already the full through-all cutter length
  // (host thickness + overshoot past BOTH skins). Do not subtract overshoot again —
  // that shortened remesh/redo cutters to a coplanar far face (blind-looking holes).
  const extrudeHeight = Math.max(
    0.5,
    shape.height,
    hasMeshExtent ? extentAlongNormal : 0,
  );
  const rebuilt = shapeFromSketchProfile(
    {
      ...shape.sketchProfile,
      sketchPlane: plane,
      faceReferenceLoops: shape.sketchProfile.faceReferenceLoops,
    },
    extrudeHeight,
    {
      ...shape,
      hole: true,
      sketchPlane: plane,
    },
    { cutIntoFace: faceHosted },
  );
  if (!rebuilt) {
    return shape;
  }
  // Never teleport a face-hole cutter onto the workplane — that makes Group "succeed"
  // with an uncut solid (no AABB overlap → boolean no-op).
  if (!cuboidsOverlap(originalBounds, meshAabb(rebuilt))) {
    return shape;
  }
  return rebuilt;
}

function canUseBoxBoolean(selection: WorkplaneShape[]) {
  return selection.every(isAxisAlignedBoxCutter);
}

function hasNonZeroRotation(shape: WorkplaneShape) {
  const rotation = Math.abs(normalizeDegrees(shape.rotation));
  const rotationX = Math.abs(normalizeDegrees(shape.rotationX ?? 0));
  const rotationZ = Math.abs(normalizeDegrees(shape.rotationZ ?? 0));
  return [rotation, rotationX, rotationZ].some((value) => value > 0.001 && Math.abs(value - 360) > 0.001);
}

async function buildGroupedShapeFromSelection(groupable: WorkplaneShape[]): Promise<GroupBuildResult> {
  const expanded = expandGroupsForBoolean(groupable).map((shape) => (
    shape.hole ? rebuildSketchHoleCutterIfPossible(shape) : shape
  ));
  // Sync bake sketch meshes before the OCCT gate so Group does not race async bake → Manifold.
  const booleanSelection = await ensureExactBrepSources(expanded);
  const hasSolid = booleanSelection.some((shape) => !shape.hole);
  const hasHole = booleanSelection.some((shape) => shape.hole);
  const hasImportedMesh = booleanSelection.some((shape) => Boolean(shape.importedMesh));
  const boxBooleanSelection = hasSolid && hasHole
    ? expandGroupsForBoxBoolean(groupable).map((shape) => (shape.hole ? rebuildSketchHoleCutterIfPossible(shape) : shape))
    : [];
  // Prefer exact OCCT when every operand has B-Rep; Manifold stays progressive fallback.
  const occtEligible = hasSolid && selectionSupportsOcctCsg(booleanSelection);
  const occtGroup = occtEligible
    ? await occtBooleanMeshShape(booleanSelection, hasHole ? "subtract" : "union")
    : null;
  const manifoldCutGroup = !occtGroup && hasSolid && hasHole
    ? await manifoldBooleanMeshShape(booleanSelection, { requireImported: false })
    : null;
  const cleanBoxGroup = !occtGroup && !manifoldCutGroup && canUseBoxBoolean(boxBooleanSelection)
    ? boxedBooleanMeshShape(boxBooleanSelection)
    : null;
  const manifoldUnionGroup = !occtGroup && hasSolid && !hasHole
    && booleanSelection.filter((shape) => !shape.hole && !shape.locked).length >= 2
    ? await manifoldUnionMeshShape(booleanSelection)
    : null;
  const exactImportedGroup = !occtGroup && hasImportedMesh && hasSolid && hasHole
    ? manifoldCutGroup ?? importedBooleanMeshShape(booleanSelection)
    : null;
  const bvhCutGroup = hasSolid && hasHole && !occtGroup && !manifoldCutGroup && !cleanBoxGroup
    ? booleanMeshShape(booleanSelection)
    : null;
  const cutGroup = exactImportedGroup ?? bvhCutGroup;
  const group = occtGroup ?? (hasSolid && hasHole
    ? manifoldCutGroup ??
      cleanBoxGroup ??
      cutGroup
    : manifoldUnionGroup ??
      (hasImportedMesh ? mergedMeshShape(booleanSelection) : null) ??
      groupedShape(groupable));
  const withMeta = group
    ? markCsgClean(withCsgMeta(
      group,
      group.csg?.op ?? inferCsgOp(group) ?? (hasHole ? "subtract" : hasSolid ? "union" : "assemble"),
      group.csg?.version ?? 1,
      false,
    ))
    : null;
  const consumed = !withMeta && hasSolid && hasHole && cutFullyConsumesSolids(booleanSelection);
  const usedMeshFallback = Boolean(withMeta && occtEligible && !occtGroup);
  return {
    group: withMeta,
    booleanSelection,
    hasSolid,
    hasHole,
    hasImportedMesh,
    consumed,
    failureNotice: hasSolid && hasHole
      ? (hasImportedMesh ? "Could not cut with this hole mesh" : "Could not cut this selection")
      : "Could not group this selection",
    qualityNotice: usedMeshFallback
      ? "Exact CAD boolean unavailable — used mesh Group. STEP for this solid may be faceted."
      : undefined,
  };
}

/** Re-evaluate a CSG body from world-space children; preserves body + child ids. */
async function remeshCsgGroupFromWorldChildren(
  body: WorkplaneShape,
  worldChildren: WorkplaneShape[],
  options?: { skipOcct?: boolean },
): Promise<WorkplaneShape | null> {
  if (worldChildren.length === 0) return null;
  const op = body.csg?.op ?? inferCsgOp(body);
  if (!op) return body;

  // Feature tree keeps suppressed children; only active ones feed the boolean/display mesh.
  const activeChildren = worldChildren.filter(
    (child) => !child.suppressed && !child.csg?.suppressed && !child.locked,
  );

  if (op === "assemble") {
    // No boolean cache — viewport renders live children and already skips suppressed ones.
    return markCsgClean({
      ...body,
      importedMesh: undefined,
      groupedShapes: body.groupedShapes,
      csg: {
        op: "assemble",
        version: (body.csg?.version ?? 0) + 1,
        suppressed: body.csg?.suppressed,
      },
    });
  }

  if (activeChildren.length === 0) {
    return markCsgClean({
      ...body,
      importedMesh: undefined,
      groupedShapes: body.groupedShapes,
      csg: {
        op,
        version: (body.csg?.version ?? 0) + 1,
        suppressed: body.csg?.suppressed,
      },
    });
  }

  // A body with only hole features left has nothing to display.
  if (activeChildren.every((child) => child.hole)) {
    return markCsgClean({
      ...body,
      importedMesh: undefined,
      groupedShapes: body.groupedShapes,
      csg: {
        op,
        version: (body.csg?.version ?? 0) + 1,
        suppressed: body.csg?.suppressed,
      },
    });
  }

  // Nested-preserving path: do not expand nested CSG — use their mesh caches as operands.
  let result = await evaluateCsgOpOnOperands(activeChildren, op, options);
  if (!result?.importedMesh) {
    // Fallback: legacy flatten path for stubborn cases (active children only).
    const flat = await buildGroupedShapeFromSelection(activeChildren);
    result = flat.group;
  }
  if (!result?.importedMesh) {
    const sole = activeChildren.find((child) => !child.hole) ?? activeChildren[0];
    result = bakeSolidAsGroupMesh(sole);
  }
  if (!result?.importedMesh) return null;

  const g = result;
  return markCsgClean({
    ...g,
    id: body.id,
    name: body.name,
    color: body.color,
    locked: body.locked,
    hidden: body.hidden,
    // Keep recipes so the editor can re-apply fillet/chamfer after remesh.
    // Geometry (cadBrep / display edges) is invalid until re-applied.
    edgeTreatments: body.edgeTreatments,
    edgeTreatmentHistory: body.edgeTreatmentHistory,
    edgeResizeMode: body.edgeResizeMode,
    cadBrep: undefined,
    cadBrepFrame: undefined,
    cadDisplayEdges: undefined,
    cadDisplayEdgesVersion: undefined,
    // Keep suppressed features in the tree even though they were not remeshed in.
    groupedShapes: worldChildren.map((child) =>
      cloneAsGroupChild(child, g.x, g.z, g.elevation ?? 0, true),
    ),
    csg: {
      op: g.csg?.op ?? op,
      version: (body.csg?.version ?? 0) + 1,
      suppressed: body.csg?.suppressed,
    },
  });
}

/**
 * Bottom-up remesh: nested evaluated children first, then this node.
 * Preserves nested op structure (no flatten).
 */
async function remeshCsgGroup(group: WorkplaneShape, options?: { skipOcct?: boolean }): Promise<WorkplaneShape | null> {
  if (!group.groupedShapes?.length) return null;
  if (group.csg?.suppressed) return group;
  const op = group.csg?.op ?? inferCsgOp(group);
  if (!op) return group;

  const nextChildren: WorkplaneShape[] = [];
  for (const child of group.groupedShapes) {
    if (child.suppressed || child.csg?.suppressed) {
      nextChildren.push(child);
      continue;
    }
    const childOp = child.csg?.op ?? inferCsgOp(child);
    if (child.groupedShapes?.length && childOp && childOp !== "assemble") {
      const remeshedChild = await remeshCsgGroup(child, options);
      nextChildren.push(remeshedChild ?? child);
    } else {
      nextChildren.push(child);
    }
  }

  const withChildren = { ...group, groupedShapes: nextChildren };
  const worldChildren = restoreGroupedChildren(withChildren, { preserveIds: true });
  return remeshCsgGroupFromWorldChildren(withChildren, worldChildren, options);
}

/** Replace a leaf (world pose) under a CSG body and remesh; fail closed keeps last good mesh. */
async function updateCsgLeafAndRemesh(
  body: WorkplaneShape,
  leafId: string,
  nextLeafWorld: WorkplaneShape,
): Promise<{ body: WorkplaneShape; remeshed: boolean }> {
  const worldChildren = restoreGroupedChildren(body, { preserveIds: true });
  let found = false;
  const nextChildren: WorkplaneShape[] = [];
  for (const child of worldChildren) {
    if (child.id === leafId) {
      found = true;
      nextChildren.push({ ...nextLeafWorld, id: leafId });
      continue;
    }
    if (child.groupedShapes?.length && csgTreeContainsId(child, leafId)) {
      const nested = await updateCsgLeafAndRemesh(child, leafId, nextLeafWorld);
      nextChildren.push(nested.body);
      found = true;
      continue;
    }
    nextChildren.push(child);
  }
  if (!found) {
    const dirty = replaceLeafInCsgTree(
      body,
      leafId,
      cloneAsGroupChild({ ...nextLeafWorld, id: leafId }, body.x, body.z, body.elevation ?? 0, true),
    );
    const remeshed = await remeshCsgGroup(dirty);
    if (!remeshed) {
      return {
        body: {
          ...dirty,
          importedMesh: body.importedMesh,
          csg: { ...(dirty.csg ?? { op: inferCsgOp(dirty) ?? "union", version: 1 }), dirty: true },
        },
        remeshed: false,
      };
    }
    return { body: remeshed, remeshed: true };
  }
  const remeshed = await remeshCsgGroupFromWorldChildren(body, nextChildren);
  if (!remeshed) {
    const dirtyChildren = nextChildren.map((child) =>
      cloneAsGroupChild(child, body.x, body.z, body.elevation ?? 0, true),
    );
    return {
      body: {
        ...body,
        groupedShapes: dirtyChildren,
        csg: {
          ...(body.csg ?? { op: inferCsgOp(body) ?? "union", version: 1 }),
          dirty: true,
          version: (body.csg?.version ?? 0) + 1,
        },
      },
      remeshed: false,
    };
  }
  return { body: remeshed, remeshed: true };
}

/** Restore mesh caches stripped from compact history snapshots. */
async function remeshDirtyHistoryShapes(shapes: WorkplaneShape[]): Promise<{ shapes: WorkplaneShape[]; failedNames: string[] }> {
  const next = [...shapes];
  const failedNames: string[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const shape = next[index];
    if (!historyShapeNeedsRemesh(shape)) continue;
    const priorBrepStep = shape.importedMesh?.brepStep;
    const hadEdgeFeatures = Boolean(shape.edgeTreatments?.length || shape.cadBrep);
    const remeshed = await remeshCsgGroup(shape);
    if (remeshed) {
      let restored = remeshed;
      // Keep exact STEP payload across undo remesh when the new mesh didn't bake yet.
      if (priorBrepStep && restored.importedMesh && !restored.importedMesh.brepStep) {
        restored = {
          ...restored,
          importedMesh: { ...restored.importedMesh, brepStep: priorBrepStep },
        };
      }
      // Keep recipes; drop only baked BREP/display edges (IDs are invalid until re-apply).
      if (hadEdgeFeatures) {
        restored = {
          ...restored,
          edgeTreatments: shape.edgeTreatments ?? restored.edgeTreatments,
          edgeTreatmentHistory: shape.edgeTreatmentHistory ?? restored.edgeTreatmentHistory,
          edgeResizeMode: shape.edgeResizeMode ?? restored.edgeResizeMode,
          cadBrep: undefined,
          cadBrepFrame: undefined,
          cadDisplayEdges: undefined,
          cadDisplayEdgesVersion: undefined,
        };
      }
      next[index] = restored;
    } else {
      failedNames.push(shape.name || shape.id);
      // Refuse silent stale mesh: mark dirty so UI/export can warn.
      next[index] = {
        ...shape,
        csg: shape.csg
          ? { ...shape.csg, dirty: true }
          : { op: inferCsgOp(shape) ?? "union", version: 1, dirty: true },
      };
    }
  }
  return { shapes: next, failedNames };
}

/** Keep host body id when a cut/union result replaces an existing CSG host. */
function asPreservedCsgBody(host: WorkplaneShape, group: WorkplaneShape): WorkplaneShape {
  // Always preserve the host id so face-sketch links, selection, and Features stay stable
  // when the first cut/join wraps a bare box/cylinder/import into a CSG body.
  const bodyId = host.id;
  const body = bodyId === group.id
    ? { ...group, name: host.name || group.name, color: host.color || group.color }
    : { ...group, id: bodyId, name: host.name, color: host.color };
  return rewriteSketchHostIds(body, host.id, bodyId);
}

/** World triangles for face-sketch outlines — prefer evaluated mesh caches (CSG/import). */
function worldTrianglesForHostShape(host: WorkplaneShape) {
  const mesh = meshForShape(host);
  return worldTrianglesFromMeshData(mesh.vertices, mesh.faces);
}

function debugShapeSummary(shape: WorkplaneShape): Record<string, unknown> {
  return {
    id: shape.id,
    name: shape.name,
    kind: shape.kind,
    hole: Boolean(shape.hole),
    x: Number(shape.x.toFixed(3)),
    z: Number(shape.z.toFixed(3)),
    elevation: Number((shape.elevation ?? 0).toFixed(3)),
    width: Number(shapeWidth(shape).toFixed(3)),
    depth: Number(shapeDepth(shape).toFixed(3)),
    height: Number(shape.height.toFixed(3)),
    rotation: Number(shape.rotation.toFixed(3)),
    rotationX: Number((shape.rotationX ?? 0).toFixed(3)),
    rotationZ: Number((shape.rotationZ ?? 0).toFixed(3)),
    mirrorX: Boolean(shape.mirrorX),
    mirrorY: Boolean(shape.mirrorY),
    mirrorZ: Boolean(shape.mirrorZ),
    importedTriangles: shape.importedMesh?.triangleCount ?? 0,
    imagePlate: shape.imagePlate ? `${shape.imagePlate.pixelWidth}x${shape.imagePlate.pixelHeight}` : null,
    edgeTreatments: shape.edgeTreatments ?? [],
    cadDisplayEdgeCount: shape.cadDisplayEdges?.length ?? null,
    cadDisplayEdgesVersion: shape.cadDisplayEdgesVersion ?? null,
    edgeResizeMode: shape.edgeResizeMode ?? "scale",
    cadBrepLength: shape.cadBrep?.length ?? 0,
    cadPrimitiveKind: shape.cadPrimitiveFrame?.kind ?? null,
    groupedCount: shape.groupedShapes?.length ?? 0,
    children: shape.groupedShapes?.map(debugShapeSummary) ?? [],
  };
}

function compactShapeSummary(shape: WorkplaneShape, index: number) {
  const childSummary = shape.groupedShapes
    ?.map((child) => `${child.kind}${child.hole ? "H" : "S"}${child.importedMesh ? "I" : ""}`)
    .join("+");
  return [
    `${index}:${shape.kind}${shape.hole ? "H" : "S"}${shape.importedMesh ? "I" : ""}${shape.imagePlate ? "P" : ""}`,
    `g${shape.groupedShapes?.length ?? 0}`,
    `tri${shape.importedMesh?.triangleCount ?? 0}`,
    `edge${shape.edgeTreatments?.map((feature) => `${feature.kind}:${feature.amount}:${feature.edgeCount}:${feature.chamferAngle ?? ""}`).join("|") ?? ""}`,
    `viewEdges${shape.cadDisplayEdges?.length ?? "auto"}v${shape.cadDisplayEdgesVersion ?? 0}`,
    `edgeResize${shape.edgeResizeMode ?? "scale"}`,
    `brep${shape.cadBrep?.length ?? 0}`,
    `prim${shape.cadPrimitiveFrame ? `${shape.cadPrimitiveFrame.kind}:${shape.cadPrimitiveFrame.width}:${shape.cadPrimitiveFrame.depth}:${shape.cadPrimitiveFrame.height}` : ""}`,
    `p${Number(shape.x.toFixed(2))},${Number(shape.z.toFixed(2))},${Number((shape.elevation ?? 0).toFixed(2))}`,
    `d${Number(shapeWidth(shape).toFixed(2))}x${Number(shapeDepth(shape).toFixed(2))}x${Number(shape.height.toFixed(2))}`,
    `r${Number((shape.rotationX ?? 0).toFixed(1))},${Number(shape.rotation.toFixed(1))},${Number((shape.rotationZ ?? 0).toFixed(1))}`,
    `m${shape.mirrorX ? "x" : ""}${shape.mirrorY ? "y" : ""}${shape.mirrorZ ? "z" : ""}`,
    childSummary ? `c[${childSummary}]` : "c[]",
  ].join(",");
}

function mcpShapeSummary(shape: WorkplaneShape): SketchForgeMcpShapeSummary {
  return {
    id: shape.id,
    name: shape.name,
    kind: shape.kind,
    color: shape.color,
    hole: Boolean(shape.hole),
    locked: Boolean(shape.locked),
    hidden: Boolean(shape.hidden),
    position: {
      x: shape.x,
      z: shape.z,
      elevation: shape.elevation ?? 0,
    },
    dimensions: {
      width: shapeWidth(shape),
      depth: shapeDepth(shape),
      height: shape.height,
      size: shape.size,
    },
    rotation: {
      x: shape.rotationX ?? 0,
      y: shape.rotation,
      z: shape.rotationZ ?? 0,
    },
    mirror: {
      x: Boolean(shape.mirrorX),
      y: Boolean(shape.mirrorY),
      z: Boolean(shape.mirrorZ),
    },
    edgeTreatments: shape.edgeTreatments ?? [],
    groupedCount: shape.groupedShapes?.length ?? 0,
    importedTriangles: shape.importedMesh?.triangleCount ?? 0,
    cadDisplayEdgeCount: shape.cadDisplayEdges?.length ?? null,
    sketchPointCount: shape.sketchProfile?.points.length ?? 0,
    sketchSegmentCount: shape.sketchProfile?.segments.length ?? 0,
    children: shape.groupedShapes?.map(mcpShapeSummary),
  };
}

function defaultMcpSketchProfile(width: number, depth: number): SketchProfile {
  const halfWidth = Math.max(0.01, width) / 2;
  const halfDepth = Math.max(0.01, depth) / 2;
  const pointIds = ["mcp-sketch-a", "mcp-sketch-b", "mcp-sketch-c", "mcp-sketch-d"].map((prefix) => createLocalId(prefix));
  return {
    points: [
      { id: pointIds[0], x: -halfWidth, z: -halfDepth, mode: "corner" },
      { id: pointIds[1], x: halfWidth, z: -halfDepth, mode: "corner" },
      { id: pointIds[2], x: halfWidth, z: halfDepth, mode: "corner" },
      { id: pointIds[3], x: -halfWidth, z: halfDepth, mode: "corner" },
    ],
    segments: [
      { id: createLocalId("mcp-sketch-segment"), startId: pointIds[0], endId: pointIds[1], kind: "line" },
      { id: createLocalId("mcp-sketch-segment"), startId: pointIds[1], endId: pointIds[2], kind: "line" },
      { id: createLocalId("mcp-sketch-segment"), startId: pointIds[2], endId: pointIds[3], kind: "line" },
      { id: createLocalId("mcp-sketch-segment"), startId: pointIds[3], endId: pointIds[0], kind: "line" },
    ],
    images: [],
  };
}

function mcpNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mcpString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function mcpStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function mcpNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry)) : [];
}

function mcpFiniteNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry)) : [];
}

function readMcpEditorIdentity() {
  const storageKey = "sketchforge.mcp.editorIdentity";
  try {
    const existing = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as { editorId?: unknown; editorNumber?: unknown } | null;
    if (typeof existing?.editorId === "string" && typeof existing.editorNumber === "number") {
      return { editorId: existing.editorId, editorNumber: existing.editorNumber };
    }
  } catch {
    // Session identity is best-effort; fall through and create a new one.
  }

  const randomValues = new Uint32Array(1);
  window.crypto?.getRandomValues?.(randomValues);
  const editorNumber = 10000 + ((randomValues[0] || Math.floor(Math.random() * 90000)) % 90000);
  const editorId = window.crypto?.randomUUID?.() ?? `sketchforge-editor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const identity = { editorId, editorNumber };
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(identity));
  } catch {
    // Private browsing can block sessionStorage; the in-memory identity is enough for this tab.
  }
  return identity;
}

export function SketchForgeEditor({
  initialShapes = [],
  initialHistory,
  initialHistoryIndex,
  initialSnap,
  initialWorkspace,
  onHome,
  onProjectShapesChange,
  onProjectSnapshot,
  onProjectWorkspaceChange,
  onProjectNameChange,
  projectId,
  projectName = "PeakCAD design",
  projectRevision = 0,
}: {
  initialShapes?: WorkplaneShape[];
  initialHistory?: EditorHistoryEntry[];
  initialHistoryIndex?: number;
  initialSnap?: GridSize;
  initialWorkspace?: WorkplaneWorkspaceSettings;
  onHome?: () => void;
  onProjectShapesChange?: (snapshot: {
    projectId: string;
    shapes: WorkplaneShape[];
    history: EditorHistoryEntry[];
    historyIndex: number;
  }) => void;
  onProjectSnapshot?: (snapshot: { image: string; imageDark?: string; projectId: string; shapes: number }) => void;
  onProjectWorkspaceChange?: (snapshot: { projectId: string; workspace: WorkplaneWorkspaceSettings; snap: GridSize }) => void;
  onProjectNameChange?: (name: string) => void;
  projectId?: string | null;
  projectName?: string;
  projectRevision?: number;
} = {}) {
  const initialSceneRef = useRef<WorkplaneShape[] | null>(null);
  if (initialSceneRef.current === null) {
    initialSceneRef.current = initialShapes.map(canonicalizeShape);
  }
  const initialHistoryStateRef = useRef<EditorHistoryState | null>(null);
  if (initialHistoryStateRef.current === null) {
    initialHistoryStateRef.current = hydrateEditorHistoryState(initialSceneRef.current, initialHistory, initialHistoryIndex);
  }
  const [shapes, setShapes] = useState<WorkplaneShape[]>(() => initialSceneRef.current as WorkplaneShape[]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<WorkplaneShape[]>([]);
  const [systemClipboardSupported, setSystemClipboardSupported] = useState(false);
  const [history, setHistory] = useState<EditorHistoryEntry[]>(() => (initialHistoryStateRef.current as EditorHistoryState).entries);
  const [historyIndex, setHistoryIndex] = useState(() => (initialHistoryStateRef.current as EditorHistoryState).index);
  const [placementElevation, setPlacementElevation] = useState(0);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkplaneWorkspaceSettings>(() => {
    const normalized = normalizeWorkspaceSettings(initialWorkspace);
    setActiveDisplayQuality(normalized.displayQuality);
    return normalized;
  });
  const [snapGrid, setSnapGrid] = useState<GridSize>(() => normalizeSnapGrid(initialSnap, DEFAULT_SNAP_GRID));
  const [workplaneMode, setWorkplaneMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [topPanel, setTopPanel] = useState<TopPanel>(null);
  const [stepExporting, setStepExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState<ExportSuccessPayload | null>(null);
  const exportSuccessSeqRef = useRef(0);
  const celebrateExport = useCallback((format: string, detail?: string) => {
    exportSuccessSeqRef.current += 1;
    setExportSuccess({ id: exportSuccessSeqRef.current, format, detail });
  }, []);
  const [blueprintExporting, setBlueprintExporting] = useState(false);
  const [blueprintExportOpen, setBlueprintExportOpen] = useState(false);
  const [alignMode, setAlignMode] = useState(false);
  const [alignAnchorId, setAlignAnchorId] = useState<string | null>(null);
  const [alignPreview, setAlignPreview] = useState<{ axis: AlignAxis; target: AlignTarget } | null>(null);
  const [mirrorMode, setMirrorMode] = useState(false);
  const [mirrorPreviewAxis, setMirrorPreviewAxis] = useState<AlignAxis | null>(null);
  const [activeMode, setActiveMode] = useState("3D Design");
  const [notice, setNoticeState] = useState("Ready");
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [noticeSeq, setNoticeSeq] = useState(0);
  const [noticeQuiet, setNoticeQuiet] = useState(false);
  const setNotice = useCallback((message: string) => {
    setNoticeState(message);
    setNoticeQuiet(isQuietNotice(message));
    // Bump even when the text is unchanged so a dismissed toast reappears.
    setNoticeSeq((value) => value + 1);
  }, []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sketchImageInputRef = useRef<HTMLInputElement | null>(null);
  const booleanAutomationRunRef = useRef<string | null>(null);
  const projectHydratingRef = useRef(false);
  const projectInteractionActiveRef = useRef(false);
  const pendingProjectShapesRef = useRef<WorkplaneShape[] | null>(null);
  const projectSyncTimerRef = useRef<number | null>(null);
  const lastProjectShapesSyncRef = useRef("");
  const lastProjectShapesEchoRef = useRef<string | null>(null);
  const lastProjectIdRef = useRef<string | null>(null);
  const lastProjectFrameRef = useRef<string | null>(null);
  const shapesRef = useRef(shapes);
  const selectedIdsRef = useRef(selectedIds);
  const workspaceSettingsRef = useRef(workspaceSettings);
  const noticeRef = useRef(notice);
  const projectInfoRef = useRef({ projectId: projectId ?? null, projectName });
  const historyIndexRef = useRef(historyIndex);
  const historyRef = useRef(history);
  /**
   * Depth of nested "apply this without recording a step" sections.
   *
   * Re-applying fillets after an undo runs through the ordinary commit path, and appending to the
   * history truncates everything above the cursor — so undoing a filleted boolean body threw the
   * redo stack away and stacked the re-application on top as undo steps of its own.
   */
  const historyWriteSuspendedRef = useRef(0);
  const interactionHistoryStartRef = useRef("");
  const interactionHistoryChangedRef = useRef(false);
  const interactionHistoryTimerRef = useRef<number | null>(null);
  const interactionStartShapesRef = useRef<Record<string, WorkplaneShape> | null>(null);
  const lastShapeActionRef = useRef<Record<string, ShapeRepeatAction>>({});
  const duplicateRepeatDeltasRef = useRef<Map<string, ShapeRepeatDelta>>(new Map());
  const viewNudgeAxesRef = useRef<ViewNudgeAxes>(DEFAULT_VIEW_NUDGE_AXES);
  const rotationEditApiRef = useRef<{ dismiss: () => void } | null>(null);
  const [projectInteractionActive, setProjectInteractionActive] = useState(false);
  const [toolbarMode, setToolbarMode] = useState<ToolbarMode>("geometry");
  const [shapeRailPinned, setShapeRailPinned] = useState(false);
  const [sketchActive, setSketchActive] = useState(false);
  const [sketchFacePickMode, setSketchFacePickMode] = useState(false);
  const [sketchTool, setSketchTool] = useState<SketchTool>("line");
  const [sketchPolygonSides, setSketchPolygonSides] = useState(DEFAULT_SKETCH_POLYGON_SIDES);
  const [polygonSidesPrompt, setPolygonSidesPrompt] = useState<number | null>(null);
  const [extrudeHeightPrompt, setExtrudeHeightPrompt] = useState<number | null>(null);
  const [extrudeAsHole, setExtrudeAsHole] = useState(false);
  const [revolvePrompt, setRevolvePrompt] = useState<null | { phase: "pick" } | { phase: "confirm"; axis: SketchRevolveAxis }>(null);
  const [sketchProfile, setSketchProfile] = useState<SketchProfile>(() => emptySketchProfile());
  const [sketchDoc, setSketchDoc] = useState<SketchDoc>(() => createEmptySketchDoc(defaultSketchPlane()));
  const [sketchFocusMode, setSketchFocusMode] = useState<SketchFocusMode>("2d");
  const [sketchSolveStatus, setSketchSolveStatus] = useState<SketchDefinitionStatus>("empty");
  const [sketchDof, setSketchDof] = useState(0);
  const [sketchConflicts, setSketchConflicts] = useState<string[]>([]);
  const [sketchHistory, setSketchHistory] = useState<SketchProfile[]>([emptySketchProfile()]);
  const [sketchHistoryIndex, setSketchHistoryIndex] = useState(0);
  const sketchHistoryRef = useRef(sketchHistory);
  const sketchHistoryIndexRef = useRef(sketchHistoryIndex);
  const [sketchActivePointId, setSketchActivePointId] = useState<string | null>(null);
  const [sketchSelection, setSketchSelection] = useState<SketchSelection>(null);
  const [sketchMeasureStart, setSketchMeasureStart] = useState<SketchPoint | null>(null);
  const [sketchMeasurement, setSketchMeasurement] = useState<SketchMeasurement>(null);
  const [sketchClipboard, setSketchClipboard] = useState<SketchClipboard | null>(null);
  const [editingSketchShapeId, setEditingSketchShapeId] = useState<string | null>(null);
  const [activeFeatureId, setActiveFeatureId] = useState<string | null>(null);
  const [lastSketchSnap, setLastSketchSnap] = useState<SketchSnapResult | null>(null);
  const [edgeModifier, setEdgeModifier] = useState<EdgeModifierSession | null>(null);
  const edgeModifierRef = useRef<EdgeModifierSession | null>(null);
  const [circularPattern, setCircularPattern] = useState<CircularPatternSession | null>(null);
  const circularPatternRef = useRef<CircularPatternSession | null>(null);
  const [valueDialog, setValueDialog] = useState<ValueDialogState>(null);
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const [hotkeys, setHotkeys] = useState(() => loadHotkeyBindings());
  const cadModifierWorkerRef = useRef<Worker | null>(null);
  const cadModifierPendingRef = useRef(new Map<number, {
    resolve: (message: CadModifierWorkerResponse) => void;
    reject: (error: Error) => void;
    timer: number;
  }>());
  const cadModifierRequestRef = useRef(0);
  const cadModifierPrepareRef = useRef(0);
  const cadModifierLatestPreviewRef = useRef(0);
  const cadModifierBaseShapeRef = useRef<WorkplaneShape | null>(null);
  const reapplyEdgeTreatmentsRef = useRef<(shape: WorkplaneShape) => Promise<void>>(async () => {});
  const cadModifierBaseFingerprintRef = useRef("");
  const cadModifierSourcePartsRef = useRef<WorkplaneShape[]>([]);
  const cadModifierWatchdogRef = useRef<{ requestId: number; phase: CadModifierRequestPhase; timer: number } | null>(null);
  const cadModifierWorkerRestartRef = useRef<() => Worker | null>(() => null);
  /** Monotonic remesh generation — stale async remesh results are ignored. */
  const remeshGenerationRef = useRef(0);
  /** Debounced CSG remesh while dragging feature property sliders. */
  const featureRemeshTimerRef = useRef<number | null>(null);
  const pendingFeatureRemeshRef = useRef<{ bodyId: string; message: string } | null>(null);
  /** True after a Manifold-only (skipOcct) remesh — flush exact CAD on pointer-up. */
  const featureRemeshNeedsExactRef = useRef(false);
  const lastMcpErrorRef = useRef<string | null>(null);
  const executeMcpCommandRef = useRef<((command: SketchForgeMcpCommand) => Promise<unknown>) | null>(null);

  const clearCadModifierWatchdog = useCallback((requestId?: number) => {
    const active = cadModifierWatchdogRef.current;
    if (!active || (requestId !== undefined && active.requestId !== requestId)) return;
    window.clearTimeout(active.timer);
    cadModifierWatchdogRef.current = null;
  }, []);

  const armCadModifierWatchdog = useCallback((requestId: number, phase: CadModifierRequestPhase) => {
    clearCadModifierWatchdog();
    const timer = window.setTimeout(() => {
      const active = cadModifierWatchdogRef.current;
      if (!active || active.requestId !== requestId) return;
      cadModifierWatchdogRef.current = null;
      cadModifierWorkerRef.current?.terminate();
      cadModifierWorkerRef.current = null;
      cadModifierWorkerRestartRef.current();
      const message = cadModifierTimeoutMessage(phase);
      setEdgeModifier((current) => current ? {
        ...current,
        busy: false,
        prepared: false,
        preview: null,
        error: message,
      } : current);
      setNotice(message);
    }, hardwareProfile().modifierTimeoutMs || cadModifierRequestTimeoutMs());
    cadModifierWatchdogRef.current = { requestId, phase, timer };
  }, [clearCadModifierWatchdog]);

  useEffect(() => {
    let disposed = false;
    const rejectPendingRequests = (message: string) => {
      cadModifierPendingRef.current.forEach((pending) => {
        window.clearTimeout(pending.timer);
        pending.reject(new Error(message));
      });
      cadModifierPendingRef.current.clear();
    };
    const reportWorkerFailure = (worker: Worker | null, detail?: string) => {
      if (worker && cadModifierWorkerRef.current !== worker) return;
      clearCadModifierWatchdog();
      worker?.terminate();
      cadModifierWorkerRef.current = null;
      rejectPendingRequests("The CAD worker could not start");
      const requestId = cadModifierRequestRef.current + 1;
      cadModifierRequestRef.current = requestId;
      cadModifierPrepareRef.current = requestId;
      cadModifierLatestPreviewRef.current = requestId;
      if (detail) {
        console.error("[PeakCAD] CAD worker failed to start:", detail);
      }
      if (cadModifierBaseShapeRef.current) {
        // Surfaced by the edge modifier panel's own error state — skip the redundant toast.
        const message = cadModifierWorkerFailureMessage();
        setEdgeModifier((current) => current ? { ...current, busy: false, prepared: false, preview: null, error: message } : current);
      }
    };
    const spareWorkersRef = { current: [] as Worker[] };
    const bindPrimaryWorker = (worker: Worker) => {
      worker.onmessage = handleWorkerMessage;
      worker.onerror = (event) => {
        event.preventDefault();
        const detail = [event.message, event.filename, event.lineno].filter(Boolean).join(" @ ");
        reportWorkerFailure(worker, detail || "worker error event");
      };
      worker.onmessageerror = () => reportWorkerFailure(worker, "worker messageerror");
      return worker;
    };
    const createWorker = () => {
      if (disposed) return null;
      cadModifierWorkerRef.current?.terminate();
      spareWorkersRef.current.forEach((spare) => spare.terminate());
      spareWorkersRef.current = [];
      try {
        // Single primary worker only — a warm spare doubled startup failures and memory
        // without helping the common fillet/chamfer path (OCCT loads lazily on prepare).
        const worker = bindPrimaryWorker(new Worker(new URL("../workers/cadModifier.worker.ts", import.meta.url), { type: "module" }));
        cadModifierWorkerRef.current = worker;
        return worker;
      } catch (error) {
        reportWorkerFailure(null, error instanceof Error ? error.message : String(error));
        return null;
      }
    };
    function handleWorkerMessage(event: MessageEvent<CadModifierWorkerResponse>) {
      const message = event.data;
      clearCadModifierWatchdog(message.requestId);
      const pending = cadModifierPendingRef.current.get(message.requestId);
      if (pending) {
        window.clearTimeout(pending.timer);
        cadModifierPendingRef.current.delete(message.requestId);
        if (message.type === "error") {
          pending.reject(new Error(message.message));
        } else {
          pending.resolve(message);
        }
        return;
      }
      if (message.type === "ready") {
        if (message.requestId !== cadModifierPrepareRef.current) return;
        setEdgeModifier((current) => current ? {
          ...current,
          edges: message.edges,
          selectedEdgeIds: [],
          busy: false,
          prepared: true,
          preview: null,
          componentPreviews: [],
          error: message.selectableEdgeIds.length ? null : "No sharp manifold edges were found at this threshold",
        } : current);
        if (message.selectableEdgeIds.length) {
          setNotice("Select highlighted edges, then adjust the preview");
        }
        return;
      }
      if (message.type === "preview") {
        if (message.requestId !== cadModifierLatestPreviewRef.current) return;
        const base = cadModifierBaseShapeRef.current;
        const sourceParts = cadModifierSourcePartsRef.current.length ? cadModifierSourcePartsRef.current : (base ? [base] : []);
        const rawPreview = base ? shapeFromCadMesh(base, message.positions, message.normals, message.indices, message.brep, message.step) : null;
        const preview = rawPreview ? {
          ...rawPreview,
          cadDisplayEdges: cadDisplayEdgesForShape(rawPreview, message.displayEdges),
          cadDisplayEdgesVersion: 2 as const,
        } : null;
        const componentPreviews = cadModifierComponentPreviews(sourceParts, message.components);
        setEdgeModifier((current) => current ? {
          ...current,
          preview,
          componentPreviews,
          busy: false,
          error: preview ? null : "The CAD kernel returned an empty edge treatment",
        } : current);
        if (preview) setNotice("Edge treatment preview ready");
        return;
      }
      if (message.type === "error") {
        if (message.requestId < cadModifierLatestPreviewRef.current) return;
        if (message.resetSession) {
          const requestId = cadModifierRequestRef.current + 1;
          cadModifierRequestRef.current = requestId;
          cadModifierLatestPreviewRef.current = requestId;
          cadModifierPrepareRef.current = requestId;
          cadModifierBaseShapeRef.current = null;
          cadModifierBaseFingerprintRef.current = "";
          cadModifierSourcePartsRef.current = [];
          setEdgeModifier(null);
          setNotice(message.message);
          return;
        }
        // The edge modifier panel already renders message.message as its error state.
        setEdgeModifier((current) => current ? { ...current, busy: false, preview: null, error: message.message } : current);
      }
    }
    cadModifierWorkerRestartRef.current = createWorker;
    createWorker();
    return () => {
      disposed = true;
      clearCadModifierWatchdog();
      cadModifierWorkerRestartRef.current = () => null;
      rejectPendingRequests("The CAD worker was closed");
      cadModifierWorkerRef.current?.terminate();
      cadModifierWorkerRef.current = null;
      spareWorkersRef.current.forEach((spare) => spare.terminate());
      spareWorkersRef.current = [];
    };
  }, [clearCadModifierWatchdog]);

  const invalidateCadModifierSession = useCallback(() => {
    const wasActive = cadModifierBaseShapeRef.current !== null;
    if (!wasActive) return false;
    const hadInFlightRequest = cadModifierWatchdogRef.current !== null;
    clearCadModifierWatchdog();
    const requestId = cadModifierRequestRef.current + 1;
    cadModifierRequestRef.current = requestId;
    cadModifierLatestPreviewRef.current = requestId;
    cadModifierPrepareRef.current = requestId;
    if (hadInFlightRequest) {
      cadModifierWorkerRef.current?.terminate();
      cadModifierWorkerRef.current = null;
      cadModifierWorkerRestartRef.current();
    } else {
      cadModifierWorkerRef.current?.postMessage({ type: "dispose", requestId } satisfies CadModifierWorkerRequest);
    }
    cadModifierBaseShapeRef.current = null;
    cadModifierBaseFingerprintRef.current = "";
    cadModifierSourcePartsRef.current = [];
    setEdgeModifier(null);
    return true;
  }, [clearCadModifierWatchdog]);

  useEffect(() => {
    const warmBooleanRuntime = () => {
      warmManifoldBooleanWorker();
      void getManifoldRuntime().catch(() => {
        // Allow a real grouping action to retry if an idle preload was interrupted.
        manifoldRuntimePromise = null;
      });
    };
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(warmBooleanRuntime, { timeout: 1500 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timer = globalThis.setTimeout(warmBooleanRuntime, 250);
    return () => globalThis.clearTimeout(timer);
  }, []);

  useEffect(() => {
    setSystemClipboardSupported(Boolean(navigator.clipboard));
    setClipboard(readSharedClipboard());
    const onStorage = (event: StorageEvent) => {
      if (event.key === SHARED_CLIPBOARD_STORAGE_KEY) {
        setClipboard(readSharedClipboard());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    shapesRef.current = shapes;
  }, [shapes]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
    const currentHistory = historyRef.current;
    const currentIndex = Math.min(historyIndexRef.current, Math.max(0, currentHistory.length - 1));
    const currentEntry = currentHistory[currentIndex];
    if (currentEntry && currentEntry.selectedIds.join("\0") !== selectedIds.join("\0")) {
      const updated = currentHistory.map((entry, index) => index === currentIndex ? { ...entry, selectedIds: [...selectedIds] } : entry);
      historyRef.current = updated;
      setHistory(updated);
    }
  }, [selectedIds]);

  useEffect(() => {
    workspaceSettingsRef.current = workspaceSettings;
    setActiveDisplayQuality(workspaceSettings.displayQuality);
  }, [workspaceSettings]);

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  useEffect(() => {
    if (!notice || notice === "Ready") {
      setNoticeVisible(false);
      return;
    }
    setNoticeVisible(true);
    const timer = window.setTimeout(() => {
      setNoticeVisible(false);
    }, noticeQuiet ? 2_500 : 10_000);
    return () => window.clearTimeout(timer);
  }, [notice, noticeQuiet, noticeSeq]);

  const dismissNotice = useCallback(() => {
    setNoticeVisible(false);
  }, []);

  useEffect(() => {
    projectInfoRef.current = { projectId: projectId ?? null, projectName };
  }, [projectId, projectName]);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    sketchHistoryRef.current = sketchHistory;
  }, [sketchHistory]);

  useEffect(() => {
    sketchHistoryIndexRef.current = sketchHistoryIndex;
  }, [sketchHistoryIndex]);

  useEffect(() => {
    edgeModifierRef.current = edgeModifier;
  }, [edgeModifier]);

  useEffect(() => {
    circularPatternRef.current = circularPattern;
  }, [circularPattern]);

  useEffect(() => {
    const refreshHotkeys = () => setHotkeys(loadHotkeyBindings());
    window.addEventListener(HOTKEYS_CHANGED_EVENT, refreshHotkeys);
    return () => window.removeEventListener(HOTKEYS_CHANGED_EVENT, refreshHotkeys);
  }, []);

  useEffect(() => {
    setWorkspaceSettings(() => {
      const normalized = normalizeWorkspaceSettings(initialWorkspace);
      setActiveDisplayQuality(normalized.displayQuality);
      return normalized;
    });
  }, [initialWorkspace]);

  useEffect(() => {
    setSnapGrid(normalizeSnapGrid(initialSnap, DEFAULT_SNAP_GRID));
  }, [initialSnap]);

  const selectedShapes = useMemo(() => shapes.filter((shape) => selectedIds.includes(shape.id)), [selectedIds, shapes]);
  const selectedShape = selectedShapes.at(-1) ?? null;
  const hasSelection = selectedShapes.length > 0;
  useEffect(() => {
    if (!hasSelection) {
      setShapeRailPinned(false);
    }
  }, [hasSelection]);
  // Held as a stable array: the viewport reuses its edge lines while this is the same list, and
  // rebuilding it inline made every pointer move dispose and re-upload one geometry per edge.
  const modifierSelectableEdges = useMemo(
    () => edgeModifier ? edgeModifier.edges.filter((edge) => selectableCadModifierEdge(edge, edgeModifier.sharpAngle)) : [],
    [edgeModifier?.edges, edgeModifier?.sharpAngle],
  );
  const modifierAvailableEdgeIds = useMemo(
    () => modifierSelectableEdges.map((edge) => edge.id),
    [modifierSelectableEdges],
  );
  const edgeModifierMaxAmount = useMemo(() => {
    const source = cadModifierBaseShapeRef.current ?? selectedShape;
    if (!source) return 10;
    const smallestDimension = Math.min(shapeWidth(source), shapeDepth(source), source.height);
    return Math.max(MIN_EDGE_MODIFIER_AMOUNT, smallestDimension * 0.99);
  }, [edgeModifier, selectedShape]);
  const selectedEdgeFeatureCount = useMemo(() => selectedShape ? edgeTreatmentFeatureCount(selectedShape) : 0, [selectedShape]);
  const selectedReversibleEdgeFeatureCount = useMemo(() => selectedShape ? reversibleEdgeTreatmentCount(selectedShape) : 0, [selectedShape]);
  const selectedEdgeHistoryOptions = useMemo(() => selectedShape ? edgeTreatmentHistoryOptions(selectedShape) : [], [selectedShape]);
  const canSeparateSelectedParts = useMemo(
    () => selectedShapes.length === 1 && Boolean(selectedShape && separablePartCount(selectedShape) > 1),
    [selectedShape, selectedShapes.length],
  );
  const canCircularPattern = useMemo(() => selectedShapes.some((shape) => !shape.locked), [selectedShapes]);
  const circularPatternSources = useMemo(() => {
    if (!circularPattern) return [];
    const sourceIds = new Set(circularPattern.sourceIds);
    return shapes.filter((shape) => sourceIds.has(shape.id));
  }, [circularPattern, shapes]);
  const circularPatternPivot = useMemo(() => {
    if (!circularPattern?.pivotId) return null;
    return shapes.find((shape) => shape.id === circularPattern.pivotId) ?? null;
  }, [circularPattern, shapes]);
  const circularPatternRadius = circularPattern?.radius ?? 0;
  const toggleModifierEdge = useCallback((id: number, singleEdge = false) => {
    setEdgeModifier((current) => {
      // Only the edge list has to exist. Refusing while `busy` swallowed every click made during
      // the preview a previous click kicked off, so picking edges in quick succession dropped most
      // of them with nothing on screen changing. A newer selection just supersedes the request in
      // flight — the worker's reply is discarded unless its id is still the latest.
      if (!current || !current.prepared) return current;
      const allowed = new Set(current.edges.filter((edge) => selectableCadModifierEdge(edge, current.sharpAngle)).map((edge) => edge.id));
      if (!allowed.has(id)) return current;
      const ids = current.tangentChain && !singleEdge ? tangentCadEdgeChain(current.edges, id, allowed) : [id];
      const next = new Set(current.selectedEdgeIds);
      const remove = ids.every((edgeId) => next.has(edgeId));
      ids.forEach((edgeId) => remove ? next.delete(edgeId) : next.add(edgeId));
      return { ...current, selectedEdgeIds: [...next], preview: null, busy: next.size > 0, error: next.size ? null : "Select at least one highlighted edge" };
    });
  }, []);

  const exportableShapeCount = useMemo(() => (hasSelection ? selectedShapes : shapes).filter((shape) => !shape.hole).length, [hasSelection, selectedShapes, shapes]);
  const exportScopeLabel = hasSelection ? "selected" : "total";
  const exportPreflight = useMemo(
    () => buildStepExportPreflight(hasSelection ? selectedShapes : shapes),
    [hasSelection, selectedShapes, shapes],
  );
  const effectiveAlignAnchorId = useMemo(
    () => effectiveAlignmentAnchorId(selectedShapes, alignAnchorId),
    [alignAnchorId, selectedShapes],
  );
  const alignHandleStatuses = useMemo(() => (alignMode ? alignmentStatuses(selectedShapes, effectiveAlignAnchorId) : []), [alignMode, effectiveAlignAnchorId, selectedShapes]);
  const activeToolChip = useMemo<{ label: string; hint: string } | null>(() => {
    if (edgeModifier) {
      return { label: edgeModifier.kind === "fillet" ? "Fillet" : "Chamfer", hint: "Esc to cancel" };
    }
    if (circularPattern) {
      return { label: "Circular pattern", hint: "Esc to cancel" };
    }
    if (alignMode) {
      return { label: "Align", hint: "Esc to cancel" };
    }
    if (mirrorMode) {
      return { label: "Mirror", hint: "Esc to cancel" };
    }
    return null;
  }, [alignMode, circularPattern, edgeModifier, mirrorMode]);
  const sketchToolChip = useMemo<{ label: string; hint: string } | null>(() => {
    if (!sketchActive || sketchTool === "select") return null;
    const label = SKETCH_TOOL_CHIP_LABELS[sketchTool];
    if (!label) return null;
    return { label, hint: "Esc to exit" };
  }, [sketchActive, sketchTool]);
  const viewportShapes = useMemo(
    () => {
      const preview = edgeModifier?.preview;
      if (preview && cadModifierBaseShapeRef.current) {
        return shapes.map((shape) => shape.id === cadModifierBaseShapeRef.current?.id ? preview : shape);
      }
      if (alignMode && alignPreview) {
        return alignedShapesForSelection(shapes, selectedIds, selectedShapes, effectiveAlignAnchorId, alignPreview.axis, alignPreview.target).nextShapes;
      }
      if (mirrorMode && mirrorPreviewAxis) {
        return mirroredShapesForSelection(shapes, selectedIds, selectedShapes, mirrorPreviewAxis).nextShapes;
      }
      if (circularPattern?.preview) {
        const sourceIds = new Set(circularPattern.sourceIds);
        return shapes.filter((shape) => !sourceIds.has(shape.id)).concat(circularPattern.preview);
      }
      return shapes;
    },
    [alignMode, alignPreview, circularPattern, edgeModifier?.preview, effectiveAlignAnchorId, mirrorMode, mirrorPreviewAxis, selectedIds, selectedShapes, shapes],
  );
  const debugState = useMemo(
    () =>
      JSON.stringify({
        notice,
        selectedIds,
        shapeCount: shapes.length,
        shapes: shapes.map(debugShapeSummary),
      }),
    [notice, selectedIds, shapes],
  );
  const compactDebugState = useMemo(
    () => `notice=${notice};selected=${selectedIds.length};count=${shapes.length};${shapes.map(compactShapeSummary).join(";")}`,
    [notice, selectedIds, shapes],
  );

  const captureProjectPreviewFrame = useCallback(() => {
    if (typeof window === "undefined") {
      return lastProjectFrameRef.current;
    }
    try {
      const image = window.sketchforgeCaptureCanvas?.({ hideOverlays: false });
      if (image && image.length > 100) {
        lastProjectFrameRef.current = image;
        return image;
      }
    } catch {
      // Fall back to the last good geometry-mode frame below.
    }
    return lastProjectFrameRef.current;
  }, []);

  const captureProjectPreviewThemes = useCallback(() => {
    if (typeof window === "undefined") {
      const fallback = lastProjectFrameRef.current;
      return fallback ? { light: fallback, dark: fallback } : null;
    }
    try {
      const themed = window.sketchforgeCaptureProjectThumbnails?.({ hideOverlays: false });
      if (themed?.light && themed.light.length > 100) {
        lastProjectFrameRef.current = themed.light;
        return themed;
      }
    } catch {
      // Fall back to a single-frame capture below.
    }
    const image = captureProjectPreviewFrame();
    return image && image.length > 100 ? { light: image, dark: image } : null;
  }, [captureProjectPreviewFrame]);

  const publishProjectSnapshot = useCallback(() => {
    if (!projectId || !onProjectSnapshot) {
      return;
    }
    const themed = captureProjectPreviewThemes();
    if (themed?.light && themed.light.length > 100) {
      onProjectSnapshot({
        image: themed.light,
        imageDark: themed.dark && themed.dark.length > 100 ? themed.dark : undefined,
        projectId,
        shapes: shapesRef.current.length,
      });
    }
  }, [captureProjectPreviewThemes, onProjectSnapshot, projectId]);

  const handleHome = useCallback(() => {
    publishProjectSnapshot();
    onHome?.();
  }, [onHome, publishProjectSnapshot]);

  const changeToolbarMode = useCallback((mode: ToolbarMode) => {
    if (mode === "sketch") {
      // Geometry viewport unmounts in sketch mode — stash the current frame first.
      captureProjectPreviewFrame();
    }
    setSketchFacePickMode(false);
    setToolbarMode((current) => {
      if (current !== mode) {
        setModeTransitioning(true);
        window.setTimeout(() => setModeTransitioning(false), 180);
      }
      return mode;
    });
    setTopPanel(null);
    setMenuOpen(false);
  }, [captureProjectPreviewFrame]);

  useEffect(() => {
    if (selectedShapes.length < 2) {
      setAlignMode(false);
      setAlignAnchorId(null);
      setAlignPreview(null);
    }
    if (alignAnchorId && !selectedIds.includes(alignAnchorId)) {
      setAlignAnchorId(null);
      setAlignPreview(null);
    }
    if (selectedShapes.length === 0) {
      setMirrorMode(false);
      setMirrorPreviewAxis(null);
    }
  }, [alignAnchorId, selectedIds, selectedShapes.length]);

  const syncProjectShapes = useCallback(
    (nextShapes: WorkplaneShape[]) => {
      if (!projectId || !onProjectShapesChange) {
        return;
      }
      if (projectInteractionActiveRef.current) {
        pendingProjectShapesRef.current = nextShapes.map(canonicalizeShape);
        if (projectSyncTimerRef.current !== null) {
          window.clearTimeout(projectSyncTimerRef.current);
          projectSyncTimerRef.current = null;
        }
        return;
      }
      const canonicalNext = nextShapes.map(canonicalizeShape);
      const serialized = projectShapesFingerprint(canonicalNext);
      if (lastProjectShapesSyncRef.current === serialized) {
        return;
      }
      if (projectSyncTimerRef.current !== null) {
        window.clearTimeout(projectSyncTimerRef.current);
      }
      projectSyncTimerRef.current = window.setTimeout(() => {
        lastProjectShapesSyncRef.current = serialized;
        lastProjectShapesEchoRef.current = serialized;
        onProjectShapesChange({
          projectId,
          shapes: canonicalNext,
          history: historyRef.current,
          historyIndex: historyIndexRef.current,
        });
        projectSyncTimerRef.current = null;
      }, 120);
    },
    [onProjectShapesChange, projectId],
  );

  const flushProjectShapesSync = useCallback(() => {
    if (!projectId || !onProjectShapesChange) {
      return;
    }
    if (projectSyncTimerRef.current !== null) {
      window.clearTimeout(projectSyncTimerRef.current);
      projectSyncTimerRef.current = null;
    }
    const canonicalNext = (pendingProjectShapesRef.current ?? shapesRef.current).map(canonicalizeShape);
    pendingProjectShapesRef.current = null;
    const serialized = projectShapesFingerprint(canonicalNext);
    if (lastProjectShapesSyncRef.current === serialized) {
      return;
    }
    lastProjectShapesSyncRef.current = serialized;
    lastProjectShapesEchoRef.current = serialized;
    onProjectShapesChange({
      projectId,
      shapes: canonicalNext,
      history: historyRef.current,
      historyIndex: historyIndexRef.current,
    });
  }, [onProjectShapesChange, projectId]);

  const appendHistorySnapshot = useCallback((nextShapes: WorkplaneShape[], nextSelection: string[]) => {
    // Report the change so the project still saves, but leave the timeline (and the redo stack) alone.
    if (historyWriteSuspendedRef.current > 0) return true;
    const entry = editorHistoryEntry(nextShapes, nextSelection);
    const result = appendEditorHistorySnapshot(historyRef.current, historyIndexRef.current, entry);
    if (result.entries !== historyRef.current) {
      historyRef.current = result.entries;
      setHistory(result.entries);
    }
    historyIndexRef.current = result.index;
    setHistoryIndex(result.index);
    return result.changed;
  }, []);

  const finalizeInteractionHistory = useCallback(() => {
    const startFingerprint = interactionHistoryStartRef.current;
    const hadChanges = interactionHistoryChangedRef.current;
    const interactionStartShapes = interactionStartShapesRef.current;
    interactionHistoryStartRef.current = "";
    interactionHistoryChangedRef.current = false;
    interactionStartShapesRef.current = null;
    if (!hadChanges) {
      return;
    }

    const canonicalNext = shapesRef.current.map(canonicalizeShape);
    const nextFingerprint = projectShapesFingerprint(canonicalNext);
    if (!startFingerprint || startFingerprint === nextFingerprint) {
      return;
    }

    if (interactionStartShapes) {
      canonicalNext.forEach((shape) => {
        const before = interactionStartShapes[shape.id];
        if (!before) {
          return;
        }
        const delta = computeShapeRepeatDelta(before, shape);
        if (hasShapeRepeatDelta(delta)) {
          lastShapeActionRef.current[shape.id] = { delta, before };
          duplicateRepeatDeltasRef.current = new Map();
        }
      });
    }

    appendHistorySnapshot(canonicalNext, selectedIdsRef.current);
  }, [appendHistorySnapshot]);

  useEffect(() => {
    if (projectInteractionActive || !pendingProjectShapesRef.current) {
      return;
    }
    const pendingShapes = pendingProjectShapesRef.current;
    pendingProjectShapesRef.current = null;
    const timer = window.setTimeout(() => syncProjectShapes(pendingShapes), 180);
    return () => window.clearTimeout(timer);
  }, [projectInteractionActive, syncProjectShapes]);

  const flushPendingFeatureRemeshRef = useRef<(options?: { skipOcct?: boolean; deferHistory?: boolean }) => Promise<void>>(
    async () => {},
  );

  const updateProjectInteractionActive = useCallback(
    (active: boolean) => {
      if (active) {
        if (interactionHistoryTimerRef.current !== null) {
          window.clearTimeout(interactionHistoryTimerRef.current);
          interactionHistoryTimerRef.current = null;
          finalizeInteractionHistory();
        }
        if (!projectInteractionActiveRef.current) {
          interactionHistoryStartRef.current = projectShapesFingerprint(shapesRef.current);
          interactionHistoryChangedRef.current = false;
          interactionStartShapesRef.current = snapshotShapesForRepeat(shapesRef.current);
        }
        projectInteractionActiveRef.current = true;
        setProjectInteractionActive((current) => (current ? current : true));
        return;
      }

      projectInteractionActiveRef.current = false;
      setProjectInteractionActive((current) => (current ? false : current));
      if (interactionHistoryTimerRef.current !== null) {
        window.clearTimeout(interactionHistoryTimerRef.current);
        interactionHistoryTimerRef.current = null;
      }
      const needsFeatureFlush =
        pendingFeatureRemeshRef.current !== null
        || featureRemeshTimerRef.current !== null
        || featureRemeshNeedsExactRef.current;
      if (needsFeatureFlush) {
        void (async () => {
          // Final OCCT pass after Manifold-only drag remeshes; history via finalize below.
          await flushPendingFeatureRemeshRef.current({ skipOcct: false, deferHistory: true });
          finalizeInteractionHistory();
        })();
        return;
      }
      finalizeInteractionHistory();
    },
    [finalizeInteractionHistory],
  );

  const updateProjectWorkspaceSettings = useCallback(
    (settings: { workspace: WorkplaneWorkspaceSettings; snap: GridSize }) => {
      setWorkspaceSettings(settings.workspace);
      setSnapGrid(normalizeSnapGrid(settings.snap, DEFAULT_SNAP_GRID));
      if (!projectId || !onProjectWorkspaceChange) {
        return;
      }
      onProjectWorkspaceChange({ projectId, ...settings });
    },
    [onProjectWorkspaceChange, projectId],
  );

  const commitShapes = useCallback(
    (next: WorkplaneShape[], nextSelection: string | string[] | null = selectedIds, message?: string) => {
      const canonicalNext = migrateShapesCsg(next.map(canonicalizeShape));
      const requestedSelection = Array.isArray(nextSelection) ? nextSelection : nextSelection ? [nextSelection] : [];
      const validSelection = requestedSelection.filter((id, index) => requestedSelection.indexOf(id) === index && canonicalNext.some((shape) => shape.id === id));
      shapesRef.current = canonicalNext;
      selectedIdsRef.current = validSelection;
      setShapes(canonicalNext);
      setSelectedIds(validSelection);
      const changed = appendHistorySnapshot(canonicalNext, validSelection);
      if (message) {
        setNotice(message);
      }
      if (changed) {
        syncProjectShapes(canonicalNext);
      }
    },
    [appendHistorySnapshot, selectedIds, syncProjectShapes],
  );

  const flushPendingFeatureRemesh = useCallback(async (options?: { skipOcct?: boolean; deferHistory?: boolean }) => {
    if (featureRemeshTimerRef.current !== null) {
      window.clearTimeout(featureRemeshTimerRef.current);
      featureRemeshTimerRef.current = null;
    }
    const pending = pendingFeatureRemeshRef.current;
    if (!pending) {
      featureRemeshNeedsExactRef.current = false;
      return;
    }
    const body = shapesRef.current.find((entry) => entry.id === pending.bodyId);
    if (!body?.groupedShapes?.length) {
      pendingFeatureRemeshRef.current = null;
      featureRemeshNeedsExactRef.current = false;
      return;
    }
    const skipOcct = Boolean(options?.skipOcct);
    const remeshGen = remeshGenerationRef.current + 1;
    remeshGenerationRef.current = remeshGen;
    const remeshed = await remeshCsgGroup(body, { skipOcct });
    if (remeshGen !== remeshGenerationRef.current) return;
    const next = remeshed ?? {
      ...body,
      importedMesh: body.importedMesh,
      csg: { ...(body.csg ?? { op: inferCsgOp(body) ?? "union", version: 1 }), dirty: true },
    };
    const liveOnly = projectInteractionActiveRef.current || Boolean(options?.deferHistory);
    if (liveOnly) {
      if (projectInteractionActiveRef.current) {
        featureRemeshNeedsExactRef.current = skipOcct || featureRemeshNeedsExactRef.current;
      } else {
        pendingFeatureRemeshRef.current = null;
        featureRemeshNeedsExactRef.current = false;
      }
      setShapes((current) => {
        const mapped = current.map((entry) => (entry.id === body.id ? next : entry));
        shapesRef.current = mapped;
        interactionHistoryChangedRef.current = true;
        return mapped;
      });
      if (!projectInteractionActiveRef.current && next.edgeTreatments?.length) {
        await reapplyEdgeTreatmentsRef.current(next);
      }
      return;
    }
    pendingFeatureRemeshRef.current = null;
    featureRemeshNeedsExactRef.current = false;
    commitShapes(
      shapesRef.current.map((entry) => (entry.id === body.id ? next : entry)),
      body.id,
      pending.message,
    );
    if (!remeshed && (body.csg?.op ?? inferCsgOp(body)) !== "assemble") {
      setNotice("Could not rebuild body after feature edit — last good mesh kept. Ungroup then Group to retry.");
    } else if (next.edgeTreatments?.length) {
      await reapplyEdgeTreatmentsRef.current(next);
    }
  }, [commitShapes]);
  flushPendingFeatureRemeshRef.current = flushPendingFeatureRemesh;

  /** Attach brepStep without a history entry (background CAD bake). */
  const patchBrepStepQuietly = useCallback((shapeId: string, brepStep: string) => {
    const next = shapesRef.current.map((shape) => {
      if (shape.id === shapeId) {
        return withBakedSketchBrepStep(shape, brepStep);
      }
      if (shape.groupedShapes?.length && csgTreeContainsId(shape, shapeId)) {
        const leaf = findShapeInTree([shape], shapeId);
        if (!leaf) return shape;
        // Attaching the bake changes no geometry, so the body must not be flagged for remesh.
        return replaceLeafInCsgTree(shape, shapeId, withBakedSketchBrepStep(leaf, brepStep), { markDirty: false });
      }
      return shape;
    });
    shapesRef.current = next;
    setShapes(next);
    syncProjectShapes(next);
  }, [syncProjectShapes]);

  const scheduleSketchBrepBake = useCallback((shape: WorkplaneShape) => {
    const shapeId = shape.id;
    const fingerprint = projectShapesFingerprint([shape]);
    void (async () => {
      try {
        const brepStep = await bakeSketchFeatureBrepStep(shape);
        if (!brepStep) return;
        const current = findShapeInTree(shapesRef.current, shapeId);
        if (!current || projectShapesFingerprint([current]) !== fingerprint) return;
        patchBrepStepQuietly(shapeId, brepStep);
      } catch {
        // Faceted STEP remains available if exact bake fails.
      }
    })();
  }, [patchBrepStepQuietly]);

  const scheduleCsgBrepBake = useCallback((group: WorkplaneShape) => {
    const groupId = group.id;
    void (async () => {
      try {
        const { bakeCsgBodyBrepStep } = await import("@/lib/stepExport");
        const baked = await bakeCsgBodyBrepStep(group);
        const step = baked?.importedMesh?.brepStep;
        if (!step) return;
        const current = shapesRef.current.find((shape) => shape.id === groupId);
        if (!current?.importedMesh) return;
        const next = shapesRef.current.map((shape) => (
          shape.id === groupId
            ? { ...shape, importedMesh: { ...shape.importedMesh!, brepStep: step } }
            : shape
        ));
        shapesRef.current = next;
        setShapes(next);
        syncProjectShapes(next);
      } catch {
        // Keep Manifold mesh; faceted STEP still works.
      }
    })();
  }, [syncProjectShapes]);

  // First-run CAD path coaching (once per browser).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "peakcad.cadPathCoach.v1";
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      return;
    }
    const timer = window.setTimeout(() => {
      setNotice("Tip: Box → sketch a hole on a face → Group → Download STEP. Open Tips for the full CAD path.");
      setTopPanel("tips");
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  const removeEdgeTreatment = useCallback(async (optionId: string) => {
    if (!selectedShape) {
      setNotice("Select a shape with an edge feature first");
      return;
    }
    if (selectedShape.locked) {
      setNotice("Unlock the shape before removing an edge feature");
      return;
    }
    const option = selectedEdgeHistoryOptions.find((candidate) => candidate.id === optionId);
    if (!option) {
      setNotice("Choose an edge feature to remove");
      return;
    }
    const sourceFingerprint = projectShapesFingerprint([selectedShape]);
    const sourceProjectId = projectInfoRef.current.projectId;
    const restored = await restoreEdgeTreatmentInShape(selectedShape, option.path, option.entryId);
    if (!restored) {
      setNotice(selectedEdgeFeatureCount > 0 ? "This edge feature has no stored undo history" : "No edge feature to remove");
      return;
    }
    const currentTarget = shapesRef.current.find((shape) => shape.id === selectedShape.id);
    if (projectInfoRef.current.projectId !== sourceProjectId || !currentTarget || projectShapesFingerprint([currentTarget]) !== sourceFingerprint) {
      setNotice("The object changed while removing the edge feature; try again");
      return;
    }
    invalidateCadModifierSession();
    commitShapes(
      shapesRef.current.map((shape) => shape.id === selectedShape.id ? restored.shape : shape),
      restored.shape.id,
      `Removed ${restored.label}`,
    );
    setNotice(`Removed ${restored.label}`);
  }, [commitShapes, invalidateCadModifierSession, selectedEdgeFeatureCount, selectedEdgeHistoryOptions, selectedShape]);

  const commitSketchProfile = useCallback(
    (next: SketchProfile, message?: string, docOverride?: SketchDoc | null) => {
      const snapshot = cloneSketchProfile(next);
      const current = sketchHistoryRef.current;
      const currentIndex = Math.min(sketchHistoryIndexRef.current, Math.max(0, current.length - 1));
      const trimmed = current.slice(0, currentIndex + 1);
      const latest = trimmed.at(-1);
      setSketchProfile(snapshot);
      // Fold the profile back into the live doc rather than rebuilding from it: the profile cannot
      // express construction or projected geometry or analytic curves, so rebuilding destroyed all
      // of it. Host face linkage, constraints and settings ride along on the doc.
      const baseDoc = docOverride ?? mergeProfileIntoDoc(sketchDoc, snapshot);
      const solved = solveSketchDoc(baseDoc);
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      // If solver moved points, keep profile in sync
      const solvedProfile = sketchDocToProfile(solved.doc);
      if (JSON.stringify(solvedProfile.points) !== JSON.stringify(snapshot.points)) {
        setSketchProfile({ ...snapshot, points: solvedProfile.points, segments: solvedProfile.segments });
      }
      if (latest && JSON.stringify(latest) === JSON.stringify(snapshot)) {
        if (message) setNotice(message);
        return;
      }
      const nextHistory = [...trimmed, cloneSketchProfile(snapshot)].slice(-MAX_SKETCH_HISTORY_ENTRIES);
      sketchHistoryRef.current = nextHistory;
      sketchHistoryIndexRef.current = nextHistory.length - 1;
      setSketchHistory(nextHistory);
      setSketchHistoryIndex(sketchHistoryIndexRef.current);
      if (message) setNotice(message);
    },
    // The whole doc is the merge base now, so a stale closure would silently revert entities.
    [sketchDoc],
  );

  const beginSketch = useCallback((profile?: SketchProfile, editingId: string | null = null, plane?: SketchPlane | null, existingDoc?: SketchDoc | null) => {
    captureProjectPreviewFrame();
    let resolvedPlane = resolveSketchPlane(
      plane
        ?? profile?.sketchPlane
        ?? existingDoc?.plane
        ?? (editingId ? shapesRef.current.find((shape) => shape.id === editingId)?.sketchPlane : null),
    );
    const initial = cloneSketchProfile(profile ?? emptySketchProfile());
    let faceLoops = initial.faceReferenceLoops ?? [];

    // Bind the sketch to the picked host face: recenter UV on that face and show its outline.
    if (resolvedPlane.hostShapeId && faceLoops.length === 0) {
      const host = shapesRef.current.find((shape) => shape.id === resolvedPlane.hostShapeId);
      if (host) {
        const classified = classifySketchFaceHit(host, resolvedPlane.origin, resolvedPlane.normal);
        if (classified.kind === "planar" && classified.analytic?.type === "disc-cap") {
          resolvedPlane = classified.plane ?? resolvedPlane;
          faceLoops = [discCapFaceLoop(classified.analytic.radius)];
        } else if (
          (classified.kind === "cylindrical" || resolvedPlane.surface?.kind === "cylinder")
          && (classified.analytic?.type === "barrel" || resolvedPlane.surface)
        ) {
          const surface = classified.analytic?.type === "barrel"
            ? classified.analytic.surface
            : resolvedPlane.surface!;
          resolvedPlane = classified.plane
            ? cloneSketchPlane(classified.plane)
            : { ...resolvedPlane, surface };
          faceLoops = [barrelFaceLoop(surface.radius, surface.height)];
        } else {
          try {
            const prepared = prepareFaceSketchReference(
              resolvedPlane,
              worldTrianglesForHostShape(host),
            );
            resolvedPlane = prepared.plane;
            faceLoops = prepared.loops;
          } catch {
            // Keep the raw hit plane if mesh projection fails.
          }
        }
      }
    }

    initial.sketchPlane = cloneSketchPlane(resolvedPlane);
    initial.faceReferenceLoops = faceLoops.map((loop) => loop.map((point) => ({ ...point })));
    const shape = editingId ? shapesRef.current.find((entry) => entry.id === editingId) : null;
    const doc = existingDoc
      ? cloneSketchDoc(existingDoc)
      : ensureSketchDocOnShape({
          sketchDoc: shape?.sketchDoc,
          sketchProfile: initial,
          sketchPlane: resolvedPlane,
          sketchId: shape?.sketchId,
        }) ?? sketchProfileToDoc(initial, shape?.sketchId);
    doc.plane = cloneSketchPlane(resolvedPlane);
    doc.faceReferenceLoops = initial.faceReferenceLoops;
    const solved = solveSketchDoc(doc);
    setSketchFacePickMode(false);
    setToolbarMode("sketch");
    setSketchActive(true);
    setSketchFocusMode("2d");
    setRevolvePrompt(null);
    setPolygonSidesPrompt(null);
    setExtrudeHeightPrompt(null);
    setSketchTool(profile?.segments.length || solved.doc.entities.length ? "select" : "line");
    setSketchProfile(initial);
    setSketchDoc(solved.doc);
    setSketchSolveStatus(solved.status);
    setSketchDof(solved.dof);
    setSketchConflicts(solved.conflicts);
    const initialHistory = [cloneSketchProfile(initial)];
    sketchHistoryRef.current = initialHistory;
    sketchHistoryIndexRef.current = 0;
    setSketchHistory(initialHistory);
    setSketchHistoryIndex(0);
    setSketchActivePointId(null);
    setSketchSelection(null);
    setSketchMeasureStart(null);
    setSketchMeasurement(null);
    setEditingSketchShapeId(editingId);
    const hostName = resolvedPlane.hostShapeId
      ? shapesRef.current.find((shapeEntry) => shapeEntry.id === resolvedPlane.hostShapeId)?.name
      : null;
    const barrel = resolvedPlane.surface?.kind === "cylinder";
    setNotice(
      editingId
        ? `Editing sketch — ${solved.status.replace("-", " ")}${solved.dof ? ` (${solved.dof} DOF)` : ""}`
        : hostName
          ? barrel
            ? `Unwrapped ${hostName}: up/down = height, left/right = around — Hole cuts through, Solid joins outward`
            : `Sketching on ${hostName} — Extrude as Hole (cut) or Solid (join)`
          : "Sketch started: place the first point",
    );
  }, [captureProjectPreviewFrame]);

  const beginEditSelectedSketch = useCallback(() => {
    const selected = selectedShape;
    const feature = activeFeatureId && selected?.groupedShapes
      ? selected.groupedShapes.find((child) => child.id === activeFeatureId) ?? null
      : null;
    const shape = resolveEditableSketchShape(feature ?? selected, {
      preferredId: activeFeatureId,
      preferFaceFeatures: !activeFeatureId,
    });
    if (!shape || !shapeHasEditableSketch(shape)) {
      setNotice("Select a body with a sketch feature, or Alt-click a feature then Edit sketch");
      return;
    }
    const session = beginEditSketchSession(shape, "2d");
    if (!session?.doc) {
      setNotice("That shape has no editable sketch");
      return;
    }
    const profile = shape.sketchProfile ?? sketchDocToProfile(session.doc);
    beginSketch(profile, shape.id, shape.sketchPlane ?? session.doc.plane, session.doc);
  }, [activeFeatureId, beginSketch, selectedShape]);

  /** Edit a driving sketch dimension from the inspector without entering sketch mode (Fusion-like). */
  const editSelectedSketchDimension = useCallback((dimensionId: string, value: number) => {
    void (async () => {
      const selected = selectedShape;
      const feature = activeFeatureId && selected?.groupedShapes
        ? selected.groupedShapes.find((child) => child.id === activeFeatureId) ?? null
        : null;
      const shape = resolveEditableSketchShape(feature ?? selected);
      if (!shape?.sketchDoc || !shape.sketchProfile) {
        setNotice("Select a sketched solid with dimensions");
        return;
      }
      const solved = setDrivingDimensionValue(shape.sketchDoc, dimensionId, value);
      const profile = sketchDocToProfile(solved.doc);
      profile.sketchPlane = shape.sketchPlane ?? profile.sketchPlane;
      const rebuilt = shapeFromSketchProfile(profile, shape.height, {
        ...shape,
        sketchDoc: solved.doc,
        sketchId: shape.sketchId ?? solved.doc.id,
      }, {
        cutIntoFace: Boolean(shape.hole && isFaceHostedSketch(shape.sketchPlane, shape.sketchProfile?.faceReferenceLoops)),
      });
      if (!rebuilt) {
        setNotice("Could not rebuild sketch after dimension change");
        return;
      }
      rebuilt.sketchDoc = solved.doc;
      rebuilt.hole = shape.hole;
      rebuilt.color = shape.color;
      const owner = findCsgBodyOwningLeaf(shapesRef.current, shape.id);
      if (owner) {
        const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
        const sourceProjectId = projectInfoRef.current.projectId;
        const remeshGen = remeshGenerationRef.current + 1;
        remeshGenerationRef.current = remeshGen;
        const { body, remeshed } = await updateCsgLeafAndRemesh(owner, shape.id, rebuilt);
        if (remeshGen !== remeshGenerationRef.current) return;
        if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(shapesRef.current) !== sourceFingerprint) {
          setNotice("The scene changed while remeshing; try the dimension edit again");
          return;
        }
        commitShapes(
          shapesRef.current.map((entry) => (entry.id === owner.id ? body : entry)),
          body.id,
          `Sketch dimension → ${value.toFixed(2)} mm`,
        );
        scheduleSketchBrepBake(rebuilt);
        if (body.importedMesh && !body.importedMesh.brepStep) scheduleCsgBrepBake(body);
        if (remeshed && body.edgeTreatments?.length) {
          await reapplyEdgeTreatmentsRef.current(body);
        }
        if (!remeshed) {
          setNotice("Could not remesh after dimension change — last good mesh kept. Ungroup then Group to retry.");
        }
        return;
      }
      commitShapes(
        shapesRef.current.map((entry) => (entry.id === shape.id ? rebuilt : entry)),
        rebuilt.id,
        `Sketch dimension → ${value.toFixed(2)} mm`,
      );
      scheduleSketchBrepBake(rebuilt);
    })();
  }, [activeFeatureId, commitShapes, scheduleCsgBrepBake, scheduleSketchBrepBake, selectedShape]);

  const suppressSelectedFeature = useCallback((featureId: string, suppressed: boolean) => {
    void (async () => {
      const body = selectedShape;
      if (!body?.groupedShapes?.length) return;
      const dirty = setCsgChildSuppressed(body, featureId, suppressed);
      const remeshGen = remeshGenerationRef.current + 1;
      remeshGenerationRef.current = remeshGen;
      const remeshed = await remeshCsgGroup(dirty);
      if (remeshGen !== remeshGenerationRef.current) return;
      const next = remeshed ?? {
        ...dirty,
        importedMesh: body.importedMesh,
        csg: { ...(dirty.csg ?? { op: inferCsgOp(dirty) ?? "union", version: 1 }), dirty: true },
      };
      commitShapes(
        shapesRef.current.map((entry) => (entry.id === body.id ? next : entry)),
        body.id,
        suppressed ? `Feature off — body rebuilt` : `Feature on — body rebuilt`,
      );
      if (!remeshed) {
        setNotice("Could not rebuild body after toggling feature — last good mesh kept. Ungroup then Group to retry.");
      } else if (next.edgeTreatments?.length) {
        await reapplyEdgeTreatmentsRef.current(next);
      }
    })();
  }, [commitShapes, selectedShape]);

  const reorderSelectedFeature = useCallback((featureId: string, direction: "up" | "down") => {
    const body = selectedShape;
    if (!body?.groupedShapes?.length) return;
    const next = reorderCsgChild(body, featureId, direction);
    if (next === body) return;
    // Every child of a node feeds one op, so the evaluated solid is the same whatever the order.
    // Rebuilding would only spend the wait and risk an exact body returning faceted.
    commitShapes(
      shapesRef.current.map((entry) => (entry.id === body.id ? next : entry)),
      body.id,
      `Reordered feature ${direction}`,
    );
  }, [commitShapes, selectedShape]);

  const updateSelectedFeature = useCallback((featureId: string, patch: ShapeUpdatePatch) => {
    const body = shapesRef.current.find((entry) => entry.id === selectedShape?.id) ?? selectedShape;
    if (!body?.groupedShapes?.length) return;
    const child = body.groupedShapes.find((entry) => entry.id === featureId);
    if (!child) return;
    if (child.locked && !("locked" in patch)) {
      setNotice(`“${child.name}” is locked`);
      return;
    }
    const cleanedPatch = cleanShapePatch(patch);
    const nextChild = canonicalizeShape(
      "hole" in cleanedPatch
        ? withHoleMode({ ...child, ...cleanedPatch }, Boolean(cleanedPatch.hole), cleanedPatch.color)
        : { ...child, ...cleanedPatch },
    );
    const dirty = bumpCsgVersion({
      ...body,
      groupedShapes: body.groupedShapes.map((entry) => (entry.id === featureId ? nextChild : entry)),
    });
    const message = `Edited ${nextChild.name || nextChild.kind}`;
    const op = dirty.csg?.op ?? inferCsgOp(dirty);

    // Apply child params immediately so inspector + assemble previews stay in sync with the slider.
    const applyDirty = (current: WorkplaneShape[]) =>
      current.map((entry) => (entry.id === body.id ? dirty : entry));
    if (projectInteractionActiveRef.current) {
      setShapes((current) => {
        const next = applyDirty(current);
        shapesRef.current = next;
        interactionHistoryChangedRef.current = true;
        return next;
      });
    } else {
      const next = applyDirty(shapesRef.current);
      shapesRef.current = next;
      setShapes(next);
    }

    if (op === "assemble") {
      // Viewport already draws live children for assemble — no boolean remesh.
      const next = markCsgClean({
        ...dirty,
        importedMesh: undefined,
        csg: {
          op: "assemble",
          version: (dirty.csg?.version ?? 0) + 1,
          suppressed: dirty.csg?.suppressed,
        },
      });
      if (projectInteractionActiveRef.current) {
        setShapes((current) => {
          const mapped = current.map((entry) => (entry.id === body.id ? next : entry));
          shapesRef.current = mapped;
          interactionHistoryChangedRef.current = true;
          return mapped;
        });
      } else {
        commitShapes(
          shapesRef.current.map((entry) => (entry.id === body.id ? next : entry)),
          body.id,
          message,
        );
      }
      return;
    }

    pendingFeatureRemeshRef.current = { bodyId: body.id, message };
    if (featureRemeshTimerRef.current !== null) {
      window.clearTimeout(featureRemeshTimerRef.current);
    }
    const delay = projectInteractionActiveRef.current ? 50 : 0;
    featureRemeshTimerRef.current = window.setTimeout(() => {
      featureRemeshTimerRef.current = null;
      void flushPendingFeatureRemesh({ skipOcct: projectInteractionActiveRef.current });
    }, delay);
  }, [commitShapes, flushPendingFeatureRemesh, selectedShape]);

  // Clear in-body feature focus when the top-level selection changes.
  useEffect(() => {
    setActiveFeatureId(null);
  }, [selectedIds.join("|")]);

  const beginSketchFacePick = useCallback(() => {
    setAlignMode(false);
    setMirrorMode(false);
    setCircularPattern(null);
    invalidateCadModifierSession();
    setSketchFacePickMode(true);
    setToolbarMode("geometry");
    setSketchActive(false);
    setEditingSketchShapeId(null);
    setNotice("Click a face to sketch on, or click the workplane");
  }, [invalidateCadModifierSession]);

  const cancelSketchFacePick = useCallback(() => {
    setSketchFacePickMode(false);
    setNotice("Sketch cancelled");
  }, []);

  const cancelSketch = useCallback(() => {
    setSketchActive(false);
    setSketchFacePickMode(false);
    setSketchActivePointId(null);
    setSketchSelection(null);
    setSketchMeasureStart(null);
    setSketchMeasurement(null);
    setEditingSketchShapeId(null);
    setRevolvePrompt(null);
    setPolygonSidesPrompt(null);
    setExtrudeHeightPrompt(null);
    setNotice("Sketch cancelled");
  }, []);

  const sketchUndo = useCallback(() => {
    const currentHistory = sketchHistoryRef.current;
    const currentIndex = sketchHistoryIndexRef.current;
    if (currentIndex <= 0) {
      setNotice("Nothing to undo in this sketch");
      return;
    }
    const nextIndex = currentIndex - 1;
    sketchHistoryIndexRef.current = nextIndex;
    setSketchHistoryIndex(nextIndex);
    const restored = cloneSketchProfile(currentHistory[nextIndex] ?? emptySketchProfile());
    // History entries may omit plane — keep the active host link.
    if (!restored.sketchPlane?.hostShapeId && sketchDoc.plane.hostShapeId) {
      restored.sketchPlane = mergeSketchPlanes(restored.sketchPlane, sketchDoc.plane);
    }
    if (!restored.faceReferenceLoops?.length && sketchDoc.faceReferenceLoops?.length) {
      restored.faceReferenceLoops = sketchDoc.faceReferenceLoops.map((loop) => loop.map((point) => ({ ...point })));
    }
    setSketchProfile(restored);
    // Merge rather than rebuild: sketch history stores profiles, which carry no construction or
    // projected geometry and no analytic curves, so rebuilding would drop them on every undo.
    setSketchDoc((doc) => mergeProfileIntoDoc(doc, restored));
    setSketchActivePointId(null);
    setSketchSelection(null);
    setNotice("Sketch undo");
  }, [sketchDoc.faceReferenceLoops, sketchDoc.plane]);

  const sketchRedo = useCallback(() => {
    const currentHistory = sketchHistoryRef.current;
    const currentIndex = sketchHistoryIndexRef.current;
    if (currentIndex >= currentHistory.length - 1) {
      setNotice("Nothing to redo in this sketch");
      return;
    }
    const nextIndex = currentIndex + 1;
    sketchHistoryIndexRef.current = nextIndex;
    setSketchHistoryIndex(nextIndex);
    const restored = cloneSketchProfile(currentHistory[nextIndex] ?? emptySketchProfile());
    if (!restored.sketchPlane?.hostShapeId && sketchDoc.plane.hostShapeId) {
      restored.sketchPlane = mergeSketchPlanes(restored.sketchPlane, sketchDoc.plane);
    }
    if (!restored.faceReferenceLoops?.length && sketchDoc.faceReferenceLoops?.length) {
      restored.faceReferenceLoops = sketchDoc.faceReferenceLoops.map((loop) => loop.map((point) => ({ ...point })));
    }
    setSketchProfile(restored);
    setSketchDoc((doc) => mergeProfileIntoDoc(doc, restored));
    setSketchActivePointId(null);
    setSketchSelection(null);
    setNotice("Sketch redo");
  }, [sketchDoc.faceReferenceLoops, sketchDoc.plane]);

  const setActiveSketchTool = useCallback((tool: SketchTool) => {
    setSketchTool(tool);
    setSketchActivePointId(null);
    setSketchSelection(null);
    if (tool !== "measure") setSketchMeasureStart(null);
    if (tool === "polygon") {
      setPolygonSidesPrompt(sketchPolygonSides);
    } else {
      setPolygonSidesPrompt(null);
    }
    const messages: Record<SketchTool, string> = {
      line: "Line: click points to draw straight segments",
      bezier: "Bézier: click and drag points to pull curve handles",
      smooth: "Smooth curve: click points to build a flowing path",
      circle: "Circle: click the center, then drag to set the radius",
      ellipse: "Ellipse: click a corner, then drag the opposite corner",
      square: "Square: click a corner, then drag to size",
      rectangle: "Rectangle: click a corner, then drag the opposite corner",
      roundRect: "Rounded rectangle: click a corner, then drag to size",
      slot: "Slot: click a corner, then drag to size the capsule",
      triangle: "Triangle: click the center, then drag to a vertex",
      polygon: "Polygon: choose how many sides, then click the center and drag",
      star: "Star: click the center, then drag to a tip",
      arc: "Arc: click start, end, then a point the arc should pass through",
      offset: "Offset: click a line segment, then drag to set the offset distance",
      select: "Select: edit sketch geometry, pick blue profiles, or edit dimensions",
      refine: "Refine: click a segment to add a point, or a point to remove it",
      erase: "Erase: drag over points and lines to remove them",
      measure: "Measure: choose two points",
      dimension: "Dimension: select a line segment to add a driving length",
      trim: "Trim: select a segment to remove it",
      fillet: "Fillet: select a corner point to round",
      chamfer: "Chamfer: select a corner point to cut",
      mirror: "Mirror: select geometry, then a straight axis line",
      pattern: "Pattern: select geometry, then confirm spacing",
      "constrain-h": "Horizontal: select a line",
      "constrain-v": "Vertical: select a line",
      "constrain-equal": "Equal: select two lines",
      "constrain-parallel": "Parallel: select two lines",
      "constrain-perp": "Perpendicular: select two lines",
      "constrain-tangent": "Tangent: select a line and a circle center point",
      "constrain-symmetry": "Symmetry: select two points (or lines), then the axis line",
    };
    setNotice(messages[tool]);
  }, [sketchPolygonSides]);

  // Apply Fusion-like constraint / modify / dimension tools when the user picks entities.
  useEffect(() => {
    if (!sketchActive || !sketchSelection) return;
    const segmentIds =
      sketchSelection.kind === "segment"
        ? [sketchSelection.id]
        : sketchSelection.kind === "multiple"
          ? sketchSelection.segmentIds
          : [];
    const pointIds =
      sketchSelection.kind === "point"
        ? [sketchSelection.id]
        : sketchSelection.kind === "multiple"
          ? sketchSelection.pointIds
          : [];

    if (sketchTool === "dimension") {
      if (segmentIds[0]) {
        const segment = sketchProfile.segments.find((entry) => entry.id === segmentIds[0]);
        const a = sketchProfile.points.find((point) => point.id === segment?.startId);
        const b = sketchProfile.points.find((point) => point.id === segment?.endId);
        if (!segment || !a || !b) return;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const solved = addLinearDimension(sketchDoc, { entityId: segment.id, value: length, driving: true });
        setSketchDoc(solved.doc);
        setSketchSolveStatus(solved.status);
        setSketchDof(solved.dof);
        setSketchConflicts(solved.conflicts);
        commitSketchProfile(sketchDocToProfile(solved.doc), `Driving dimension ${length.toFixed(2)} mm`, solved.doc);
        setSketchTool("select");
        setSketchSelection(null);
        return;
      }
      if (pointIds.length) {
        setNotice("Select a segment to add a dimension");
      }
      return;
    }

    if (sketchTool === "trim" && segmentIds[0]) {
      const nextDoc = trimEntity(sketchDoc, segmentIds[0]);
      const solved = solveSketchDoc(nextDoc);
      setSketchDoc(solved.doc);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Segment trimmed", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }

    if ((sketchTool === "fillet" || sketchTool === "chamfer") && pointIds[0]) {
      setValueDialog({ kind: sketchTool === "fillet" ? "sketch-fillet" : "sketch-chamfer", pointId: pointIds[0] });
      return;
    }

    if (sketchTool === "constrain-h" && segmentIds[0]) {
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "horizontal", entityIds: [segmentIds[0]] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Horizontal constraint", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    if (sketchTool === "constrain-v" && segmentIds[0]) {
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "vertical", entityIds: [segmentIds[0]] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Vertical constraint", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    if ((sketchTool === "constrain-equal" || sketchTool === "constrain-parallel" || sketchTool === "constrain-perp") && segmentIds.length >= 2) {
      const kind = sketchTool === "constrain-equal" ? "equal" : sketchTool === "constrain-parallel" ? "parallel" : "perpendicular";
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind, entityIds: [segmentIds[0], segmentIds[1]] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), `${kind} constraint`, solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }

    if (sketchTool === "constrain-tangent" && segmentIds[0] && pointIds[0]) {
      const circle = sketchDoc.entities.find((entity) => entity.kind === "circle" && entity.centerId === pointIds[0]);
      if (!circle) {
        setNotice("Tangent: select a line segment and a circle's center point");
        return;
      }
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "tangent", entityIds: [segmentIds[0], circle.id] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Tangent constraint", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }

    if (sketchTool === "constrain-symmetry" && sketchSelection.kind === "multiple" && segmentIds.length >= 1) {
      const axisId = segmentIds[segmentIds.length - 1];
      if (pointIds.length >= 2) {
        const solved = solveSketchDoc(addConstraints(sketchDoc, [{
          kind: "symmetry",
          entityIds: [pointIds[0], pointIds[1], axisId],
          pointIds: [pointIds[0], pointIds[1]],
        }]));
        setSketchDoc(solved.doc);
        setSketchSolveStatus(solved.status);
        setSketchDof(solved.dof);
        setSketchConflicts(solved.conflicts);
        commitSketchProfile(sketchDocToProfile(solved.doc), "Symmetry constraint", solved.doc);
        setSketchTool("select");
        setSketchSelection(null);
        return;
      }
      const pairSegments = segmentIds.filter((id) => id !== axisId);
      if (pairSegments.length >= 2) {
        const solved = solveSketchDoc(addConstraints(sketchDoc, [{
          kind: "symmetry",
          entityIds: [pairSegments[0], pairSegments[1], axisId],
        }]));
        setSketchDoc(solved.doc);
        setSketchSolveStatus(solved.status);
        setSketchDof(solved.dof);
        setSketchConflicts(solved.conflicts);
        commitSketchProfile(sketchDocToProfile(solved.doc), "Symmetry constraint", solved.doc);
        setSketchTool("select");
        setSketchSelection(null);
        return;
      }
    }

    if (sketchTool === "mirror" && sketchSelection.kind === "multiple" && segmentIds.length >= 1) {
      const axisId = segmentIds[segmentIds.length - 1];
      const entityIds = [...sketchSelection.pointIds, ...sketchSelection.segmentIds.filter((id) => id !== axisId)];
      if (!entityIds.length) return;
      const nextDoc = mirrorEntities(sketchDoc, entityIds, axisId);
      const solved = solveSketchDoc(nextDoc);
      setSketchDoc(solved.doc);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Mirrored selection", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }

    if (sketchTool === "pattern" && (segmentIds.length || pointIds.length)) {
      const entityIds = sketchSelection.kind === "multiple"
        ? [...sketchSelection.pointIds, ...sketchSelection.segmentIds]
        : sketchSelection.kind === "segment"
          ? [sketchSelection.id]
          : sketchSelection.kind === "point"
            ? [sketchSelection.id]
            : [];
      setValueDialog({ kind: "sketch-pattern", entityIds });
    }
  }, [commitSketchProfile, sketchActive, sketchDoc, sketchProfile, sketchSelection, sketchTool]);

  const confirmSketchFilletChamferDialog = useCallback((values: Record<string, string>) => {
    if (!valueDialog || (valueDialog.kind !== "sketch-fillet" && valueDialog.kind !== "sketch-chamfer")) return;
    const { kind: dialogKind, pointId } = valueDialog;
    setValueDialog(null);
    const amount = Number.parseFloat(values.amount ?? "");
    if (!Number.isFinite(amount) || amount <= 0) return;
    const nextProfile = dialogKind === "sketch-fillet"
      ? filletCorner(sketchProfile, pointId, amount)
      : chamferCorner(sketchProfile, pointId, amount);
    if (!nextProfile) {
      setNotice("Pick a corner where exactly two segments meet");
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    commitSketchProfile(nextProfile, dialogKind === "sketch-fillet" ? "Corner filleted" : "Corner chamfered");
    setSketchTool("select");
    setSketchSelection(null);
  }, [commitSketchProfile, sketchProfile, valueDialog]);

  const confirmSketchPatternDialog = useCallback((values: Record<string, string>) => {
    if (!valueDialog || valueDialog.kind !== "sketch-pattern") return;
    const { entityIds } = valueDialog;
    setValueDialog(null);
    const countX = Math.max(1, Number.parseInt(values.countX ?? "3", 10) || 3);
    const countZ = Math.max(1, Number.parseInt(values.countZ ?? "1", 10) || 1);
    const spacingX = Number.parseFloat(values.spacingX ?? "10") || 10;
    const spacingZ = Number.parseFloat(values.spacingZ ?? "10") || 10;
    const nextDoc = rectangularPattern(sketchDoc, entityIds, countX, countZ, spacingX, spacingZ);
    const solved = solveSketchDoc(nextDoc);
    setSketchDoc(solved.doc);
    commitSketchProfile(sketchDocToProfile(solved.doc), "Rectangular pattern created", solved.doc);
    setSketchTool("select");
    setSketchSelection(null);
  }, [commitSketchProfile, sketchDoc, valueDialog]);

  const cancelValueDialog = useCallback(() => {
    setValueDialog(null);
  }, []);

  const setSketchPolygonSideCount = useCallback((sides: number) => {
    const next = Math.max(MIN_SKETCH_POLYGON_SIDES, Math.min(MAX_SKETCH_POLYGON_SIDES, Math.round(sides)));
    setSketchPolygonSides(next);
    setPolygonSidesPrompt((current) => (current === null ? null : next));
    if (sketchTool === "polygon") {
      setNotice(`Polygon: click the center, then drag (${next} sides)`);
    }
  }, [sketchTool]);

  const confirmPolygonSidesPrompt = useCallback(() => {
    if (polygonSidesPrompt === null) return;
    const next = Math.max(MIN_SKETCH_POLYGON_SIDES, Math.min(MAX_SKETCH_POLYGON_SIDES, Math.round(polygonSidesPrompt)));
    setSketchPolygonSides(next);
    setPolygonSidesPrompt(null);
    setSketchTool("polygon");
    setNotice(`Polygon: click the center, then drag (${next} sides)`);
  }, [polygonSidesPrompt]);

  const cancelPolygonSidesPrompt = useCallback(() => {
    setPolygonSidesPrompt(null);
    if (sketchTool === "polygon") {
      setNotice(`Polygon: click the center, then drag (${sketchPolygonSides} sides)`);
    }
  }, [sketchPolygonSides, sketchTool]);

  const measureSketchPoint = useCallback(
    (point: SketchPoint) => {
      if (!sketchMeasureStart) {
        setSketchMeasureStart({ ...point });
        setSketchMeasurement(null);
        setNotice("Choose the second measurement point");
        return;
      }
      const measurement = { start: { ...sketchMeasureStart }, end: { ...point } };
      setSketchMeasurement(measurement);
      setSketchMeasureStart(null);
      setNotice(`Measured ${Number(Math.hypot(measurement.end.x - measurement.start.x, measurement.end.z - measurement.start.z).toFixed(2))} mm`);
    },
    [sketchMeasureStart],
  );

  const clearSketchMeasurement = useCallback(() => {
    setSketchMeasureStart(null);
    setSketchMeasurement(null);
    setNotice("Sketch measurement removed");
  }, []);

  const connectSketchPoint = useCallback(
    (pointId: string, profile = sketchProfile) => {
      if (!["line", "bezier", "smooth"].includes(sketchTool)) return profile;
      const curveKind = sketchTool as NonNullable<SketchSegment["kind"]>;
      if (!sketchActivePointId) {
        setSketchActivePointId(pointId);
        setSketchSelection({ kind: "point", id: pointId });
        return profile;
      }
      if (sketchActivePointId === pointId) return profile;
      const duplicate = profile.segments.some(
        (segment) =>
          (segment.startId === sketchActivePointId && segment.endId === pointId) ||
          (segment.startId === pointId && segment.endId === sketchActivePointId),
      );
      const next = duplicate
        ? profile
        : {
            ...profile,
            segments: [...profile.segments, { id: createLocalId("sketch-segment"), startId: sketchActivePointId, endId: pointId, kind: curveKind }],
          };
      const smoothed = sketchTool === "smooth" ? withSmoothSketchHandles(next) : next;
      const closed = orderedSketchPaths(smoothed).some((path) => path.closed && path.steps.some((step) => step.segment.startId === sketchActivePointId || step.segment.endId === sketchActivePointId));
      if (!duplicate) commitSketchProfile(smoothed, closed ? "Profile closed—edit the path or finish the sketch" : "Sketch segment added");
      setSketchActivePointId(closed ? null : pointId);
      setSketchSelection({ kind: "point", id: pointId });
      if (closed) setSketchTool("select");
      return smoothed;
    },
    [commitSketchProfile, sketchActivePointId, sketchProfile, sketchTool],
  );

  const appendSketchGeometry = useCallback(
    (geometry: Pick<SketchProfile, "points" | "segments"> | null, emptyMessage: string, successMessage: string, selectAfter = true) => {
      if (!geometry) {
        setNotice(emptyMessage);
        return;
      }
      const next: SketchProfile = {
        ...sketchProfile,
        points: [...sketchProfile.points, ...geometry.points],
        segments: [...sketchProfile.segments, ...geometry.segments],
      };
      commitSketchProfile(next, successMessage);
      setSketchActivePointId(null);
      setSketchSelection(null);
      if (selectAfter) {
        setSketchTool("select");
      }
      setNotice(successMessage);
    },
    [commitSketchProfile, sketchProfile],
  );

  const addSketchCircle = useCallback(
    (center: { x: number; z: number }, radius: number) => {
      appendSketchGeometry(circleSketchGeometry(center, radius), "Circle radius is too small", "Circle closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchEllipse = useCallback(
    (origin: { x: number; z: number }, corner: { x: number; z: number }) => {
      appendSketchGeometry(ellipseSketchGeometry(origin, corner), "Ellipse is too small", "Ellipse closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchSquare = useCallback(
    (origin: { x: number; z: number }, corner: { x: number; z: number }) => {
      appendSketchGeometry(squareSketchGeometry(origin, corner), "Square is too small", "Square closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchRectangle = useCallback(
    (origin: { x: number; z: number }, corner: { x: number; z: number }) => {
      appendSketchGeometry(rectangleSketchGeometry(origin, corner), "Rectangle is too small", "Rectangle closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchRoundRect = useCallback(
    (origin: { x: number; z: number }, corner: { x: number; z: number }) => {
      appendSketchGeometry(roundedRectangleSketchGeometry(origin, corner), "Rounded rectangle is too small", "Rounded rectangle closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchSlot = useCallback(
    (origin: { x: number; z: number }, corner: { x: number; z: number }) => {
      appendSketchGeometry(slotSketchGeometry(origin, corner), "Slot is too small", "Slot closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchTriangle = useCallback(
    (center: { x: number; z: number }, vertex: { x: number; z: number }) => {
      appendSketchGeometry(regularPolygonSketchGeometry(center, vertex, 3), "Triangle is too small", "Triangle closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchPolygon = useCallback(
    (center: { x: number; z: number }, vertex: { x: number; z: number }) => {
      appendSketchGeometry(
        regularPolygonSketchGeometry(center, vertex, sketchPolygonSides),
        "Polygon is too small",
        `${sketchPolygonSides}-sided polygon closed—edit the path or finish the sketch`,
      );
    },
    [appendSketchGeometry, sketchPolygonSides],
  );

  const addSketchStar = useCallback(
    (center: { x: number; z: number }, tip: { x: number; z: number }) => {
      appendSketchGeometry(starSketchGeometry(center, tip), "Star is too small", "Star closed—edit the path or finish the sketch");
    },
    [appendSketchGeometry],
  );

  const addSketchArc = useCallback(
    (start: { x: number; z: number }, end: { x: number; z: number }, through: { x: number; z: number }) => {
      appendSketchGeometry(arcSketchGeometry(start, end, through), "Could not fit an arc through those points", "Arc added", false);
    },
    [appendSketchGeometry],
  );

  const addSketchOffsetLine = useCallback(
    (segmentId: string, toward: { x: number; z: number }) => {
      const segment = sketchProfile.segments.find((entry) => entry.id === segmentId);
      const start = segment ? sketchProfile.points.find((point) => point.id === segment.startId) : null;
      const end = segment ? sketchProfile.points.find((point) => point.id === segment.endId) : null;
      if (!segment || !start || !end || segment.kind === "bezier" || segment.kind === "smooth") {
        setNotice("Offset works on straight line segments");
        return;
      }
      appendSketchGeometry(offsetLineSketchGeometry(start, end, toward), "Offset distance is too small", "Offset line added", false);
    },
    [appendSketchGeometry, sketchProfile.points, sketchProfile.segments],
  );

  const addSketchPlanePoint = useCallback(
    (position: { x: number; z: number }, handles?: { handleIn: { x: number; z: number }; handleOut: { x: number; z: number } }) => {
      if (sketchTool === "measure") {
        measureSketchPoint({ id: "measure", ...position });
        return;
      }
      if (!["line", "bezier", "smooth"].includes(sketchTool)) return;
      const curveKind = sketchTool as NonNullable<SketchSegment["kind"]>;
      const existing = sketchProfile.points.find((point) => Math.hypot(point.x - position.x, point.z - position.z) < 0.0001);
      if (existing) {
        connectSketchPoint(existing.id);
        return;
      }
      const point: SketchPoint = {
        id: createLocalId("sketch-point"),
        ...position,
        ...(handles ?? {}),
        mode: sketchTool === "line" ? "corner" : sketchTool === "smooth" ? "smooth" : handles ? "smooth" : "corner",
      };
      const segmentId = sketchActivePointId ? createLocalId("sketch-segment") : null;
      const next: SketchProfile = { ...sketchProfile, points: [...sketchProfile.points, point] };
      if (sketchActivePointId && segmentId) {
        next.segments = [...next.segments, { id: segmentId, startId: sketchActivePointId, endId: point.id, kind: curveKind }];
      }
      const prepared = sketchTool === "smooth" ? withSmoothSketchHandles(next) : next;
      // Persist snap inferences as real constraints (H/V/coincident/midpoint).
      let docOverride: SketchDoc | null = null;
      const snap = lastSketchSnap;
      if (snap?.inferredConstraints?.length) {
        const migrated = sketchProfileToDoc(prepared, sketchDoc.id, sketchDoc.plane);
        migrated.constraints = sketchDoc.constraints;
        migrated.dimensions = sketchDoc.dimensions;
        const inferred: Array<{ kind: "coincident" | "horizontal" | "vertical" | "midpoint"; entityIds: string[]; pointIds?: string[] }> = [];
        for (const inf of snap.inferredConstraints) {
          if (inf.kind === "coincident" && inf.pointIds?.[0]) {
            inferred.push({ kind: "coincident", entityIds: [], pointIds: [inf.pointIds[0], point.id] });
          } else if ((inf.kind === "horizontal" || inf.kind === "vertical") && segmentId) {
            inferred.push({ kind: inf.kind, entityIds: [segmentId] });
          } else if (inf.kind === "midpoint" && inf.entityIds?.[0]) {
            inferred.push({ kind: "midpoint", entityIds: [inf.entityIds[0]], pointIds: [point.id] });
          }
        }
        if (inferred.length) docOverride = addConstraints(migrated, inferred);
      }
      commitSketchProfile(
        prepared,
        sketchActivePointId ? "Sketch point and segment added" : "Sketch point added",
        docOverride,
      );
      setSketchActivePointId(point.id);
      setSketchSelection({ kind: "point", id: point.id });
    },
    [commitSketchProfile, connectSketchPoint, lastSketchSnap, measureSketchPoint, sketchActivePointId, sketchDoc, sketchProfile, sketchTool],
  );

  const pressSketchPoint = useCallback(
    (id: string) => {
      const point = sketchProfile.points.find((entry) => entry.id === id);
      if (!point) return;
      if (sketchTool === "measure") {
        measureSketchPoint(point);
        setSketchSelection({ kind: "point", id });
        return;
      }
      if (sketchTool === "select") {
        setSketchSelection({ kind: "point", id });
        setSketchActivePointId(null);
        return;
      }
      connectSketchPoint(id);
    },
    [connectSketchPoint, measureSketchPoint, sketchProfile.points, sketchTool],
  );

  const deleteSketchPoint = useCallback(
    (id: string) => {
      const connected = sketchProfile.segments.filter((segment) => segment.startId === id || segment.endId === id);
      const neighboringIds = connected.map((segment) => segment.startId === id ? segment.endId : segment.startId);
      const remainingSegments = sketchProfile.segments.filter((segment) => segment.startId !== id && segment.endId !== id);
      if (neighboringIds.length === 2 && neighboringIds[0] !== neighboringIds[1]) {
        const duplicate = remainingSegments.some((segment) =>
          (segment.startId === neighboringIds[0] && segment.endId === neighboringIds[1]) ||
          (segment.startId === neighboringIds[1] && segment.endId === neighboringIds[0]),
        );
        if (!duplicate) {
          remainingSegments.push({
            id: createLocalId("sketch-segment"),
            startId: neighboringIds[0],
            endId: neighboringIds[1],
            kind: connected.every((segment) => segment.kind === "line") ? "line" : connected.some((segment) => segment.kind === "smooth") ? "smooth" : "bezier",
          });
        }
      }
      const next = {
        ...sketchProfile,
        points: sketchProfile.points.filter((point) => point.id !== id),
        segments: remainingSegments,
      };
      commitSketchProfile(next.segments.some((segment) => segment.kind === "smooth") ? withSmoothSketchHandles(next) : next, "Sketch point removed");
      if (sketchActivePointId === id) setSketchActivePointId(null);
      setSketchSelection(null);
    },
    [commitSketchProfile, sketchActivePointId, sketchProfile],
  );

  const deleteSketchSegment = useCallback(
    (id: string) => {
      commitSketchProfile({ ...sketchProfile, segments: sketchProfile.segments.filter((segment) => segment.id !== id) }, "Sketch line removed");
      setSketchActivePointId(null);
      setSketchSelection(null);
    },
    [commitSketchProfile, sketchProfile],
  );

  const eraseSketchEntities = useCallback(
    (pointIds: string[], segmentIds: string[]) => {
      if (!pointIds.length && !segmentIds.length) return;
      const removedPoints = new Set(pointIds);
      const removedSegments = new Set(segmentIds);
      const nextSegments = sketchProfile.segments.filter(
        (segment) =>
          !removedSegments.has(segment.id)
          && !removedPoints.has(segment.startId)
          && !removedPoints.has(segment.endId),
      );
      const connectedPointIds = new Set<string>();
      for (const segment of nextSegments) {
        connectedPointIds.add(segment.startId);
        connectedPointIds.add(segment.endId);
      }
      const nextPoints = sketchProfile.points.filter((point) => {
        if (removedPoints.has(point.id)) return false;
        // Drop points that no longer belong to any remaining segment.
        if (!connectedPointIds.has(point.id) && sketchProfile.segments.some((segment) => segment.startId === point.id || segment.endId === point.id)) {
          return false;
        }
        return true;
      });
      const next: SketchProfile = {
        ...sketchProfile,
        points: nextPoints,
        segments: nextSegments,
      };
      const count = removedPoints.size + removedSegments.size;
      commitSketchProfile(
        next.segments.some((segment) => segment.kind === "smooth") ? withSmoothSketchHandles(next) : next,
        count === 1 ? "Erased sketch geometry" : `Erased ${count} sketch items`,
      );
      if (sketchActivePointId && removedPoints.has(sketchActivePointId)) setSketchActivePointId(null);
      setSketchSelection(null);
    },
    [commitSketchProfile, sketchActivePointId, sketchProfile],
  );

  const updateSketchImage = useCallback((id: string, patch: Partial<SketchImage>, message = "Sketch image updated") => {
    const image = (sketchProfile.images ?? []).find((entry) => entry.id === id);
    if (!image) return;
    commitSketchProfile({
      ...sketchProfile,
      images: (sketchProfile.images ?? []).map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
    }, message);
    setSketchSelection({ kind: "image", id });
    setSketchActivePointId(null);
  }, [commitSketchProfile, sketchProfile]);

  const deleteSketchImage = useCallback((id: string) => {
    if (!(sketchProfile.images ?? []).some((image) => image.id === id)) return;
    commitSketchProfile({
      ...sketchProfile,
      images: (sketchProfile.images ?? []).filter((image) => image.id !== id),
    }, "Sketch image removed");
    setSketchSelection(null);
  }, [commitSketchProfile, sketchProfile]);

  const addSketchImageFile = useCallback(async (file: File) => {
    if (!sketchActive || sketchTool !== "select") {
      setNotice("Choose Select before adding a sketch image");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setNotice("Choose a PNG, JPG, WebP, GIF, or other image file");
      return;
    }
    try {
      const prepared = await prepareImportedImage(file);
      const dimensions = imagePlateDimensions(prepared.pixelWidth, prepared.pixelHeight);
      const image: SketchImage = {
        id: createLocalId("sketch-image"),
        name: file.name.replace(/\.[^.]+$/, "") || "Sketch image",
        ...prepared,
        x: 0,
        z: 0,
        width: dimensions.width,
        depth: dimensions.depth,
        opacity: 0.55,
        lockAspect: true,
      };
      commitSketchProfile({ ...sketchProfile, images: [...(sketchProfile.images ?? []), image] }, `Added ${file.name} to the sketch`);
      setSketchSelection({ kind: "image", id: image.id });
      setSketchActivePointId(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The sketch image could not be added");
    }
  }, [commitSketchProfile, sketchActive, sketchProfile, sketchTool]);

  const deleteSelectedSketchEntity = useCallback(() => {
    if (!sketchSelection) {
      setNotice("Select a sketch point or segment to remove it");
      return;
    }
    if (sketchSelection.kind === "point") deleteSketchPoint(sketchSelection.id);
    else if (sketchSelection.kind === "segment") deleteSketchSegment(sketchSelection.id);
    else if (sketchSelection.kind === "image") deleteSketchImage(sketchSelection.id);
    else {
      const pointIds = new Set(sketchSelection.pointIds);
      const segmentIds = new Set(sketchSelection.segmentIds);
      const imageIds = new Set(sketchSelection.imageIds ?? []);
      commitSketchProfile({
        ...sketchProfile,
        points: sketchProfile.points.filter((point) => !pointIds.has(point.id)),
        segments: sketchProfile.segments.filter((segment) => !segmentIds.has(segment.id) && !pointIds.has(segment.startId) && !pointIds.has(segment.endId)),
        images: (sketchProfile.images ?? []).filter((image) => !imageIds.has(image.id)),
      }, "Selected sketch geometry removed");
      setSketchActivePointId(null);
      setSketchSelection(null);
    }
  }, [commitSketchProfile, deleteSketchImage, deleteSketchPoint, deleteSketchSegment, sketchProfile, sketchSelection]);

  const copySelectedSketch = useCallback(() => {
    const clipped = sketchClipboardFromSelection(sketchProfile, sketchSelection);
    if (!clipped) {
      setNotice("Select sketch points, lines, or images to copy");
      return;
    }
    setSketchClipboard(clipped);
    const count = clipped.points.length + clipped.segments.length + clipped.images.length;
    setNotice(`Copied ${count} sketch item${count === 1 ? "" : "s"}`);
  }, [sketchProfile, sketchSelection]);

  const cutSelectedSketch = useCallback(() => {
    const clipped = sketchClipboardFromSelection(sketchProfile, sketchSelection);
    if (!clipped) {
      setNotice("Select sketch points, lines, or images to cut");
      return;
    }
    setSketchClipboard(clipped);
    deleteSelectedSketchEntity();
    const count = clipped.points.length + clipped.segments.length + clipped.images.length;
    setNotice(`Cut ${count} sketch item${count === 1 ? "" : "s"}`);
  }, [deleteSelectedSketchEntity, sketchProfile, sketchSelection]);

  const pasteSelectedSketch = useCallback(() => {
    if (!sketchClipboard) {
      setNotice("Sketch clipboard is empty");
      return;
    }
    const { profile, selection } = pasteSketchClipboardIntoProfile(sketchProfile, sketchClipboard);
    commitSketchProfile(profile, "Sketch pasted");
    setSketchSelection(selection);
    setSketchActivePointId(selection?.kind === "point" ? selection.id : null);
    setSketchTool("select");
  }, [commitSketchProfile, sketchClipboard, sketchProfile]);

  const moveSketchPoint = useCallback((id: string, position: { x: number; z: number }) => {
    const current = sketchProfile.points.find((point) => point.id === id);
    if (!current) return;
    const deltaX = position.x - current.x;
    const deltaZ = position.z - current.z;
    const next = {
      ...sketchProfile,
      points: sketchProfile.points.map((point) => point.id === id ? {
        ...point,
        ...position,
        handleIn: point.handleIn ? { x: point.handleIn.x + deltaX, z: point.handleIn.z + deltaZ } : undefined,
        handleOut: point.handleOut ? { x: point.handleOut.x + deltaX, z: point.handleOut.z + deltaZ } : undefined,
      } : point),
    };
    commitSketchProfile(next, "Sketch point moved");
  }, [commitSketchProfile, sketchProfile]);

  const moveSketchHandle = useCallback((id: string, handle: "in" | "out", position: { x: number; z: number }) => {
    const next = cloneSketchProfile(sketchProfile);
    const point = next.points.find((entry) => entry.id === id);
    if (!point) return;
    if (handle === "in") point.handleIn = { ...position };
    else point.handleOut = { ...position };
    if (point.mode === "smooth") {
      const opposite = { x: point.x * 2 - position.x, z: point.z * 2 - position.z };
      if (handle === "in") point.handleOut = opposite;
      else point.handleIn = opposite;
    }
    commitSketchProfile(next, "Curve handle adjusted");
  }, [commitSketchProfile, sketchProfile]);

  const setSketchPointMode = useCallback((id: string, mode: "corner" | "smooth" | "split") => {
    let next = cloneSketchProfile(sketchProfile);
    const point = next.points.find((entry) => entry.id === id);
    if (!point) return;
    point.mode = mode;
    if (mode === "corner") {
      point.handleIn = undefined;
      point.handleOut = undefined;
      next.segments = next.segments.map((segment) => segment.startId === id || segment.endId === id ? { ...segment, kind: "line" } : segment);
    } else {
      next.segments = next.segments.map((segment) => segment.startId === id || segment.endId === id ? { ...segment, kind: "bezier" } : segment);
      if (!point.handleIn || !point.handleOut) next = withSmoothSketchHandles(next);
      const updated = next.points.find((entry) => entry.id === id);
      if (updated) updated.mode = mode;
    }
    commitSketchProfile(next, mode === "corner" ? "Made corner" : mode === "smooth" ? "Made smooth" : "Curve handles split");
  }, [commitSketchProfile, sketchProfile]);

  const insertSketchPoint = useCallback((segmentId: string, position: { x: number; z: number }) => {
    const segment = sketchProfile.segments.find((entry) => entry.id === segmentId);
    if (!segment) return;
    const point: SketchPoint = { id: createLocalId("sketch-point"), ...position, mode: segment.kind === "line" ? "corner" : "smooth" };
    let next: SketchProfile = {
      ...sketchProfile,
      points: [...sketchProfile.points, point],
      segments: sketchProfile.segments.flatMap((entry) => entry.id === segmentId ? [
        { ...entry, id: createLocalId("sketch-segment"), endId: point.id },
        { ...entry, id: createLocalId("sketch-segment"), startId: point.id },
      ] : [entry]),
    };
    if (segment.kind === "smooth") next = withSmoothSketchHandles(next);
    commitSketchProfile(next, "Point added to path");
    setSketchSelection({ kind: "point", id: point.id });
    setSketchTool("select");
  }, [commitSketchProfile, sketchProfile]);

  const exitSketchMode = useCallback(() => {
    setSketchActive(false);
    setEditingSketchShapeId(null);
    setRevolvePrompt(null);
    setPolygonSidesPrompt(null);
    setExtrudeHeightPrompt(null);
    setToolbarMode("geometry");
  }, []);

  const startSketchExtrude = useCallback(() => {
    setRevolvePrompt(null);
    const closedCount = orderedSketchPaths(sketchProfile).filter((path) => path.closed).length;
    if (closedCount === 0) {
      setNotice("Close at least one profile before extruding");
      return;
    }
    const existing = editingSketchShapeId ? shapes.find((shape) => shape.id === editingSketchShapeId) ?? null : null;
    const plane = mergeSketchPlanes(sketchProfile.sketchPlane, sketchDoc.plane);
    const faceSketch = isFaceHostedSketch(plane, sketchProfile.faceReferenceLoops ?? sketchDoc.faceReferenceLoops);
    const barrel = isCylinderSketchPlane(plane);
    const host = plane.hostShapeId
      ? shapes.find((shape) => shape.id === plane.hostShapeId && !shape.hole && !shape.hidden)
      : null;
    // Face holes default to through-all so the cutter fully punches the 3D part.
    // Barrel holes punch through the diameter (radial), not along a single planar normal.
    const throughDepth = barrel
      ? barrelThroughDepthMm(plane.surface)
      : host
        ? shapeThicknessInwardFromFace(host, plane.origin, plane.normal)
        : null;
    const defaultHeight = existing?.sketchFinish === "revolve"
      ? 10
      : existing?.height
        ?? throughDepth
        ?? 10;
    setExtrudeAsHole(faceSketch || Boolean(existing?.hole));
    setExtrudeHeightPrompt(Math.max(0.5, Number(defaultHeight.toFixed(2))));
    setNotice(faceSketch
      ? (barrel && throughDepth
        ? `Barrel sketch on ${host?.name ?? "cylinder"} — Hole cuts through (${throughDepth.toFixed(1)} mm), Solid joins outward`
        : throughDepth
          ? `Face sketch on ${host?.name ?? "part"} — Hole cuts through (${throughDepth.toFixed(1)} mm), Solid joins onto the face`
          : "Face sketch — Hole cuts into the part, Solid joins onto the face")
      : "Set extrude height, then create a solid or hole");
  }, [editingSketchShapeId, shapes, sketchDoc.faceReferenceLoops, sketchDoc.plane, sketchProfile]);

  const cancelExtrudeHeightPrompt = useCallback(() => {
    setExtrudeHeightPrompt(null);
    setExtrudeAsHole(false);
    setNotice("Extrude cancelled");
  }, []);

  const finishSketchExtrude = useCallback(async (heightMm?: number, asHole = extrudeAsHole) => {
    setRevolvePrompt(null);
    setExtrudeHeightPrompt(null);
    const existing = editingSketchShapeId
      ? findShapeInTree(shapesRef.current, editingSketchShapeId)
      : null;
    const mergedPlane = mergeSketchPlanes(sketchProfile.sketchPlane, sketchDoc.plane);
    const faceLoops = sketchProfile.faceReferenceLoops ?? sketchDoc.faceReferenceLoops;
    const faceSketch = isFaceHostedSketch(mergedPlane, faceLoops);
    const barrel = isCylinderSketchPlane(mergedPlane);
    const hostForDepth = mergedPlane.hostShapeId
      ? shapesRef.current.find((shape) => shape.id === mergedPlane.hostShapeId && !shape.hole && !shape.hidden)
      : null;
    const throughDepth = barrel
      ? barrelThroughDepthMm(mergedPlane.surface)
      : hostForDepth
        ? shapeThicknessInwardFromFace(hostForDepth, mergedPlane.origin, mergedPlane.normal)
        : null;
    const fallbackHeight = existing?.sketchFinish === "revolve"
      ? 10
      : existing?.height
        ?? throughDepth
        ?? 10;
    // Face holes that match the solid size must go fully through — otherwise coplanar
    // side walls leave the cutter sitting on the surface.
    let height = Math.max(0.5, heightMm ?? fallbackHeight);
    if (asHole && faceSketch && throughDepth) {
      // Face cuts are through-all: thickness measured from the sketch face, plus
      // overshoot past both skins so the hole isn't short/offset.
      // Barrel cuts use radial through-diameter (+ overshoot).
      height = barrel
        ? barrelHoleCutDepthMm(mergedPlane.surface)
        : faceHoleCutDepthMm(throughDepth);
    }
    const profileForExtrude = {
      ...sketchProfile,
      sketchPlane: mergedPlane,
      faceReferenceLoops: faceLoops,
    };
    const seedExisting = existing
      ? {
          ...existing,
          sketchDoc: cloneSketchDoc({ ...sketchDoc, plane: mergedPlane, faceReferenceLoops: faceLoops }),
          sketchId: sketchDoc.id,
          sketchProfileIds: sketchDoc.selectedProfileIds.length ? sketchDoc.selectedProfileIds : existing.sketchProfileIds,
        }
      : null;
    const base = shapeFromSketchProfile(profileForExtrude, height, seedExisting, {
      cutIntoFace: Boolean(asHole && faceSketch),
    });
    if (!base) {
      setNotice("Close at least one profile before extruding");
      return;
    }
    const linkedDoc = cloneSketchDoc({ ...sketchDoc, plane: mergedPlane, faceReferenceLoops: faceLoops });
    base.sketchDoc = linkedDoc;
    base.sketchId = sketchDoc.id;
    base.sketchPlane = cloneSketchPlane(mergedPlane);
    if (sketchDoc.selectedProfileIds.length) base.sketchProfileIds = [...sketchDoc.selectedProfileIds];
    let extruded = asHole ? withHoleMode(base, true) : withHoleMode(base, false, existing?.color ?? base.color);

    // Resolve host for cut (hole) or join (solid on a face) — any solid, not only sketched ones.
    const preferredHostId = mergedPlane.hostShapeId ?? null;
    const selectedSolidId = selectedIdsRef.current.find((id) => {
      const shape = shapesRef.current.find((entry) => entry.id === id);
      return Boolean(shape && !shape.hole && !shape.locked && !shape.hidden && shape.id !== extruded.id && shape.id !== existing?.id);
    }) ?? null;
    const wantHost = Boolean(asHole || faceSketch);
    let host = wantHost
      ? findOverlappingHostForHole(extruded, shapesRef.current, preferredHostId ?? selectedSolidId)
      : null;

    // If host was found by selection/overlap after the first build, rebuild through-all
    // along the cut normal (exact profile size — no in-plane inflate).
    if (asHole && host && (!hostForDepth || host.id !== hostForDepth.id) && !barrel) {
      const hostThrough = faceHoleCutDepthMm(
        shapeThicknessInwardFromFace(host, mergedPlane.origin, mergedPlane.normal),
      );
      if (hostThrough > height + 0.05) {
        const rebuilt = shapeFromSketchProfile(profileForExtrude, hostThrough, seedExisting, {
          cutIntoFace: true,
        });
        if (rebuilt) {
          rebuilt.sketchDoc = linkedDoc;
          rebuilt.sketchId = sketchDoc.id;
          rebuilt.sketchPlane = cloneSketchPlane(mergedPlane);
          extruded = withHoleMode(rebuilt, true);
          height = hostThrough;
        }
      }
    }

    // Editing a sketch feature already under a CSG body: replace leaf + remesh (no re-nest).
    const existingOwner = existing ? findCsgBodyOwningLeaf(shapesRef.current, existing.id) : null;
    if (existing && existingOwner) {
      const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
      const sourceProjectId = projectInfoRef.current.projectId;
      const remeshGen = remeshGenerationRef.current + 1;
      remeshGenerationRef.current = remeshGen;
      const { body, remeshed } = await updateCsgLeafAndRemesh(existingOwner, existing.id, extruded);
      if (remeshGen !== remeshGenerationRef.current) return;
      if (projectInfoRef.current.projectId === sourceProjectId && projectShapesFingerprint(shapesRef.current) === sourceFingerprint) {
        commitShapes(
          shapesRef.current.map((shape) => (shape.id === existingOwner.id ? body : shape)),
          body.id,
          asHole ? `Sketch hole updated in ${existingOwner.name}` : `Sketch feature updated in ${existingOwner.name}`,
        );
        scheduleSketchBrepBake(extruded);
        scheduleCsgBrepBake(body);
        if (remeshed && body.edgeTreatments?.length) {
          await reapplyEdgeTreatmentsRef.current(body);
        }
        if (!remeshed) {
          setNotice("Could not remesh CSG body after sketch edit — last good mesh kept. Ungroup then Group to retry.");
        }
        exitSketchMode();
        setExtrudeAsHole(false);
        return;
      }
    }

    // Face / selected-solid: cut (hole) or join (solid) immediately into the host body.
    if (host && (asHole || faceSketch)) {
      const operands = asHole
        ? [withHoleMode(host, false), extruded]
        : [withHoleMode(host, false), withHoleMode(extruded, false, extruded.color)];
      const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
      const sourceProjectId = projectInfoRef.current.projectId;
      const result = await buildGroupedShapeFromSelection(operands);
      if (projectInfoRef.current.projectId === sourceProjectId && projectShapesFingerprint(shapesRef.current) === sourceFingerprint) {
        if (result.group) {
          const linkedGroup = asPreservedCsgBody(host, result.group);
          const remaining = shapesRef.current.filter((shape) => shape.id !== host.id && shape.id !== existing?.id);
          commitShapes(
            [...remaining, linkedGroup],
            linkedGroup.id,
            asHole ? `Sketch hole cut into ${host.name}` : `Sketch solid joined to ${host.name}`,
          );
          scheduleSketchBrepBake(extruded);
          scheduleCsgBrepBake(linkedGroup);
          exitSketchMode();
          setExtrudeAsHole(false);
          return;
        }
        if (result.consumed) {
          const remaining = shapesRef.current.filter((shape) => shape.id !== host.id && shape.id !== existing?.id);
          commitShapes(remaining, null, "Sketch feature consumed the host solid");
          exitSketchMode();
          setExtrudeAsHole(false);
          return;
        }
        setNotice(
          result.failureNotice
            || (asHole
              ? "Could not cut this sketch hole into the 3D part — try a deeper extrude or Group manually"
              : "Could not join this sketch solid to the 3D part — try Group manually"),
        );
      }
    }

    const nextShapes = existing
      ? shapesRef.current.map((shape) => (shape.id === existing.id ? extruded : shape))
      : [...shapesRef.current, extruded];
    commitShapes(
      nextShapes,
      extruded.id,
      asHole
        ? (host
          ? `Sketch hole ready — cut into ${host.name} failed; select the solid and Group to retry`
          : (existing ? "Sketch updated as hole — select a 3D solid and Group to cut" : `Sketch hole ready at ${height.toFixed(1)} mm — select a 3D solid and Group to cut`))
        : (faceSketch && host
          ? `Sketch solid ready — join to ${host.name} failed; select the solid and Group to retry`
          : (existing ? "Sketch updated in 3D" : `Sketch extruded at ${height.toFixed(1)} mm`)),
    );
    scheduleSketchBrepBake(extruded);
    exitSketchMode();
    setExtrudeAsHole(false);
  }, [commitShapes, editingSketchShapeId, exitSketchMode, extrudeAsHole, scheduleCsgBrepBake, scheduleSketchBrepBake, sketchDoc, sketchProfile]);

  const completeSketchRevolve = useCallback((axis: SketchRevolveAxis) => {
    const existing = editingSketchShapeId ? shapes.find((shape) => shape.id === editingSketchShapeId) ?? null : null;
    const revolved = shapeFromSketchRevolve(sketchProfile, axis, existing);
    if (!revolved) {
      setRevolvePrompt({ phase: "pick" });
      setSketchTool("select");
      setNotice("Revolve needs a closed profile that stays on one side of the axis. Pick another axis line.");
      return;
    }
    const nextShapes = existing ? shapes.map((shape) => (shape.id === existing.id ? revolved : shape)) : [...shapes, revolved];
    commitShapes(nextShapes, revolved.id, existing ? "Sketch revolved" : "Sketch revolved around axis");
    scheduleSketchBrepBake(revolved);
    exitSketchMode();
  }, [commitShapes, editingSketchShapeId, exitSketchMode, scheduleSketchBrepBake, shapes, sketchProfile]);

  const startSketchRevolve = useCallback(() => {
    if (!isDefaultSketchPlane(sketchProfile.sketchPlane)) {
      setNotice("Revolve is only available on workplane sketches");
      return;
    }
    const closedCount = orderedSketchPaths(sketchProfile).filter((path) => path.closed).length;
    if (closedCount === 0) {
      setNotice("Close a profile first, then click Revolve");
      return;
    }
    setSketchTool("select");
    const selectedAxis = resolveSketchRevolveAxis(sketchProfile, sketchSelection);
    if (selectedAxis) {
      setRevolvePrompt({ phase: "confirm", axis: selectedAxis });
      return;
    }
    setRevolvePrompt({ phase: "pick" });
  }, [sketchProfile, sketchSelection]);

  useEffect(() => {
    if (!revolvePrompt) return;
    const axis = resolveSketchRevolveAxis(sketchProfile, sketchSelection);
    if (!axis) return;
    if (revolvePrompt.phase === "pick") {
      setRevolvePrompt({ phase: "confirm", axis });
      return;
    }
    const sameAxis =
      Math.hypot(revolvePrompt.axis.start.x - axis.start.x, revolvePrompt.axis.start.z - axis.start.z) < 1e-6
      && Math.hypot(revolvePrompt.axis.end.x - axis.end.x, revolvePrompt.axis.end.z - axis.end.z) < 1e-6;
    const reversedAxis =
      Math.hypot(revolvePrompt.axis.start.x - axis.end.x, revolvePrompt.axis.start.z - axis.end.z) < 1e-6
      && Math.hypot(revolvePrompt.axis.end.x - axis.start.x, revolvePrompt.axis.end.z - axis.start.z) < 1e-6;
    if (!sameAxis && !reversedAxis) {
      setRevolvePrompt({ phase: "confirm", axis });
    }
  }, [revolvePrompt, sketchProfile, sketchSelection]);

  useEffect(() => {
    if (!projectId) {
      lastProjectIdRef.current = null;
      lastProjectShapesSyncRef.current = "";
      lastProjectShapesEchoRef.current = null;
      return;
    }
    if (projectInteractionActiveRef.current) {
      return;
    }
    const projectChanged = lastProjectIdRef.current !== projectId;
    if (projectChanged) {
      lastProjectIdRef.current = projectId;
      lastProjectShapesSyncRef.current = "";
      lastProjectShapesEchoRef.current = null;
    }
    const incoming = initialShapes.map(canonicalizeShape);
    const incomingSerialized = projectShapesFingerprint(incoming);
    // The parent echoes shapes after a local save; rehydrating that echo can reset active transform state.
    if (!projectChanged && lastProjectShapesEchoRef.current !== null && incomingSerialized === lastProjectShapesEchoRef.current) {
      lastProjectShapesSyncRef.current = incomingSerialized;
      return;
    }
    if (projectSyncTimerRef.current !== null) {
      window.clearTimeout(projectSyncTimerRef.current);
      projectSyncTimerRef.current = null;
    }
    if (!projectChanged && incomingSerialized === projectShapesFingerprint(shapes)) {
      // Seed echo even when shapes already match — otherwise the first drag-end
      // rehydrates stale parent props and snaps the model back.
      lastProjectShapesSyncRef.current = incomingSerialized;
      lastProjectShapesEchoRef.current = incomingSerialized;
      return;
    }
    const hydratedHistory = hydrateEditorHistoryState(incoming, initialHistory, initialHistoryIndex);
    projectHydratingRef.current = true;
    const remeshGen = remeshGenerationRef.current + 1;
    remeshGenerationRef.current = remeshGen;
    void (async () => {
      // Heal CSG bodies that were saved with stripped history mesh caches.
      let migratedIncoming = migrateShapesCsg(incoming.map(canonicalizeShape));
      const needsHeal = migratedIncoming.some(historyShapeNeedsRemesh);
      let remeshFailed: string[] = [];
      if (needsHeal) {
        const remeshResult = await remeshDirtyHistoryShapes(migratedIncoming);
        migratedIncoming = remeshResult.shapes;
        remeshFailed = remeshResult.failedNames;
      }
      if (remeshGen !== remeshGenerationRef.current) return;
      // Treat the hydrated snapshot as our own echo so interaction-end does not
      // wipe local edits with the pre-save parent copy.
      lastProjectShapesSyncRef.current = projectShapesFingerprint(migratedIncoming);
      lastProjectShapesEchoRef.current = lastProjectShapesSyncRef.current;
      shapesRef.current = migratedIncoming;
      selectedIdsRef.current = [];
      historyRef.current = hydratedHistory.entries;
      historyIndexRef.current = hydratedHistory.index;
      setShapes(migratedIncoming);
      setSelectedIds([]);
      setHistory(hydratedHistory.entries);
      setHistoryIndex(hydratedHistory.index);
      const healNotice = remeshFailed.length
        ? `Project synced · ${remeshFailed.length} group mesh${remeshFailed.length === 1 ? "" : "es"} could not rebuild`
        : needsHeal
          ? "Project synced · rebuilt group meshes"
          : "Project synced";
      setNotice(incoming.length ? healNotice : "Ready");
      if (needsHeal && remeshFailed.length === 0) {
        // Persist healed tessellations so the next load is not empty again.
        syncProjectShapes(migratedIncoming);
      }
    })();
  }, [initialHistory, initialHistoryIndex, initialShapes, projectId, projectInteractionActive, projectRevision, syncProjectShapes]);

  useEffect(() => {
    if (!projectId || !onProjectShapesChange) {
      return;
    }
    if (projectHydratingRef.current) {
      projectHydratingRef.current = false;
      const hydrated = projectShapesFingerprint(shapes);
      lastProjectShapesSyncRef.current = hydrated;
      lastProjectShapesEchoRef.current = hydrated;
      return;
    }
    syncProjectShapes(shapes);
  }, [onProjectShapesChange, projectId, shapes, syncProjectShapes]);

  useEffect(() => {
    const handlePageHide = () => {
      flushProjectShapesSync();
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      flushProjectShapesSync();
      if (projectSyncTimerRef.current !== null) {
        window.clearTimeout(projectSyncTimerRef.current);
      }
      if (interactionHistoryTimerRef.current !== null) {
        window.clearTimeout(interactionHistoryTimerRef.current);
      }
    };
  }, [flushProjectShapesSync]);

  const addShape = useCallback(
    (asset: ShapeAsset, point?: { x: number; z: number; elevation?: number }) => {
      const place = point ?? { x: 0, z: 0, elevation: placementElevation };
      if (asset.kind === "thread") {
        try {
          const nextShape = createThreadShape({
            designation: DEFAULT_THREAD_DESIGNATION,
            point: place,
            base: {
              id: createLocalId("thread"),
              name: `Threads ${DEFAULT_THREAD_DESIGNATION}`,
              color: asset.color,
            },
          });
          commitShapes([...shapesRef.current, nextShape], nextShape.id, "Threads added");
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Could not build threads");
        }
        return;
      }
      const nextShape = makeShapeFromAsset(asset, place, workspaceSettingsRef.current.displayQuality);
      commitShapes([...shapesRef.current, nextShape], nextShape.id, `${asset.name} added`);
    },
    [commitShapes, placementElevation],
  );

  const recordShapeRepeatActions = useCallback((entries: Array<{ shapeId: string; delta: ShapeRepeatDelta; before?: WorkplaneShape }>) => {
    let recorded = false;
    entries.forEach(({ shapeId, delta, before }) => {
      if (!hasShapeRepeatDelta(delta)) {
        return;
      }
      const current = shapesRef.current.find((shape) => shape.id === shapeId);
      if (!current) {
        return;
      }
      lastShapeActionRef.current[shapeId] = {
        delta,
        before: before ?? current,
      };
      recorded = true;
    });
    if (recorded) {
      duplicateRepeatDeltasRef.current = new Map();
    }
  }, []);

  const updateShape = useCallback(
    (id: string, patch: ShapeUpdatePatch) => {
      const bakeTransform = Boolean(patch.bakeTransform);
      const cleanedPatch = cleanShapePatch(patch);
      const previous = shapesRef.current.find((shape) => shape.id === id);

      // Inspector Hole button: face-sketch cutters know their host — cut immediately.
      if (previous && !previous.locked && "hole" in cleanedPatch && cleanedPatch.hole && previous.sketchPlane?.hostShapeId) {
        void (async () => {
          const holeShape = withHoleMode(previous, true, cleanedPatch.color);
          const hostId = previous.sketchPlane?.hostShapeId;
          const host = hostId
            ? shapesRef.current.find((shape) => shape.id === hostId && !shape.hole && !shape.locked && !shape.hidden)
            : null;
          if (!host) {
            commitShapes(
              shapesRef.current.map((shape) => (shape.id === id ? holeShape : shape)),
              selectedIdsRef.current,
              "Changed selection to hole — select a solid and Group to cut",
            );
            return;
          }
          const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
          const sourceProjectId = projectInfoRef.current.projectId;
          const result = await buildGroupedShapeFromSelection([withHoleMode(host, false), holeShape]);
          if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(shapesRef.current) !== sourceFingerprint) {
            setNotice("The scene changed while cutting; try Hole again");
            return;
          }
          if (result.group) {
            const linkedGroup = asPreservedCsgBody(host, result.group);
            commitShapes(
              shapesRef.current.filter((shape) => shape.id !== host.id && shape.id !== id).concat(linkedGroup),
              linkedGroup.id,
              `Cut hole into ${host.name}`,
            );
            return;
          }
          if (result.consumed) {
            commitShapes(
              shapesRef.current.filter((shape) => shape.id !== host.id && shape.id !== id),
              null,
              "Hole consumed the host solid",
            );
            return;
          }
          commitShapes(
            shapesRef.current.map((shape) => (shape.id === id ? holeShape : shape)),
            selectedIdsRef.current,
            result.failureNotice,
          );
        })();
        return;
      }

      if (previous?.kind === "thread") {
        const designationFromPatch = cleanedPatch.threadSpec?.designation as MetricThreadDesignation | undefined;
        const threadSpecDriven = Boolean(cleanedPatch.threadSpec);
        const sizeDriven =
          typeof cleanedPatch.width === "number" ||
          typeof cleanedPatch.depth === "number" ||
          typeof cleanedPatch.size === "number";
        const heightDriven = typeof cleanedPatch.height === "number";
        const sidesDriven = typeof cleanedPatch.sides === "number";
        // Never scale a thread mesh — that squashes pitch. Always regenerate so
        // height changes add/remove turns at the metric pitch. Also regenerate on
        // bakeTransform after gizmo drags that only updated dimensions.
        const meshOutOfSync = Boolean(
          previous.importedMesh
          && (
            Math.abs(previous.height - previous.importedMesh.baseHeight) > 1e-4
            || Math.abs(shapeWidth(previous) - previous.importedMesh.baseWidth) > 1e-4
            || Math.abs(shapeDepth(previous) - previous.importedMesh.baseDepth) > 1e-4
          ),
        );
        const shouldRebuild =
          threadSpecDriven
          || sidesDriven
          || heightDriven
          || sizeDriven
          || (bakeTransform && meshOutOfSync);

        if (shouldRebuild) {
          let designation = (designationFromPatch ?? previous.threadSpec?.designation ?? DEFAULT_THREAD_DESIGNATION) as MetricThreadDesignation;
          if (sizeDriven && !designationFromPatch) {
            designation = nearestMetricThreadForDiameter(
              cleanedPatch.width ?? cleanedPatch.depth ?? cleanedPatch.size ?? shapeWidth(previous),
            ).designation;
          }
          const height = Math.max(0.5, cleanedPatch.height ?? previous.height);
          try {
            const built = createThreadShape({
              designation,
              height,
              base: {
                ...previous,
                ...cleanedPatch,
                id: previous.id,
                name: previous.name,
                color: cleanedPatch.color ?? previous.color,
                sides: cleanedPatch.sides ?? previous.sides,
                threadSpec: {
                  designation,
                  majorDiameter: cleanedPatch.threadSpec?.majorDiameter ?? previous.threadSpec?.majorDiameter ?? 6,
                  pitch: cleanedPatch.threadSpec?.pitch ?? previous.threadSpec?.pitch ?? 1,
                  style: cleanedPatch.threadSpec?.style ?? previous.threadSpec?.style,
                  clearance: cleanedPatch.threadSpec?.clearance ?? previous.threadSpec?.clearance,
                  part: cleanedPatch.threadSpec?.part ?? previous.threadSpec?.part,
                },
              },
            });
            const nextShape = canonicalizeShape({
              ...built,
              x: typeof cleanedPatch.x === "number" ? cleanedPatch.x : previous.x,
              z: typeof cleanedPatch.z === "number" ? cleanedPatch.z : previous.z,
              elevation: typeof cleanedPatch.elevation === "number" ? cleanedPatch.elevation : previous.elevation,
              rotation: typeof cleanedPatch.rotation === "number" ? cleanedPatch.rotation : previous.rotation,
              rotationX: typeof cleanedPatch.rotationX === "number" ? cleanedPatch.rotationX : previous.rotationX,
              rotationZ: typeof cleanedPatch.rotationZ === "number" ? cleanedPatch.rotationZ : previous.rotationZ,
              mirrorX: "mirrorX" in cleanedPatch ? cleanedPatch.mirrorX : previous.mirrorX,
              mirrorY: "mirrorY" in cleanedPatch ? cleanedPatch.mirrorY : previous.mirrorY,
              mirrorZ: "mirrorZ" in cleanedPatch ? cleanedPatch.mirrorZ : previous.mirrorZ,
              color: cleanedPatch.color ?? previous.color,
              hole: "hole" in cleanedPatch ? cleanedPatch.hole : previous.hole,
              locked: "locked" in cleanedPatch ? cleanedPatch.locked : previous.locked,
              hidden: "hidden" in cleanedPatch ? cleanedPatch.hidden : previous.hidden,
            });
            if (projectInteractionActiveRef.current) {
              // Live height/sides edits: update the mesh without a history entry per tick.
              setShapes((current) => {
                const next = current.map((shape) => (shape.id === id ? nextShape : shape));
                interactionHistoryChangedRef.current = true;
                shapesRef.current = next;
                return next;
              });
            } else {
              commitShapes(
                shapesRef.current.map((shape) => (shape.id === id ? nextShape : shape)),
                selectedIds,
                `${designation} threads updated`,
              );
            }
          } catch (error) {
            setNotice(error instanceof Error ? error.message : "Could not rebuild threads");
          }
          return;
        }

        // Rotations/mirrors on threads must not bake a scaled mesh into positions.
        if (bakeTransform) {
          const patched = canonicalizeShape({ ...previous, ...cleanedPatch });
          if (!workplaneShapesEqual(previous, patched)) {
            if (projectInteractionActiveRef.current) {
              setShapes((current) => {
                const next = current.map((shape) => (shape.id === id ? patched : shape));
                interactionHistoryChangedRef.current = true;
                shapesRef.current = next;
                return next;
              });
            } else {
              commitShapes(
                shapesRef.current.map((shape) => (shape.id === id ? patched : shape)),
                selectedIds,
              );
            }
          }
          return;
        }
      }

      const applyPatch = (current: WorkplaneShape[]) => {
        let changed = false;
        const next = current.map((shape) => {
          if (shape.id !== id) {
            return shape;
          }

          const patched = { ...shape, ...cleanedPatch };
          const canonicalBase = canonicalizeShape("hole" in cleanedPatch ? withHoleMode(patched, Boolean(cleanedPatch.hole), cleanedPatch.color) : patched);
          const canonical = bakeTransform ? canonicalizeShape(bakeShapeTransformIntoMesh(canonicalBase)) : canonicalBase;
          if (workplaneShapesEqual(shape, canonical)) {
            return shape;
          }
          changed = true;
          return canonical;
        });
        return { changed, next };
      };

      if (projectInteractionActiveRef.current) {
        setShapes((current) => {
          const { changed, next } = applyPatch(current);
          if (!changed) {
            return current;
          }
          interactionHistoryChangedRef.current = true;
          shapesRef.current = next;
          return next;
        });
        return;
      }

      const { changed, next } = applyPatch(shapesRef.current);
      if (changed) {
        // Record typed/post-drag rotation (and other numeric edits) for Duplicate & Repeat.
        // Bake-only patches keep whatever finalizeInteractionHistory already stored.
        if (previous) {
          const rotationPatched =
            typeof cleanedPatch.rotation === "number" ||
            typeof cleanedPatch.rotationX === "number" ||
            typeof cleanedPatch.rotationZ === "number";
          if (rotationPatched) {
            // Prefer the pre-drag shape when the degree box commits after a mouse rotate.
            const beforeForDelta = patch.repeatDeltaBefore ?? previous;
            const afterForDelta = canonicalizeShape({ ...previous, ...cleanedPatch });
            const delta = computeShapeRepeatDelta(beforeForDelta, afterForDelta);
            if (hasShapeRepeatDelta(delta)) {
              lastShapeActionRef.current[id] = { delta, before: beforeForDelta };
              duplicateRepeatDeltasRef.current = new Map();
            }
          }
        }
        const holeNotice =
          "hole" in cleanedPatch
            ? cleanedPatch.hole
              ? "Changed to hole — select a solid and Group to cut"
              : "Changed to solid"
            : undefined;
        commitShapes(next, selectedIds, holeNotice);
      }
    },
    [commitShapes, selectedIds],
  );

  const deleteSelected = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    const selected = new Set(selectedIds);
    const lockedSelected = shapes.filter((shape) => selected.has(shape.id) && shape.locked);
    const removable = shapes.filter((shape) => selected.has(shape.id) && !shape.locked);
    if (removable.length === 0) {
      setNotice(lockedSelected.length ? "Unlock the shape before deleting it" : "Select a shape first");
      return;
    }
    const remaining = shapes.filter((shape) => !selected.has(shape.id) || shape.locked);
    commitShapes(
      remaining,
      [],
      lockedSelected.length
        ? `Deleted ${removable.length} shape${removable.length === 1 ? "" : "s"} (${lockedSelected.length} locked kept)`
        : `Deleted ${removable.length} selected shape${removable.length === 1 ? "" : "s"}`,
    );
  }, [commitShapes, hasSelection, selectedIds, shapes]);

  const duplicateSelected = useCallback(() => {
    // Bake/close any open degree box first so blur doesn't re-apply rotation.
    rotationEditApiRef.current?.dismiss();
    duplicateRepeatDeltasRef.current = new Map();
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    // Keep the copy in the same place as the original (TinkerCAD-style).
    const sourceShapes = shapesRef.current.filter((shape) => selectedIdsRef.current.includes(shape.id));
    const duplicates = sourceShapes.map((shape) => createDuplicateForRepeat(shape, createLocalId(`${shape.id}-copy`)));
    commitShapes(
      [...shapesRef.current, ...duplicates],
      duplicates.map((shape) => shape.id),
      `Duplicated ${duplicates.length} shape${duplicates.length === 1 ? "" : "s"}`,
    );
  }, [commitShapes, hasSelection]);

  const duplicateAndRepeatSelected = useCallback(() => {
    // Bake/close any open degree box first so blur doesn't re-apply rotation.
    rotationEditApiRef.current?.dismiss();
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }

    // Workflow: duplicate in place, then apply the last transform (e.g. +10°) to the copy only.
    const sourceShapes = shapesRef.current.filter((shape) => selectedIdsRef.current.includes(shape.id));
    const nextRepeatDeltas = new Map<string, ShapeRepeatDelta>();
    const duplicates = sourceShapes.map((shape) => {
      const storedAction = lastShapeActionRef.current[shape.id];
      const delta =
        duplicateRepeatDeltasRef.current.get(shape.id) ?? storedAction?.delta ?? DEFAULT_SHAPE_REPEAT_DELTA;
      const duplicate = createDuplicateForRepeat(shape, createLocalId(`${shape.id}-repeat`));
      const repeated = hasShapeRepeatDelta(delta)
        ? applyRepeatActionToDuplicate(duplicate, delta, { incremental: true })
        : duplicate;
      nextRepeatDeltas.set(repeated.id, delta);
      if (hasShapeRepeatDelta(delta)) {
        lastShapeActionRef.current[repeated.id] = {
          delta,
          before: shape,
        };
      }
      return repeated;
    });

    duplicateRepeatDeltasRef.current = nextRepeatDeltas;
    commitShapes(
      [...shapesRef.current, ...duplicates],
      duplicates.map((shape) => shape.id),
      `Duplicated and repeated ${duplicates.length} shape${duplicates.length === 1 ? "" : "s"}`,
    );
  }, [commitShapes, hasSelection]);

  const copySelected = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    setClipboard(selectedShapes);
    writeSharedClipboard(selectedShapes);
    setNotice(`Copied ${selectedShapes.length} shape${selectedShapes.length === 1 ? "" : "s"}`);
  }, [hasSelection, selectedShapes]);

  const pasteShape = useCallback(async () => {
    const sourceProjectId = projectInfoRef.current.projectId;
    const systemClipboard = await readSystemClipboard();
    const sharedClipboard = readSharedClipboard();
    const sourceClipboard = systemClipboard.length > 0 ? systemClipboard : sharedClipboard.length > 0 ? sharedClipboard : clipboard;
    if (sourceClipboard.length === 0) {
      setNotice("SketchForge clipboard is empty");
      return;
    }
    if (projectInfoRef.current.projectId !== sourceProjectId) {
      setNotice("Paste cancelled because the project changed");
      return;
    }
    if (serializeShapesForSync(sourceClipboard) !== serializeShapesForSync(clipboard)) {
      setClipboard(sourceClipboard);
    }
    const pasted = sourceClipboard.map((shape) => ({
      ...shape,
      id: createLocalId(`${shape.id}-paste`),
      x: Math.min(110, shape.x + 12),
      z: Math.min(110, shape.z + 12),
    }));
    commitShapes([...shapesRef.current, ...pasted], pasted.map((shape) => shape.id), `Pasted ${pasted.length} shape${pasted.length === 1 ? "" : "s"}`);
  }, [clipboard, commitShapes]);

  const undo = useCallback(() => {
    void (async () => {
      if (projectInteractionActiveRef.current) {
        setNotice("Finish the current drag or transform before undoing");
        return;
      }
      if (circularPatternRef.current) {
        circularPatternRef.current = null;
        setCircularPattern(null);
        setNotice("Circular pattern cancelled");
        return;
      }
      const modifierCancelled = invalidateCadModifierSession();
      const currentHistory = historyRef.current;
      const currentIndex = historyIndexRef.current;
      if (currentIndex <= 0) {
        setNotice(modifierCancelled ? "Edge modifier cancelled" : "Nothing to undo");
        return;
      }
      const nextIndex = currentIndex - 1;
      const entry = currentHistory[nextIndex];
      const remeshGen = remeshGenerationRef.current + 1;
      remeshGenerationRef.current = remeshGen;
      let nextShapes = expandHistoryShapes(entry?.shapes ?? [], entry?.meshVault).map(canonicalizeShape);
      const undoRemesh = await remeshDirtyHistoryShapes(nextShapes);
      nextShapes = undoRemesh.shapes;
      if (remeshGen !== remeshGenerationRef.current) return;
      const nextSelection = (entry?.selectedIds ?? []).filter((id) => nextShapes.some((shape) => shape.id === id));
      historyIndexRef.current = nextIndex;
      shapesRef.current = nextShapes;
      selectedIdsRef.current = nextSelection;
      setHistoryIndex(nextIndex);
      setShapes(nextShapes);
      setSelectedIds(nextSelection);
      setActiveFeatureId(null);
      syncProjectShapes(nextShapes);
      const remeshWarn = undoRemesh.failedNames.length
        ? ` · ${undoRemesh.failedNames.length} mesh${undoRemesh.failedNames.length === 1 ? "" : "es"} need rebuild`
        : "";
      setNotice((modifierCancelled ? "Edge modifier cancelled · Undo" : "Undo") + remeshWarn);
      // Restoring the fillets is part of arriving at this step, not a step of its own.
      historyWriteSuspendedRef.current += 1;
      try {
        for (const shape of nextShapes) {
          if (shape.edgeTreatments?.length && !shape.cadBrep) {
            await reapplyEdgeTreatmentsRef.current(shape);
          }
        }
      } finally {
        historyWriteSuspendedRef.current -= 1;
      }
    })();
  }, [invalidateCadModifierSession, syncProjectShapes]);

  const redo = useCallback(() => {
    void (async () => {
      if (projectInteractionActiveRef.current) {
        setNotice("Finish the current drag or transform before redoing");
        return;
      }
      if (circularPatternRef.current) {
        circularPatternRef.current = null;
        setCircularPattern(null);
      }
      const currentHistory = historyRef.current;
      const currentIndex = historyIndexRef.current;
      if (currentIndex >= currentHistory.length - 1) {
        setNotice("Nothing to redo");
        return;
      }
      const modifierCancelled = invalidateCadModifierSession();
      const nextIndex = currentIndex + 1;
      const entry = currentHistory[nextIndex];
      const remeshGen = remeshGenerationRef.current + 1;
      remeshGenerationRef.current = remeshGen;
      let nextShapes = expandHistoryShapes(entry?.shapes ?? [], entry?.meshVault).map(canonicalizeShape);
      const redoRemesh = await remeshDirtyHistoryShapes(nextShapes);
      nextShapes = redoRemesh.shapes;
      if (remeshGen !== remeshGenerationRef.current) return;
      const nextSelection = (entry?.selectedIds ?? []).filter((id) => nextShapes.some((shape) => shape.id === id));
      historyIndexRef.current = nextIndex;
      shapesRef.current = nextShapes;
      selectedIdsRef.current = nextSelection;
      setHistoryIndex(nextIndex);
      setShapes(nextShapes);
      setSelectedIds(nextSelection);
      setActiveFeatureId(null);
      syncProjectShapes(nextShapes);
      const remeshWarn = redoRemesh.failedNames.length
        ? ` · ${redoRemesh.failedNames.length} mesh${redoRemesh.failedNames.length === 1 ? "" : "es"} need rebuild`
        : "";
      setNotice((modifierCancelled ? "Edge modifier cancelled · Redo" : "Redo") + remeshWarn);
      historyWriteSuspendedRef.current += 1;
      try {
        for (const shape of nextShapes) {
          if (shape.edgeTreatments?.length && !shape.cadBrep) {
            await reapplyEdgeTreatmentsRef.current(shape);
          }
        }
      } finally {
        historyWriteSuspendedRef.current -= 1;
      }
    })();
  }, [invalidateCadModifierSession, syncProjectShapes]);

  const toggleAlignMode = useCallback(() => {
    if (selectedShapes.length < 2) {
      setNotice("Select at least two shapes to align");
      return;
    }
    setAlignMode((active) => {
      const next = !active;
      setAlignPreview(null);
      if (next) {
        setMirrorMode(false);
        setMirrorPreviewAxis(null);
        setCircularPattern(null);
      }
      setNotice(next ? "Align: choose a dot, or click a selected shape to anchor it" : "Align cancelled");
      return next;
    });
  }, [selectedShapes.length]);

  const chooseAlignAnchor = useCallback(
    (id: string) => {
      if (!selectedIds.includes(id)) {
        return;
      }
      const shape = shapes.find((entry) => entry.id === id);
      const lockedAnchor = selectedShapes.find((entry) => entry.locked);
      if (lockedAnchor && lockedAnchor.id !== id) {
        setNotice(`Align anchor: ${lockedAnchor.name} (locked)`);
        return;
      }
      setAlignAnchorId(id);
      setAlignPreview(null);
      setNotice(shape ? `Align anchor: ${shape.name}` : "Align anchor set");
    },
    [selectedIds, selectedShapes, shapes],
  );

  const alignSelectionTo = useCallback(
    (axis: AlignAxis, target: AlignTarget) => {
      if (selectedShapes.length < 2) {
        setNotice("Select at least two shapes to align");
        return;
      }

      const { nextShapes, moved } = alignedShapesForSelection(shapes, selectedIds, selectedShapes, effectiveAlignAnchorId, axis, target);
      setAlignPreview(null);

      if (moved === 0) {
        setNotice("Already aligned");
        return;
      }

      commitShapes(nextShapes, selectedIds, `Aligned ${moved} shape${moved === 1 ? "" : "s"} ${alignmentLabel(axis, target)}`);
    },
    [commitShapes, effectiveAlignAnchorId, selectedIds, selectedShapes, shapes],
  );

  const previewAlignSelection = useCallback((axis: AlignAxis, target: AlignTarget) => {
    setAlignPreview({ axis, target });
  }, []);

  const clearAlignPreview = useCallback(() => {
    setAlignPreview(null);
  }, []);

  const toggleMirrorMode = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    setMirrorMode((active) => {
      const next = !active;
      setMirrorPreviewAxis(null);
      if (next) {
        setAlignMode(false);
        setAlignAnchorId(null);
        setAlignPreview(null);
        setCircularPattern(null);
      }
      setNotice(next ? "Mirror: choose an axis arrow" : "Mirror cancelled");
      return next;
    });
  }, [hasSelection]);

  const mirrorSelectionAcross = useCallback(
    (axis: AlignAxis) => {
      if (!hasSelection) {
        setNotice("Select a shape first");
        return;
      }
      const { nextShapes, moved } = mirroredShapesForSelection(shapes, selectedIds, selectedShapes, axis);
      setMirrorPreviewAxis(null);
      if (moved === 0) {
        setNotice("Nothing to mirror");
        return;
      }
      commitShapes(nextShapes, selectedIds, `Mirrored ${moved} shape${moved === 1 ? "" : "s"} ${mirrorAxisLabel(axis)}`);
    },
    [commitShapes, hasSelection, selectedIds, selectedShapes, shapes],
  );

  const previewMirrorSelection = useCallback((axis: AlignAxis) => {
    setMirrorPreviewAxis(axis);
  }, []);

  const clearMirrorPreview = useCallback(() => {
    setMirrorPreviewAxis(null);
  }, []);

  const rebuildCircularPatternPreview = useCallback(
    (session: CircularPatternSession, sourceShapes: WorkplaneShape[]): WorkplaneShape[] | null => {
      const sourceIds = new Set(session.sourceIds);
      const sources = sourceShapes.filter((shape) => sourceIds.has(shape.id) && !shape.locked);
      if (!session.center || !sources.length || !(session.radius > 0)) return null;
      const pivot = session.pivotId
        ? sourceShapes.find((shape) => shape.id === session.pivotId) ?? null
        : null;
      return circularPatternInstances(sources, session.center, session.count, {
        radius: session.radius,
        seatElevation: pivot ? patternSeatElevationOnPivot(pivot) : undefined,
        rotationOffset: session.rotation,
        createId: circularPatternCopyId,
      });
    },
    [],
  );

  const cancelCircularPattern = useCallback(() => {
    circularPatternRef.current = null;
    setCircularPattern(null);
    setNotice("Circular pattern cancelled");
  }, []);

  const toggleCircularPattern = useCallback(() => {
    if (circularPattern) {
      cancelCircularPattern();
      return;
    }
    const unlockedSelected = selectedShapes.filter((shape) => !shape.locked);
    if (!unlockedSelected.length) {
      setNotice("Select at least one unlocked shape to pattern");
      return;
    }
    setAlignMode(false);
    setAlignAnchorId(null);
    setAlignPreview(null);
    setMirrorMode(false);
    setMirrorPreviewAxis(null);
    invalidateCadModifierSession();
    setCircularPattern({
      sourceIds: unlockedSelected.map((shape) => shape.id),
      pivotId: null,
      center: null,
      radius: 20,
      count: CIRCULAR_PATTERN_DEFAULT_COUNT,
      rotation: 0,
      preview: null,
    });
    setNotice("Circular pattern: click a shape to orbit around");
  }, [cancelCircularPattern, circularPattern, invalidateCadModifierSession, selectedShapes]);

  const setCircularPatternPivot = useCallback(
    (pivotId: string) => {
      setCircularPattern((current) => {
        if (!current) return current;
        if (current.sourceIds.includes(pivotId)) {
          setNotice("Pick a different shape to orbit around (not one of the patterned sources)");
          return current;
        }
        const pivot = shapesRef.current.find((shape) => shape.id === pivotId);
        if (!pivot) return current;
        const center = { x: pivot.x, z: pivot.z };
        // First pick (or a different pivot): start at that shape’s footprint radius.
        // Re-clicking the same pivot keeps any radius the user already dialed in.
        const radius = current.pivotId === pivotId
          ? clampCircularPatternRadius(current.radius)
          : circularPatternRadiusFromShape(pivot);
        const next: CircularPatternSession = {
          ...current,
          pivotId,
          center,
          radius,
        };
        setNotice(`Orbiting around ${pivot.name}`);
        return { ...next, preview: rebuildCircularPatternPreview(next, shapesRef.current) };
      });
    },
    [rebuildCircularPatternPreview],
  );

  const patchCircularPatternCount = useCallback(
    (count: number) => {
      setCircularPattern((current) => {
        if (!current) return current;
        const next: CircularPatternSession = { ...current, count: clampCircularPatternCount(count) };
        return { ...next, preview: rebuildCircularPatternPreview(next, shapesRef.current) };
      });
    },
    [rebuildCircularPatternPreview],
  );

  const patchCircularPatternRadius = useCallback(
    (radius: number) => {
      setCircularPattern((current) => {
        if (!current) return current;
        const next: CircularPatternSession = { ...current, radius: clampCircularPatternRadius(radius) };
        return { ...next, preview: rebuildCircularPatternPreview(next, shapesRef.current) };
      });
    },
    [rebuildCircularPatternPreview],
  );

  const patchCircularPatternRotation = useCallback(
    (rotation: CircularPatternRotationStep) => {
      setCircularPattern((current) => {
        if (!current) return current;
        const next: CircularPatternSession = { ...current, rotation: clampCircularPatternRotation(rotation) };
        return { ...next, preview: rebuildCircularPatternPreview(next, shapesRef.current) };
      });
    },
    [rebuildCircularPatternPreview],
  );

  const applyCircularPattern = useCallback(() => {
    if (!circularPattern?.center || !circularPattern.preview?.length) return;
    const sourceIds = new Set(circularPattern.sourceIds);
    const nextShapes = shapes.filter((shape) => !sourceIds.has(shape.id)).concat(circularPattern.preview);
    const wouldClamp = circularPatternWouldClamp(
      circularPattern.center,
      circularPattern.radius,
      circularPattern.count,
    );
    commitShapes(nextShapes, circularPattern.preview.map((shape) => shape.id), `Circular pattern ×${circularPattern.count}`);
    setCircularPattern(null);
    if (wouldClamp) {
      setNotice("Circular pattern clamped some positions to ±110 mm");
    }
  }, [circularPattern, commitShapes, shapes]);

  const circularPatternGeometryKey = useMemo(() => {
    if (!circularPattern) return "";
    const ids = [...circularPattern.sourceIds];
    if (circularPattern.pivotId) ids.push(circularPattern.pivotId);
    return ids
      .map((id) => {
        const shape = shapes.find((entry) => entry.id === id);
        if (!shape) return `${id}:gone`;
        return [
          id,
          shape.x,
          shape.z,
          shape.elevation ?? 0,
          shape.width ?? shape.size ?? 0,
          shape.depth ?? shape.size ?? 0,
          shape.height,
          shape.size ?? 0,
          shape.radius ?? "",
          shape.rotation ?? 0,
          shape.rotationX ?? 0,
          shape.rotationZ ?? 0,
          shape.sides ?? "",
          shape.topRadius ?? "",
          shape.baseRadius ?? "",
        ].join(":");
      })
      .join("|");
  }, [circularPattern, shapes]);

  useEffect(() => {
    if (!circularPattern) return;
    const sourceIds = new Set(circularPattern.sourceIds);
    const sources = shapesRef.current.filter((shape) => sourceIds.has(shape.id));
    if (sources.length !== circularPattern.sourceIds.length || sources.some((shape) => shape.locked)) {
      setCircularPattern(null);
      setNotice("Circular pattern cancelled");
      return;
    }

    let center = circularPattern.center;
    if (circularPattern.pivotId) {
      const pivot = shapesRef.current.find((shape) => shape.id === circularPattern.pivotId);
      if (!pivot) {
        setCircularPattern(null);
        setNotice("Circular pattern cancelled — pivot shape removed");
        return;
      }
      center = { x: pivot.x, z: pivot.z };
    }
    if (!center) return;

    setCircularPattern((current) => {
      if (!current) return current;
      const next: CircularPatternSession = { ...current, center };
      const preview = rebuildCircularPatternPreview(next, shapesRef.current);
      const sameCenter =
        current.center
        && Math.abs(current.center.x - center!.x) < 1e-9
        && Math.abs(current.center.z - center!.z) < 1e-9;
      const samePreview =
        Boolean(current.preview && preview)
        && current.preview!.length === preview!.length
        && current.preview!.every((shape, index) => {
          const other = preview![index];
          return (
            shape.id === other.id
            && shape.x === other.x
            && shape.z === other.z
            && (shape.elevation ?? 0) === (other.elevation ?? 0)
            && (shape.width ?? shape.size) === (other.width ?? other.size)
            && (shape.depth ?? shape.size) === (other.depth ?? other.size)
            && shape.height === other.height
            && (shape.size ?? 0) === (other.size ?? 0)
            && (shape.radius ?? 0) === (other.radius ?? 0)
            && (shape.rotation ?? 0) === (other.rotation ?? 0)
            && (shape.rotationX ?? 0) === (other.rotationX ?? 0)
            && (shape.rotationZ ?? 0) === (other.rotationZ ?? 0)
            && (shape.sides ?? 0) === (other.sides ?? 0)
          );
        });
      if (sameCenter && samePreview) return current;
      // Keep center object identity when values are unchanged so viewport effects stay quiet.
      return {
        ...next,
        center: sameCenter ? current.center : center,
        preview,
      };
    });
  }, [
    circularPattern?.count,
    circularPattern?.pivotId,
    circularPattern?.radius,
    circularPattern?.rotation,
    circularPattern?.sourceIds,
    circularPatternGeometryKey,
    rebuildCircularPatternPreview,
  ]);

  useEffect(() => {
    if (!circularPattern) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelCircularPattern();
      } else if (event.key === "Enter" && circularPattern.center && circularPattern.preview?.length) {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest("input, select, textarea, button, [contenteditable='true']")) return;
        event.preventDefault();
        applyCircularPattern();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyCircularPattern, cancelCircularPattern, circularPattern]);

  useEffect(() => {
    if (!alignMode && !mirrorMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (alignMode) {
        setAlignMode(false);
        setAlignPreview(null);
        setNotice("Align cancelled");
      }
      if (mirrorMode) {
        setMirrorMode(false);
        setMirrorPreviewAxis(null);
        setNotice("Mirror cancelled");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [alignMode, mirrorMode]);

  const postCadModifierRequest = useCallback((request: CadModifierWorkerPayload, transfer: Transferable[] = []) => {
    // Prefer a live worker; cold-start once if a prior crash cleared the ref.
    const worker = cadModifierWorkerRef.current ?? cadModifierWorkerRestartRef.current();
    if (!worker) return null;
    const requestId = cadModifierRequestRef.current + 1;
    cadModifierRequestRef.current = requestId;
    try {
      worker.postMessage({ ...request, requestId } as CadModifierWorkerRequest, transfer);
    } catch {
      // Do not retry with the same transfer list — ArrayBuffers are neutered after a failed postMessage.
      worker.terminate();
      if (cadModifierWorkerRef.current === worker) cadModifierWorkerRef.current = null;
      return null;
    }
    return requestId;
  }, []);

  const postCadModifierRequestAsync = useCallback((request: CadModifierWorkerPayload, transfer: Transferable[] = [], timeoutMs = 20000) => {
    const worker = cadModifierWorkerRef.current ?? cadModifierWorkerRestartRef.current();
    if (!worker) {
      return Promise.reject(new Error("The CAD worker is not ready"));
    }
    const requestId = cadModifierRequestRef.current + 1;
    cadModifierRequestRef.current = requestId;
    return new Promise<CadModifierWorkerResponse>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!cadModifierPendingRef.current.has(requestId)) return;
        const pendingRequests = [...cadModifierPendingRef.current.values()];
        cadModifierPendingRef.current.clear();
        pendingRequests.forEach((pending) => window.clearTimeout(pending.timer));
        cadModifierWorkerRef.current?.terminate();
        cadModifierWorkerRef.current = null;
        const invalidationId = cadModifierRequestRef.current + 1;
        cadModifierRequestRef.current = invalidationId;
        cadModifierLatestPreviewRef.current = invalidationId;
        cadModifierPrepareRef.current = invalidationId;
        cadModifierBaseShapeRef.current = null;
        cadModifierBaseFingerprintRef.current = "";
        cadModifierSourcePartsRef.current = [];
        setEdgeModifier(null);
        cadModifierWorkerRestartRef.current();
        pendingRequests.forEach((pending) => pending.reject(new Error("Timed out waiting for the CAD worker; the worker was restarted")));
      }, timeoutMs);
      cadModifierPendingRef.current.set(requestId, { resolve, reject, timer });
      try {
        worker.postMessage({ ...request, requestId } as CadModifierWorkerRequest, transfer);
      } catch (error) {
        window.clearTimeout(timer);
        cadModifierPendingRef.current.delete(requestId);
        reject(error instanceof Error ? error : new Error("The CAD worker rejected the request"));
      }
    });
  }, []);

  const cancelEdgeModifier = useCallback(() => {
    invalidateCadModifierSession();
    setNotice("Edge modifier cancelled");
  }, [invalidateCadModifierSession]);

  const startEdgeModifier = useCallback((kind: CadModifierKind) => {
    if (selectedShapes.length !== 1 || !selectedShape || selectedShape.locked || selectedShape.hole) {
      setNotice(`Select one unlocked solid to ${kind}`);
      return;
    }
    invalidateCadModifierSession();
    const appliedEdgeTreatmentCount = edgeTreatmentFeatureCount(selectedShape);
    const hasAppliedEdgeTreatment = Boolean(selectedShape.importedMesh && selectedShape.edgeTreatments?.length);
    const sourceParts = selectedShape.groupedShapes?.length && !hasAppliedEdgeTreatment ? restoreGroupedChildren(selectedShape) : [selectedShape];
    const partInputs: Array<{ shape: WorkplaneShape; mesh?: MeshData; brep?: string; brepTransform?: number[]; primitive?: CadModifierPrimitivePart }> = sourceParts.map((shape) => {
      const frame = shape.cadBrepFrame;
      const preserveNeedsRetessellation = preservesEdgeTreatmentSize(shape) && Boolean(frame) && (
        Math.abs(shapeWidth(shape) - (frame?.width ?? shapeWidth(shape))) > 1e-6 ||
        Math.abs(shapeDepth(shape) - (frame?.depth ?? shapeDepth(shape))) > 1e-6 ||
        Math.abs(shape.height - (frame?.height ?? shape.height)) > 1e-6
      );
      const primitive = cadModifierPrimitiveForShape(shape);
      if (primitive) return { shape, primitive };
      return shape.cadBrep && frame && !preserveNeedsRetessellation
        ? { shape, brep: shape.cadBrep, brepTransform: cadBrepTransformForShape(shape) }
        : { shape, mesh: meshForShape(shape) };
    });
    const triangleCount = partInputs.reduce((total, part) => total + (part.mesh?.faces.length ?? 0), 0);
    if (triangleCount === 0 && partInputs.every((part) => !part.brep && !part.primitive)) {
      setNotice("The selected object has no printable surface");
      return;
    }
    if (triangleCount > 180_000) {
      setNotice("This mesh is too dense for interactive edge treatment. Simplify it below 180,000 triangles first.");
      return;
    }
    const amount = Math.max(MIN_EDGE_MODIFIER_AMOUNT, Math.min(1, shapeWidth(selectedShape) / 6, shapeDepth(selectedShape) / 6, selectedShape.height / 6));
    cadModifierBaseShapeRef.current = selectedShape;
    cadModifierBaseFingerprintRef.current = projectShapesFingerprint([selectedShape]);
    cadModifierSourcePartsRef.current = sourceParts;
    setAlignMode(false);
    setMirrorMode(false);
    setCircularPattern(null);
    setEdgeModifier({
      kind,
      edges: [],
      selectedEdgeIds: [],
      amount,
      sharpAngle: 25,
      chamferAngle: 45,
      quality: modifierQualityForDisplay(workspaceSettingsRef.current.displayQuality),
      tangentChain: true,
      preserveEdgeSize: selectedShape.edgeResizeMode === "preserve",
      busy: true,
      prepared: false,
      error: null,
      preview: null,
      componentPreviews: [],
    });
    setNotice(`Preparing ${kind} edges in the CAD worker`);
    const parts: CadModifierMeshPart[] = partInputs.map((part) => {
      if (part.brep) return { brep: part.brep, brepTransform: part.brepTransform, hole: Boolean(part.shape.hole) };
      if (part.primitive) return { primitive: part.primitive, hole: Boolean(part.shape.hole) };
      return { ...meshDataToCadTransfer(part.mesh as MeshData), hole: Boolean(part.shape.hole) };
    });
    const prepareRequestId = postCadModifierRequest({
      type: "prepare",
      parts,
      sharpAngle: 25,
      suppressTreatmentDetailEdges: appliedEdgeTreatmentCount > 0,
    }, parts.flatMap((part) => part.positions && part.indices ? [part.positions.buffer, part.indices.buffer] : []));
    if (prepareRequestId === null) {
      // The edge modifier panel renders this same error — skip the redundant toast.
      const message = cadModifierWorkerFailureMessage();
      setEdgeModifier((current) => current ? { ...current, busy: false, prepared: false, error: message } : current);
      return;
    }
    cadModifierPrepareRef.current = prepareRequestId;
    armCadModifierWatchdog(prepareRequestId, "prepare");
  }, [armCadModifierWatchdog, invalidateCadModifierSession, postCadModifierRequest, selectedShape, selectedShapes.length]);

  const prepareCadModifierForMcp = useCallback(async (shape: WorkplaneShape, sharpAngle: number) => {
    if (shape.locked || shape.hole) {
      throw new Error("Select one unlocked solid object for edge treatment");
    }
    const appliedEdgeTreatmentCount = edgeTreatmentFeatureCount(shape);
    const hasAppliedEdgeTreatment = Boolean(shape.importedMesh && shape.edgeTreatments?.length);
    const sourceParts = shape.groupedShapes?.length && !hasAppliedEdgeTreatment ? restoreGroupedChildren(shape) : [shape];
    const partInputs: Array<{ shape: WorkplaneShape; mesh?: MeshData; brep?: string; brepTransform?: number[]; primitive?: CadModifierPrimitivePart }> = sourceParts.map((partShape) => {
      const frame = partShape.cadBrepFrame;
      const preserveNeedsRetessellation = preservesEdgeTreatmentSize(partShape) && Boolean(frame) && (
        Math.abs(shapeWidth(partShape) - (frame?.width ?? shapeWidth(partShape))) > 1e-6 ||
        Math.abs(shapeDepth(partShape) - (frame?.depth ?? shapeDepth(partShape))) > 1e-6 ||
        Math.abs(partShape.height - (frame?.height ?? partShape.height)) > 1e-6
      );
      const primitive = cadModifierPrimitiveForShape(partShape);
      if (primitive) return { shape: partShape, primitive };
      return partShape.cadBrep && frame && !preserveNeedsRetessellation
        ? { shape: partShape, brep: partShape.cadBrep, brepTransform: cadBrepTransformForShape(partShape) }
        : { shape: partShape, mesh: meshForShape(partShape) };
    });
    const triangleCount = partInputs.reduce((total, part) => total + (part.mesh?.faces.length ?? 0), 0);
    if (triangleCount === 0 && partInputs.every((part) => !part.brep && !part.primitive)) {
      throw new Error("The selected object has no printable surface");
    }
    if (triangleCount > 180_000) {
      throw new Error("This mesh is too dense for interactive edge treatment. Simplify it below 180,000 triangles first.");
    }
    const parts: CadModifierMeshPart[] = partInputs.map((part) => {
      if (part.brep) return { brep: part.brep, brepTransform: part.brepTransform, hole: Boolean(part.shape.hole) };
      if (part.primitive) return { primitive: part.primitive, hole: Boolean(part.shape.hole) };
      return { ...meshDataToCadTransfer(part.mesh as MeshData), hole: Boolean(part.shape.hole) };
    });
    const transfer = parts.flatMap((part) => part.positions && part.indices ? [part.positions.buffer as Transferable, part.indices.buffer as Transferable] : []);
    const response = await postCadModifierRequestAsync({
      type: "prepare",
      parts,
      sharpAngle,
      suppressTreatmentDetailEdges: appliedEdgeTreatmentCount > 0,
    }, transfer);
    if (response.type !== "ready") {
      throw new Error("The CAD worker did not return an edge list");
    }
    return { response, sourceParts };
  }, [postCadModifierRequestAsync]);

  const applyCadModifierForMcp = useCallback(async (
    shape: WorkplaneShape,
    params: Record<string, unknown>,
  ) => {
    invalidateCadModifierSession();
    const sourceFingerprint = projectShapesFingerprint([shape]);
    const sourceProjectId = projectInfoRef.current.projectId;
    const kind: CadModifierKind = params.kind === "fillet" ? "fillet" : "chamfer";
    const sharpAngle = Math.max(1, Math.min(CAD_MODIFIER_MAX_SHARP_ANGLE, mcpNumber(params.sharpAngle, 25)));
    const amount = Math.max(MIN_EDGE_MODIFIER_AMOUNT, mcpNumber(params.amount, 1));
    const chamferAngle = Math.max(5, Math.min(85, mcpNumber(params.chamferAngle, 45)));
    const quality: CadModifierQuality = params.quality === "draft" || params.quality === "fine" ? params.quality : "standard";
    const preserveEdgeSize = typeof params.preserveEdgeSize === "boolean" ? params.preserveEdgeSize : shape.edgeResizeMode === "preserve";
    const { response, sourceParts } = await prepareCadModifierForMcp(shape, sharpAngle);
    const selectableIds = response.edges.filter((edge) => selectableCadModifierEdge(edge, sharpAngle)).map((edge) => edge.id);
    const requestedIds = mcpNumberArray(params.edgeIds);
    const selectedEdgeIds = params.edgeIds === "all" || params.allEdges === true ? selectableIds : requestedIds.filter((edgeId) => selectableIds.includes(edgeId));
    const missingIds = requestedIds.filter((edgeId) => !selectableIds.includes(edgeId));
    if (selectedEdgeIds.length === 0) {
      throw new Error("Select at least one valid highlighted edge ID");
    }
    if (missingIds.length > 0) {
      throw new Error(`These edge IDs are not selectable at the current threshold: ${missingIds.join(", ")}`);
    }
    const previewResponse = await postCadModifierRequestAsync({
      type: "preview",
      kind,
      edgeIds: selectedEdgeIds,
      amount,
      quality,
      chamferAngle,
    }, [], 30000);
    if (previewResponse.type !== "preview") {
      throw new Error("The CAD worker did not return an edge preview");
    }
    const rawPreview = shapeFromCadMesh(shape, previewResponse.positions, previewResponse.normals, previewResponse.indices, previewResponse.brep, previewResponse.step);
    if (!rawPreview) {
      throw new Error("The CAD kernel returned an empty edge treatment");
    }
    const preview = canonicalizeShape({
      ...rawPreview,
      cadDisplayEdges: cadDisplayEdgesForShape(rawPreview, previewResponse.displayEdges),
      cadDisplayEdgesVersion: 2 as const,
    });
    const feature = {
      kind,
      amount,
      edgeCount: selectedEdgeIds.length,
      edgeIds: selectedEdgeIds,
      edgeFingerprints: fingerprintsForEdgeIds(response.edges, selectedEdgeIds),
      allEdges: params.edgeIds === "all" || params.allEdges === true || selectedEdgeIds.length === selectableIds.length,
      sharpAngle,
      quality,
      ...(kind === "chamfer" ? { chamferAngle } : {}),
    } satisfies NonNullable<WorkplaneShape["edgeTreatments"]>[number];
    const session: EdgeModifierSession = {
      kind,
      edges: response.edges,
      selectedEdgeIds,
      amount,
      sharpAngle,
      chamferAngle,
      quality,
      tangentChain: false,
      preserveEdgeSize,
      busy: false,
      prepared: true,
      error: null,
      preview,
      componentPreviews: cadModifierComponentPreviews(sourceParts, previewResponse.components),
    };
    const createdAt = Date.now();
    const groupedModifiedShape = groupedShapeWithComponentEdgeTreatment(shape, preview, sourceParts, session, feature, createdAt);
    const modifiedShape = groupedModifiedShape ?? shapeWithEdgeTreatmentRecord(
      bakedEdgeTreatmentPreview(preview, shape),
      shape,
      feature,
      preserveEdgeSize,
      createdAt,
    );
    const currentTarget = shapesRef.current.find((candidate) => candidate.id === shape.id);
    if (
      projectInfoRef.current.projectId !== sourceProjectId ||
      !currentTarget ||
      projectShapesFingerprint([currentTarget]) !== sourceFingerprint
    ) {
      throw new Error("The target object or project changed while the edge treatment was running; try again");
    }
    commitShapes(
      shapesRef.current.map((candidate) => candidate.id === shape.id ? modifiedShape : candidate),
      modifiedShape.id,
      `${kind === "fillet" ? "Filleted" : "Chamfered"} ${selectedEdgeIds.length} edge${selectedEdgeIds.length === 1 ? "" : "s"} by MCP`,
    );
    return {
      object: mcpShapeSummary(modifiedShape),
      selectedEdgeIds,
      selectableEdgeIds: selectableIds,
    };
  }, [commitShapes, invalidateCadModifierSession, prepareCadModifierForMcp, postCadModifierRequestAsync]);

  reapplyEdgeTreatmentsRef.current = async (shape: WorkplaneShape) => {
    const recipes = [...(shape.edgeTreatments ?? [])];
    if (recipes.length === 0) return;
    // Strip recipes first so re-apply does not double-stack the same features.
    const stripped: WorkplaneShape = {
      ...shape,
      edgeTreatments: undefined,
      edgeTreatmentHistory: undefined,
      cadBrep: undefined,
      cadBrepFrame: undefined,
      cadDisplayEdges: undefined,
      cadDisplayEdgesVersion: undefined,
    };
    commitShapes(
      shapesRef.current.map((entry) => (entry.id === shape.id ? stripped : entry)),
      shape.id,
    );
    let applied = 0;
    for (const recipe of recipes) {
      const live = shapesRef.current.find((entry) => entry.id === shape.id);
      if (!live) break;
      try {
        const sharpAngle = recipe.sharpAngle ?? 25;
        const { response } = await prepareCadModifierForMcp(live, sharpAngle);
        const edgeIds = matchRecipeEdgeIds(recipe, response.edges, sharpAngle);
        if (edgeIds.length === 0) continue;
        await applyCadModifierForMcp(live, {
          kind: recipe.kind,
          amount: recipe.amount,
          sharpAngle,
          quality: recipe.quality ?? "standard",
          chamferAngle: recipe.chamferAngle ?? 45,
          edgeIds,
          preserveEdgeSize: shape.edgeResizeMode === "preserve",
        });
        applied += 1;
      } catch {
        // Keep going — partial re-apply is better than silent loss.
      }
    }
    if (applied === recipes.length) {
      setNotice(`Re-applied ${applied} edge feature${applied === 1 ? "" : "s"} after remesh`);
    } else if (applied > 0) {
      setNotice(`Re-applied ${applied} of ${recipes.length} edge features after remesh`);
    } else {
      setNotice("Body rebuilt. Could not auto re-apply fillet/chamfer — use Edge tools again.");
    }
  };

  useEffect(() => {
    const base = cadModifierBaseShapeRef.current;
    if (!edgeModifier || !base) return;
    const current = shapes.find((shape) => shape.id === base.id);
    if (current && projectShapesFingerprint([current]) === cadModifierBaseFingerprintRef.current) return;
    invalidateCadModifierSession();
    setNotice("Edge modifier cancelled because the object changed");
  }, [edgeModifier, invalidateCadModifierSession, shapes]);

  const applyEdgeModifier = useCallback(() => {
    const base = cadModifierBaseShapeRef.current;
    if (!edgeModifier?.preview || !base) {
      setNotice("Wait for a valid edge preview before applying");
      return;
    }
    const label = edgeModifier.kind === "fillet" ? "Filleted" : "Chamfered";
    const selectableCount = edgeModifier.edges.filter((edge) => selectableCadModifierEdge(edge, edgeModifier.sharpAngle)).length;
    const selectedEdgeIds = [...edgeModifier.selectedEdgeIds];
    const feature = {
      kind: edgeModifier.kind,
      amount: edgeModifier.amount,
      edgeCount: selectedEdgeIds.length,
      edgeIds: selectedEdgeIds,
      edgeFingerprints: fingerprintsForEdgeIds(edgeModifier.edges, selectedEdgeIds),
      allEdges: selectedEdgeIds.length === selectableCount,
      sharpAngle: edgeModifier.sharpAngle,
      quality: edgeModifier.quality,
      ...(edgeModifier.kind === "chamfer" ? { chamferAngle: edgeModifier.chamferAngle } : {}),
    } satisfies NonNullable<WorkplaneShape["edgeTreatments"]>[number];
    const createdAt = Date.now();
    const previewShape = canonicalizeShape({
      ...edgeModifier.preview,
      cadDisplayEdges: edgeModifier.preview.cadDisplayEdges?.length
        ? edgeModifier.preview.cadDisplayEdges
        : cadDisplayEdgesAfterTreatment(edgeModifier.preview, edgeModifier),
      cadDisplayEdgesVersion: 2,
    });
    const groupedModifiedShape = groupedShapeWithComponentEdgeTreatment(
      base,
      previewShape,
      cadModifierSourcePartsRef.current,
      edgeModifier,
      feature,
      createdAt,
    );
    const modifiedShape: WorkplaneShape = groupedModifiedShape ?? shapeWithEdgeTreatmentRecord(
      bakedEdgeTreatmentPreview(previewShape, base),
      base,
      feature,
      edgeModifier.preserveEdgeSize,
      createdAt,
    );
    commitShapes(
      shapes.map((shape) => shape.id === base.id ? modifiedShape : shape),
      base.id,
      `${label} ${edgeModifier.selectedEdgeIds.length} edge${edgeModifier.selectedEdgeIds.length === 1 ? "" : "s"}`,
    );
    invalidateCadModifierSession();
  }, [commitShapes, edgeModifier, invalidateCadModifierSession, shapes]);

  useEffect(() => {
    if (!edgeModifier) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelEdgeModifier();
      } else if (event.key === "Enter" && edgeModifier.preview && edgeModifier.selectedEdgeIds.length > 0 && !edgeModifier.busy && !edgeModifier.error) {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest("input, select, textarea, button, [contenteditable='true']")) return;
        event.preventDefault();
        applyEdgeModifier();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyEdgeModifier, cancelEdgeModifier, edgeModifier]);

  useEffect(() => {
    if (!edgeModifier?.prepared || edgeModifier.selectedEdgeIds.length === 0) return;
    const timer = window.setTimeout(() => {
      const requestId = postCadModifierRequest({
        type: "preview",
        kind: edgeModifier.kind,
        edgeIds: edgeModifier.selectedEdgeIds,
        amount: edgeModifier.amount,
        quality: edgeModifier.quality,
        chamferAngle: edgeModifier.chamferAngle,
      });
      if (requestId === null) {
        // The edge modifier panel renders this same error — skip the redundant toast.
        const message = cadModifierWorkerFailureMessage();
        setEdgeModifier((current) => current ? { ...current, busy: false, prepared: false, preview: null, error: message } : current);
        return;
      }
      cadModifierLatestPreviewRef.current = requestId;
      armCadModifierWatchdog(requestId, "preview");
      setEdgeModifier((current) => current ? { ...current, busy: true, error: null } : current);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [armCadModifierWatchdog, edgeModifier?.amount, edgeModifier?.chamferAngle, edgeModifier?.kind, edgeModifier?.prepared, edgeModifier?.quality, edgeModifier?.selectedEdgeIds, postCadModifierRequest]);

  const snapSelected = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    const selected = new Set(selectedIds);
    const grid = visibleGridStep(workspaceSettings);
    commitShapes(
      shapes.map((shape) =>
        selected.has(shape.id) && !shape.locked
          ? snapShapeFootprintToVisibleGrid(shape, meshAabb(shape), workspaceSettings)
          : shape,
      ),
      selectedIds,
      `Snapped ${selectedShapes.length} shape${selectedShapes.length === 1 ? "" : "s"} to ${grid} mm visible grid`,
    );
  }, [commitShapes, hasSelection, selectedIds, selectedShapes.length, shapes, workspaceSettings]);

  const toggleHidden = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    const selected = new Set(selectedIds);
    const shouldHide = selectedShapes.some((shape) => !shape.hidden);
    commitShapes(
      shapes.map((shape) => (selected.has(shape.id) && !shape.locked ? { ...shape, hidden: shouldHide } : shape)),
      selectedIds,
      shouldHide ? "Selection hidden" : "Selection visible",
    );
  }, [commitShapes, hasSelection, selectedIds, selectedShapes, shapes]);

  const showHidden = useCallback(() => {
    const hiddenCount = shapes.filter((shape) => shape.hidden).length;
    if (hiddenCount === 0) {
      setNotice("No hidden shapes");
      return;
    }
    commitShapes(
      shapes.map((shape) => ({ ...shape, hidden: false })),
      selectedIds,
      `Showed ${hiddenCount} hidden shape${hiddenCount === 1 ? "" : "s"}`,
    );
  }, [commitShapes, selectedIds, shapes]);

  const toggleLocked = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    const selected = new Set(selectedIds);
    const shouldLock = selectedShapes.some((shape) => !shape.locked);
    commitShapes(
      shapes.map((shape) => (selected.has(shape.id) ? { ...shape, locked: shouldLock } : shape)),
      selectedIds,
      shouldLock ? "Selection locked" : "Selection unlocked",
    );
  }, [commitShapes, hasSelection, selectedIds, selectedShapes, shapes]);

  const setSelectionHoleMode = useCallback(
    async (hole: boolean) => {
      if (!hasSelection) {
        setNotice("Select a shape first");
        return;
      }
      const selected = new Set(selectedIds);
      const nextShapes = shapesRef.current.map((shape) =>
        selected.has(shape.id) && !shape.locked ? withHoleMode(shape, hole) : shape,
      );

      if (hole) {
        // Face-sketch holes know their host — cut immediately instead of requiring a manual Group.
        const faceHoles = nextShapes.filter(
          (shape) => selected.has(shape.id) && shape.hole && shape.sketchPlane?.hostShapeId && !shape.locked,
        );
        for (const holeShape of faceHoles) {
          const hostId = holeShape.sketchPlane?.hostShapeId;
          const host = hostId ? nextShapes.find((shape) => shape.id === hostId && !shape.hole && !shape.locked && !shape.hidden) : null;
          if (!host) continue;
          const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
          const sourceProjectId = projectInfoRef.current.projectId;
          const result = await buildGroupedShapeFromSelection([withHoleMode(host, false), holeShape]);
          if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(shapesRef.current) !== sourceFingerprint) {
            setNotice("The scene changed while cutting; try Hole again");
            return;
          }
          if (result.group) {
            const linkedGroup = asPreservedCsgBody(host, result.group);
            commitShapes(
              shapesRef.current.filter((shape) => shape.id !== host.id && shape.id !== holeShape.id).concat(linkedGroup),
              linkedGroup.id,
              `Cut hole into ${host.name}`,
            );
            return;
          }
          if (result.consumed) {
            commitShapes(
              shapesRef.current.filter((shape) => shape.id !== host.id && shape.id !== holeShape.id),
              null,
              "Hole consumed the host solid",
            );
            return;
          }
          setNotice(result.failureNotice);
          return;
        }
      }

      commitShapes(
        nextShapes,
        selectedIds,
        hole
          ? "Changed selection to hole — select a solid and Group to cut"
          : "Changed selection to solid",
      );
    },
    [commitShapes, hasSelection, selectedIds],
  );

  const cutSelected = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    const selected = new Set(selectedIds);
    setClipboard(selectedShapes);
    writeSharedClipboard(selectedShapes);
    commitShapes(
      shapes.filter((shape) => !selected.has(shape.id)),
      [],
      `Cut ${selectedShapes.length} shape${selectedShapes.length === 1 ? "" : "s"}`,
    );
  }, [commitShapes, hasSelection, selectedIds, selectedShapes, shapes]);

  const raiseSelected = useCallback(
    (delta: number) => {
      if (!hasSelection) {
        return;
      }
      const selected = new Set(selectedIds);
      const repeatEntries: Array<{ shapeId: string; delta: ShapeRepeatDelta }> = [];
      selectedIds.forEach((shapeId) => {
        const shape = shapes.find((entry) => entry.id === shapeId);
        if (shape && !shape.locked) {
          repeatEntries.push({ shapeId, delta: { elevation: delta } });
        }
      });
      recordShapeRepeatActions(repeatEntries);
      commitShapes(
        shapes.map((shape) =>
          selected.has(shape.id) && !shape.locked
            ? {
                ...shape,
                elevation: Math.max(0, Math.min(180, (shape.elevation ?? 0) + delta)),
              }
            : shape,
        ),
        selectedIds,
        delta > 0 ? "Moved selection up" : "Moved selection down",
      );
    },
    [commitShapes, hasSelection, recordShapeRepeatActions, selectedIds, shapes],
  );

  const dropSelectedToWorkplane = useCallback(() => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    const selected = new Set(selectedIds);
    commitShapes(
      shapes.map((shape) => (selected.has(shape.id) && !shape.locked ? { ...shape, ...dropPatchForShape(shape, placementElevation) } : shape)),
      selectedIds,
      placementElevation === 0 ? "Dropped selection to the workplane" : `Dropped selection to ${placementElevation.toFixed(2)} mm workplane`,
    );
  }, [commitShapes, hasSelection, placementElevation, selectedIds, shapes]);

  const activateWorkplaneTool = useCallback(() => {
    setWorkplaneMode((active) => {
      const next = !active;
      setNotice(next ? "Workplane tool: click a shape top or empty grid" : "Workplane tool cancelled");
      return next;
    });
  }, []);

  const setPlacementWorkplane = useCallback((elevation: number, source: "shape" | "base") => {
    setPlacementElevation(elevation);
    setNotice(source === "shape" ? `Workplane set to ${elevation.toFixed(2)} mm` : "Workplane reset to base");
  }, []);

  const groupSelected = useCallback(async () => {
    if (selectedShapes.length < 2) {
      setNotice("Select at least two shapes to group");
      return;
    }

    if (selectedShapes.some((shape) => shape.locked)) {
      setNotice("Unlock every selected shape before grouping");
      return;
    }

    const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
    const sourceProjectId = projectInfoRef.current.projectId;
    const result = await buildGroupedShapeFromSelection(selectedShapes);
    if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(shapesRef.current) !== sourceFingerprint) {
      setNotice("The scene changed while grouping; select the objects and try again");
      return;
    }
    const { group } = result;
    if (!group) {
      if (result.consumed) {
        const selected = new Set(selectedIds);
        commitShapes(shapesRef.current.filter((shape) => !selected.has(shape.id)), null, "Grouped: hole consumed solid");
        return;
      }
      setNotice(result.failureNotice);
      return;
    }
    // Preserve sketch↔host links so later face sketches / re-cuts still find this body.
    let linkedGroup = group;
    for (const solid of selectedShapes.filter((shape) => !shape.hole)) {
      linkedGroup = rewriteSketchHostIds(linkedGroup, solid.id, group.id);
    }
    const selected = new Set(selectedIds);
    commitShapes([...shapesRef.current.filter((shape) => !selected.has(shape.id)), linkedGroup], linkedGroup.id, `Grouped ${selectedShapes.length} shapes`);
    scheduleCsgBrepBake(linkedGroup);
    if (result.qualityNotice) {
      setNotice(result.qualityNotice);
    }
  }, [commitShapes, scheduleCsgBrepBake, selectedIds, selectedShapes]);

  const intersectSelected = useCallback(async () => {
    const groupable = selectedShapes.filter((shape) => !shape.locked);
    const hasSolid = groupable.some((shape) => !shape.hole);
    const hasHole = groupable.some((shape) => shape.hole);
    if (!hasSolid || !hasHole) {
      setNotice("Select at least one solid and one hole for Intersection");
      return;
    }

    const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
    const sourceProjectId = projectInfoRef.current.projectId;
    const result = await buildIntersectionShapeFromSelection(groupable);
    if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(shapesRef.current) !== sourceFingerprint) {
      setNotice("The scene changed while intersecting; select the objects and try again");
      return;
    }
    if (!result.group && !result.empty) {
      setNotice(result.failureNotice);
      return;
    }

    const operandIds = new Set(groupable.map((shape) => shape.id));
    const remainingShapes = shapesRef.current.filter((shape) => !operandIds.has(shape.id));
    if (result.empty) {
      commitShapes(remainingShapes, null, "Intersection is empty");
      return;
    }

    const intersection = result.group;
    if (!intersection) {
      return;
    }
    commitShapes([...remainingShapes, intersection], intersection.id, `Intersected ${groupable.length} shapes`);
  }, [commitShapes, selectedShapes]);

  const ungroupSelected = useCallback(() => {
    const groups = selectedShapes.filter((shape) => shape.groupedShapes?.length);
    if (groups.length === 0) {
      setNotice("Select a group first");
      return;
    }
    const groupIds = new Set(groups.map((shape) => shape.id));
    const restored = groups.flatMap((group) => restoreGroupedChildren(group));
    commitShapes([...shapes.filter((shape) => !groupIds.has(shape.id)), ...restored], restored.map((shape) => shape.id), `Ungrouped ${groups.length} group${groups.length === 1 ? "" : "s"}`);
  }, [commitShapes, selectedShapes, shapes]);

  const separateSelectedParts = useCallback(() => {
    if (selectedShapes.length !== 1 || !selectedShape) {
      setNotice("Select one object to separate");
      return;
    }
    if (selectedShape.locked) {
      setNotice("Unlock the object before separating parts");
      return;
    }
    const parts = separateShapeParts(selectedShape);
    if (parts.length <= 1) {
      setNotice("The selected object has only one connected part");
      return;
    }
    const separatedThreads = canSeparateThreadScrew(selectedShape);
    commitShapes(
      [...shapes.filter((shape) => shape.id !== selectedShape.id), ...parts],
      parts.map((shape) => shape.id),
      separatedThreads ? "Separated shaft and thread cutter" : `Separated ${parts.length} parts`,
    );
    if (separatedThreads) {
      setNotice("Shaft kept as solid; thread cutter is a Hole — adjust Clearance, then Group with your part");
    }
  }, [commitShapes, selectedShape, selectedShapes.length, shapes]);

  const mcpSceneSnapshot = useCallback((includeRawShapes = false): SketchForgeMcpSceneSummary & { rawShapes?: WorkplaneShape[] } => {
    const projectInfo = projectInfoRef.current;
    const currentShapes = shapesRef.current;
    return {
      projectId: projectInfo.projectId,
      projectName: projectInfo.projectName,
      notice: noticeRef.current,
      selectedIds: selectedIdsRef.current,
      shapeCount: currentShapes.length,
      workspace: workspaceSettingsRef.current,
      snap: snapGrid,
      shapes: currentShapes.map(mcpShapeSummary),
      ...(includeRawShapes ? { rawShapes: currentShapes.map((shape) => canonicalizeShape(shape)) } : {}),
    };
  }, [snapGrid]);

  const executeMcpCommand = useCallback(async (command: SketchForgeMcpCommand): Promise<unknown> => {
    const params = command.params ?? {};
    const currentShapes = () => shapesRef.current;
    const findShape = (id: unknown) => (typeof id === "string" ? currentShapes().find((shape) => shape.id === id) ?? null : null);

    try {
      lastMcpErrorRef.current = null;
      if (command.action === "get_scene") {
        return mcpSceneSnapshot(params.includeRawShapes === true);
      }

      if (command.action === "list_objects") {
        return { objects: currentShapes().map(mcpShapeSummary) };
      }

      if (command.action === "select_objects") {
        const requestedIds = mcpStringArray(params.ids ?? params.id);
        const validIds = requestedIds.filter((id) => currentShapes().some((shape) => shape.id === id));
        setSelectedIds(validIds);
        selectedIdsRef.current = validIds;
        setNotice(validIds.length ? `MCP selected ${validIds.length} object${validIds.length === 1 ? "" : "s"}` : "MCP cleared selection");
        return { selectedIds: validIds, objects: currentShapes().filter((shape) => validIds.includes(shape.id)).map(mcpShapeSummary) };
      }

      if (command.action === "delete_objects") {
        const requestedIds = mcpStringArray(params.ids ?? params.id);
        const ids = requestedIds.length ? new Set(requestedIds) : new Set(selectedIdsRef.current);
        const deleted = currentShapes().filter((shape) => ids.has(shape.id));
        if (deleted.length === 0) throw new Error("No matching objects to delete");
        commitShapes(currentShapes().filter((shape) => !ids.has(shape.id)), [], `MCP deleted ${deleted.length} object${deleted.length === 1 ? "" : "s"}`);
        selectedIdsRef.current = [];
        return { deletedIds: deleted.map((shape) => shape.id), deletedCount: deleted.length };
      }

      if (command.action === "create_shape") {
        const rawKind = mcpString(params.kind, "box");
        const kind = rawKind === "cube" ? "box" : rawKind;
        const width = Math.max(MIN_SHAPE_DIMENSION, mcpNumber(params.width ?? params.size, 20));
        const depth = Math.max(MIN_SHAPE_DIMENSION, mcpNumber(params.depth ?? params.size, rawKind === "cube" ? width : 20));
        const height = Math.max(MIN_SHAPE_DIMENSION, mcpNumber(params.height ?? params.size, rawKind === "cube" ? width : 20));
        const x = mcpNumber(params.x, 0);
        const z = mcpNumber(params.z, 0);
        const elevation = mcpNumber(params.elevation, placementElevation);
        const color = mcpString(params.color, kind === "cylinder" ? "#d97813" : "#d41721");
        const name = mcpString(params.name, kind === "cylinder" ? "Cylinder" : kind === "sketch" ? "Sketch extrusion" : rawKind === "cube" ? "Cube" : "Box");
        let shape: WorkplaneShape;
        if (kind === "sketch") {
          const hostShapeId = typeof params.hostShapeId === "string" && params.hostShapeId.trim()
            ? params.hostShapeId.trim()
            : undefined;
          const host = hostShapeId
            ? currentShapes().find((entry) => entry.id === hostShapeId && !entry.hole && !entry.hidden)
            : undefined;
          // Bake on the host top face when hosted so hole auto-cut overlaps the solid.
          const hostPlane = host
            ? {
                ...defaultSketchPlane(),
                origin: {
                  x: host.x,
                  y: (host.elevation ?? 0) + host.height,
                  z: host.z,
                },
                uAxis: { x: 1, y: 0, z: 0 },
                vAxis: { x: 0, y: 0, z: 1 },
                normal: { x: 0, y: 1, z: 0 },
                hostShapeId,
              }
            : undefined;
          const profile = {
            ...defaultMcpSketchProfile(width, depth),
            ...(hostPlane ? { sketchPlane: hostPlane } : {}),
          };
          const extruded = shapeFromSketchProfile(profile, height);
          if (!extruded) throw new Error("Could not create the sketch profile");
          const withHost = hostPlane
            ? {
                ...extruded,
                sketchPlane: hostPlane,
                sketchProfile: extruded.sketchProfile
                  ? { ...extruded.sketchProfile, sketchPlane: hostPlane }
                  : extruded.sketchProfile,
              }
            : extruded;
          shape = canonicalizeShape({
            ...withHost,
            name,
            color,
            x: host ? host.x + x : x,
            z: host ? host.z + z : z,
            elevation: host ? (host.elevation ?? 0) + host.height : elevation,
            rotation: mcpNumber(params.rotation, 0),
            rotationX: mcpNumber(params.rotationX, 0),
            rotationZ: mcpNumber(params.rotationZ, 0),
          });
        } else if (kind === "box" || kind === "cylinder") {
          shape = sceneShape({
            name,
            kind,
            color,
            x,
            z,
            elevation,
            width,
            depth,
            height,
            size: Math.max(width, depth),
            rotation: mcpNumber(params.rotation, 0),
            rotationX: mcpNumber(params.rotationX, 0),
            rotationZ: mcpNumber(params.rotationZ, 0),
            sides: kind === "cylinder" ? Math.max(3, Math.floor(mcpNumber(params.sides, 96))) : undefined,
          });
        } else {
          throw new Error("MCP create_shape currently supports box, cube, cylinder, and sketch");
        }
        const committedShape = canonicalizeShape(bakeShapeTransformIntoMesh(shape));
        commitShapes([...currentShapes(), committedShape], committedShape.id, `${committedShape.name} added by MCP`);
        return { object: mcpShapeSummary(committedShape) };
      }

      if (command.action === "import_mesh") {
        const positions = mcpFiniteNumberArray(params.positions);
        const normals = mcpFiniteNumberArray(params.normals);
        if (positions.length < 9 || positions.length % 9 !== 0) {
          throw new Error("import_mesh requires positions as triangle xyz values");
        }
        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < positions.length; index += 3) {
          const x = positions[index];
          const y = positions[index + 1];
          const z = positions[index + 2];
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
        const width = Math.max(MIN_SHAPE_DIMENSION, mcpNumber(params.width, maxX - minX));
        const depth = Math.max(MIN_SHAPE_DIMENSION, mcpNumber(params.depth, maxZ - minZ));
        const height = Math.max(MIN_SHAPE_DIMENSION, mcpNumber(params.height, maxY - minY));
        const shape = canonicalizeShape({
          id: createLocalId("mcp-imported-mesh"),
          name: mcpString(params.name, "Imported mesh"),
          kind: "mesh",
          color: mcpString(params.color, "#9bd7f0"),
          x: mcpNumber(params.x, 0),
          z: mcpNumber(params.z, 0),
          elevation: mcpNumber(params.elevation, 0),
          size: Math.max(width, depth),
          width,
          depth,
          height,
          rotation: mcpNumber(params.rotation, 0),
          rotationX: mcpNumber(params.rotationX, 0),
          rotationZ: mcpNumber(params.rotationZ, 0),
          importedMesh: {
            positions,
            normals: normals.length === positions.length ? normals : undefined,
            baseWidth: width,
            baseDepth: depth,
            baseHeight: height,
            triangleCount: Math.floor(positions.length / 9),
            sourceFormat: "json",
          },
          locked: false,
          hidden: false,
        } satisfies WorkplaneShape);
        commitShapes([...currentShapes(), shape], shape.id, `${shape.name} imported by MCP`);
        return { object: mcpShapeSummary(shape) };
      }

      if (command.action === "update_object") {
        const target = findShape(params.id);
        if (!target) throw new Error("Object not found");
        if (target.locked) throw new Error("Unlock the object before updating it");
        const patch: ShapeUpdatePatch = {};
        const rotationWasRequested = [params.rotation, params.rotationX, params.rotationZ].some(
          (value) => typeof value === "number" && Number.isFinite(value),
        );
        (["x", "z", "elevation", "width", "depth", "height", "size", "rotation", "rotationX", "rotationZ"] as const).forEach((key) => {
          if (typeof params[key] === "number" && Number.isFinite(params[key])) {
            patch[key] = params[key];
          }
        });
        if (typeof params.color === "string") patch.color = params.color;
        if (typeof params.name === "string") patch.name = params.name;
        if (typeof params.hole === "boolean") patch.hole = params.hole;

        // Face-sketch cutters: mirror updateShape auto-cut when MCP sets hole:true.
        if (patch.hole && target.sketchPlane?.hostShapeId) {
          const holeShape = withHoleMode(target, true, typeof patch.color === "string" ? patch.color : undefined);
          const hostId = target.sketchPlane.hostShapeId;
          const host = currentShapes().find(
            (shape) => shape.id === hostId && !shape.hole && !shape.locked && !shape.hidden,
          );
          if (!host) {
            const nextShapes = currentShapes().map((shape) => (shape.id === target.id ? holeShape : shape));
            commitShapes(nextShapes, target.id, "MCP changed selection to hole — select a solid and Group to cut");
            return { object: mcpShapeSummary(holeShape), autoCut: false, reason: "host_not_found" };
          }
          const sourceFingerprint = projectShapesFingerprint(currentShapes());
          const sourceProjectId = projectInfoRef.current.projectId;
          const result = await buildGroupedShapeFromSelection([withHoleMode(host, false), holeShape]);
          if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(currentShapes()) !== sourceFingerprint) {
            throw new Error("The scene changed while cutting; run the command again");
          }
          if (result.group) {
            const linkedGroup = asPreservedCsgBody(host, result.group);
            commitShapes(
              currentShapes().filter((shape) => shape.id !== host.id && shape.id !== target.id).concat(linkedGroup),
              linkedGroup.id,
              `MCP cut hole into ${host.name}`,
            );
            return { object: mcpShapeSummary(linkedGroup), autoCut: true };
          }
          if (result.consumed) {
            commitShapes(
              currentShapes().filter((shape) => shape.id !== host.id && shape.id !== target.id),
              null,
              "MCP hole consumed the host solid",
            );
            return { consumed: true, autoCut: true };
          }
          const nextShapes = currentShapes().map((shape) => (shape.id === target.id ? holeShape : shape));
          commitShapes(nextShapes, target.id, result.failureNotice);
          return { object: mcpShapeSummary(holeShape), autoCut: false, reason: result.failureNotice };
        }

        const nextShapes = currentShapes().map((shape) => {
          if (shape.id !== target.id) return shape;
          const patched = { ...shape, ...cleanShapePatch(patch) };
          const width = shapeWidth(patched);
          const depth = shapeDepth(patched);
          const sized = { ...patched, size: Math.max(width, depth) };
          const canonical = canonicalizeShape(
            "hole" in patch ? withHoleMode(sized, Boolean(patch.hole), typeof patch.color === "string" ? patch.color : undefined) : sized,
          );
          return rotationWasRequested ? canonicalizeShape(bakeShapeTransformIntoMesh(canonical)) : canonical;
        });
        const updated = nextShapes.find((shape) => shape.id === target.id) as WorkplaneShape;
        commitShapes(nextShapes, target.id, `${updated.name} updated by MCP`);
        return { object: mcpShapeSummary(updated) };
      }

      if (command.action === "align_objects") {
        const axis = params.axis === "x" || params.axis === "y" || params.axis === "z" ? params.axis : null;
        const target = params.target === "min" || params.target === "center" || params.target === "max" ? params.target : null;
        if (!axis || !target) throw new Error("align_objects requires axis x/y/z and target min/center/max");
        const requestedIds = mcpStringArray(params.ids);
        const ids = requestedIds.length ? requestedIds : selectedIdsRef.current;
        const selectedForAlign = currentShapes().filter((shape) => ids.includes(shape.id));
        if (selectedForAlign.length < 2) throw new Error("Select at least two objects to align");
        const validIds = selectedForAlign.map((shape) => shape.id);
        const requestedAnchorId = typeof params.anchorId === "string" ? params.anchorId : null;
        const anchorId = effectiveAlignmentAnchorId(selectedForAlign, requestedAnchorId);
        const { nextShapes, moved } = alignedShapesForSelection(currentShapes(), validIds, selectedForAlign, anchorId, axis, target);
        if (moved === 0) {
          setSelectedIds(validIds);
          selectedIdsRef.current = validIds;
          setNotice(`MCP alignment already ${alignmentLabel(axis, target)}`);
          return {
            moved,
            selectedIds: validIds,
            anchorId,
            objects: selectedForAlign.map(mcpShapeSummary),
          };
        }
        commitShapes(nextShapes, validIds, `MCP aligned ${moved} object${moved === 1 ? "" : "s"} ${alignmentLabel(axis, target)}`);
        return {
          moved,
          selectedIds: validIds,
          anchorId,
          objects: nextShapes.filter((shape) => validIds.includes(shape.id)).map(mcpShapeSummary),
        };
      }

      if (command.action === "group_objects") {
        const ids = new Set(mcpStringArray(params.ids));
        const groupable = currentShapes().filter((shape) => ids.has(shape.id));
        if (groupable.length < 2) throw new Error("Select at least two objects to group");
        if (groupable.some((shape) => shape.locked)) throw new Error("Unlock every selected object before grouping");
        const sourceFingerprint = projectShapesFingerprint(currentShapes());
        const sourceProjectId = projectInfoRef.current.projectId;
        const result = await buildGroupedShapeFromSelection(groupable);
        if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(currentShapes()) !== sourceFingerprint) {
          throw new Error("The scene changed while grouping; run the command again");
        }
        if (!result.group) {
          if (result.consumed) {
            commitShapes(currentShapes().filter((shape) => !ids.has(shape.id)), null, "MCP group consumed solid");
            return { consumed: true, objects: currentShapes().filter((shape) => !ids.has(shape.id)).map(mcpShapeSummary) };
          }
          throw new Error(result.failureNotice);
        }
        commitShapes([...currentShapes().filter((shape) => !ids.has(shape.id)), result.group], result.group.id, `MCP grouped ${groupable.length} objects`);
        return { object: mcpShapeSummary(result.group) };
      }

      if (command.action === "ungroup_objects") {
        const requestedIds = mcpStringArray(params.ids ?? params.id);
        const ids = requestedIds.length ? new Set(requestedIds) : new Set(selectedIdsRef.current);
        const groups = currentShapes().filter((shape) => ids.has(shape.id) && shape.groupedShapes?.length);
        if (groups.length === 0) throw new Error("Select at least one group to ungroup");
        const groupIds = new Set(groups.map((shape) => shape.id));
        const restored = groups.flatMap((group) => restoreGroupedChildren(group));
        commitShapes([...currentShapes().filter((shape) => !groupIds.has(shape.id)), ...restored], restored.map((shape) => shape.id), `MCP ungrouped ${groups.length} group${groups.length === 1 ? "" : "s"}`);
        return { objects: restored.map(mcpShapeSummary) };
      }

      if (command.action === "boolean_cut") {
        const solidIds = new Set(mcpStringArray(params.solidIds ?? params.solids));
        const holeIds = new Set(mcpStringArray(params.holeIds ?? params.holes));
        const operandIds = new Set([...solidIds, ...holeIds]);
        const operands = currentShapes()
          .filter((shape) => operandIds.has(shape.id))
          .map((shape) => holeIds.has(shape.id) ? withHoleMode(shape, true) : withHoleMode(shape, false));
        if (!operands.some((shape) => !shape.hole) || !operands.some((shape) => shape.hole)) {
          throw new Error("Provide at least one solidId and one holeId for boolean_cut");
        }
        if (operands.some((shape) => shape.locked)) {
          throw new Error("Unlock every boolean operand before cutting");
        }
        const sourceFingerprint = projectShapesFingerprint(currentShapes());
        const sourceProjectId = projectInfoRef.current.projectId;
        const result = await buildGroupedShapeFromSelection(operands);
        if (projectInfoRef.current.projectId !== sourceProjectId || projectShapesFingerprint(currentShapes()) !== sourceFingerprint) {
          throw new Error("The scene changed while cutting; run the command again");
        }
        const remainingShapes = currentShapes().filter((shape) => !operandIds.has(shape.id));
        if (result.consumed) {
          commitShapes(remainingShapes, null, "MCP cut consumed solid");
          return { consumed: true };
        }
        if (!result.group) {
          throw new Error(result.failureNotice);
        }
        commitShapes([...remainingShapes, result.group], result.group.id, "MCP boolean cut complete");
        return { object: mcpShapeSummary(result.group) };
      }

      if (command.action === "separate_parts") {
        const target = findShape(params.id) ?? (selectedIdsRef.current.length === 1 ? findShape(selectedIdsRef.current[0]) : null);
        if (!target) throw new Error("Select one object to separate");
        if (target.locked) throw new Error("Unlock the object before separating parts");
        const parts = separateShapeParts(target);
        if (parts.length <= 1) throw new Error("The selected object has only one connected part");
        commitShapes([...currentShapes().filter((shape) => shape.id !== target.id), ...parts], parts.map((shape) => shape.id), `MCP separated ${parts.length} parts`);
        return { objects: parts.map(mcpShapeSummary) };
      }

      if (command.action === "list_edges") {
        const target = findShape(params.id);
        if (!target) throw new Error("Object not found");
        invalidateCadModifierSession();
        const sharpAngle = Math.max(1, Math.min(CAD_MODIFIER_MAX_SHARP_ANGLE, mcpNumber(params.sharpAngle, 25)));
        const { response } = await prepareCadModifierForMcp(target, sharpAngle);
        const selectableEdgeIds = response.edges.filter((edge) => selectableCadModifierEdge(edge, sharpAngle)).map((edge) => edge.id);
        return { object: mcpShapeSummary(target), sharpAngle, selectableEdgeIds, edges: response.edges };
      }

      if (command.action === "apply_edge_treatment") {
        const target = findShape(params.id);
        if (!target) throw new Error("Object not found");
        return applyCadModifierForMcp(target, params);
      }

      if (command.action === "edit_sketch") {
        const raw = findShape(params.id)
          ?? (typeof params.id === "string" ? findShapeInTree(currentShapes(), params.id) : null)
          ?? (selectedIdsRef.current[0] ? findShape(selectedIdsRef.current[0]) : null);
        const target = resolveEditableSketchShape(raw, { preferFaceFeatures: true });
        if (!target || !shapeHasEditableSketch(target)) throw new Error("edit_sketch requires a sketched solid or face sketch feature id");
        const session = beginEditSketchSession(target, "2d");
        if (!session?.doc) throw new Error("Shape has no editable sketch document");
        const profile = target.sketchProfile ?? sketchDocToProfile(session.doc);
        beginSketch(profile, target.id, target.sketchPlane ?? session.doc.plane, session.doc);
        return {
          editingShapeId: target.id,
          sketchId: session.doc.id,
          status: solveSketchDoc(session.doc).status,
          constraintCount: session.doc.constraints.length,
          dimensionCount: session.doc.dimensions.length,
        };
      }

      if (command.action === "set_sketch_dimension") {
        const raw = findShape(params.id)
          ?? (typeof params.id === "string" ? findShapeInTree(currentShapes(), params.id) : null)
          ?? (selectedIdsRef.current[0] ? findShape(selectedIdsRef.current[0]) : null);
        const target = resolveEditableSketchShape(raw);
        if (!target?.sketchDoc) throw new Error("set_sketch_dimension requires a sketched solid with sketchDoc");
        const dimensionId = typeof params.dimensionId === "string" ? params.dimensionId : target.sketchDoc.dimensions[0]?.id;
        const value = typeof params.value === "number" ? params.value : Number.NaN;
        if (!dimensionId || !Number.isFinite(value) || value <= 0) throw new Error("Provide dimensionId and a positive value");
        const solved = setDrivingDimensionValue(target.sketchDoc, dimensionId, value);
        const profile = sketchDocToProfile(solved.doc);
        profile.sketchPlane = target.sketchPlane ?? profile.sketchPlane;
        const rebuilt = shapeFromSketchProfile(profile, target.height, {
          ...target,
          sketchDoc: solved.doc,
          sketchId: target.sketchId ?? solved.doc.id,
        }, {
          cutIntoFace: Boolean(target.hole && isFaceHostedSketch(target.sketchPlane, target.sketchProfile?.faceReferenceLoops)),
        });
        if (!rebuilt) throw new Error("Could not rebuild sketch after dimension change");
        rebuilt.sketchDoc = solved.doc;
        rebuilt.hole = target.hole;
        rebuilt.color = target.color;
        const owner = findCsgBodyOwningLeaf(currentShapes(), target.id);
        if (owner) {
          const remeshGen = remeshGenerationRef.current + 1;
          remeshGenerationRef.current = remeshGen;
          const { body, remeshed } = await updateCsgLeafAndRemesh(owner, target.id, rebuilt);
          if (remeshGen !== remeshGenerationRef.current) {
            return { object: mcpShapeSummary(owner), dimensionId, value, status: solved.status, dof: solved.dof, remeshed: false, stale: true };
          }
          commitShapes(
            currentShapes().map((shape) => (shape.id === owner.id ? body : shape)),
            body.id,
            `MCP sketch dimension → ${value.toFixed(2)} mm`,
          );
          if (!remeshed) {
            setNotice("Could not remesh after dimension change — last good mesh kept. Ungroup then Group to retry.");
          }
          return {
            object: mcpShapeSummary(body),
            dimensionId,
            value,
            status: solved.status,
            dof: solved.dof,
            remeshed,
          };
        }
        commitShapes(
          currentShapes().map((shape) => (shape.id === target.id ? rebuilt : shape)),
          rebuilt.id,
          `MCP sketch dimension → ${value.toFixed(2)} mm`,
        );
        return {
          object: mcpShapeSummary(rebuilt),
          dimensionId,
          value,
          status: solved.status,
          dof: solved.dof,
        };
      }

      if (command.action === "inspect_errors") {
        return {
          notice: noticeRef.current,
          edgeModifierError: edgeModifierRef.current?.error ?? null,
          lastMcpError: lastMcpErrorRef.current,
        };
      }

      if (command.action === "capture_image") {
        const face = mcpString(params.face, "current") as SketchForgeMcpViewFace;
        const image = await (window.sketchforgeCaptureView?.(face) ?? window.sketchforgeCaptureCanvas?.() ?? "");
        if (!image || image.length < 100) {
          throw new Error("The SketchForge viewport did not return an image");
        }
        return { face, dataUrl: image, bytesApprox: Math.floor(image.length * 0.75) };
      }

      throw new Error(`Unknown MCP command: ${command.action}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastMcpErrorRef.current = message;
      setNotice(message);
      throw error;
    }
  }, [
    applyCadModifierForMcp,
    beginSketch,
    commitShapes,
    initialSnap,
    invalidateCadModifierSession,
    mcpSceneSnapshot,
    placementElevation,
    prepareCadModifierForMcp,
  ]);

  useEffect(() => {
    executeMcpCommandRef.current = executeMcpCommand;
  }, [executeMcpCommand]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || typeof window === "undefined") {
      return;
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
      return;
    }

    const identity = readMcpEditorIdentity();
    let stopped = false;
    let polling = false;

    const heartbeat = () => {
      const projectInfo = projectInfoRef.current;
      const currentShapes = shapesRef.current;
      void fetch(SKETCHFORGE_MCP_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "heartbeat",
          editor: {
            ...identity,
            projectId: projectInfo.projectId,
            projectName: projectInfo.projectName,
            url: window.location.href,
            focused: document.visibilityState === "visible" && document.hasFocus(),
            shapeCount: currentShapes.length,
            selectedCount: selectedIdsRef.current.length,
            notice: noticeRef.current,
            lastError: edgeModifierRef.current?.error ?? lastMcpErrorRef.current,
          },
        }),
      }).catch(() => undefined);
    };

    const submitResult = (commandId: string, ok: boolean, data?: unknown, error?: string) => {
      void fetch(SKETCHFORGE_MCP_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "result",
          editorId: identity.editorId,
          result: { commandId, ok, data, error, completedAt: Date.now() },
        }),
      }).catch(() => undefined);
    };

    const poll = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const response = await fetch(SKETCHFORGE_MCP_ROUTE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "poll", editorId: identity.editorId }),
        });
        const payload = (await response.json().catch(() => null)) as { command?: SketchForgeMcpCommand | null } | null;
        const command = payload?.command;
        if (command) {
          try {
            const data = await executeMcpCommandRef.current?.(command);
            submitResult(command.id, true, data);
          } catch (error) {
            submitResult(command.id, false, undefined, error instanceof Error ? error.message : String(error));
          }
        }
      } catch {
        // The local bridge may not exist while static builds or tests render the editor.
      } finally {
        polling = false;
      }
    };

    heartbeat();
    void poll();
    const heartbeatTimer = window.setInterval(heartbeat, 1000);
    const pollTimer = window.setInterval(() => void poll(), SKETCHFORGE_MCP_POLL_MS);
    window.addEventListener("focus", heartbeat);
    document.addEventListener("visibilitychange", heartbeat);
    return () => {
      stopped = true;
      window.clearInterval(heartbeatTimer);
      window.clearInterval(pollTimer);
      window.removeEventListener("focus", heartbeat);
      document.removeEventListener("visibilitychange", heartbeat);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || typeof window === "undefined") {
      return;
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const caseId = params.get("codexBooleanCase");
    if (!caseId) {
      return;
    }

    const modeParam = params.get("codexBooleanMode");
    const mode: BooleanAutomationMode = modeParam === "before" || modeParam === "ungroup" ? modeParam : "after";
    const runKey = `${caseId}:${mode}`;
    if (booleanAutomationRunRef.current === runKey) {
      return;
    }
    booleanAutomationRunRef.current = runKey;
    document.body.dataset.codexBooleanTestDone = "running";
    delete document.body.dataset.codexBooleanTestResult;
    delete document.body.dataset.codexBooleanTestImageReady;
    delete document.body.dataset.codexBooleanTestScreenshotPath;

    const finish = (detail: BooleanAutomationResult) => {
      window.__sketchforgeBooleanTest = detail;
      const captureCanvas = () => {
        try {
          const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
          const image = window.sketchforgeCaptureCanvas?.() ?? canvas?.toDataURL("image/png") ?? "";
          if (image.length > 100) {
            window.__sketchforgeBooleanTestImage = image;
            document.body.dataset.codexBooleanTestImageReady = "true";
            void fetch("/api/codex-screenshot", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: `boolean-${detail.caseId}-${detail.mode}.png`, dataUrl: image }),
            })
              .then((response) => (response.ok ? response.json() : null))
              .then((payload: { path?: string } | null) => {
                if (payload?.path) {
                  document.body.dataset.codexBooleanTestScreenshotPath = payload.path;
                }
              })
              .catch(() => {
                document.body.dataset.codexBooleanTestImageReady = "false";
              });
          }
        } catch {
          document.body.dataset.codexBooleanTestImageReady = "false";
        }
      };
      const publish = () => {
        document.body.dataset.codexBooleanTestDone = detail.ok ? "true" : "false";
        document.body.dataset.codexBooleanTestResult = JSON.stringify(detail);
        window.dispatchEvent(new CustomEvent("sketchforge:boolean-test-done", { detail }));
      };
      publish();
      window.setTimeout(publish, 100);
      window.setTimeout(captureCanvas, 1000);
      window.setTimeout(captureCanvas, 1800);
    };

    const run = async () => {
      const testCase = booleanAutomationScene(caseId);
      if (!testCase) {
        finish({
          ok: false,
          caseId,
          label: "Unknown boolean test",
          mode,
          notice: "Unknown boolean automation case",
          shapeCount: 0,
          selectedCount: 0,
          error: `Unknown boolean automation case: ${caseId}`,
        });
        return;
      }

      const ids = testCase.shapes.map((shape) => shape.id);
      if (mode === "before") {
        const noticeText = `Boolean test before: ${testCase.label}`;
        commitShapes(testCase.shapes, ids, noticeText);
        finish({
          ok: true,
          caseId,
          label: testCase.label,
          mode,
          notice: noticeText,
          shapeCount: testCase.shapes.length,
          selectedCount: ids.length,
        });
        return;
      }

      const result = await buildGroupedShapeFromSelection(testCase.shapes);
      if (!result.group) {
        const noticeText = result.consumed ? "Grouped: hole consumed solid" : result.failureNotice;
        commitShapes(result.consumed ? [] : testCase.shapes, result.consumed ? [] : ids, noticeText);
        finish({
          ok: result.consumed,
          caseId,
          label: testCase.label,
          mode,
          notice: noticeText,
          shapeCount: result.consumed ? 0 : testCase.shapes.length,
          selectedCount: result.consumed ? 0 : ids.length,
          error: result.consumed ? undefined : result.failureNotice,
        });
        return;
      }

      const triangleCount = result.group.importedMesh?.triangleCount ?? meshForShape(result.group).faces.length;
      const groupedCount = result.group.groupedShapes?.length ?? 0;
      if (mode === "ungroup") {
        const restored = restoreGroupedChildren(result.group);
        const noticeText = `Boolean test ungrouped: ${testCase.label}`;
        commitShapes(restored, restored.map((shape) => shape.id), noticeText);
        finish({
          ok: restored.length === groupedCount,
          caseId,
          label: testCase.label,
          mode,
          notice: noticeText,
          shapeCount: restored.length,
          selectedCount: restored.length,
          triangleCount,
          groupedCount,
          groupId: result.group.id,
        });
        return;
      }

      const noticeText = `Boolean test after: ${testCase.label}`;
      commitShapes([result.group], result.group.id, noticeText);
      finish({
        ok: true,
        caseId,
        label: testCase.label,
        mode,
        notice: noticeText,
        shapeCount: 1,
        selectedCount: 1,
        triangleCount,
        groupedCount,
        groupId: result.group.id,
      });
    };

    void run();
  }, [commitShapes]);

  const exportDesign = useCallback((format: ExportFormat) => {
    const sourceShapes = hasSelection ? selectedShapes : shapes;
    const exportable = sourceShapes.filter((shape) => !shape.hole);
    if (exportable.length === 0) {
      setNotice(hasSelection ? "Select at least one solid shape before exporting" : "Add a solid shape before exporting");
      return;
    }
    const invalidSvg = exportable.map(invalidSvgMeshReason).find((reason): reason is string => Boolean(reason));
    if (invalidSvg) {
      setNotice(`${invalidSvg}. Re-import the source SVG after fixing its contours`);
      return;
    }
    const meshes = exportable.map(meshForShape);
    const selectedNotice = `Exported ${exportable.length} selected shape${exportable.length === 1 ? "" : "s"}`;
    const finishNotice = (label: string, result: DownloadResult) => {
      celebrateExport(label, `${exportable.length} solid${exportable.length === 1 ? "" : "s"}`);
      if (result.mode === "folder") {
        setNotice(`Saved ${label} to ${result.path}`);
        return;
      }
      setNotice(hasSelection ? `${selectedNotice} as ${label}` : `Exported ${label}`);
    };
    const failNotice = (label: string, error: unknown) => {
      setNotice(error instanceof Error ? error.message : `Could not export ${label}`);
    };
    if (format === "stl") {
      void downloadBlobFile(projectExportFileName(projectName, "stl"), toStl(meshes), "model/stl")
        .then((result) => finishNotice("STL", result))
        .catch((error: unknown) => failNotice("STL", error));
      return;
    }
    if (format === "3mf") {
      try {
        const bytes = to3mf(meshes);
        void downloadBlobFile(projectExportFileName(projectName, "3mf"), bytes, "model/3mf")
          .then((result) => finishNotice("3MF", result))
          .catch((error: unknown) => failNotice("3MF", error));
      } catch (error: unknown) {
        failNotice("3MF", error);
      }
      return;
    }
    void downloadTextFile(projectExportFileName(projectName, "obj"), toObj(meshes), "text/plain")
      .then((result) => finishNotice("OBJ", result))
      .catch((error: unknown) => failNotice("OBJ", error));
  }, [celebrateExport, hasSelection, projectName, selectedShapes, shapes]);

  const exportStepDesign = useCallback(async () => {
    if (stepExporting) {
      return;
    }
    const sourceShapes = hasSelection ? selectedShapes : shapes;
    if (sourceShapes.some((shape) => shape.hole) && !sourceShapes.some((shape) => !shape.hole)) {
      setNotice("Select at least one solid shape before exporting STEP");
      return;
    }
    const preflight = buildStepExportPreflight(sourceShapes);
    const pending = preflight.filter((row) => row.quality === "pending");
    const facetedPreview = preflight.filter((row) => row.quality === "faceted").length;
    const exactPreview = preflight.filter((row) => row.quality === "exact").length;
    if (pending.length > 0) {
      setNotice(
        `STEP preflight: ${exactPreview} exact · ${facetedPreview} faceted · ${pending.length} pending (${pending.map((row) => row.name).join(", ")}). Building anyway…`,
      );
    } else {
      setNotice(
        `STEP preflight: ${exactPreview} exact · ${facetedPreview} faceted. Building…`,
      );
    }
    setStepExporting(true);
    try {
      const { exportShapesToStep } = await import("@/lib/stepExport");
      const { blob, exportedCount, exactCount, facetedCount, skipped, degraded } = await exportShapesToStep(sourceShapes);
      const text = await blob.text();
      const result = await downloadTextFile(projectExportFileName(projectName, "step"), text, "application/step");
      const qualityNote = `Exported ${exactCount} exact · ${facetedCount} faceted solid${exportedCount === 1 ? "" : "s"}`;
      const facetTip = facetedCount > 0
        ? " Faceted STEP is mesh-based CAD interchange, not feature-editable B-Rep."
        : "";
      const skipNote = skipped.length > 0
        ? ` Skipped ${skipped.length} empty/degenerate shape${skipped.length === 1 ? "" : "s"}.`
        : "";
      // Name the affected bodies: this is the one outcome where the file looks fine but the part
      // is wrong, so a bare count is not enough to keep someone from machining solid stock.
      const degradedNote = degraded.length > 0
        ? ` WARNING — ${degraded.length} body${degraded.length === 1 ? "" : "s"} exported with missing cuts: ${degraded.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}.`
        : "";
      celebrateExport("STEP", `${exactCount} exact · ${facetedCount} faceted`);
      if (result.mode === "folder") {
        setNotice(`Saved STEP to ${result.path}. ${qualityNote}.${facetTip}${skipNote}${degradedNote}`);
      } else {
        setNotice(`${qualityNote}.${facetTip}${skipNote}${degradedNote}`);
      }
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "Could not export STEP");
    } finally {
      setStepExporting(false);
    }
  }, [celebrateExport, hasSelection, projectName, selectedShapes, shapes, stepExporting]);

  const exportBlueprint = useCallback(async (formats: BlueprintExportFormat[]) => {
    if (blueprintExporting || formats.length === 0) {
      return;
    }
    const sourceShapes = (hasSelection ? selectedShapes : shapes).filter((shape) => !shape.hole && !shape.hidden);
    if (sourceShapes.length === 0) {
      setNotice(hasSelection ? "Select at least one solid shape before exporting a blueprint" : "Add a solid shape before exporting a blueprint");
      return;
    }
    setBlueprintExporting(true);
    const formatLabels = formats.map((format) => format.toUpperCase()).join(" + ");
    setNotice(`Building 2D blueprint (${formatLabels})…`);
    try {
      const { blueprintPartFrame, buildBlueprintDrawing, writeBlueprintDxf, writeBlueprintPdf, writeBlueprintSvg } = await import("@/lib/blueprintExport");
      const parts = sourceShapes.map((shape) => {
        const mesh = meshForShape(shape);
        const frame = blueprintPartFrame(mesh.vertices, {
          width: shapeWidth(shape),
          depth: shapeDepth(shape),
          height: shape.height,
          elevation: shape.elevation ?? 0,
          x: shape.x,
          z: shape.z,
        });
        return {
          name: shape.name,
          kind: shape.kind,
          vertices: mesh.vertices,
          faces: mesh.faces,
          sides: shape.sides,
          leftAngle: shape.leftAngle,
          rightAngle: shape.rightAngle,
          topRadius: shape.topRadius ?? shape.groupedShapes?.find((child) => child.kind === "cone" && !child.hole)?.topRadius,
          baseRadius: shape.baseRadius ?? shape.groupedShapes?.find((child) => child.kind === "cone" && !child.hole)?.baseRadius,
          color: shape.color,
          ...frame,
        };
      });
      const drawing = buildBlueprintDrawing({
        projectName,
        parts,
        workspace: workspaceSettings,
      });

      const savedPaths: string[] = [];
      for (const format of formats) {
        let result: DownloadResult;
        if (format === "pdf") {
          result = await downloadBlobFile(projectExportFileName(projectName, "pdf"), writeBlueprintPdf(drawing), "application/pdf");
        } else if (format === "dxf") {
          result = await downloadTextFile(projectExportFileName(projectName, "dxf"), writeBlueprintDxf(drawing), "application/dxf");
        } else {
          result = await downloadTextFile(projectExportFileName(projectName, "svg"), writeBlueprintSvg(drawing), "image/svg+xml");
        }
        if (result.mode === "folder") {
          savedPaths.push(result.path);
        }
      }

      celebrateExport(`Blueprint ${formatLabels}`, `${parts.length} part${parts.length === 1 ? "" : "s"}`);
      setBlueprintExportOpen(false);
      if (savedPaths.length > 0) {
        setNotice(`Saved blueprint ${formatLabels} to ${savedPaths.join(", ")}`);
      } else {
        setNotice(hasSelection
          ? `Exported blueprint ${formatLabels} for ${parts.length} selected shape${parts.length === 1 ? "" : "s"}`
          : `Exported blueprint ${formatLabels} (${parts.length} part${parts.length === 1 ? "" : "s"})`);
      }
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "Could not export blueprint");
    } finally {
      setBlueprintExporting(false);
    }
  }, [blueprintExporting, celebrateExport, hasSelection, projectName, selectedShapes, shapes, workspaceSettings]);

  const openBlueprintExport = useCallback(() => {
    const sourceShapes = (hasSelection ? selectedShapes : shapes).filter((shape) => !shape.hole && !shape.hidden);
    if (sourceShapes.length === 0) {
      setNotice(hasSelection ? "Select at least one solid shape before exporting a blueprint" : "Add a solid shape before exporting a blueprint");
      return;
    }
    setBlueprintExportOpen(true);
  }, [hasSelection, selectedShapes, shapes]);

  const clearDesign = useCallback(() => {
    commitShapes([], [], "New empty design");
    setClipboard([]);
    setMenuOpen(false);
    setTopPanel(null);
  }, [commitShapes]);

  const createHouseScene = useCallback(
    (replace = true) => {
      const house = makeHouseScene();
      const next = replace ? house : [...shapes, ...house];
      commitShapes(next, house.map((shape) => shape.id), "House scene created");
      setMenuOpen(false);
      setTopPanel(null);
      return house;
    },
    [commitShapes, shapes],
  );

  const createPerfScene = useCallback(
    (count = 500) => {
      const scene = makeBlockPerfScene(count);
      commitShapes(scene, [], `Performance scene: ${scene.length} blocks`);
      setMenuOpen(false);
      setTopPanel(null);
      return scene;
    },
    [commitShapes],
  );

  const saveDesign = useCallback(() => {
    setNotice(`Saved design with ${shapes.length} shape${shapes.length === 1 ? "" : "s"}`);
    setMenuOpen(false);
  }, [shapes.length]);

  const makeCopy = useCallback(() => {
    if (shapes.length === 0) {
      setNotice("Nothing to copy yet");
      setMenuOpen(false);
      return;
    }
    const copies = shapes.map((shape) => ({
      ...shape,
      id: createLocalId(`${shape.id}-copy`),
      x: Math.min(110, shape.x + 12),
      z: Math.min(110, shape.z + 12),
    }));
    commitShapes([...shapes, ...copies], copies.map((shape) => shape.id), "Made a copy of the design");
    setMenuOpen(false);
  }, [commitShapes, shapes]);

  const selectFile = useCallback(async (file: File) => {
    const isStep = /\.(step|stp)$/i.test(file.name);
    const isSvg = /\.svg$/i.test(file.name) || file.type === "image/svg+xml";
    const is3mf = /\.3mf$/i.test(file.name);
    if (!isStep && !isSvg && !importExtensionSupported(file.name)) {
      setNotice("Unsupported file type. Use STL, STEP, SVG, or 3MF.");
      return;
    }

    const sourceProjectId = projectInfoRef.current.projectId;
    try {
      let nextShape: WorkplaneShape;
      const importWarnings: string[] = [];
      if (isStep) {
        setNotice("Reading STEP… first import loads the OpenCascade kernel (~22 MB), one time per session");
        const { importedShapeFromStep } = await import("@/lib/stepImport");
        nextShape = await importedShapeFromStep(file.name, await file.arrayBuffer());
      } else if (isSvg) {
        setNotice(`Importing SVG (${file.name})…`);
        nextShape = importedShapeFromSvg(file.name, await file.text(), (warning) => importWarnings.push(warning));
      } else if (is3mf) {
        nextShape = importedShapeFrom3mf(file.name, await file.arrayBuffer());
      } else {
        nextShape = importedShapeFromStl(file.name, await file.arrayBuffer());
      }
      if (projectInfoRef.current.projectId !== sourceProjectId) {
        setNotice(`Import of ${file.name} cancelled because the project changed`);
        return;
      }
      commitShapes([...shapesRef.current, nextShape], nextShape.id, `Imported ${file.name}`);
      setTopPanel(null);
      // Overrides the commit notice on purpose: a partial import needs to be seen.
      if (importWarnings.length > 0) setNotice(`Imported ${file.name} — ${importWarnings.join(" ")}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not import ${file.name}`);
    }
  }, [commitShapes]);

  const selectFiles = useCallback(
    (files: FileList | File[]) => {
      const file = Array.from(files)[0];
      if (file) {
        void selectFile(file);
      }
    },
    [selectFile],
  );

  const selectShape = useCallback((id: string | string[] | null, mode: "replace" | "toggle" = "replace") => {
    const resolveId = (pickId: string) => {
      if (!circularPattern) return pickId;
      return resolveCircularPatternSourceId(pickId, circularPattern) ?? pickId;
    };
    setSelectedIds((current) => {
      if (Array.isArray(id)) {
        const unique = id.map(resolveId).filter((entry, index, list) => list.indexOf(entry) === index);
        return mode === "toggle" ? unique.reduce((next, entry) => (next.includes(entry) ? next.filter((selected) => selected !== entry) : [...next, entry]), current) : unique;
      }
      if (!id) {
        return mode === "toggle" ? current : [];
      }
      const resolved = resolveId(id);
      if (mode === "toggle") {
        return current.includes(resolved) ? current.filter((entry) => entry !== resolved) : [...current, resolved];
      }
      return [resolved];
    });
  }, [circularPattern]);

  const nudgeSelected = useCallback(
    (deltaX: number, deltaZ: number, gridStep = 0) => {
      if (!hasSelection) {
        return;
      }
      const snapCoord = (value: number, delta: number) => {
        const next = value + delta;
        if (gridStep <= 0) return Math.max(-110, Math.min(110, next));
        // Land on the grid cell in the nudge direction (no diagonal / half-step drift).
        const snapped = Math.round(next / gridStep) * gridStep;
        return Math.max(-110, Math.min(110, Number(snapped.toFixed(6))));
      };
      const selected = new Set(selectedIds);
      const repeatEntries: Array<{ shapeId: string; delta: ShapeRepeatDelta }> = [];
      const nextShapes = shapes.map((shape) => {
        if (!selected.has(shape.id) || shape.locked) return shape;
        const x = snapCoord(shape.x, deltaX);
        const z = snapCoord(shape.z, deltaZ);
        repeatEntries.push({ shapeId: shape.id, delta: { x: x - shape.x, z: z - shape.z } });
        return { ...shape, x, z };
      });
      recordShapeRepeatActions(repeatEntries);
      commitShapes(
        nextShapes,
        selectedIds,
        `Moved ${selectedShapes.length} shape${selectedShapes.length === 1 ? "" : "s"}`,
      );
    },
    [commitShapes, hasSelection, recordShapeRepeatActions, selectedIds, selectedShapes.length, shapes],
  );

  const nudgeSelectedByView = useCallback(
    (screenRight: number, screenUp: number, step: number) => {
      const { deltaX, deltaZ } = viewNudgeDelta(viewNudgeAxesRef.current, screenRight, screenUp, step);
      nudgeSelected(deltaX, deltaZ, step);
    },
    [nudgeSelected],
  );

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Never treat hotkeys as shape-delete while typing in a field.
      if (isTypingTarget(event.target) || isHotkeyRecordingActive()) {
        return;
      }

      const action = matchHotkeyAction(
        event,
        hotkeys,
        undefined,
        sketchActive && toolbarMode === "sketch" ? { preferCategory: "Sketch" } : undefined,
      );
      if (!action) return;

      const snapGridStep = (() => {
        if (snapGrid === "Off") return 0;
        if (snapGrid === "Brick") return 8;
        return Number.parseFloat(snapGrid) || 1;
      })();
      const unit = snapGridStep > 0 ? snapGridStep : 1;
      const step = event.shiftKey ? unit * 5 : unit;

      if (sketchActive && toolbarMode === "sketch") {
        if (action === "escape") {
          event.preventDefault();
          if (polygonSidesPrompt !== null) {
            cancelPolygonSidesPrompt();
            return;
          }
          if (extrudeHeightPrompt !== null) {
            cancelExtrudeHeightPrompt();
            return;
          }
          setSketchActivePointId(null);
          setSketchSelection(null);
          setRevolvePrompt(null);
          setNotice("Current sketch chain cleared");
          return;
        }
        if (action === "delete") {
          event.preventDefault();
          if (sketchSelection) deleteSelectedSketchEntity();
          else if (sketchMeasurement) clearSketchMeasurement();
          else {
            // Never wipe the whole sketch on Delete with an empty selection.
            setNotice("Nothing selected to delete");
          }
          return;
        }
        if (action === "undo") {
          event.preventDefault();
          sketchUndo();
          return;
        }
        if (action === "redo") {
          event.preventDefault();
          sketchRedo();
          return;
        }
        if (action === "copy") {
          event.preventDefault();
          copySelectedSketch();
          return;
        }
        if (action === "cut") {
          event.preventDefault();
          cutSelectedSketch();
          return;
        }
        if (action === "paste") {
          event.preventDefault();
          pasteSelectedSketch();
          return;
        }
        if (action === "selectAll") {
          event.preventDefault();
          const pointIds = sketchProfile.points.map((point) => point.id);
          const segmentIds = sketchProfile.segments.map((segment) => segment.id);
          const imageIds = (sketchProfile.images ?? []).map((image) => image.id);
          if (!pointIds.length && !segmentIds.length && !imageIds.length) {
            setNotice("Sketch is empty");
            return;
          }
          setSketchSelection({ kind: "multiple", pointIds, segmentIds, imageIds });
          setSketchActivePointId(null);
          setNotice(`Selected all sketch items (${pointIds.length + segmentIds.length + imageIds.length})`);
          return;
        }
        if (action === "nudgeLeft" || action === "nudgeRight" || action === "nudgeUp" || action === "nudgeDown") {
          const pointIds =
            sketchSelection?.kind === "point"
              ? [sketchSelection.id]
              : sketchSelection?.kind === "multiple"
                ? sketchSelection.pointIds
                : [];
          if (!pointIds.length) {
            setNotice("Select sketch points to nudge");
            return;
          }
          event.preventDefault();
          const deltaX = action === "nudgeLeft" ? -step : action === "nudgeRight" ? step : 0;
          const deltaZ = action === "nudgeUp" ? -step : action === "nudgeDown" ? step : 0;
          const idSet = new Set(pointIds);
          const next = {
            ...sketchProfile,
            points: sketchProfile.points.map((point) => {
              if (!idSet.has(point.id)) return point;
              return {
                ...point,
                x: point.x + deltaX,
                z: point.z + deltaZ,
                handleIn: point.handleIn
                  ? { x: point.handleIn.x + deltaX, z: point.handleIn.z + deltaZ }
                  : undefined,
                handleOut: point.handleOut
                  ? { x: point.handleOut.x + deltaX, z: point.handleOut.z + deltaZ }
                  : undefined,
              };
            }),
          };
          commitSketchProfile(next, "Sketch points nudged");
          return;
        }
        if (action === "sketchLine") {
          event.preventDefault();
          setActiveSketchTool("line");
          return;
        }
        if (action === "sketchCircle") {
          event.preventDefault();
          setActiveSketchTool("circle");
          return;
        }
        if (action === "sketchRectangle") {
          event.preventDefault();
          setActiveSketchTool("rectangle");
          return;
        }
        if (action === "sketchDimension") {
          event.preventDefault();
          setActiveSketchTool("dimension");
          return;
        }
        if (action === "sketchExtrude") {
          event.preventDefault();
          startSketchExtrude();
          return;
        }
        if (action === "sketchFocusToggle") {
          // Only toggle 2D/3D when focus is on the sketch surface (or loose body focus),
          // so Tab can still move through inspector/tool UI controls.
          const target = event.target as HTMLElement | null;
          const onSketchSurface = Boolean(target?.closest?.(".sketch-plate, .sketch-plate-wrap"));
          const looseFocus =
            !target
            || target === document.body
            || target === document.documentElement
            || target.classList?.contains("sketchforge-editor");
          if (!onSketchSurface && !looseFocus) {
            return;
          }
          event.preventDefault();
          setSketchFocusMode((mode) => (mode === "2d" ? "3d" : "2d"));
          return;
        }
        if (action === "holeMode") {
          event.preventDefault();
          setNotice("Hole mode applies in 3D — finish or exit the sketch first");
          return;
        }
        if (action === "solidMode") {
          event.preventDefault();
          setActiveSketchTool("select");
          return;
        }
        return;
      }

      switch (action) {
        case "escape":
          event.preventDefault();
          if (sketchFacePickMode) {
            cancelSketchFacePick();
            break;
          }
          setSelectedIds([]);
          setNotice("Selection cleared");
          break;
        case "delete":
          event.preventDefault();
          deleteSelected();
          break;
        case "undo":
          event.preventDefault();
          undo();
          break;
        case "redo":
          event.preventDefault();
          redo();
          break;
        case "copy":
          event.preventDefault();
          copySelected();
          break;
        case "cut":
          event.preventDefault();
          cutSelected();
          break;
        case "paste":
          event.preventDefault();
          pasteShape();
          break;
        case "duplicate":
          event.preventDefault();
          duplicateSelected();
          break;
        case "duplicateRepeat":
          event.preventDefault();
          duplicateAndRepeatSelected();
          break;
        case "selectAll":
          event.preventDefault();
          setSelectedIds(shapes.filter((shape) => !shape.hidden).map((shape) => shape.id));
          setNotice("Selected all visible shapes");
          break;
        case "group":
          event.preventDefault();
          groupSelected();
          break;
        case "ungroup":
          event.preventDefault();
          ungroupSelected();
          break;
        case "toggleLocked":
          event.preventDefault();
          toggleLocked();
          break;
        case "toggleHidden":
          event.preventDefault();
          toggleHidden();
          break;
        case "showHidden":
          event.preventDefault();
          showHidden();
          break;
        case "raise":
          event.preventDefault();
          raiseSelected(step);
          break;
        case "lower":
          event.preventDefault();
          raiseSelected(-step);
          break;
        case "nudgeLeft":
          event.preventDefault();
          nudgeSelectedByView(-1, 0, step);
          break;
        case "nudgeRight":
          event.preventDefault();
          nudgeSelectedByView(1, 0, step);
          break;
        case "nudgeUp":
          event.preventDefault();
          nudgeSelectedByView(0, 1, step);
          break;
        case "nudgeDown":
          event.preventDefault();
          nudgeSelectedByView(0, -1, step);
          break;
        case "dropToWorkplane":
          if (!hasSelection) return;
          event.preventDefault();
          dropSelectedToWorkplane();
          break;
        case "holeMode":
          event.preventDefault();
          if (extrudeHeightPrompt !== null) {
            setExtrudeAsHole(true);
            break;
          }
          setSelectionHoleMode(true);
          break;
        case "solidMode":
          event.preventDefault();
          if (extrudeHeightPrompt !== null) {
            setExtrudeAsHole(false);
            break;
          }
          setSelectionHoleMode(false);
          break;
        case "align":
          event.preventDefault();
          toggleAlignMode();
          break;
        case "mirror":
          event.preventDefault();
          toggleMirrorMode();
          break;
        case "pattern":
          event.preventDefault();
          toggleCircularPattern();
          break;
        case "chamfer":
          event.preventDefault();
          if (edgeModifier?.kind === "chamfer") cancelEdgeModifier();
          else startEdgeModifier("chamfer");
          break;
        case "fillet":
          event.preventDefault();
          if (edgeModifier?.kind === "fillet") cancelEdgeModifier();
          else startEdgeModifier("fillet");
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    cancelEdgeModifier,
    cancelExtrudeHeightPrompt,
    cancelPolygonSidesPrompt,
    cancelSketchFacePick,
    clearSketchMeasurement,
    commitSketchProfile,
    copySelected,
    copySelectedSketch,
    cutSelected,
    cutSelectedSketch,
    deleteSelected,
    deleteSelectedSketchEntity,
    dropSelectedToWorkplane,
    duplicateAndRepeatSelected,
    duplicateSelected,
    edgeModifier?.kind,
    groupSelected,
    hasSelection,
    hotkeys,
    nudgeSelectedByView,
    pasteSelectedSketch,
    pasteShape,
    polygonSidesPrompt,
    extrudeHeightPrompt,
    raiseSelected,
    redo,
    shapes,
    sketchActive,
    sketchFacePickMode,
    sketchMeasurement,
    sketchProfile,
    sketchRedo,
    sketchSelection,
    sketchUndo,
    setActiveSketchTool,
    setSelectionHoleMode,
    showHidden,
    snapGrid,
    startEdgeModifier,
    startSketchExtrude,
    toggleAlignMode,
    toggleCircularPattern,
    toggleHidden,
    toggleLocked,
    toggleMirrorMode,
    toolbarMode,
    undo,
    ungroupSelected,
  ]);

  return (
    <div className="sketchforge-editor">
      <EditorTopBar
        projectName={projectName}
        onProjectNameChange={onProjectNameChange}
        onHome={onHome ? handleHome : undefined}
        onImport={() => {
          setTopPanel(null);
          setMenuOpen(false);
          fileInputRef.current?.click();
        }}
        onExport={() => {
          setTopPanel("export");
          setMenuOpen(false);
        }}
        onBlueprintExport={openBlueprintExport}
        blueprintExporting={blueprintExporting}
        toolbarMode={toolbarMode}
        onToolbarModeChange={changeToolbarMode}
        tools={
          toolbarMode === "sketch" && sketchActive && sketchFocusMode === "2d" ? (
            <EditorModeStrip
              canUndo={sketchHistoryIndex > 0}
              canRedo={sketchHistoryIndex < sketchHistory.length - 1}
              canCopy={Boolean(sketchSelection)}
              canPaste={Boolean(sketchClipboard)}
              onUndo={sketchUndo}
              onRedo={sketchRedo}
              onCopy={copySelectedSketch}
              onPaste={pasteSelectedSketch}
            />
          ) : toolbarMode === "geometry" ? (
            <EditorViewportToolbar
              canUndo={!projectInteractionActive && (historyIndex > 0 || Boolean(edgeModifier) || Boolean(circularPattern))}
              canRedo={!projectInteractionActive && historyIndex < history.length - 1}
              hasClipboard={clipboard.length > 0 || systemClipboardSupported}
              hasSelection={hasSelection}
              canGroup={selectedShapes.length > 1 && selectedShapes.every((shape) => !shape.locked)}
              canIntersect={selectedShapes.some((shape) => !shape.locked && !shape.hole) && selectedShapes.some((shape) => !shape.locked && Boolean(shape.hole))}
              canUngroup={selectedShapes.some((shape) => Boolean(shape.groupedShapes?.length))}
              alignMode={alignMode}
              canAlign={selectedShapes.length > 1}
              canEdgeModify={selectedShapes.length === 1 && Boolean(selectedShape && !selectedShape.locked && !selectedShape.hole)}
              edgeModifierKind={edgeModifier?.kind ?? null}
              circularPatternActive={Boolean(circularPattern)}
              canCircularPattern={canCircularPattern}
              mirrorMode={mirrorMode}
              onCopy={copySelected}
              onPaste={pasteShape}
              onDuplicate={duplicateSelected}
              onDuplicateAndRepeat={duplicateAndRepeatSelected}
              onDelete={deleteSelected}
              onUndo={undo}
              onRedo={redo}
              onGroup={groupSelected}
              onUngroup={ungroupSelected}
              onIntersect={intersectSelected}
              onAlign={toggleAlignMode}
              onMirror={toggleMirrorMode}
              onCircularPattern={toggleCircularPattern}
              onChamfer={() => edgeModifier?.kind === "chamfer" ? cancelEdgeModifier() : startEdgeModifier("chamfer")}
              onFillet={() => edgeModifier?.kind === "fillet" ? cancelEdgeModifier() : startEdgeModifier("fillet")}
            />
          ) : null
        }
      />
      {blueprintExportOpen ? (
        <BlueprintExportModal
          exporting={blueprintExporting}
          onClose={() => {
            if (!blueprintExporting) {
              setBlueprintExportOpen(false);
            }
          }}
          onExport={(formats) => {
            void exportBlueprint(formats);
          }}
        />
      ) : null}
      <div className={`editor-body${modeTransitioning ? " mode-transitioning" : ""}`}>
        {toolbarMode === "sketch" && sketchActive && sketchFocusMode === "2d" ? (
          <>
          <SketchUtilitySidebar
            sketchTool={sketchTool}
            onSketchTool={setActiveSketchTool}
            onSketchImage={() => {
              if (sketchTool !== "select") {
                setNotice("Choose Select before adding a sketch image");
                return;
              }
              sketchImageInputRef.current?.click();
            }}
          />
          <div className="editor-sketch-area">
            <ActiveToolChip
              visible={Boolean(sketchToolChip)}
              label={sketchToolChip?.label ?? ""}
              hint={sketchToolChip?.hint}
            />
            <SketchFinishToolbar
              onSketchExtrude={startSketchExtrude}
              onSketchRevolve={startSketchRevolve}
              onSketchCancel={cancelSketch}
              revolveDisabled={!isDefaultSketchPlane(sketchProfile.sketchPlane)}
            />
            {extrudeHeightPrompt !== null ? (
              <>
                <div className="sketch-tool-prompt-backdrop" aria-hidden onPointerDown={(event) => event.preventDefault()} />
                <div className="sketch-revolve-prompt phase-confirm" role="dialog" aria-modal="true" aria-label="Extrude height">
                  <div className="sketch-revolve-prompt-copy">
                    <strong>Extrude to 3D</strong>
                    <span>
                      {extrudeAsHole
                        ? (isDefaultSketchPlane(sketchProfile.sketchPlane)
                          ? "Create a hole cutter, then select it with a solid and Group to cut."
                          : "Cut into the face you sketched on (through depth by default).")
                        : (isDefaultSketchPlane(sketchProfile.sketchPlane)
                          ? "Create a solid you can move and edit like any other object."
                          : "Join onto the face you sketched on (Fusion-style Extrude → Join).")}
                    </span>
                  </div>
                  <div className="shape-state-card sketch-extrude-mode" role="group" aria-label="Extrude as solid or hole">
                    <button
                      type="button"
                      className={!extrudeAsHole ? "active solid-choice" : "solid-choice"}
                      aria-pressed={!extrudeAsHole}
                      aria-label="Extrude as solid"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setExtrudeAsHole(false);
                      }}
                    >
                      <span className="large-solid-swatch" style={{ "--swatch": "#d41721" } as CSSProperties} />
                      <span>{isDefaultSketchPlane(sketchProfile.sketchPlane) ? "Solid" : "Join"}</span>
                    </button>
                    <button
                      type="button"
                      className={extrudeAsHole ? "active hole-choice" : "hole-choice"}
                      aria-pressed={extrudeAsHole}
                      aria-label="Extrude as hole"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setExtrudeAsHole(true);
                      }}
                    >
                      <span className="large-hole-swatch" />
                      <span>{isDefaultSketchPlane(sketchProfile.sketchPlane) ? "Hole" : "Cut"}</span>
                    </button>
                  </div>
                  <div className="sketch-extrude-height-prompt" aria-label="Extrude height">
                    <button
                      type="button"
                      aria-label="Decrease height"
                      onClick={() => setExtrudeHeightPrompt((value) => Math.max(0.5, Number(((value ?? 10) - 1).toFixed(2))))}
                    >
                      −
                    </button>
                    <label className="sketch-extrude-height-field">
                      <input
                        type="number"
                        min={0.5}
                        step={0.5}
                        value={extrudeHeightPrompt}
                        onChange={(event) => {
                          const next = Number.parseFloat(event.target.value);
                          if (Number.isFinite(next)) setExtrudeHeightPrompt(Math.max(0.5, next));
                        }}
                      />
                      <span>mm</span>
                    </label>
                    <button
                      type="button"
                      aria-label="Increase height"
                      onClick={() => setExtrudeHeightPrompt((value) => Number(((value ?? 10) + 1).toFixed(2)))}
                    >
                      +
                    </button>
                  </div>
                  <div className="sketch-revolve-prompt-actions">
                    <button type="button" className="primary" onClick={() => finishSketchExtrude(extrudeHeightPrompt, extrudeAsHole)}>
                      {extrudeAsHole
                        ? (isDefaultSketchPlane(sketchProfile.sketchPlane) ? "Create hole" : "Cut into part")
                        : (isDefaultSketchPlane(sketchProfile.sketchPlane) ? "Create solid" : "Join to part")}
                    </button>
                    <button type="button" className="cancel" onClick={cancelExtrudeHeightPrompt}>Cancel</button>
                  </div>
                </div>
              </>
            ) : null}
            {polygonSidesPrompt !== null ? (
              <>
                <div className="sketch-tool-prompt-backdrop" aria-hidden onPointerDown={(event) => event.preventDefault()} />
                <div className="sketch-revolve-prompt phase-pick" role="dialog" aria-modal="true" aria-label="Polygon sides">
                  <div className="sketch-revolve-prompt-copy">
                    <strong>Polygon: how many sides?</strong>
                    <span>Choose a side count, then confirm to start drawing.</span>
                  </div>
                  <div className="sketch-polygon-sides-prompt" aria-label="Polygon side count">
                    <button
                      type="button"
                      aria-label="Fewer sides"
                      disabled={polygonSidesPrompt <= MIN_SKETCH_POLYGON_SIDES}
                      onClick={() => setPolygonSidesPrompt((sides) => Math.max(MIN_SKETCH_POLYGON_SIDES, (sides ?? MIN_SKETCH_POLYGON_SIDES) - 1))}
                    >
                      −
                    </button>
                    <span>{polygonSidesPrompt}</span>
                    <button
                      type="button"
                      aria-label="More sides"
                      disabled={polygonSidesPrompt >= MAX_SKETCH_POLYGON_SIDES}
                      onClick={() => setPolygonSidesPrompt((sides) => Math.min(MAX_SKETCH_POLYGON_SIDES, (sides ?? MAX_SKETCH_POLYGON_SIDES) + 1))}
                    >
                      +
                    </button>
                  </div>
                  <div className="sketch-polygon-sides-presets" aria-label="Common side counts">
                    {[3, 4, 5, 6, 8, 12].map((sides) => (
                      <button
                        key={sides}
                        type="button"
                        className={polygonSidesPrompt === sides ? "active" : ""}
                        onClick={() => setPolygonSidesPrompt(sides)}
                      >
                        {sides}
                      </button>
                    ))}
                  </div>
                  <div className="sketch-revolve-prompt-actions">
                    <button type="button" className="primary" onClick={confirmPolygonSidesPrompt}>
                      Draw polygon
                    </button>
                    <button type="button" className="cancel" onClick={cancelPolygonSidesPrompt}>
                      Cancel
                    </button>
                  </div>
                </div>
              </>
            ) : null}
            {revolvePrompt ? (
              <div className={`sketch-revolve-prompt phase-${revolvePrompt.phase}`} role="dialog" aria-live="polite" aria-label="Revolve axis">
                {revolvePrompt.phase === "pick" ? (
                  <>
                    <div className="sketch-revolve-prompt-copy">
                      <strong>Revolve: choose an axis</strong>
                      <span>Click a straight line in the sketch to revolve around.</span>
                    </div>
                    <div className="sketch-revolve-prompt-actions">
                      <button type="button" className="cancel" onClick={() => setRevolvePrompt(null)}>Cancel revolve</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="sketch-revolve-prompt-copy">
                      <strong>Use this line as the revolve axis?</strong>
                      <span>Confirm to create the solid, or click a different straight line.</span>
                    </div>
                    <div className="sketch-revolve-prompt-actions">
                      <button type="button" className="primary" onClick={() => completeSketchRevolve(revolvePrompt.axis)}>
                        Confirm axis
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSketchSelection(null);
                          setRevolvePrompt({ phase: "pick" });
                        }}
                      >
                        Pick another
                      </button>
                      <button type="button" className="cancel" onClick={() => setRevolvePrompt(null)}>Cancel</button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
            <SketchPalette
              doc={sketchDoc}
              status={sketchSolveStatus}
              dof={sketchDof}
              conflicts={sketchConflicts}
              focusMode={sketchFocusMode}
              selectedProfileCount={sketchDoc.selectedProfileIds.length || closedProfilesFromLegacy(sketchProfile).length}
              onToggleFocusMode={() => setSketchFocusMode((mode) => (mode === "2d" ? "3d" : "2d"))}
              onPatchSettings={(patch) => {
                setSketchDoc((doc) => ({ ...doc, settings: { ...doc.settings, ...patch } }));
              }}
              onRemoveConstraint={(constraintId) => {
                const nextDoc = removeConstraint(sketchDoc, constraintId);
                const solved = solveSketchDoc(nextDoc);
                setSketchDoc(solved.doc);
                setSketchSolveStatus(solved.status);
                setSketchDof(solved.dof);
                setSketchConflicts(solved.conflicts);
                setSketchProfile(sketchDocToProfile(solved.doc));
                setNotice("Constraint removed");
              }}
              onToggleConstructionMode={() => {
                setSketchDoc((doc) => ({
                  ...doc,
                  settings: { ...doc.settings, constructionMode: !doc.settings.constructionMode },
                }));
                setNotice(sketchDoc.settings.constructionMode ? "Solid geometry mode" : "Construction geometry mode");
              }}
            />
            <div className="sketch-project-actions">
              <button
                type="button"
                className="sketch-project-edges-button"
                onClick={() => {
                  const hostId = sketchDoc.plane.hostShapeId;
                  const host = hostId ? shapes.find((shape) => shape.id === hostId) : null;
                  if (!host) {
                    setNotice("No host body to project edges from — sketch on a face first");
                    return;
                  }
                  const edges = boxEdgesForProjection(
                    host.id,
                    { x: host.x, y: (host.elevation ?? 0) + host.height / 2, z: host.z },
                    { width: host.width, height: host.height, depth: host.depth },
                    sketchDoc.plane,
                  );
                  const projected = projectEdgesOntoSketch(sketchDoc, edges.slice(0, 4));
                  const solved = solveSketchDoc(projected.doc);
                  setSketchDoc(solved.doc);
                  setSketchSolveStatus(solved.status);
                  setSketchDof(solved.dof);
                  setSketchConflicts(solved.conflicts);
                  commitSketchProfile(sketchDocToProfile(solved.doc), `Projected ${projected.addedEntityIds.length} reference entities`, solved.doc);
                }}
              >
                Project host edges
              </button>
            </div>
            <SketchWorkspace
              profile={sketchProfile}
              referenceShapes={shapes.filter((shape) => shape.id !== editingSketchShapeId)}
              tool={sketchTool}
              activePointId={sketchActivePointId}
              selected={sketchSelection}
              measurement={sketchMeasurement}
              pendingMeasurementStart={sketchMeasureStart}
              initialSnap={snapGrid}
              initialWorkspace={workspaceSettings}
              onSnapChange={(nextSnap) => {
                updateProjectWorkspaceSettings({ workspace: workspaceSettings, snap: nextSnap });
              }}
              polygonSides={sketchPolygonSides}
              selectedProfileIds={sketchDoc.selectedProfileIds}
              activeSnap={lastSketchSnap}
              showDimensions={sketchDoc.settings.showDimensions}
              dimensions={sketchDoc.dimensions}
              showConstraints={sketchDoc.settings.showConstraints}
              constraints={sketchDoc.constraints}
              constraintEntities={sketchDoc.entities}
              constraintConflicts={sketchConflicts}
              solveStatus={sketchSolveStatus}
              solveDof={sketchDof}
              onPlanePoint={addSketchPlanePoint}
              onDrawCircle={addSketchCircle}
              onDrawEllipse={addSketchEllipse}
              onDrawSquare={addSketchSquare}
              onDrawRectangle={addSketchRectangle}
              onDrawRoundRect={addSketchRoundRect}
              onDrawSlot={addSketchSlot}
              onDrawTriangle={addSketchTriangle}
              onDrawPolygon={addSketchPolygon}
              onDrawStar={addSketchStar}
              onDrawArc={addSketchArc}
              onOffsetSegment={addSketchOffsetLine}
              onPointPress={pressSketchPoint}
              onSelectSegment={(id) => {
                setSketchSelection({ kind: "segment", id });
                setSketchActivePointId(null);
                if (revolvePrompt) {
                  const axis = resolveSketchRevolveAxis(sketchProfile, { kind: "segment", id });
                  if (!axis) {
                    setNotice("That isn’t a straight axis line. Click a straight segment to revolve around.");
                  }
                }
              }}
              onSelectMany={(pointIds, segmentIds, imageIds) => {
                setSketchSelection(pointIds.length || segmentIds.length || imageIds.length ? { kind: "multiple", pointIds, segmentIds, imageIds } : null);
                setSketchActivePointId(null);
                const count = pointIds.length + segmentIds.length + imageIds.length;
                setNotice(count ? `Selected ${count} sketch item${count === 1 ? "" : "s"}` : "Sketch selection cleared");
              }}
              onSelectImage={(id) => {
                setSketchSelection({ kind: "image", id });
                setSketchActivePointId(null);
                setNotice("Sketch image selected");
              }}
              onUpdateImage={updateSketchImage}
              onDeleteImage={deleteSketchImage}
              onDeletePoint={deleteSketchPoint}
              onDeleteSegment={deleteSketchSegment}
              onEraseEntities={eraseSketchEntities}
              onMovePoint={moveSketchPoint}
              onMoveHandle={moveSketchHandle}
              onInsertPoint={insertSketchPoint}
              onSetPointMode={setSketchPointMode}
              onClearMeasurement={clearSketchMeasurement}
              onSelectProfile={(profileId) => {
                setSketchDoc((doc) => {
                  const selected = new Set(doc.selectedProfileIds);
                  if (selected.has(profileId)) selected.delete(profileId);
                  else selected.add(profileId);
                  return { ...doc, selectedProfileIds: [...selected] };
                });
              }}
              onEditDimension={(dimensionId, value) => {
                const solved = setDrivingDimensionValue(sketchDoc, dimensionId, value);
                setSketchDoc(solved.doc);
                setSketchSolveStatus(solved.status);
                setSketchDof(solved.dof);
                setSketchConflicts(solved.conflicts);
                commitSketchProfile(sketchDocToProfile(solved.doc), `Dimension → ${value.toFixed(2)}`, solved.doc);
              }}
              onSnapResolved={setLastSketchSnap}
              onToolChange={setActiveSketchTool}
              onNotice={setNotice}
            />
          </div>
          <SketchToolSidebar
            sketchTool={sketchTool}
            polygonSides={sketchPolygonSides}
            onSketchTool={setActiveSketchTool}
            onPolygonSidesChange={setSketchPolygonSideCount}
          />
          </>
        ) : (
          <>
          <div className="editor-canvas-area">
            <ActiveToolChip
              visible={Boolean(activeToolChip)}
              label={activeToolChip?.label ?? ""}
              hint={activeToolChip?.hint}
            />
            {toolbarMode === "sketch" && !sketchActive ? (
              <SketchCreateMenu
                canEditSketch={shapeHasEditableSketch(selectedShape)}
                onNewSketch={beginSketchFacePick}
                onEditSketch={beginEditSelectedSketch}
              />
            ) : null}
            {sketchActive && sketchFocusMode === "3d" ? (
              <>
                <SketchPalette
                  doc={sketchDoc}
                  status={sketchSolveStatus}
                  dof={sketchDof}
                  conflicts={sketchConflicts}
                  focusMode={sketchFocusMode}
                  selectedProfileCount={sketchDoc.selectedProfileIds.length || closedProfilesFromLegacy(sketchProfile).length}
                  onToggleFocusMode={() => setSketchFocusMode((mode) => (mode === "2d" ? "3d" : "2d"))}
                  onPatchSettings={(patch) => {
                    setSketchDoc((doc) => ({ ...doc, settings: { ...doc.settings, ...patch } }));
                  }}
                  onRemoveConstraint={(constraintId) => {
                    const nextDoc = removeConstraint(sketchDoc, constraintId);
                    const solved = solveSketchDoc(nextDoc);
                    setSketchDoc(solved.doc);
                    setSketchSolveStatus(solved.status);
                    setSketchDof(solved.dof);
                    setSketchConflicts(solved.conflicts);
                    setSketchProfile(sketchDocToProfile(solved.doc));
                    setNotice("Constraint removed");
                  }}
                  onToggleConstructionMode={() => {
                    setSketchDoc((doc) => ({
                      ...doc,
                      settings: { ...doc.settings, constructionMode: !doc.settings.constructionMode },
                    }));
                  }}
                />
                <div className="sketch-focus-3d" role="region" aria-label="Sketch in 3D view">
                  <div className="sketch-focus-3d-banner">
                    <strong>3D sketch view</strong>
                    <span>Inspect the sketch plane on the model. Use Focus 2D to draw with snaps, constraints, and dimensions.</span>
                    <div className="sketch-focus-3d-actions">
                      <button type="button" className="primary" onClick={() => setSketchFocusMode("2d")}>Focus 2D</button>
                      <button type="button" onClick={startSketchExtrude}>Extrude</button>
                      <button type="button" onClick={cancelSketch}>Cancel sketch</button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          <WorkplaneViewport
          shapes={viewportShapes}
          selectedIds={selectedIds}
          alignMode={alignMode}
          alignAnchorId={effectiveAlignAnchorId}
          alignHandles={alignHandleStatuses}
          alignReferenceShapes={shapes}
          mirrorMode={mirrorMode}
          mirrorReferenceShapes={shapes}
          circularPatternMode={Boolean(circularPattern)}
          circularPatternCenter={circularPattern?.center ?? null}
          circularPatternRadius={circularPatternRadius}
          onCircularPatternPivotPick={setCircularPatternPivot}
          sketchFacePickMode={sketchFacePickMode}
          onSketchPlanePicked={(plane) => beginSketch(undefined, null, plane)}
          onSketchFacePickRejected={(reason) => setNotice(reason)}
          onSketchFacePickCancel={cancelSketchFacePick}
          placementElevation={placementElevation}
          workplaneMode={workplaneMode}
          initialSnap={initialSnap}
          initialWorkspace={initialWorkspace}
          workspaceSettingsKey={projectId ?? "local-workplane"}
          onAddShape={addShape}
          onAlignAnchorChange={chooseAlignAnchor}
          onAlignPreview={previewAlignSelection}
          onAlignPreviewClear={clearAlignPreview}
          onAlignSelection={alignSelectionTo}
          onMirrorPreview={previewMirrorSelection}
          onMirrorPreviewClear={clearMirrorPreview}
          onMirrorSelection={mirrorSelectionAcross}
          onSelectShape={selectShape}
          onSetPlacementElevation={setPlacementWorkplane}
          onInteractionActiveChange={updateProjectInteractionActive}
          onEditSketch={shapeHasEditableSketch(selectedShape) ? beginEditSelectedSketch : undefined}
          onEditSketchDimension={resolveEditableSketchShape(
            activeFeatureId && selectedShape?.groupedShapes
              ? selectedShape.groupedShapes.find((child) => child.id === activeFeatureId) ?? selectedShape
              : selectedShape,
          )?.sketchDoc?.dimensions?.length ? editSelectedSketchDimension : undefined}
          canSeparateParts={canSeparateSelectedParts}
          onSeparateParts={separateSelectedParts}
          activeFeatureId={activeFeatureId}
          onSelectFeature={(featureId) => {
            setActiveFeatureId(featureId);
            if (featureId) {
              const body = selectedShape?.groupedShapes?.length
                ? selectedShape
                : shapes.find((shape) => shape.groupedShapes?.some((child) => child.id === featureId));
              const feature = body?.groupedShapes?.find((child) => child.id === featureId);
              setNotice(feature ? `Feature selected: ${feature.name || feature.kind}` : "Feature selected");
            }
          }}
          onSuppressFeature={selectedShape?.groupedShapes?.length ? suppressSelectedFeature : undefined}
          onReorderFeature={selectedShape?.groupedShapes?.length ? reorderSelectedFeature : undefined}
          onUpdateFeature={selectedShape?.groupedShapes?.length ? updateSelectedFeature : undefined}
          onUpdateShape={updateShape}
          onWorkspaceSettingsChange={updateProjectWorkspaceSettings}
          onWorkplaneModeChange={setWorkplaneMode}
          modifierActive={Boolean(edgeModifier)}
          modifierPreserveSelection={false}
          modifierPreviewActive={Boolean(edgeModifier?.preview)}
          modifierEdges={modifierSelectableEdges}
          selectedModifierEdgeIds={edgeModifier ? edgeModifier.selectedEdgeIds : []}
          onModifierEdgeToggle={toggleModifierEdge}
          viewNudgeAxesRef={viewNudgeAxesRef}
          rotationEditApiRef={rotationEditApiRef}
          onDropToWorkplane={dropSelectedToWorkplane}
          onSnapSelection={snapSelected}
          inspectorDockTop={
            edgeModifier ? (
              <EdgeModifierPanel
                kind={edgeModifier.kind}
                amount={edgeModifier.amount}
                maxAmount={edgeModifierMaxAmount}
                chamferAngle={edgeModifier.chamferAngle}
                quality={edgeModifier.quality}
                sharpAngle={edgeModifier.sharpAngle}
                workspace={workspaceSettings}
                tangentChain={edgeModifier.tangentChain}
                preserveEdgeSize={edgeModifier.preserveEdgeSize}
                targetName={selectedShape?.name ?? "Object"}
                groupedCount={selectedShape?.groupedShapes?.length ?? 0}
                appliedFeatureCount={selectedEdgeFeatureCount}
                reversibleFeatureCount={selectedReversibleEdgeFeatureCount}
                historyOptions={selectedEdgeHistoryOptions}
                selectedCount={edgeModifier.selectedEdgeIds.length}
                availableCount={modifierAvailableEdgeIds.length}
                busy={edgeModifier.busy}
                prepared={edgeModifier.prepared}
                error={edgeModifier.error}
                onAmountChange={(value) => setEdgeModifier((current) => current?.prepared ? { ...current, amount: Math.max(MIN_EDGE_MODIFIER_AMOUNT, Math.min(edgeModifierMaxAmount, value)), preview: null, busy: true, error: null } : current)}
                onChamferAngleChange={(value) => setEdgeModifier((current) => current?.prepared ? { ...current, chamferAngle: Math.max(5, Math.min(85, value)), preview: null, busy: true, error: null } : current)}
                onQualityChange={(quality) => setEdgeModifier((current) => current?.prepared ? { ...current, quality, preview: null, busy: true, error: null } : current)}
                onSharpAngleChange={(sharpAngle) => setEdgeModifier((current) => {
                  if (!current?.prepared) return current;
                  const nextAngle = Math.max(1, Math.min(CAD_MODIFIER_MAX_SHARP_ANGLE, sharpAngle));
                  const availableIds = new Set(current.edges
                    .filter((edge) => selectableCadModifierEdge(edge, nextAngle))
                    .map((edge) => edge.id));
                  const selectedEdgeIds = current.selectedEdgeIds.filter((edgeId) => availableIds.has(edgeId));
                  return {
                    ...current,
                    sharpAngle: nextAngle,
                    selectedEdgeIds,
                    preview: null,
                    busy: selectedEdgeIds.length > 0,
                    error: availableIds.size === 0 ? "No sharp edges match this threshold" : selectedEdgeIds.length ? null : "Select at least one highlighted edge",
                  };
                })}
                onTangentChainChange={(tangentChain) => setEdgeModifier((current) => current?.prepared ? { ...current, tangentChain } : current)}
                onPreserveEdgeSizeChange={(preserveEdgeSize) => setEdgeModifier((current) => current?.prepared ? { ...current, preserveEdgeSize } : current)}
                onSelectAll={() => setEdgeModifier((current) => current?.prepared ? { ...current, selectedEdgeIds: modifierAvailableEdgeIds, preview: null, busy: modifierAvailableEdgeIds.length > 0, error: modifierAvailableEdgeIds.length ? null : current.error } : current)}
                onClear={() => setEdgeModifier((current) => current?.prepared ? { ...current, selectedEdgeIds: [], preview: null, busy: false, error: "Select at least one highlighted edge" } : current)}
                onRemoveFeature={removeEdgeTreatment}
                onApply={applyEdgeModifier}
                onCancel={cancelEdgeModifier}
              />
            ) : null
          }
          inspectorDock={
            circularPattern ? (
              <CircularPatternPanel
                sourceCount={circularPatternSources.length}
                pivotName={circularPatternPivot?.name ?? null}
                count={circularPattern.count}
                radiusMm={circularPatternRadius}
                rotationDeg={circularPattern.rotation}
                hasPivot={Boolean(circularPattern.pivotId && circularPattern.center)}
                canApply={Boolean(circularPattern.center && circularPattern.preview?.length)}
                workspace={workspaceSettings}
                onCountChange={patchCircularPatternCount}
                onRadiusChange={patchCircularPatternRadius}
                onRotationChange={patchCircularPatternRotation}
                onApply={applyCircularPattern}
                onCancel={cancelCircularPattern}
                positionClampWarning={Boolean(
                  circularPattern.center
                  && circularPatternWouldClamp(circularPattern.center, circularPattern.radius, circularPattern.count),
                )}
              />
            ) : null
          }
          />
          </div>
          {toolbarMode === "geometry" ? (
            <ShapeSidebar
              shapes={shapes}
              selectedIds={selectedIds}
              collapsed={hasSelection && !shapeRailPinned}
              onExpand={() => setShapeRailPinned(true)}
              onCollapse={hasSelection ? () => setShapeRailPinned(false) : undefined}
              onSelectShape={selectShape}
              onAddShape={(shape) => {
                addShape(shape);
                setTopPanel(null);
                setMenuOpen(false);
              }}
            />
          ) : null}
          </>
        )}
      </div>
      {topPanel ? (
        <TopActionPanel
          panel={topPanel}
          shapeCount={exportableShapeCount}
          scopeLabel={exportScopeLabel}
          stepPreflight={exportPreflight}
          onClose={() => setTopPanel(null)}
          onExport={exportDesign}
          onExportStep={exportStepDesign}
          stepExporting={stepExporting}
          onImportFiles={selectFiles}
          onPickFile={() => fileInputRef.current?.click()}
        />
      ) : null}
      <input
        ref={sketchImageInputRef}
        className="hidden-file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void addSketchImageFile(file);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={fileInputRef}
        className="hidden-file-input"
        type="file"
        accept=".stl,.step,.stp,.svg,.3mf,image/svg+xml"
        onChange={(event) => {
          if (event.currentTarget.files) {
            selectFiles(event.currentTarget.files);
          }
          event.currentTarget.value = "";
        }}
      />
      <ExportSuccessOverlay event={exportSuccess} />
      {valueDialog?.kind === "sketch-fillet" || valueDialog?.kind === "sketch-chamfer" ? (
        <InlineValueDialog
          title={valueDialog.kind === "sketch-fillet" ? "Fillet corner" : "Chamfer corner"}
          fields={[
            {
              key: "amount",
              label: valueDialog.kind === "sketch-fillet" ? "Fillet radius" : "Chamfer distance",
              value: "2",
              unit: "mm",
              min: 0,
            },
          ]}
          confirmLabel={valueDialog.kind === "sketch-fillet" ? "Fillet" : "Chamfer"}
          onCancel={cancelValueDialog}
          onConfirm={confirmSketchFilletChamferDialog}
        />
      ) : null}
      {valueDialog?.kind === "sketch-pattern" ? (
        <InlineValueDialog
          title="Rectangular pattern"
          fields={[
            { key: "countX", label: "Count X", value: "3", inputMode: "numeric", min: 1, step: "1" },
            { key: "countZ", label: "Count Z", value: "1", inputMode: "numeric", min: 1, step: "1" },
            { key: "spacingX", label: "Spacing X", value: "10", unit: "mm" },
            { key: "spacingZ", label: "Spacing Z", value: "10", unit: "mm" },
          ]}
          confirmLabel="Create pattern"
          onCancel={cancelValueDialog}
          onConfirm={confirmSketchPatternDialog}
        />
      ) : null}
      <div
        className={`editor-toast${noticeVisible ? " visible" : ""}${noticeQuiet ? " editor-toast--quiet" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className="editor-toast-message">{notice}</span>
        {noticeVisible ? (
          <button
            className="editor-toast-dismiss"
            type="button"
            aria-label="Dismiss message"
            onClick={dismissNotice}
          >
            <X size={14} strokeWidth={2.5} />
          </button>
        ) : null}
      </div>
      <pre data-codex-state hidden>
        {debugState}
      </pre>
      <pre data-codex-summary hidden>
        {compactDebugState}
      </pre>
    </div>
  );
}

function TopActionPanel({
  panel,
  shapeCount,
  scopeLabel,
  stepPreflight,
  onClose,
  onExport,
  onExportStep,
  stepExporting,
  onImportFiles,
  onPickFile,
}: {
  panel: Exclude<TopPanel, null>;
  shapeCount: number;
  scopeLabel: "selected" | "total";
  stepPreflight: StepPreflightRow[];
  onClose: () => void;
  onExport: (format: ExportFormat) => void;
  onExportStep: () => void;
  stepExporting: boolean;
  onImportFiles: (files: FileList | File[]) => void;
  onPickFile: () => void;
}) {
  const title =
    panel === "tips"
      ? "Tips"
      : panel === "export"
        ? "Export"
        : "Import";

  return (
    <div className="top-action-panel" role="dialog" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <button aria-label={`Close ${title}`} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {panel === "import" ? (
        <div className="top-action-body">
          <button
            className="import-drop-zone"
            onClick={onPickFile}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length > 0) {
                onImportFiles(event.dataTransfer.files);
              }
            }}
          >
            <ToolbarImportIcon />
            <strong>Drop STL, STEP, SVG, or 3MF files</strong>
            <span>or click to choose from your computer</span>
          </button>
        </div>
      ) : null}
      {panel === "export" ? (
        <div className="top-action-body">
          <p>{shapeCount} {scopeLabel} solid shape{shapeCount === 1 ? "" : "s"} ready to export.</p>
          <button className="export-primary" onClick={onExportStep} disabled={stepExporting}>
            <ToolbarExportIcon />
            {stepExporting ? "Building STEP…" : "Download STEP"}
          </button>
          {stepPreflight.length > 0 ? (
            <ul className="export-body-list" aria-label="STEP quality by body">
              {stepPreflight.map((row, index) => (
                <li key={`${row.name}-${row.kind}-${index}`} className="export-body-row">
                  <span className="export-body-row-name">{row.name || "Untitled"}</span>
                  <span
                    className={`cad-ready-badge${row.quality === "faceted" ? " cad-ready-badge--mesh" : ""}${row.quality === "pending" || row.quality === "unsupported" ? " cad-ready-badge--pending" : ""}`}
                    title={row.detail}
                  >
                    {shapeExportQualityLabel(row.quality)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="export-step-note">STEP is the manufacturing-grade path. Mesh formats below are for print and interchange.</p>
          <div className="export-mesh-actions">
            <button onClick={() => onExport("stl")}>
              <Download size={18} />
              Download STL
            </button>
            <button onClick={() => onExport("obj")}>
              <ToolbarExportIcon />
              Download OBJ
            </button>
            <button onClick={() => onExport("3mf")}>
              <ToolbarExportIcon />
              Download 3MF
            </button>
          </div>
        </div>
      ) : null}
      {panel === "tips" ? (
        <div className="top-action-body">
          <p><strong>CAD path (30 seconds)</strong></p>
          <p>1. Drop a Box. 2. Sketch on a face → draw a circle → Extrude as Hole. 3. Group. 4. Download STEP — look for Exact vs Faceted.</p>
          <p>Round cylinders and boxes export as true CAD. Stretch a cylinder oval and it still exports exact (elliptical). STL imports stay faceted mesh STEP.</p>
          <p>Click a shape to select it. Use the inspector Model tree for suppress/reorder, and the Edge tools for fillet/chamfer.</p>
          <p><strong>Beta tip</strong></p>
          <p>PeakCAD is local-first — no account. Assemblies (Group without holes) export multi-solid STEP. Sketch H/V/coincident and driving dims stick hard; fillet recipes re-apply after remesh when topology allows.</p>
        </div>
      ) : null}
    </div>
  );
}

