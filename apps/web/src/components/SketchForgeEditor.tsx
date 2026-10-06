"use client";

import { Download, X } from "lucide-react";
import type { ManifoldToplevel } from "manifold-3d";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { ADDITION, Brush, Evaluator, HOLLOW_INTERSECTION, INTERSECTION, SUBTRACTION, type CSGOperation } from "three-bvh-csg";
import * as THREE from "three";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clearManifoldRuntimeCache, getManifoldRuntime } from "@/lib/manifoldRuntime";
import { simplifiedImportedShapePatch } from "@/lib/meshSimplify";
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
import { LinearPatternPanel } from "./workplane/LinearPatternPanel";
import { PlacementRulerPanel } from "./workplane/PlacementRulerPanel";
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
  cloneShapesForPaste,
  readShapeClipboard,
  readSharedClipboard,
  SHARED_CLIPBOARD_STORAGE_KEY,
  writeShapeClipboard,
} from "@/lib/shapeClipboard";
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
  expandBooleanOperands,
  filterCoplanarDisplayEdges,
  pickGroupToUngroup,
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
import {
  bakeImportedBrepStepsForSave,
  importedBrepStepsAwaitingSave,
  withBakedImportedBrepSteps,
} from "@/lib/importedBrepSource";
import { meshDataToTransfer, runManifoldBooleanInWorker, warmManifoldBooleanWorker } from "@/lib/manifoldBooleanClient";
import { cloneWorkplaneShapeSnapshot, compactEdgeTreatmentHistory, edgeTreatmentAppliedFrame, lastEditableEdgeTreatment, restoreShapeBeforeEdgeTreatment } from "@/lib/edgeTreatmentHistory";
import { appendEditorHistorySnapshot, editorHistoryEntry, expandHistoryShapes, historyShapeMissingTessellation, historyShapeNeedsRemesh, hydrateEditorHistoryState, projectShapesFingerprint, type EditorHistoryEntry, type EditorHistoryState } from "@/lib/editorHistory";
import { faceToFaceTranslation } from "@/lib/objectSnap";
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
  LINEAR_PATTERN_DEFAULT_COUNT_X,
  LINEAR_PATTERN_DEFAULT_COUNT_Y,
  LINEAR_PATTERN_DEFAULT_COUNT_Z,
  clampLinearPatternCount,
  clampLinearPatternSpacing,
  linearPatternInstances,
  linearPatternSuggestedSpacing,
  linearPatternWouldClamp,
  resolveLinearPatternSourceId,
} from "@/lib/linearPattern";
import { edgeTreatmentSourceParts } from "@/lib/edgeTreatmentSources";
import {
  dissolvePatternFeature,
  findPatternSource,
  patternFeatureId,
  patternMemberIds,
  replacePatternFeature,
  syncLinkedPatternShapes,
  tagCircularPatternInstances,
  tagLinearPatternInstances,
} from "@/lib/patternFeature";
import {
  isConstructionShape,
} from "@/lib/holeFeature";
import { dropPatchOntoFrame } from "@/lib/placementFrame";
import { aabbsOverlap, shapeYawDegrees, worldAabb } from "@/lib/shapeBounds";
import {
  applyPlacementOffsetsToSelection,
  placementOffsetsFromBaseline,
  placementPoseOf,
  recapturePlacementBaseline,
  type PlacementBaseline,
  type PlacementOffsets,
} from "@/lib/placementRuler";
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
  buildStepExportPreflight,
  occtMeshFallbackNotice,
  selectionSupportsOcctCsg,
  shapeExportQualityLabel,
  type StepPreflightRow,
} from "@/lib/stepQuality";
import { fingerprintsForEdgeIds, matchRecipeEdgeIds } from "@/lib/edgeTreatmentRematch";
import { densifyClosedPathUv } from "@/lib/sketchBrep";

import {
  axisAlignedRectFromClosedPath,
  circleFromClosedPath,
  cloneSketchProfile,
  emptySketchProfile,
  orderedSketchPaths,
  pasteSketchClipboardIntoProfile,
  shapeFromSketchProfile,
  sketchClipboardFromSelection,
  withSmoothSketchHandles,
  type SketchClipboard,
} from "@/lib/sketchProfileShape";
import { makeBlockPerfScene, makeHouseScene } from "@/lib/devAutomationScenes";
import { booleanAutomationDynamicScene, booleanAutomationScene } from "@/lib/devBooleanAutomationScenes";
import {
  cadDisplayEdgesAfterTreatment,
  cadDisplayEdgesForShape,
  cadModifierComponentPreviews,
  edgeTreatmentFeatureCount,
  edgeTreatmentHistoryOptions,
  edgeTreatmentLabel,
  groupedShapeWithComponentEdgeTreatment,
  restoreOwnLastEdgeTreatment,
  reversibleEdgeTreatmentCount,
  selectableCadModifierEdge,
  shapeWithEdgeTreatmentRecord,
  tangentCadEdgeChain,
  bakedEdgeTreatmentPreview,
  shapeFromCadMesh,
} from "@/lib/editorEdgeTreatments";
import { cloneAsGroupChild, groupedShape } from "@/lib/editorGroup";
import {
  type Cuboid,
  type MeshData,
  type Vec3,
  appendMeshData,
  boundsForCuboids,
  boundsForShapes,
  meshAabb,
  meshForShape,
  shapeAabb,
} from "@/lib/editorShapeMesh";
import { MIN_SHAPE_DIMENSION, cleanModelDimension } from "@/lib/modelDimension";
import {
  alignedShapesForSelection,
  alignmentLabel,
  alignmentStatuses,
  buildGroupedShapeFromSelection,
  buildIntersectionShapeFromSelection,
  cleanShapePatch,
  effectiveAlignmentAnchorId,
  findOverlappingHostForHole,
  mirrorAxisLabel,
  mirroredShapesForSelection,
  remeshCsgGroup,
  restoreGroupedChildren,
  rewriteSketchHostIds,
  separablePartCount,
  separateShapeParts,
  shapeThicknessInwardFromFace,
  updateCsgLeafAndRemesh,
} from "@/lib/editorBoolean";
export type { Cuboid, MeshData, Vec3 };

import { promoteWorkplaneSketchToPrimitive } from "@/lib/sketchPrimitivePromote";
import {
  addConstraints,
  addLinearDimension,
  addRadiusDimension,
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
  resolveSketchCircle,
  trimClickedSpan,
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
import type { MeshSeatMode } from "@/lib/meshSeatOrientation";
import { lengthDisplayUnit } from "@/lib/measurementUnits";
import { importedShapeFrom3mf } from "@/lib/threeMfImport";
import { to3mfForShapes } from "@/lib/threeMfExport";
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
import { takePreloadedCadModifierWorker } from "@/lib/cadModifierPreload";
import { nearestMetricThreadForDiameter, type MetricThreadDesignation } from "@/lib/metricThreads";
import { canSeparateThreadScrew, createThreadShape, DEFAULT_THREAD_DESIGNATION, separateThreadScrewParts } from "@/lib/threadShape";
import type { AlignAxis, AlignHandleStatus, AlignTarget, GridSize, ShapeAsset, SketchImage, SketchPlane, SketchPoint, SketchProfile, SketchSegment, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export { importedShapeFromStl, importedShapeFromSvg, importedShapeFrom3mf };

export type ProjectSaveSnapshot = {
  projectId: string;
  shapes: WorkplaneShape[];
  history: EditorHistoryEntry[];
  historyIndex: number;
};
/** Resolves `false` when the save was cancelled (Save As picker closed) or failed. */
export type ProjectSaveHandler = (snapshot: ProjectSaveSnapshot) => Promise<boolean> | void;
/** Lets the page ask the open editor before leaving it, and route menu Save through the editor. */
export type EditorLeaveGuard = {
  confirmLeave: () => Promise<boolean>;
  save: (mode: "save" | "save-as") => Promise<boolean>;
};
export type TopPanel = "import" | "export" | "tips" | null;
export type ExportFormat = "stl" | "obj" | "3mf";
export type ToolbarMode = "geometry" | "sketch";
export type ValueDialogState =
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
  "constrain-coincident": "Coincident constraint",
  "constrain-midpoint": "Midpoint constraint",
  "constrain-fix": "Fix constraint",
  "constrain-concentric": "Concentric constraint",
};

const SKETCH_POINT_CHAIN_TOOLS = new Set<SketchTool>(["line", "bezier", "smooth"]);
const SKETCH_MULTI_POINT_TOOLS = new Set<SketchTool>([
  "dimension",
  "constrain-h",
  "constrain-v",
  "constrain-coincident",
  "constrain-symmetry",
  "constrain-concentric",
  "constrain-tangent",
  "constrain-midpoint",
]);
const SKETCH_MULTI_SEGMENT_TOOLS = new Set<SketchTool>([
  "constrain-equal",
  "constrain-parallel",
  "constrain-perp",
  "constrain-symmetry",
  "constrain-tangent",
  "constrain-concentric",
  "mirror",
  "pattern",
]);

/** Click-to-pick for constraint and modify tools. One click replaces; a second click adds. */
function accumulateSketchPick(
  current: SketchSelection,
  tool: SketchTool,
  pick: { pointId?: string; segmentId?: string },
): SketchSelection {
  const chain = SKETCH_MULTI_POINT_TOOLS.has(tool) || SKETCH_MULTI_SEGMENT_TOOLS.has(tool);
  if (!chain) {
    if (pick.pointId) return { kind: "point", id: pick.pointId };
    if (pick.segmentId) return { kind: "segment", id: pick.segmentId };
    return current;
  }
  const pointIds = current?.kind === "multiple" ? [...current.pointIds] : current?.kind === "point" ? [current.id] : [];
  const segmentIds = current?.kind === "multiple" ? [...current.segmentIds] : current?.kind === "segment" ? [current.id] : [];
  if (pick.pointId && !pointIds.includes(pick.pointId)) pointIds.push(pick.pointId);
  if (pick.segmentId && !segmentIds.includes(pick.segmentId)) segmentIds.push(pick.segmentId);
  if (!pointIds.length && segmentIds.length === 1) return { kind: "segment", id: segmentIds[0] };
  if (!segmentIds.length && pointIds.length === 1) return { kind: "point", id: pointIds[0] };
  return { kind: "multiple", pointIds, segmentIds, imageIds: [] };
}

/** Resolves once the browser has painted, so an overlay is on screen before synchronous work blocks the main thread. */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    // requestAnimationFrame never fires in a hidden window; don't stall the import on it.
    const fallback = window.setTimeout(resolve, 250);
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        window.clearTimeout(fallback);
        resolve();
      }, 0);
    });
  });
}

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
export type ShapeUpdatePatch = Partial<WorkplaneShape> & { bakeTransform?: boolean; repeatDeltaBefore?: WorkplaneShape };
export type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never;
export type CadModifierWorkerPayload = WithoutRequestId<CadModifierWorkerRequest>;
export type EdgeModifierSession = {
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
  /** Recipe being edited so prepare can reselect the original edges. */
  editRecipe?: NonNullable<WorkplaneShape["edgeTreatments"]>[number];
};

export type EdgeModifierComponentPreview = {
  owner: number;
  shape: WorkplaneShape;
};
export type CircularPatternSession = {
  sourceIds: string[];
  pivotId: string | null;
  center: CircularPatternCenter | null;
  radius: number;
  count: number;
  rotation: CircularPatternRotationStep;
  preview: WorkplaneShape[] | null;
  featureId?: string;
  editing?: boolean;
};
export type LinearPatternSession = {
  sourceIds: string[];
  countX: number;
  countZ: number;
  countY: number;
  spacingX: number;
  spacingZ: number;
  spacingY: number;
  preview: WorkplaneShape[] | null;
  featureId?: string;
  editing?: boolean;
};
export type PlacementRulerSession = {
  baseline: PlacementBaseline | null;
  baselineId: string | null;
};
export type EdgeFeatureRevertOption = {
  id: string;
  entryId: string;
  path: number[];
  label: string;
  targetName: string;
  createdAt: number;
  removesNewerCount: number;
};
export type ManifoldSolid = ReturnType<ManifoldToplevel["Manifold"]["cube"]>;
export type GroupBuildResult = {
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
export type IntersectionAttempt =
  | { status: "success"; group: WorkplaneShape }
  | { status: "empty" }
  | { status: "unsupported" };
export type IntersectionBuildResult = {
  group: WorkplaneShape | null;
  empty: boolean;
  failureNotice: string;
};
export type BooleanAutomationMode = "before" | "after" | "ungroup";
export type BooleanAutomationResult = {
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
const MAX_SKETCH_HISTORY_ENTRIES = hardwareProfile().sketchHistoryEntries;
const MIN_EDGE_MODIFIER_AMOUNT = 0.001;




function meshDataToCadTransfer(mesh: MeshData) {
  const positions = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((vertex, index) => positions.set(vertex, index * 3));
  const indices = new Uint32Array(mesh.faces.length * 3);
  mesh.faces.forEach((face, index) => indices.set(face, index * 3));
  return { positions, indices };
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
  // A turned group has to keep its children. Baking the angle into one mesh
  // deleted them, so Ungroup had nothing left to open.
  if (shape.groupedShapes?.length) {
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
  const bakedCadMetadata = bakeCadMetadataForShapeTransform(shape, { centerX, minY, centerZ, width, depth, height, yawDegrees: shapeYawDegrees(shape) });

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
  const lines = ["# PeakCAD OBJ export"];
  let offset = 1;
  meshes.forEach((mesh) => {
    lines.push(`o ${mesh.name}`);
    mesh.vertices.forEach(([x, y, z]) => lines.push(`v ${x} ${y} ${z}`));
    mesh.faces.forEach(([a, b, c]) => lines.push(`f ${a + offset} ${b + offset} ${c + offset}`));
    offset += mesh.vertices.length;
  });
  return lines.join("\n");
}



/** Restore mesh caches stripped from compact history snapshots. */
async function remeshDirtyHistoryShapes(shapes: WorkplaneShape[]): Promise<{ shapes: WorkplaneShape[]; failedNames: string[] }> {
  if (!shapes.some(historyShapeNeedsRemesh)) {
    return { shapes, failedNames: [] };
  }
  const next = [...shapes];
  const failedNames: string[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const shape = next[index];
    if (!historyShapeNeedsRemesh(shape)) continue;
    const hadEdgeFeatures = Boolean(shape.edgeTreatments?.length || shape.cadBrep);
    const remeshed = await remeshCsgGroup(shape);
    if (remeshed) {
      let restored = remeshed;
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
  onSaveProject,
  onSaveProjectAs,
  onRegisterLeaveGuard,
  hasMatchingSavedFile = false,
  projectId,
  projectName = "PeakCAD design",
  projectRevision = 0,
  onViewportReady,
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
  onSaveProject?: ProjectSaveHandler;
  onSaveProjectAs?: ProjectSaveHandler;
  onRegisterLeaveGuard?: (guard: EditorLeaveGuard | null) => void;
  hasMatchingSavedFile?: boolean;
  projectId?: string | null;
  projectName?: string;
  projectRevision?: number;
  onViewportReady?: () => void;
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
  const [importAsHole, setImportAsHole] = useState(false);
  const [stlSeatPrompt, setStlSeatPrompt] = useState<{ name: string; buffer: ArrayBuffer } | null>(null);
  const [modelLoadingName, setModelLoadingName] = useState<string | null>(null);
  const modelLoadingTokenRef = useRef(0);
  const [exactStepSaveProgress, setExactStepSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [unsavedPrompt, setUnsavedPrompt] = useState<{ saving: boolean } | null>(null);
  const unsavedPromptResolveRef = useRef<((leave: boolean) => void) | null>(null);
  const explicitSaveInFlightRef = useRef(false);
  /** Scene fingerprint at the last explicit save (or at project open); autosave does not move it. */
  const explicitSaveFingerprintRef = useRef<string | null>(null);
  const [placementRuler, setPlacementRuler] = useState<PlacementRulerSession | null>(null);
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkplaneWorkspaceSettings>(() => {
    const normalized = normalizeWorkspaceSettings(initialWorkspace);
    setActiveDisplayQuality(normalized.displayQuality);
    return normalized;
  });
  const [snapGrid, setSnapGrid] = useState<GridSize>(() => normalizeSnapGrid(initialSnap, DEFAULT_SNAP_GRID));
  const [menuOpen, setMenuOpen] = useState(false);
  const [topPanel, setTopPanel] = useState<TopPanel>(null);
  const [renderedTopPanel, setRenderedTopPanel] = useState<TopPanel>(null);
  const [topPanelClosing, setTopPanelClosing] = useState(false);
  useEffect(() => {
    if (topPanel) {
      setRenderedTopPanel(topPanel);
      setTopPanelClosing(false);
      return;
    }
    setTopPanelClosing(true);
    const timer = window.setTimeout(() => {
      setRenderedTopPanel(null);
      setTopPanelClosing(false);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [topPanel]);
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
  const [faceSnap, setFaceSnap] = useState<{ source: { shapeId: string; point: [number, number, number]; normal: [number, number, number] } | null } | null>(null);
  const faceSnapMotionRef = useRef<((shapeId: string, delta: { x: number; y: number; z: number }, done: () => void) => void) | null>(null);
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
  const sketchPickAtRef = useRef<{ x: number; z: number } | null>(null);
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
  const [linearPattern, setLinearPattern] = useState<LinearPatternSession | null>(null);
  const linearPatternRef = useRef<LinearPatternSession | null>(null);
  const [valueDialog, setValueDialog] = useState<ValueDialogState>(null);
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const [hotkeys, setHotkeys] = useState(() => loadHotkeyBindings());
  const cadModifierWorkerRef = useRef<Worker | null>(null);
  const cadModifierPendingRef = useRef(new Map<number, {
    resolve: (message: CadModifierWorkerResponse) => void;
    reject: (error: Error) => void;
    timer: number;
    mesh?: Extract<CadModifierWorkerResponse, { type: "preview" }>;
  }>());
  const cadModifierRequestRef = useRef(0);
  const cadModifierPrepareRef = useRef(0);
  const cadModifierLatestPreviewRef = useRef(0);
  const cadModifierBaseShapeRef = useRef<WorkplaneShape | null>(null);
  const reapplyEdgeTreatmentsRef = useRef<(shape: WorkplaneShape) => Promise<void>>(async () => {});
  const cadModifierBaseFingerprintRef = useRef("");
  const cadModifierSourcePartsRef = useRef<WorkplaneShape[]>([]);
  const cadModifierEditBeforeRef = useRef<WorkplaneShape | null>(null);
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
        const adopted = takePreloadedCadModifierWorker();
        const worker = bindPrimaryWorker(adopted ?? new Worker(new URL("../workers/cadModifier.worker.ts", import.meta.url), { type: "module" }));
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
        setEdgeModifier((current) => {
          if (!current) return current;
          const rematched = current.editRecipe
            ? matchRecipeEdgeIds(current.editRecipe, message.edges, current.sharpAngle)
            : [];
          const selectedEdgeIds = rematched.length > 0 ? rematched : [];
          const hasEdges = selectedEdgeIds.length > 0 || message.selectableEdgeIds.length > 0;
          return {
            ...current,
            edges: message.edges,
            selectedEdgeIds,
            busy: selectedEdgeIds.length > 0,
            prepared: true,
            preview: null,
            componentPreviews: [],
            error: hasEdges
              ? null
              : "No sharp manifold edges were found at this threshold",
          };
        });
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
      if (message.type === "previewBrep") {
        if (message.requestId !== cadModifierLatestPreviewRef.current) return;
        setEdgeModifier((current) => {
          if (!current?.preview) return current;
          const componentPreviews = current.componentPreviews.map((component, index) => {
            const brep = message.componentBreps?.[index];
            if (!brep) return component;
            return { ...component, shape: { ...component.shape, cadBrep: brep } };
          });
          return {
            ...current,
            preview: { ...current.preview, cadBrep: message.brep },
            componentPreviews,
          };
        });
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
          cadModifierEditBeforeRef.current = null;
          setEdgeModifier(null);
          setNotice(message.message);
          return;
        }
        // The edge modifier panel already renders message.message as its error state.
        setEdgeModifier((current) => current ? { ...current, busy: false, error: message.message } : current);
      }
    }
    cadModifierWorkerRestartRef.current = createWorker;
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
    clearCadModifierWatchdog();
    const requestId = cadModifierRequestRef.current + 1;
    cadModifierRequestRef.current = requestId;
    cadModifierLatestPreviewRef.current = requestId;
    cadModifierPrepareRef.current = requestId;
    cadModifierWorkerRef.current?.terminate();
    cadModifierWorkerRef.current = null;
    cadModifierBaseShapeRef.current = null;
    cadModifierBaseFingerprintRef.current = "";
    cadModifierSourcePartsRef.current = [];
    cadModifierEditBeforeRef.current = null;
    setEdgeModifier(null);
    return true;
  }, [clearCadModifierWatchdog]);

  const clearEditorToolSessions = useCallback((keep?: "placement" | "align" | "mirror" | "linear" | "circular" | "fillet") => {
    if (keep !== "align") {
      setAlignMode(false);
      setAlignAnchorId(null);
      setAlignPreview(null);
    }
    if (keep !== "mirror") {
      setMirrorMode(false);
      setMirrorPreviewAxis(null);
    }
    if (keep !== "circular") {
      circularPatternRef.current = null;
      setCircularPattern(null);
    }
    if (keep !== "linear") {
      linearPatternRef.current = null;
      setLinearPattern(null);
    }
    if (keep !== "placement") {
      setPlacementRuler(null);
    }
    if (keep !== "fillet") {
      invalidateCadModifierSession();
    }
    setFaceSnap(null);
  }, [invalidateCadModifierSession]);

  useEffect(() => {
    const warmBooleanRuntime = () => {
      warmManifoldBooleanWorker();
      void getManifoldRuntime().catch(() => {
        // Allow a real grouping action to retry if an idle preload was interrupted.
        clearManifoldRuntimeCache();
      });
      // A failed preload drops its cached promise, so the first STEP import/export retries.
      void import("@/lib/brepKernel")
        .then(({ loadBrepWithOcct }) => loadBrepWithOcct())
        .catch(() => undefined);
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
    void readShapeClipboard().then((stored) => {
      setClipboard(stored.length > 0 ? stored : readSharedClipboard());
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === SHARED_CLIPBOARD_STORAGE_KEY) {
        void readShapeClipboard().then((stored) => {
          setClipboard(stored.length > 0 ? stored : readSharedClipboard());
        });
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
    linearPatternRef.current = linearPattern;
  }, [linearPattern]);

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
  const canLinearPattern = canCircularPattern;
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
      // Keep the fillet that is already on screen. Clearing it made the previous
      // edge look erased while the next edge was calculated.
      return { ...current, selectedEdgeIds: [...next], preview: next.size > 0 ? current.preview : null, busy: next.size > 0, error: next.size ? null : "Select at least one highlighted edge" };
    });
  }, []);

  const exportableShapeCount = useMemo(() => (hasSelection ? selectedShapes : shapes).filter((shape) => !shape.hole && !isConstructionShape(shape)).length, [hasSelection, selectedShapes, shapes]);
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
    if (linearPattern) {
      return { label: "Linear pattern", hint: "Esc to cancel" };
    }
    if (placementRuler) {
      return {
        label: "Placement ruler",
        hint: hasSelection ? "Enter X, Y, or Z to move" : "Please select a shape to begin",
      };
    }
    if (alignMode) {
      return { label: "Align", hint: "Esc to cancel" };
    }
    if (mirrorMode) {
      return { label: "Mirror", hint: "Esc to cancel" };
    }
    return null;
  }, [alignMode, circularPattern, edgeModifier, hasSelection, linearPattern, mirrorMode, placementRuler]);
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
      if (linearPattern?.preview) {
        const sourceIds = new Set(linearPattern.sourceIds);
        return shapes.filter((shape) => !sourceIds.has(shape.id)).concat(linearPattern.preview);
      }
      return shapes;
    },
    [alignMode, alignPreview, circularPattern, edgeModifier?.preview, effectiveAlignAnchorId, linearPattern, mirrorMode, mirrorPreviewAxis, selectedIds, selectedShapes, shapes],
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
      const canonicalNext = migrateShapesCsg(syncLinkedPatternShapes(next).map(canonicalizeShape));
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

  const persistBakedImportedBrepSteps = useCallback(() => {
    if (historyWriteSuspendedRef.current > 0) return;
    const current = shapesRef.current;
    const baked = withBakedImportedBrepSteps(current);
    if (baked === current) return;
    // Attaching exact text is not a model edit: a scene that matched the last explicit save still does.
    if (explicitSaveFingerprintRef.current === projectShapesFingerprint(current)) {
      explicitSaveFingerprintRef.current = projectShapesFingerprint(baked);
    }
    shapesRef.current = baked;
    setShapes(baked);
    // Same model, now carrying its exact source: rewrite the cursor entry instead of adding an undo step.
    const entries = historyRef.current;
    const index = historyIndexRef.current;
    if (entries[index]) {
      const nextEntries = entries.slice();
      nextEntries[index] = editorHistoryEntry(baked, selectedIdsRef.current);
      historyRef.current = nextEntries;
      setHistory(nextEntries);
    }
    syncProjectShapes(baked);
  }, [syncProjectShapes]);

  const hasUnsavedProjectChanges = useCallback(() => {
    if (!projectId || !onSaveProject) return false;
    const current = pendingProjectShapesRef.current ?? shapesRef.current;
    if (importedBrepStepsAwaitingSave(current).length > 0) return true;
    const baseline = explicitSaveFingerprintRef.current;
    return baseline !== null && projectShapesFingerprint(current) !== baseline;
  }, [onSaveProject, projectId]);

  /**
   * Explicit Save / Save As: bake exact STEP for imported bodies that still have a live kernel
   * solid, attach it to the live shapes, then hand those shapes to the ordinary project save.
   */
  const saveProjectExplicitly = useCallback(async (mode: "save" | "save-as"): Promise<boolean> => {
    const handler = mode === "save-as" ? onSaveProjectAs ?? onSaveProject : onSaveProject;
    if (!projectId || !handler || explicitSaveInFlightRef.current) return false;
    explicitSaveInFlightRef.current = true;
    try {
      let bake: { baked: number; failedNames: string[] } = { baked: 0, failedNames: [] };
      const awaiting = importedBrepStepsAwaitingSave(pendingProjectShapesRef.current ?? shapesRef.current);
      if (awaiting.length > 0) {
        flushSync(() => {
          setNotice(`Saving exact STEP for ${awaiting.length} imported ${awaiting.length === 1 ? "body" : "bodies"}…`);
          setExactStepSaveProgress({ done: 0, total: awaiting.length });
        });
        await afterNextPaint();
        let lastPaint = performance.now();
        bake = await bakeImportedBrepStepsForSave(
          pendingProjectShapesRef.current ?? shapesRef.current,
          async (done, total) => {
            setExactStepSaveProgress({ done, total });
            if (done < total && performance.now() - lastPaint > 80) {
              await afterNextPaint();
              lastPaint = performance.now();
            }
          },
        );
        persistBakedImportedBrepSteps();
      }
      const saved = withBakedImportedBrepSteps(pendingProjectShapesRef.current ?? shapesRef.current);
      const snapshot: ProjectSaveSnapshot = {
        projectId,
        shapes: saved.map(canonicalizeShape),
        history: historyRef.current,
        historyIndex: historyIndexRef.current,
      };
      flushProjectShapesSync();
      const ok = await handler(snapshot);
      if (ok === false) return false;
      explicitSaveFingerprintRef.current = projectShapesFingerprint(saved);
      if (bake.failedNames.length > 0) {
        const names = bake.failedNames.slice(0, 4).join(", ");
        const more = bake.failedNames.length > 4 ? ` +${bake.failedNames.length - 4} more` : "";
        setNotice(
          `Saved · ${bake.failedNames.length} imported ${bake.failedNames.length === 1 ? "body" : "bodies"} could not store exact STEP and will export faceted: ${names}${more}`,
        );
      } else if (bake.baked > 0) {
        setNotice(`Saved · exact STEP stored for ${bake.baked} imported ${bake.baked === 1 ? "body" : "bodies"}`);
      }
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save the project");
      return false;
    } finally {
      explicitSaveInFlightRef.current = false;
      setExactStepSaveProgress(null);
    }
  }, [flushProjectShapesSync, onSaveProject, onSaveProjectAs, persistBakedImportedBrepSteps, projectId, setNotice]);

  const confirmLeaveProject = useCallback((): Promise<boolean> => {
    if (!hasUnsavedProjectChanges()) return Promise.resolve(true);
    unsavedPromptResolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      unsavedPromptResolveRef.current = resolve;
      setUnsavedPrompt({ saving: false });
    });
  }, [hasUnsavedProjectChanges]);

  const settleUnsavedPrompt = useCallback((leave: boolean) => {
    const resolve = unsavedPromptResolveRef.current;
    unsavedPromptResolveRef.current = null;
    setUnsavedPrompt(null);
    resolve?.(leave);
  }, []);

  const saveFromUnsavedPrompt = useCallback(async () => {
    setUnsavedPrompt({ saving: true });
    const ok = await saveProjectExplicitly("save");
    if (ok) {
      settleUnsavedPrompt(true);
      return;
    }
    // Save As picker closed or the write failed: stay in the prompt so Don't save / Cancel remain.
    setUnsavedPrompt((current) => (current ? { saving: false } : current));
  }, [saveProjectExplicitly, settleUnsavedPrompt]);

  const handleHome = useCallback(async () => {
    if (!(await confirmLeaveProject())) return;
    publishProjectSnapshot();
    onHome?.();
  }, [confirmLeaveProject, onHome, publishProjectSnapshot]);

  useEffect(() => {
    if (!onRegisterLeaveGuard) return;
    onRegisterLeaveGuard({ confirmLeave: confirmLeaveProject, save: saveProjectExplicitly });
    return () => onRegisterLeaveGuard(null);
  }, [confirmLeaveProject, onRegisterLeaveGuard, saveProjectExplicitly]);

  useEffect(() => {
    // Browsers only show their generic prompt here; in-app exits use the Save / Don't save dialog.
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedProjectChanges()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedProjectChanges]);

  useEffect(() => () => unsavedPromptResolveRef.current?.(false), []);

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
    } else if (remeshed) {
      const activeChildren = (next.groupedShapes ?? []).filter((child) => (
        !child.suppressed && !child.csg?.suppressed && !child.locked
      ));
      const fallbackNotice = occtMeshFallbackNotice({
        skipOcct,
        occtEligible: selectionSupportsOcctCsg(activeChildren),
        resultHasExactBrep: Boolean(next.importedMesh?.brepStep || next.cadBrep),
      });
      if (fallbackNotice) setNotice(fallbackNotice);
    }
  }, [commitShapes]);
  flushPendingFeatureRemeshRef.current = flushPendingFeatureRemesh;

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
    })();
  }, [activeFeatureId, commitShapes, selectedShape]);

  const suppressSelectedFeature = useCallback((featureId: string, suppressed: boolean) => {
    if (edgeModifier) {
      setNotice("Cancel the fillet or chamfer before turning a feature off.");
      return;
    }
    void (async () => {
      try {
        const body = selectedShape;
        if (!body?.groupedShapes?.length) return;
        const dirty = setCsgChildSuppressed(body, featureId, suppressed);
        const hadEdgeTreatment = Boolean(dirty.edgeTreatments?.length);
        const remeshGen = remeshGenerationRef.current + 1;
        remeshGenerationRef.current = remeshGen;
        const remeshed = await remeshCsgGroup(dirty);
        if (remeshGen !== remeshGenerationRef.current) return;
        const next = remeshed ?? {
          ...dirty,
          importedMesh: body.importedMesh,
          csg: { ...(dirty.csg ?? { op: inferCsgOp(dirty) ?? "union", version: 1 }), dirty: true },
        };
        // A fillet belongs to the solid that existed when it was applied. Turning a
        // feature off changes that solid, so the old fillet is cleared instead of
        // being run again on edges that may no longer exist.
        const committed = remeshed && hadEdgeTreatment
          ? {
              ...next,
              edgeTreatments: undefined,
              edgeTreatmentHistory: undefined,
              cadBrep: undefined,
              cadBrepFrame: undefined,
              cadDisplayEdges: undefined,
              cadDisplayEdgesVersion: undefined,
            }
          : next;
        commitShapes(
          shapesRef.current.map((entry) => (entry.id === body.id ? committed : entry)),
          body.id,
          !remeshed
            ? "Could not rebuild body after toggling feature — last good mesh kept. Ungroup then Group to retry."
            : hadEdgeTreatment
              ? (suppressed
                ? "Feature off. Fillet cleared — add it again on this body."
                : "Feature on. Fillet cleared — add it again on this body.")
              : (suppressed ? "Feature off — body rebuilt" : "Feature on — body rebuilt"),
        );
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not turn that feature off.");
      }
    })();
  }, [commitShapes, edgeModifier, selectedShape]);

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
        ? withHoleMode(
          { ...child, ...cleanedPatch, color: child.color, solidColor: child.solidColor },
          Boolean(cleanedPatch.hole),
          cleanedPatch.hole ? undefined : cleanedPatch.color,
        )
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
    clearEditorToolSessions();
    setSketchFacePickMode(true);
    setToolbarMode("geometry");
    setSketchActive(false);
    setEditingSketchShapeId(null);
    setNotice("Click a face to sketch on, or click the workplane");
  }, [clearEditorToolSessions]);

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
      dimension: "Dimension: click a line, a circle, or two points",
      trim: "Trim: click the piece to remove. It cuts at the nearest intersection",
      fillet: "Fillet: select a corner point to round",
      chamfer: "Chamfer: select a corner point to cut",
      mirror: "Mirror: select geometry, then a straight axis line",
      pattern: "Pattern: select geometry, then confirm spacing",
      "constrain-h": "Horizontal: select a line",
      "constrain-v": "Vertical: select a line",
      "constrain-equal": "Equal: select two lines",
      "constrain-parallel": "Parallel: select two lines",
      "constrain-perp": "Perpendicular: select two lines",
      "constrain-tangent": "Tangent: click a line, then a circle",
      "constrain-symmetry": "Symmetry: click two points or lines, then the axis line",
      "constrain-coincident": "Coincident: click two points to join them",
      "constrain-midpoint": "Midpoint: click a point, then the line it should sit on",
      "constrain-fix": "Fix: click a point or line to lock it",
      "constrain-concentric": "Concentric: click two circles",
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
      const circle = resolveSketchCircle(sketchDoc, segmentIds[0], pointIds[0]);
      if (circle) {
        const solved = addRadiusDimension(sketchDoc, circle.id, circle.radius * 2, true);
        setSketchDoc(solved.doc);
        setSketchSolveStatus(solved.status);
        setSketchDof(solved.dof);
        setSketchConflicts(solved.conflicts);
        commitSketchProfile(sketchDocToProfile(solved.doc), `Driving diameter ${ (circle.radius * 2).toFixed(2) } mm`, solved.doc);
        setSketchTool("select");
        setSketchSelection(null);
        return;
      }
      if (pointIds.length >= 2) {
        const a = sketchProfile.points.find((point) => point.id === pointIds[0]);
        const b = sketchProfile.points.find((point) => point.id === pointIds[1]);
        if (!a || !b) return;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        const solved = addLinearDimension(sketchDoc, { pointIds: [a.id, b.id], value: length, driving: true });
        setSketchDoc(solved.doc);
        setSketchSolveStatus(solved.status);
        setSketchDof(solved.dof);
        setSketchConflicts(solved.conflicts);
        commitSketchProfile(sketchDocToProfile(solved.doc), `Driving dimension ${length.toFixed(2)} mm`, solved.doc);
        setSketchTool("select");
        setSketchSelection(null);
        return;
      }
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
      }
      return;
    }

    if (sketchTool === "trim" && segmentIds[0]) {
      const at = sketchPickAtRef.current ?? { x: 0, z: 0 };
      const nextDoc = trimClickedSpan(sketchDoc, segmentIds[0], at);
      const solved = solveSketchDoc(nextDoc);
      setSketchDoc(solved.doc);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Trimmed", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }

    if ((sketchTool === "fillet" || sketchTool === "chamfer") && pointIds[0]) {
      setValueDialog({ kind: sketchTool === "fillet" ? "sketch-fillet" : "sketch-chamfer", pointId: pointIds[0] });
      return;
    }

    if (sketchTool === "constrain-h" && pointIds.length >= 2 && !segmentIds.length) {
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "horizontal", entityIds: [], pointIds: [pointIds[0], pointIds[1]] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Horizontal constraint", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    if (sketchTool === "constrain-v" && pointIds.length >= 2 && !segmentIds.length) {
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "vertical", entityIds: [], pointIds: [pointIds[0], pointIds[1]] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Vertical constraint", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    if (sketchTool === "constrain-coincident" && pointIds.length >= 2) {
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "coincident", entityIds: [], pointIds: [pointIds[0], pointIds[1]] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Coincident constraint", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    if (sketchTool === "constrain-midpoint" && pointIds[0] && segmentIds[0]) {
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "midpoint", entityIds: [segmentIds[0]], pointIds: [pointIds[0]] }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Midpoint constraint", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    if (sketchTool === "constrain-fix" && (pointIds[0] || segmentIds[0])) {
      const target = pointIds[0] ?? segmentIds[0];
      const line = sketchDoc.entities.find((entity) => entity.id === target && entity.kind === "line");
      const fixedIds = line && line.kind === "line" ? [line.startId, line.endId] : [target];
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "fix", entityIds: fixedIds }]));
      setSketchDoc(solved.doc);
      setSketchSolveStatus(solved.status);
      setSketchDof(solved.dof);
      setSketchConflicts(solved.conflicts);
      commitSketchProfile(sketchDocToProfile(solved.doc), "Fixed", solved.doc);
      setSketchTool("select");
      setSketchSelection(null);
      return;
    }
    if (sketchTool === "constrain-concentric") {
      const first = resolveSketchCircle(sketchDoc, segmentIds[0], pointIds[0]);
      const second = resolveSketchCircle(sketchDoc, segmentIds[1], pointIds[1]);
      if (first && second && first.id !== second.id) {
        const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "concentric", entityIds: [first.id, second.id] }]));
        setSketchDoc(solved.doc);
        setSketchSolveStatus(solved.status);
        setSketchDof(solved.dof);
        setSketchConflicts(solved.conflicts);
        commitSketchProfile(sketchDocToProfile(solved.doc), "Concentric constraint", solved.doc);
        setSketchTool("select");
        setSketchSelection(null);
        return;
      }
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

    if (sketchTool === "constrain-tangent" && (segmentIds.length || pointIds.length)) {
      const circle = resolveSketchCircle(sketchDoc, segmentIds[1], pointIds[0])
        ?? resolveSketchCircle(sketchDoc, segmentIds[0], pointIds[0]);
      const lineId = segmentIds.find((id) => sketchDoc.entities.some((entity) => entity.id === id && entity.kind === "line"));
      if (!circle || !lineId) return;
      const solved = solveSketchDoc(addConstraints(sketchDoc, [{ kind: "tangent", entityIds: [lineId, circle.id] }]));
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
      if (!(radius > 0.05)) {
        setNotice("Circle radius is too small");
        return;
      }
      const doc = cloneSketchDoc(sketchDoc);
      const centerId = createLocalId("sketch-point");
      const circleId = createLocalId("sketch-circle");
      doc.entities.push(
        { kind: "point", id: centerId, x: center.x, z: center.z },
        { kind: "circle", id: circleId, centerId, radius },
      );
      const expanded = sketchDocToProfile(doc);
      commitSketchProfile(
        {
          ...sketchProfile,
          points: expanded.points,
          segments: expanded.segments,
        },
        "Circle closed—edit the path or finish the sketch",
        doc,
      );
      setSketchActivePointId(null);
      setSketchSelection(null);
      setSketchTool("select");
    },
    [commitSketchProfile, sketchDoc, sketchProfile],
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
      if (SKETCH_POINT_CHAIN_TOOLS.has(sketchTool)) {
        connectSketchPoint(id);
        return;
      }
      setSketchActivePointId(null);
      setSketchSelection((current) => accumulateSketchPick(current, sketchTool, { pointId: id }));
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
    exitSketchMode();
    setExtrudeAsHole(false);
  }, [commitShapes, editingSketchShapeId, exitSketchMode, extrudeAsHole, sketchDoc, sketchProfile]);

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
    exitSketchMode();
  }, [commitShapes, editingSketchShapeId, exitSketchMode, shapes, sketchProfile]);

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
    const localSerialized = projectShapesFingerprint(shapesRef.current);
    if (!projectChanged && incomingSerialized === localSerialized) {
      // Seed echo even when shapes already match — otherwise the first drag-end
      // rehydrates stale parent props and snaps the model back.
      lastProjectShapesSyncRef.current = incomingSerialized;
      lastProjectShapesEchoRef.current = incomingSerialized;
      return;
    }
    // Keep in-progress / unsaved local edits. Replacing them with a stale parent
    // snapshot remeshed boolean groups and snapped moved objects back.
    if (
      !projectChanged
      && shapesRef.current.length > 0
      && incomingSerialized !== localSerialized
      && (
        lastProjectShapesEchoRef.current === localSerialized
        || lastProjectShapesSyncRef.current === localSerialized
        || lastProjectShapesEchoRef.current === incomingSerialized
        || pendingProjectShapesRef.current !== null
        || projectSyncTimerRef.current !== null
      )
    ) {
      return;
    }
    if (projectSyncTimerRef.current !== null) {
      window.clearTimeout(projectSyncTimerRef.current);
      projectSyncTimerRef.current = null;
    }
    const hydratedHistory = hydrateEditorHistoryState(incoming, initialHistory, initialHistoryIndex);
    projectHydratingRef.current = true;
    const remeshGen = remeshGenerationRef.current + 1;
    remeshGenerationRef.current = remeshGen;
    void (async () => {
      // Heal CSG bodies that were saved with stripped history mesh caches.
      let migratedIncoming = migrateShapesCsg(incoming.map(canonicalizeShape));
      const needsHeal = migratedIncoming.some(historyShapeMissingTessellation);
      let remeshFailed: string[] = [];
      if (needsHeal) {
        const remeshResult = await remeshDirtyHistoryShapes(migratedIncoming);
        migratedIncoming = remeshResult.shapes;
        remeshFailed = remeshResult.failedNames;
      }
      if (remeshGen !== remeshGenerationRef.current) return;
      const localNow = projectShapesFingerprint(shapesRef.current);
      const incomingNow = projectShapesFingerprint(migratedIncoming);
      if (!projectChanged && localNow !== incomingSerialized && localNow !== incomingNow) {
        // User moved or edited while this heal was in flight.
        projectHydratingRef.current = false;
        return;
      }
      // Treat the hydrated snapshot as our own echo so interaction-end does not
      // wipe local edits with the pre-save parent copy.
      lastProjectShapesSyncRef.current = incomingNow;
      lastProjectShapesEchoRef.current = incomingNow;
      if (projectChanged || explicitSaveFingerprintRef.current === null) {
        explicitSaveFingerprintRef.current = incomingNow;
      }
      const keepSelection = selectedIdsRef.current.filter((id) => migratedIncoming.some((shape) => shape.id === id));
      shapesRef.current = migratedIncoming;
      selectedIdsRef.current = keepSelection;
      historyRef.current = hydratedHistory.entries;
      historyIndexRef.current = hydratedHistory.index;
      setShapes(migratedIncoming);
      setSelectedIds(keepSelection);
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
      const x = point?.x ?? 0;
      const z = point?.z ?? 0;
      const place = { x, z, elevation: point?.elevation ?? 0 };
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
    [commitShapes],
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
          const canonicalBase = canonicalizeShape("hole" in cleanedPatch
            ? withHoleMode(
              { ...patched, color: shape.color, solidColor: shape.solidColor },
              Boolean(cleanedPatch.hole),
              cleanedPatch.hole ? undefined : cleanedPatch.color,
            )
            : patched);
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
    for (const id of selectedIds) {
      const shape = shapes.find((entry) => entry.id === id);
      if (shape?.patternFeature) {
        patternMemberIds(shapes, shape.patternFeature.id).forEach((memberId) => selected.add(memberId));
      }
    }
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

  const copySelected = useCallback(async () => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    setClipboard(selectedShapes);
    await writeShapeClipboard(selectedShapes);
    setNotice(`Copied ${selectedShapes.length} shape${selectedShapes.length === 1 ? "" : "s"}`);
  }, [hasSelection, selectedShapes]);

  const pasteShape = useCallback(async () => {
    const sourceProjectId = projectInfoRef.current.projectId;
    const storedClipboard = await readShapeClipboard();
    const sourceClipboard = storedClipboard.length > 0 ? storedClipboard : clipboard;
    if (sourceClipboard.length === 0) {
      setNotice("PeakCAD clipboard is empty");
      return;
    }
    if (projectInfoRef.current.projectId !== sourceProjectId) {
      setNotice("Paste cancelled because the project changed");
      return;
    }
    if (serializeShapesForSync(sourceClipboard) !== serializeShapesForSync(clipboard)) {
      setClipboard(sourceClipboard);
    }
    const pasted = cloneShapesForPaste(sourceClipboard).map((shape) => ({
      ...shape,
      x: Math.min(110, shape.x + 12),
      z: Math.min(110, shape.z + 12),
    }));
    commitShapes([...shapesRef.current, ...pasted], pasted.map((shape) => shape.id), `Pasted ${pasted.length} shape${pasted.length === 1 ? "" : "s"}`);
  }, [clipboard, commitShapes]);

  const restoreHistoryEntry = useCallback(async (nextIndex: number, label: "Undo" | "Redo", modifierCancelled: boolean) => {
    const entry = historyRef.current[nextIndex];
    let nextShapes = expandHistoryShapes(entry?.shapes ?? [], entry?.meshVault).map(canonicalizeShape);
    let remeshWarn = "";
    if (nextShapes.some(historyShapeNeedsRemesh)) {
      const remeshGen = remeshGenerationRef.current + 1;
      remeshGenerationRef.current = remeshGen;
      const remesh = await remeshDirtyHistoryShapes(nextShapes);
      if (remeshGen !== remeshGenerationRef.current) return;
      nextShapes = remesh.shapes;
      remeshWarn = remesh.failedNames.length
        ? ` · ${remesh.failedNames.length} mesh${remesh.failedNames.length === 1 ? "" : "es"} need rebuild`
        : "";
    }
    const nextSelection = (entry?.selectedIds ?? []).filter((id) => nextShapes.some((shape) => shape.id === id));
    historyIndexRef.current = nextIndex;
    shapesRef.current = nextShapes;
    selectedIdsRef.current = nextSelection;
    setHistoryIndex(nextIndex);
    setShapes(nextShapes);
    setSelectedIds(nextSelection);
    setActiveFeatureId(null);
    setPlacementRuler((current) => {
      if (!current) return current;
      return recapturePlacementBaseline(nextShapes, nextSelection, current.baselineId);
    });
    syncProjectShapes(nextShapes);
    setNotice((modifierCancelled ? `Edge modifier cancelled · ${label}` : label) + remeshWarn);
    const needFillet = nextShapes.filter((shape) => shape.edgeTreatments?.length && !shape.cadBrep);
    if (!needFillet.length) return;
    // Restoring the fillets is part of arriving at this step, not a step of its own.
    historyWriteSuspendedRef.current += 1;
    try {
      for (const shape of needFillet) {
        await reapplyEdgeTreatmentsRef.current(shape);
      }
    } finally {
      historyWriteSuspendedRef.current -= 1;
    }
  }, [syncProjectShapes]);

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
      if (linearPatternRef.current) {
        linearPatternRef.current = null;
        setLinearPattern(null);
        setNotice("Linear pattern cancelled");
        return;
      }
      const modifierCancelled = invalidateCadModifierSession();
      const currentIndex = historyIndexRef.current;
      if (currentIndex <= 0) {
        setNotice(modifierCancelled ? "Edge modifier cancelled" : "Nothing to undo");
        return;
      }
      await restoreHistoryEntry(currentIndex - 1, "Undo", modifierCancelled);
    })();
  }, [invalidateCadModifierSession, restoreHistoryEntry]);

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
      if (linearPatternRef.current) {
        linearPatternRef.current = null;
        setLinearPattern(null);
      }
      const currentIndex = historyIndexRef.current;
      if (currentIndex >= historyRef.current.length - 1) {
        setNotice("Nothing to redo");
        return;
      }
      const modifierCancelled = invalidateCadModifierSession();
      await restoreHistoryEntry(currentIndex + 1, "Redo", modifierCancelled);
    })();
  }, [invalidateCadModifierSession, restoreHistoryEntry]);

  const toggleAlignMode = useCallback(() => {
    if (selectedShapes.length < 2) {
      setNotice("Select at least two shapes to align");
      return;
    }
    setAlignMode((active) => {
      const next = !active;
      setAlignPreview(null);
      if (next) {
        clearEditorToolSessions("align");
      }
      setNotice(next ? "Align: choose a dot, or click a selected shape to anchor it" : "Align cancelled");
      return next;
    });
  }, [clearEditorToolSessions, selectedShapes.length]);

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
        clearEditorToolSessions("mirror");
      }
      setNotice(next ? "Mirror: choose an axis arrow" : "Mirror cancelled");
      return next;
    });
  }, [clearEditorToolSessions, hasSelection]);

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
    const patterned = selectedShapes.find((shape) => shape.patternFeature?.kind === "circular");
    if (patterned?.patternFeature?.circular) {
      const source = findPatternSource(shapesRef.current, patterned) ?? patterned;
      const circular = source.patternFeature?.circular;
      if (circular) {
        clearEditorToolSessions("circular");
        setCircularPattern({
          sourceIds: [source.id],
          pivotId: null,
          center: circular.center,
          radius: circular.radius,
          count: circular.count,
          rotation: clampCircularPatternRotation(circular.rotationOffset),
          preview: null,
          featureId: source.patternFeature?.id,
          editing: true,
        });
        setNotice("Edit circular pattern, then Update");
        return;
      }
    }
    const unlockedSelected = selectedShapes.filter((shape) => !shape.locked && !isConstructionShape(shape));
    if (!unlockedSelected.length) {
      setNotice("Select at least one unlocked shape to pattern");
      return;
    }
    clearEditorToolSessions("circular");
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
  }, [cancelCircularPattern, circularPattern, clearEditorToolSessions, selectedShapes]);

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
    const sources = shapes.filter((shape) => sourceIds.has(shape.id));
    const params = {
      count: circularPattern.count,
      center: circularPattern.center,
      radius: circularPattern.radius,
      rotationOffset: circularPattern.rotation,
      seatElevation: circularPattern.pivotId
        ? patternSeatElevationOnPivot(shapes.find((shape) => shape.id === circularPattern.pivotId) ?? { elevation: 0, height: 0 })
        : undefined,
    };
    let tagged: WorkplaneShape[] = [];
    for (const source of sources) {
      const featureId = circularPattern.featureId ?? patternFeatureId();
      const instances = circularPattern.preview.filter((shape) => (
        shape.id === source.id || shape.id.startsWith(`${source.id}__circular_pattern__`)
      ));
      tagged = tagged.concat(tagCircularPatternInstances(instances.length ? instances : [source], source, params, featureId));
    }
    const nextShapes = circularPattern.editing && circularPattern.featureId
      ? replacePatternFeature(shapes, tagged, circularPattern.featureId)
      : shapes.filter((shape) => !sourceIds.has(shape.id) && shape.patternFeature?.id !== circularPattern.featureId).concat(tagged);
    const wouldClamp = circularPatternWouldClamp(
      circularPattern.center,
      circularPattern.radius,
      circularPattern.count,
    );
    commitShapes(nextShapes, tagged.map((shape) => shape.id), circularPattern.editing ? `Circular pattern updated ×${circularPattern.count}` : `Circular pattern ×${circularPattern.count}`);
    setCircularPattern(null);
    if (wouldClamp) {
      setNotice("Circular pattern clamped some positions to ±110 mm");
    }
  }, [circularPattern, commitShapes, shapes]);

  const rebuildLinearPatternPreview = useCallback((session: LinearPatternSession, sourceShapes: WorkplaneShape[]) => {
    const sourceIds = new Set(session.sourceIds);
    const sources = sourceShapes.filter((shape) => sourceIds.has(shape.id) && !shape.locked);
    if (!sources.length) return null;
    return linearPatternInstances(sources, session, session);
  }, []);

  const cancelLinearPattern = useCallback(() => {
    linearPatternRef.current = null;
    setLinearPattern(null);
    setNotice("Linear pattern cancelled");
  }, []);

  const toggleLinearPattern = useCallback(() => {
    if (linearPattern) {
      cancelLinearPattern();
      return;
    }
    const patterned = selectedShapes.find((shape) => shape.patternFeature?.kind === "linear");
    if (patterned?.patternFeature) {
      const source = findPatternSource(shapesRef.current, patterned) ?? patterned;
      const linear = source.patternFeature?.linear;
      if (linear) {
        clearEditorToolSessions("linear");
        const session: LinearPatternSession = {
          sourceIds: [source.id],
          countX: linear.countX,
          countZ: linear.countZ ?? 1,
          countY: linear.countY ?? 1,
          spacingX: linear.spacingX,
          spacingZ: linear.spacingZ,
          spacingY: linear.spacingY ?? linearPatternSuggestedSpacing([source], "y"),
          preview: null,
          featureId: source.patternFeature?.id,
          editing: true,
        };
        setLinearPattern({ ...session, preview: rebuildLinearPatternPreview(session, shapesRef.current) });
        setNotice("Edit linear pattern, then Update");
        return;
      }
    }
    const unlockedSelected = selectedShapes.filter((shape) => !shape.locked && !isConstructionShape(shape));
    if (!unlockedSelected.length) {
      setNotice("Select at least one unlocked shape for a linear pattern");
      return;
    }
    clearEditorToolSessions("linear");
    const session: LinearPatternSession = {
      sourceIds: unlockedSelected.map((shape) => shape.id),
      countX: LINEAR_PATTERN_DEFAULT_COUNT_X,
      countZ: LINEAR_PATTERN_DEFAULT_COUNT_Z,
      countY: LINEAR_PATTERN_DEFAULT_COUNT_Y,
      spacingX: linearPatternSuggestedSpacing(unlockedSelected, "x"),
      spacingZ: linearPatternSuggestedSpacing(unlockedSelected, "z"),
      spacingY: linearPatternSuggestedSpacing(unlockedSelected, "y"),
      preview: null,
    };
    setLinearPattern({ ...session, preview: rebuildLinearPatternPreview(session, shapesRef.current) });
    setNotice("Linear pattern: set counts and spacing, then Apply");
  }, [cancelLinearPattern, clearEditorToolSessions, linearPattern, rebuildLinearPatternPreview, selectedShapes]);

  const patchLinearPattern = useCallback((patch: Partial<LinearPatternSession>) => {
    setLinearPattern((current) => {
      if (!current) return current;
      const next: LinearPatternSession = {
        ...current,
        ...patch,
        countX: patch.countX !== undefined ? clampLinearPatternCount(patch.countX, LINEAR_PATTERN_DEFAULT_COUNT_X) : current.countX,
        countZ: patch.countZ !== undefined ? clampLinearPatternCount(patch.countZ, LINEAR_PATTERN_DEFAULT_COUNT_Z) : current.countZ,
        countY: patch.countY !== undefined ? clampLinearPatternCount(patch.countY, LINEAR_PATTERN_DEFAULT_COUNT_Y) : current.countY,
        spacingX: patch.spacingX !== undefined ? clampLinearPatternSpacing(patch.spacingX) : current.spacingX,
        spacingZ: patch.spacingZ !== undefined ? clampLinearPatternSpacing(patch.spacingZ) : current.spacingZ,
        spacingY: patch.spacingY !== undefined ? clampLinearPatternSpacing(patch.spacingY) : current.spacingY,
      };
      return { ...next, preview: rebuildLinearPatternPreview(next, shapesRef.current) };
    });
  }, [rebuildLinearPatternPreview]);

  const applyLinearPattern = useCallback(() => {
    if (!linearPattern?.preview?.length) return;
    const sourceIds = new Set(linearPattern.sourceIds);
    const sources = shapes.filter((shape) => sourceIds.has(shape.id));
    const params = {
      countX: linearPattern.countX,
      countZ: linearPattern.countZ,
      countY: linearPattern.countY,
      spacingX: linearPattern.spacingX,
      spacingZ: linearPattern.spacingZ,
      spacingY: linearPattern.spacingY,
    };
    let tagged: WorkplaneShape[] = [];
    for (const source of sources) {
      const featureId = linearPattern.featureId ?? patternFeatureId();
      const instances = linearPattern.preview.filter((shape) => (
        shape.id === source.id || shape.id.startsWith(`${source.id}__linear_pattern__`)
      ));
      tagged = tagged.concat(tagLinearPatternInstances(instances.length ? instances : [source], source, params, featureId));
    }
    const nextShapes = linearPattern.editing && linearPattern.featureId
      ? replacePatternFeature(shapes, tagged, linearPattern.featureId)
      : shapes.filter((shape) => !sourceIds.has(shape.id)).concat(tagged);
    const wouldClamp = linearPatternWouldClamp(sources, linearPattern, linearPattern);
    commitShapes(nextShapes, tagged.map((shape) => shape.id), linearPattern.editing ? `Linear pattern updated ×${tagged.length}` : `Linear pattern ×${tagged.length}`);
    setLinearPattern(null);
    if (wouldClamp) {
      setNotice("Linear pattern clamped some positions to ±110 mm");
    }
  }, [commitShapes, linearPattern, shapes]);

  useEffect(() => {
    if (!linearPattern) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelLinearPattern();
      } else if (event.key === "Enter" && linearPattern.preview?.length) {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest("input, select, textarea, button, [contenteditable='true']")) return;
        event.preventDefault();
        applyLinearPattern();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyLinearPattern, cancelLinearPattern, linearPattern]);

  const linearPatternGeometryKey = useMemo(() => {
    if (!linearPattern) return "";
    return linearPattern.sourceIds
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
          shape.rotation ?? 0,
          shape.rotationX ?? 0,
          shape.rotationZ ?? 0,
        ].join(":");
      })
      .join("|");
  }, [linearPattern, shapes]);

  useEffect(() => {
    if (!linearPattern) return;
    const sourceIds = new Set(linearPattern.sourceIds);
    const sources = shapesRef.current.filter((shape) => sourceIds.has(shape.id));
    if (sources.length !== linearPattern.sourceIds.length || sources.some((shape) => shape.locked)) {
      setLinearPattern(null);
      setNotice("Linear pattern cancelled");
      return;
    }
    setLinearPattern((current) => {
      if (!current) return current;
      const preview = rebuildLinearPatternPreview(current, shapesRef.current);
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
          );
        });
      if (samePreview) return current;
      return { ...current, preview };
    });
  }, [
    linearPattern?.countX,
    linearPattern?.countY,
    linearPattern?.countZ,
    linearPattern?.sourceIds,
    linearPattern?.spacingX,
    linearPattern?.spacingY,
    linearPattern?.spacingZ,
    linearPatternGeometryKey,
    rebuildLinearPatternPreview,
  ]);

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
    if (!alignMode && !mirrorMode && !faceSnap) return;
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
      if (faceSnap) {
        setFaceSnap(null);
        setNotice("Snap cancelled");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [alignMode, faceSnap, mirrorMode]);

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
        cadModifierEditBeforeRef.current = null;
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
    const editEntry = lastEditableEdgeTreatment(selectedShape, kind);
    const workingShape = editEntry ? restoreShapeBeforeEdgeTreatment(selectedShape, editEntry) : selectedShape;
    cadModifierEditBeforeRef.current = editEntry ? workingShape : null;
    const appliedEdgeTreatmentCount = edgeTreatmentFeatureCount(workingShape);
    const hasAppliedEdgeTreatment = Boolean(workingShape.importedMesh && workingShape.edgeTreatments?.length);
    const sourceParts = edgeTreatmentSourceParts(workingShape, { keepResultMesh: hasAppliedEdgeTreatment });
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
    const defaultAmount = Math.max(MIN_EDGE_MODIFIER_AMOUNT, Math.min(1, shapeWidth(workingShape) / 6, shapeDepth(workingShape) / 6, workingShape.height / 6));
    const editRecipe = editEntry?.feature;
    cadModifierBaseShapeRef.current = selectedShape;
    cadModifierBaseFingerprintRef.current = projectShapesFingerprint([selectedShape]);
    cadModifierSourcePartsRef.current = sourceParts;
    clearEditorToolSessions("fillet");
    setEdgeModifier({
      kind,
      edges: [],
      selectedEdgeIds: [],
      amount: editRecipe?.amount ?? defaultAmount,
      sharpAngle: editRecipe?.sharpAngle ?? 12,
      chamferAngle: editRecipe?.chamferAngle ?? 45,
      quality: "standard",
      tangentChain: true,
      preserveEdgeSize: selectedShape.edgeResizeMode === "preserve",
      busy: true,
      prepared: false,
      error: null,
      preview: null,
      componentPreviews: [],
      editRecipe,
    });
    setNotice(editRecipe
      ? `Editing existing ${kind}`
      : `Preparing ${kind} edges in the CAD worker`);
    const parts: CadModifierMeshPart[] = partInputs.map((part) => {
      if (part.brep) return { brep: part.brep, brepTransform: part.brepTransform, hole: Boolean(part.shape.hole) };
      if (part.primitive) return { primitive: part.primitive, hole: Boolean(part.shape.hole) };
      return { ...meshDataToCadTransfer(part.mesh as MeshData), hole: Boolean(part.shape.hole) };
    });
    const prepareRequestId = postCadModifierRequest({
      type: "prepare",
      parts,
      sharpAngle: 12,
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
  }, [armCadModifierWatchdog, clearEditorToolSessions, invalidateCadModifierSession, postCadModifierRequest, selectedShape, selectedShapes.length]);

  const prepareCadModifierForMcp = useCallback(async (shape: WorkplaneShape, sharpAngle: number) => {
    if (shape.locked || shape.hole) {
      throw new Error("Select one unlocked solid object for edge treatment");
    }
    const appliedEdgeTreatmentCount = edgeTreatmentFeatureCount(shape);
    const hasAppliedEdgeTreatment = Boolean(shape.importedMesh && shape.edgeTreatments?.length);
    const sourceParts = edgeTreatmentSourceParts(shape, { keepResultMesh: hasAppliedEdgeTreatment });
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
    let brep = previewResponse.brep;
    if (!brep) {
      const exact = await postCadModifierRequestAsync({ type: "finalize" }, [], 30000);
      if (exact.type === "previewBrep" && exact.brep) brep = exact.brep;
    }
    const rawPreview = shapeFromCadMesh(shape, previewResponse.positions, previewResponse.normals, previewResponse.indices, brep, previewResponse.step);
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
    const failed: typeof recipes = [];
    for (const recipe of recipes) {
      const live = shapesRef.current.find((entry) => entry.id === shape.id);
      if (!live) {
        failed.push(recipe);
        continue;
      }
      try {
        const sharpAngle = recipe.sharpAngle ?? 25;
        const { response } = await prepareCadModifierForMcp(live, sharpAngle);
        const edgeIds = matchRecipeEdgeIds(recipe, response.edges, sharpAngle);
        const expectedEdges = recipe.allEdges
          ? edgeIds.length
          : (recipe.edgeFingerprints?.length || recipe.edgeIds?.length || recipe.edgeCount);
        if (edgeIds.length === 0 || edgeIds.length < expectedEdges) {
          failed.push(recipe);
          continue;
        }
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
        failed.push(recipe);
      }
    }
    if (failed.length > 0) {
      const live = shapesRef.current.find((entry) => entry.id === shape.id);
      if (live) {
        commitShapes(
          shapesRef.current.map((entry) => (
            entry.id === shape.id
              ? { ...entry, edgeTreatments: [...(entry.edgeTreatments ?? []), ...failed] }
              : entry
          )),
          shape.id,
        );
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
    const session = edgeModifier;
    if (!session?.preview || !base) {
      setNotice("Wait for a valid edge preview before applying");
      return;
    }
    void (async () => {
      let previewSource = session.preview;
      if (!previewSource) return;
      if (!previewSource.cadBrep) {
        try {
          const exact = await postCadModifierRequestAsync({ type: "finalize" }, [], 30000);
          if (exact.type === "previewBrep" && exact.brep) {
            previewSource = { ...previewSource, cadBrep: exact.brep };
          }
        } catch {
          // The visible mesh is still applied if the exact solid is not ready.
        }
      }
      const recordBefore = cadModifierEditBeforeRef.current ?? base;
      const label = cadModifierEditBeforeRef.current
        ? (session.kind === "fillet" ? "Updated fillet" : "Updated chamfer")
        : (session.kind === "fillet" ? "Filleted" : "Chamfered");
      const selectableCount = session.edges.filter((edge) => selectableCadModifierEdge(edge, session.sharpAngle)).length;
      const selectedEdgeIds = [...session.selectedEdgeIds];
      const feature = {
        kind: session.kind,
        amount: session.amount,
        edgeCount: selectedEdgeIds.length,
        edgeIds: selectedEdgeIds,
        edgeFingerprints: fingerprintsForEdgeIds(session.edges, selectedEdgeIds),
        allEdges: selectedEdgeIds.length === selectableCount,
        sharpAngle: session.sharpAngle,
        quality: session.quality,
        ...(session.kind === "chamfer" ? { chamferAngle: session.chamferAngle } : {}),
      } satisfies NonNullable<WorkplaneShape["edgeTreatments"]>[number];
      const createdAt = Date.now();
      const previewShape = canonicalizeShape({
        ...previewSource,
        cadDisplayEdges: previewSource.cadDisplayEdges?.length
          ? previewSource.cadDisplayEdges
          : cadDisplayEdgesAfterTreatment(previewSource, session),
        cadDisplayEdgesVersion: 2,
      });
      const groupedModifiedShape = groupedShapeWithComponentEdgeTreatment(
        recordBefore,
        previewShape,
        cadModifierSourcePartsRef.current,
        session,
        feature,
        createdAt,
      );
      const modifiedShape: WorkplaneShape = groupedModifiedShape ?? shapeWithEdgeTreatmentRecord(
        bakedEdgeTreatmentPreview(previewShape, recordBefore),
        recordBefore,
        feature,
        session.preserveEdgeSize,
        createdAt,
      );
      commitShapes(
        shapes.map((shape) => shape.id === base.id ? modifiedShape : shape),
        base.id,
        `${label} ${session.selectedEdgeIds.length} edge${session.selectedEdgeIds.length === 1 ? "" : "s"}`,
      );
      invalidateCadModifierSession();
    })();
  }, [commitShapes, edgeModifier, invalidateCadModifierSession, postCadModifierRequestAsync, shapes]);

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
    if (faceSnap) {
      setFaceSnap(null);
      setNotice("Snap cancelled");
      return;
    }
    clearEditorToolSessions();
    setFaceSnap({ source: null });
    setNotice("Click the side to move, then the side to snap it to");
  }, [clearEditorToolSessions, faceSnap]);

  const pickFaceSnap = useCallback((pick: { shapeId: string; point: [number, number, number]; normal: [number, number, number] }) => {
    if (!faceSnap) return;
    if (!faceSnap.source) {
      const shape = shapesRef.current.find((item) => item.id === pick.shapeId);
      if (!shape || shape.locked) {
        setNotice(shape?.locked ? "That shape is locked" : "Click a shape");
        return;
      }
      setFaceSnap({ source: pick });
      setNotice("Now click the side to snap it to");
      return;
    }
    if (pick.shapeId === faceSnap.source.shapeId) {
      setNotice("Click a side on the other shape");
      return;
    }
    const delta = faceToFaceTranslation(faceSnap.source, pick);
    if (!delta) {
      setNotice("Could not snap those sides");
      return;
    }
    const sourceId = faceSnap.source.shapeId;
    const deltaCopy = delta;
    const finish = () => {
      commitShapes(
        shapesRef.current.map((shape) => shape.id === sourceId && !shape.locked
          ? { ...shape, x: shape.x + deltaCopy.x, z: shape.z + deltaCopy.z, elevation: (shape.elevation ?? 0) + deltaCopy.y }
          : shape),
        [sourceId],
        "Snapped sides together",
      );
      setNotice("Snapped sides together");
    };
    setFaceSnap(null);
    const motion = faceSnapMotionRef.current;
    if (motion) motion(sourceId, deltaCopy, finish);
    else finish();
  }, [commitShapes, faceSnap]);

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

  const cutSelected = useCallback(async () => {
    if (!hasSelection) {
      setNotice("Select a shape first");
      return;
    }
    const selected = new Set(selectedIds);
    setClipboard(selectedShapes);
    await writeShapeClipboard(selectedShapes);
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
      shapes.map((shape) => (selected.has(shape.id) && !shape.locked ? { ...shape, ...dropPatchOntoFrame(shape, meshAabb(shape)) } : shape)),
      selectedIds,
      "Dropped selection to the workplane",
    );
  }, [commitShapes, hasSelection, selectedIds, shapes]);

  const togglePlacementRuler = useCallback(() => {
    setPlacementRuler((current) => {
      if (current) {
        setNotice("Placement ruler closed");
        return null;
      }
      clearEditorToolSessions("placement");
      const primary = selectedIds[0] ? shapes.find((shape) => shape.id === selectedIds[0]) : undefined;
      setNotice(primary ? "Enter how far to move in X, Y, or Z" : "Please select a shape to begin");
      return {
        baseline: primary ? placementPoseOf(primary) : null,
        baselineId: primary?.id ?? null,
      };
    });
  }, [clearEditorToolSessions, selectedIds, shapes]);

  const deactivatePlacementRuler = useCallback(() => {
    setPlacementRuler((current) => {
      if (current) setNotice("Placement ruler closed");
      return null;
    });
  }, []);

  const applyPlacementRulerOffset = useCallback((axis: keyof PlacementOffsets, millimeters: number) => {
    if (!hasSelection) {
      setNotice("Please select a shape to begin");
      return;
    }
    const primary = shapes.find((shape) => shape.id === selectedIds[0] && !shape.locked);
    const baseline = placementRuler?.baselineId === selectedIds[0] && placementRuler.baseline
      ? placementRuler.baseline
      : primary
        ? placementPoseOf(primary)
        : null;
    if (!baseline) {
      setNotice("Please select a shape to begin");
      return;
    }
    commitShapes(
      applyPlacementOffsetsToSelection(shapes, selectedIds, baseline, axis, millimeters),
      selectedIds,
      `Moved selection ${axis.toUpperCase()} ${millimeters.toFixed(2)} mm`,
    );
  }, [commitShapes, hasSelection, placementRuler, selectedIds, shapes]);

  useEffect(() => {
    if (!placementRuler) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPlacementRuler(null);
      setNotice("Placement ruler closed");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [placementRuler]);

  useEffect(() => {
    if (!placementRuler) return;
    const id = selectedIds[0] ?? null;
    if (placementRuler.baselineId === id) return;
    const shape = id ? shapes.find((entry) => entry.id === id) : undefined;
    setPlacementRuler((current) => {
      if (!current || current.baselineId === id) return current;
      return {
        ...current,
        baseline: shape ? placementPoseOf(shape) : null,
        baselineId: id,
      };
    });
    if (shape) setNotice("Enter how far to move in X, Y, or Z");
    else setNotice("Please select a shape to begin");
  }, [placementRuler, selectedIds, shapes]);

  const groupSelected = useCallback(async () => {
    const groupable = selectedShapes.filter((shape) => !isConstructionShape(shape));
    if (groupable.length < 2) {
      setNotice("Select at least two solids to group (construction planes stay out of Group)");
      return;
    }

    if (groupable.some((shape) => shape.locked)) {
      setNotice("Unlock every selected shape before grouping");
      return;
    }

    const sourceFingerprint = projectShapesFingerprint(shapesRef.current);
    const sourceProjectId = projectInfoRef.current.projectId;
    const result = await buildGroupedShapeFromSelection(groupable);
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
    const groupedIds = new Set(groupable.map((shape) => shape.id));
    commitShapes([...shapesRef.current.filter((shape) => !groupedIds.has(shape.id)), linkedGroup], linkedGroup.id, `Grouped ${groupable.length} shapes`);
    setActiveFeatureId(null);
    if (result.qualityNotice) {
      setNotice(result.qualityNotice);
    }
  }, [commitShapes, selectedIds, selectedShapes]);

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
    setActiveFeatureId(null);
  }, [commitShapes, selectedShapes]);

  const ungroupSelected = useCallback(() => {
    const groups = selectedShapes.filter((shape) => shape.groupedShapes?.length);
    if (groups.length === 0) {
      setNotice("Select a group first");
      return;
    }
    const targetId = pickGroupToUngroup(selectedIds, groups.map((group) => group.id));
    const target = groups.find((group) => group.id === targetId) ?? groups[groups.length - 1];
    const restored = restoreGroupedChildren(target);
    commitShapes(
      [...shapes.filter((shape) => shape.id !== target.id), ...restored],
      restored.map((shape) => shape.id),
      "Ungrouped last group",
    );
  }, [commitShapes, selectedIds, selectedShapes, shapes]);

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

  const reduceSelectedMesh = useCallback(async (keepFraction: number) => {
    if (!selectedShape?.importedMesh) {
      setNotice("Select an imported mesh to reduce");
      return;
    }
    if (selectedShape.locked) {
      setNotice("Unlock the object before reducing triangles");
      return;
    }
    let patch: Partial<WorkplaneShape> | null = null;
    try {
      patch = await simplifiedImportedShapePatch(selectedShape, keepFraction);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not reduce this mesh");
      return;
    }
    if (!patch?.importedMesh) {
      setNotice("Could not reduce this mesh. Try a lower detail setting.");
      return;
    }
    const next = { ...selectedShape, ...patch };
    commitShapes(
      shapesRef.current.map((shape) => (shape.id === selectedShape.id ? next : shape)),
      selectedShape.id,
      `Reduced ${selectedShape.name} to ${patch.importedMesh.triangleCount.toLocaleString()} triangles`,
    );
  }, [commitShapes, selectedShape]);

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
        const elevation = mcpNumber(params.elevation, 0);
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
        const targetId = pickGroupToUngroup(
          requestedIds.length ? requestedIds : selectedIdsRef.current,
          groups.map((group) => group.id),
        );
        const target = groups.find((group) => group.id === targetId) ?? groups[groups.length - 1];
        const restored = restoreGroupedChildren(target);
        commitShapes(
          [...currentShapes().filter((shape) => shape.id !== target.id), ...restored],
          restored.map((shape) => shape.id),
          "MCP ungrouped last group",
        );
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
          throw new Error("The PeakCAD viewport did not return an image");
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

    let pollTimer: number | null = null;
    const stopPoll = () => {
      if (pollTimer != null) window.clearInterval(pollTimer);
      pollTimer = null;
    };
    const startPoll = () => {
      if (pollTimer != null) return;
      void poll();
      pollTimer = window.setInterval(() => void poll(), SKETCHFORGE_MCP_POLL_MS);
    };
    const heartbeatAndListen = async () => {
      if (stopped) return;
      try {
        const projectInfo = projectInfoRef.current;
        const currentShapes = shapesRef.current;
        const response = await fetch(SKETCHFORGE_MCP_ROUTE, {
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
        });
        const payload = (await response.json().catch(() => null)) as { listen?: boolean } | null;
        if (payload?.listen) startPoll();
        else stopPoll();
      } catch {
        stopPoll();
      }
    };

    const onWake = () => void heartbeatAndListen();
    void heartbeatAndListen();
    const heartbeatTimer = window.setInterval(onWake, 2000);
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      stopped = true;
      window.clearInterval(heartbeatTimer);
      stopPoll();
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
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
      const meshes = exportable.map(meshForShape);
      void downloadBlobFile(projectExportFileName(projectName, "stl"), toStl(meshes), "model/stl")
        .then((result) => finishNotice("STL", result))
        .catch((error: unknown) => failNotice("STL", error));
      return;
    }
    if (format === "3mf") {
      try {
        const exported = to3mfForShapes(exportable);
        const label = exported.preserved
          ? "3MF. The model was updated and the file’s other settings were kept"
          : "3MF";
        void downloadBlobFile(projectExportFileName(projectName, "3mf"), exported.bytes, "model/3mf")
          .then((result) => finishNotice(label, result))
          .catch((error: unknown) => failNotice("3MF", error));
      } catch (error: unknown) {
        failNotice("3MF", error);
      }
      return;
    }
    const meshes = exportable.map(meshForShape);
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
      persistBakedImportedBrepSteps();
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
  }, [celebrateExport, hasSelection, persistBakedImportedBrepSteps, projectName, selectedShapes, shapes, stepExporting]);

  const exportBlueprint = useCallback(async (formats: BlueprintExportFormat[]) => {
    if (blueprintExporting || formats.length === 0) {
      return;
    }
    const sourceShapes = (hasSelection ? selectedShapes : shapes).filter((shape) => !shape.hole && !shape.hidden && !isConstructionShape(shape));
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
    const sourceShapes = (hasSelection ? selectedShapes : shapes).filter((shape) => !shape.hole && !shape.hidden && !isConstructionShape(shape));
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

  // Parsing and meshing run synchronously on the main thread, so the wheel is committed and
  // painted before that work starts; only the latest import's token may clear it.
  const showModelLoading = useCallback(async (fileName: string, message?: string) => {
    const token = ++modelLoadingTokenRef.current;
    flushSync(() => {
      if (message) setNotice(message);
      setModelLoadingName(fileName);
    });
    await afterNextPaint();
    return token;
  }, [setNotice]);

  // Waits for the frame that shows the new shapes: the viewport builds their meshes after
  // commit, and that freeze should still show the wheel.
  const hideModelLoading = useCallback(async (token: number) => {
    await afterNextPaint();
    if (modelLoadingTokenRef.current === token) setModelLoadingName(null);
  }, []);

  const selectFile = useCallback(async (file: File) => {
    const isStep = /\.(step|stp)$/i.test(file.name);
    const isSvg = /\.svg$/i.test(file.name) || file.type === "image/svg+xml";
    const is3mf = /\.3mf$/i.test(file.name);
    if (!isStep && !isSvg && !importExtensionSupported(file.name)) {
      setNotice("Unsupported file type. Use STL, STEP, SVG, or 3MF.");
      return;
    }

    const sourceProjectId = projectInfoRef.current.projectId;
    const loadingNotice = isStep
      ? "Reading STEP… first import loads the OpenCascade kernel (~22 MB), one time per session"
      : isSvg ? `Importing SVG (${file.name})…` : undefined;
    const loadingToken = isStep || isSvg || is3mf ? await showModelLoading(file.name, loadingNotice) : 0;
    try {
      let nextShapes: WorkplaneShape[];
      const importWarnings: string[] = [];
      if (isStep) {
        const { importedShapesFromStep } = await import("@/lib/stepImport");
        nextShapes = await importedShapesFromStep(file.name, await file.arrayBuffer());
      } else if (isSvg) {
        nextShapes = [importedShapeFromSvg(file.name, await file.text(), (warning) => importWarnings.push(warning))];
      } else if (is3mf) {
        nextShapes = [importedShapeFrom3mf(file.name, await file.arrayBuffer())];
      } else {
        setStlSeatPrompt({ name: file.name, buffer: await file.arrayBuffer() });
        setTopPanel("import");
        setNotice(`${file.name} is ready. Lay it flat, or keep the file’s orientation and sit it on the floor.`);
        return;
      }
      if (projectInfoRef.current.projectId !== sourceProjectId) {
        setNotice(`Import of ${file.name} cancelled because the project changed`);
        return;
      }
      const imported = nextShapes.map((shape) => importAsHole ? withHoleMode(shape, true) : shape);
      setStlSeatPrompt(null);
      const preserved3mf = is3mf && imported.some((shape) => shape.source3mf);
      const label = preserved3mf
        ? `Imported ${file.name}. Exporting 3MF keeps this file’s other settings.`
        : imported.length === 1
          ? (importAsHole ? `Imported ${file.name} as a hole` : `Imported ${file.name}`)
          : `Imported ${imported.length} bodies from ${file.name}`;
      commitShapes([...shapesRef.current, ...imported], imported.map((shape) => shape.id), label);
      setTopPanel(null);
      // Overrides the commit notice on purpose: a partial import needs to be seen.
      if (importWarnings.length > 0) setNotice(`Imported ${file.name} — ${importWarnings.join(" ")}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not import ${file.name}`);
    } finally {
      if (loadingToken) void hideModelLoading(loadingToken);
    }
  }, [commitShapes, hideModelLoading, importAsHole, showModelLoading]);

  const placeStlImport = useCallback(async (mode: MeshSeatMode) => {
    const prompt = stlSeatPrompt;
    if (!prompt) return;
    // Cleared up front so a second click can't import the same file twice while it loads.
    setStlSeatPrompt(null);
    const loadingToken = await showModelLoading(prompt.name);
    try {
      const shape = importedShapeFromStl(prompt.name, prompt.buffer, mode, workspaceSettings);
      const imported = importAsHole ? withHoleMode(shape, true) : shape;
      const label = importAsHole
        ? `Imported ${prompt.name} as a hole`
        : mode === "keep-orientation"
          ? `Imported ${prompt.name} in its file orientation`
          : `Imported ${prompt.name} laid flat`;
      commitShapes([...shapesRef.current, imported], [imported.id], label);
      setTopPanel(null);
    } catch (error) {
      setStlSeatPrompt((current) => current ?? prompt);
      setNotice(error instanceof Error ? error.message : `Could not import ${prompt.name}`);
    } finally {
      void hideModelLoading(loadingToken);
    }
  }, [commitShapes, hideModelLoading, importAsHole, showModelLoading, stlSeatPrompt, workspaceSettings]);

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
      if (circularPattern) {
        return resolveCircularPatternSourceId(pickId, circularPattern) ?? pickId;
      }
      if (linearPattern) {
        return resolveLinearPatternSourceId(pickId, linearPattern) ?? pickId;
      }
      return pickId;
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
  }, [circularPattern, linearPattern]);

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
      if (isHotkeyRecordingActive()) {
        return;
      }

      const action = matchHotkeyAction(
        event,
        hotkeys,
        undefined,
        sketchActive && toolbarMode === "sketch" ? { preferCategory: "Sketch" } : undefined,
      );

      // Inspector / overlay fields steal focus when a shape is selected. Still allow
      // undo/redo so Ctrl+Z is not trapped in a dimension box.
      if (isTypingTarget(event.target)) {
        if (action === "undo" || action === "redo") {
          const target = event.target;
          const inCadField = target instanceof HTMLElement && Boolean(
            target.closest(".shape-inspector, .edge-modifier-panel, .transform-overlay, .placement-ruler-overlay, .dimension-input"),
          );
          if (inCadField) {
            event.preventDefault();
            if (sketchActive && toolbarMode === "sketch") {
              if (action === "undo") sketchUndo();
              else sketchRedo();
            } else if (action === "undo") {
              undo();
            } else {
              redo();
            }
          }
        }
        return;
      }

      if (!action) return;

      const snapGridStep = (() => {
        if (snapGrid === "Off") return 0;
        if (snapGrid === "Brick") return 8;
        return Number.parseFloat(snapGrid) || 1;
      })();
      const unit = snapGridStep > 0 ? snapGridStep : 0.01;
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
            || target.classList?.contains("peakcad-editor");
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
          if (edgeModifier) {
            cancelEdgeModifier();
            break;
          }
          if (linearPattern) {
            cancelLinearPattern();
            break;
          }
          if (circularPattern) {
            cancelCircularPattern();
            break;
          }
          if (placementRuler) {
            setPlacementRuler(null);
            setNotice("Placement ruler closed");
            break;
          }
          if (alignMode) {
            setAlignMode(false);
            setAlignPreview(null);
            setNotice("Align cancelled");
            break;
          }
          if (mirrorMode) {
            setMirrorMode(false);
            setMirrorPreviewAxis(null);
            setNotice("Mirror cancelled");
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
    cancelCircularPattern,
    cancelLinearPattern,
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
    edgeModifier,
    alignMode,
    circularPattern,
    linearPattern,
    mirrorMode,
    placementRuler,
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
    toggleLinearPattern,
    toggleHidden,
    toggleLocked,
    toggleMirrorMode,
    toolbarMode,
    undo,
    ungroupSelected,
  ]);

  const geometryToolbarProps = {
    canUndo: historyIndex > 0 || Boolean(edgeModifier) || Boolean(circularPattern) || Boolean(linearPattern),
    canRedo: historyIndex < history.length - 1,
    hasClipboard: clipboard.length > 0 || systemClipboardSupported,
    hasSelection,
    canGroup: selectedShapes.filter((shape) => !isConstructionShape(shape)).length > 1 && selectedShapes.every((shape) => !shape.locked),
    canIntersect: selectedShapes.some((shape) => !shape.locked && !shape.hole && !isConstructionShape(shape)) && selectedShapes.some((shape) => !shape.locked && Boolean(shape.hole)),
    canUngroup: selectedShapes.some((shape) => Boolean(shape.groupedShapes?.length)),
    alignMode,
    canAlign: selectedShapes.length > 1,
    canEdgeModify: selectedShapes.length === 1 && Boolean(selectedShape && !selectedShape.locked && !selectedShape.hole),
    edgeModifierKind: edgeModifier?.kind ?? null,
    circularPatternActive: Boolean(circularPattern),
    canCircularPattern,
    linearPatternActive: Boolean(linearPattern),
    canLinearPattern,
    mirrorMode,
    onCopy: copySelected,
    onPaste: pasteShape,
    onDuplicate: duplicateSelected,
    onDuplicateAndRepeat: duplicateAndRepeatSelected,
    onDelete: deleteSelected,
    onUndo: undo,
    onRedo: redo,
    onGroup: groupSelected,
    onUngroup: ungroupSelected,
    onIntersect: intersectSelected,
    onAlign: toggleAlignMode,
    onMirror: toggleMirrorMode,
    onCircularPattern: toggleCircularPattern,
    onLinearPattern: toggleLinearPattern,
    onChamfer: () => edgeModifier?.kind === "chamfer" ? cancelEdgeModifier() : startEdgeModifier("chamfer"),
    onFillet: () => edgeModifier?.kind === "fillet" ? cancelEdgeModifier() : startEdgeModifier("fillet"),
  };

  return (
    <div className="peakcad-editor">
      <EditorTopBar
        projectName={projectName}
        onProjectNameChange={onProjectNameChange}
        onHome={onHome ? () => void handleHome() : undefined}
        onImport={() => {
          setTopPanel("import");
          setMenuOpen(false);
        }}
        onSaveProject={projectId && onSaveProject ? () => void saveProjectExplicitly("save") : undefined}
        onSaveProjectAs={projectId && onSaveProjectAs ? () => void saveProjectExplicitly("save-as") : undefined}
        hasMatchingSavedFile={hasMatchingSavedFile}
        onExport={() => {
          setTopPanel("export");
          setMenuOpen(false);
        }}
        toolbarMode={toolbarMode}
        onToolbarModeChange={changeToolbarMode}
        leftTools={
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
            <EditorViewportToolbar cluster="edit" {...geometryToolbarProps} />
          ) : null
        }
        rightTools={
          toolbarMode === "geometry" ? (
            <EditorViewportToolbar cluster="modify" {...geometryToolbarProps} />
          ) : null
        }
      />
      {unsavedPrompt ? (
        <section
          className="dashboard-confirm-overlay editor-unsaved-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="editor-unsaved-title"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" && !unsavedPrompt.saving) settleUnsavedPrompt(false);
          }}
        >
          <div className="dashboard-confirm-dialog">
            <header>
              <strong id="editor-unsaved-title">Save changes?</strong>
              <button
                type="button"
                aria-label="Cancel and stay in this project"
                disabled={unsavedPrompt.saving}
                onClick={() => settleUnsavedPrompt(false)}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              {unsavedPrompt.saving
                ? exactStepSaveProgress
                  ? `Saving exact STEP… ${exactStepSaveProgress.done} / ${exactStepSaveProgress.total} imported ${exactStepSaveProgress.total === 1 ? "body" : "bodies"}`
                  : "Saving…"
                : (
                  <>
                    <span>{projectName}</span> has changes since you last saved. Your model is autosaved, but exact STEP
                    for new imports is only kept when you save.
                  </>
                )}
            </p>
            <div className="dashboard-confirm-actions">
              <button
                className="dashboard-confirm-cancel editor-unsaved-discard"
                type="button"
                disabled={unsavedPrompt.saving}
                onClick={() => settleUnsavedPrompt(true)}
              >
                Don&apos;t save
              </button>
              <button
                className="dashboard-confirm-cancel"
                type="button"
                disabled={unsavedPrompt.saving}
                onClick={() => settleUnsavedPrompt(false)}
              >
                Cancel
              </button>
              <button
                className="dashboard-confirm-save"
                type="button"
                autoFocus
                disabled={unsavedPrompt.saving}
                onClick={() => void saveFromUnsavedPrompt()}
              >
                {unsavedPrompt.saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </section>
      ) : null}
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
              <ActiveToolChip
                visible={Boolean(sketchToolChip)}
                label={sketchToolChip?.label ?? ""}
                hint={sketchToolChip?.hint}
              />
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
              onSelectSegment={(id, at) => {
                sketchPickAtRef.current = at ?? null;
                setSketchActivePointId(null);
                setSketchSelection((current) => accumulateSketchPick(current, sketchTool, { segmentId: id }));
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
          onSketchPlanePicked={(plane) => {
            beginSketch(undefined, null, plane);
          }}
          onSketchFacePickRejected={(reason) => setNotice(reason)}
          onSketchFacePickCancel={cancelSketchFacePick}
          placementRulerMode={Boolean(placementRuler)}
          onActivatePlacementRuler={togglePlacementRuler}
          onDeactivatePlacementRuler={deactivatePlacementRuler}
          initialSnap={initialSnap}
          initialWorkspace={initialWorkspace}
          workspaceSettingsKey={projectId ?? "local-workplane"}
          onSceneReady={onViewportReady}
          onAddShape={addShape}
          onAlignAnchorChange={chooseAlignAnchor}
          onAlignPreview={previewAlignSelection}
          onAlignPreviewClear={clearAlignPreview}
          onAlignSelection={alignSelectionTo}
          onMirrorPreview={previewMirrorSelection}
          onMirrorPreviewClear={clearMirrorPreview}
          onMirrorSelection={mirrorSelectionAcross}
          onSelectShape={selectShape}
          onInteractionActiveChange={updateProjectInteractionActive}
          onEditSketch={shapeHasEditableSketch(selectedShape) ? beginEditSelectedSketch : undefined}
          onEditSketchDimension={resolveEditableSketchShape(
            activeFeatureId && selectedShape?.groupedShapes
              ? selectedShape.groupedShapes.find((child) => child.id === activeFeatureId) ?? selectedShape
              : selectedShape,
          )?.sketchDoc?.dimensions?.length ? editSelectedSketchDimension : undefined}
          canSeparateParts={canSeparateSelectedParts}
          onSeparateParts={separateSelectedParts}
          onReduceTriangles={reduceSelectedMesh}
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
          modelTreeLocked={Boolean(edgeModifier)}
          onReorderFeature={selectedShape?.groupedShapes?.length ? reorderSelectedFeature : undefined}
          onUpdateFeature={selectedShape?.groupedShapes?.length ? updateSelectedFeature : undefined}
          onEditPattern={selectedShape?.patternFeature ? () => {
            if (selectedShape.patternFeature?.kind === "linear") toggleLinearPattern();
            else toggleCircularPattern();
          } : undefined}
          onDissolvePattern={selectedShape?.patternFeature ? () => {
            const featureId = selectedShape.patternFeature?.id;
            if (!featureId) return;
            commitShapes(dissolvePatternFeature(shapesRef.current, featureId), selectedIds, "Pattern dissolved — copies are independent");
          } : undefined}
          onUpdateShape={updateShape}
          onWorkspaceSettingsChange={updateProjectWorkspaceSettings}
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
          faceSnapActive={faceSnap !== null}
          faceSnapSource={faceSnap?.source ?? null}
          faceSnapMotionRef={faceSnapMotionRef}
          onFaceSnapPick={pickFaceSnap}
          inspectorDockTop={
            edgeModifier ? (
              <EdgeModifierPanel
                kind={edgeModifier.kind}
                editing={Boolean(edgeModifier.editRecipe)}
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
            placementRuler && hasSelection ? (
              <PlacementRulerPanel
                offsets={placementRuler.baseline && selectedShape && selectedShape.id === placementRuler.baselineId
                  ? placementOffsetsFromBaseline(selectedShape, placementRuler.baseline)
                  : { x: 0, y: 0, z: 0 }}
                workspace={workspaceSettings}
                autoFocusFirst
                onOffsetChange={applyPlacementRulerOffset}
                onCancel={() => {
                  setPlacementRuler(null);
                  setNotice("Placement ruler closed");
                }}
              />
            ) : linearPattern ? (
              <LinearPatternPanel
                sourceCount={linearPattern.sourceIds.length}
                countX={linearPattern.countX}
                countZ={linearPattern.countZ}
                countY={linearPattern.countY}
                spacingX={linearPattern.spacingX}
                spacingZ={linearPattern.spacingZ}
                spacingY={linearPattern.spacingY}
                canApply={Boolean(linearPattern.preview?.length)}
                workspace={workspaceSettings}
                onCountXChange={(countX) => patchLinearPattern({ countX })}
                onCountZChange={(countZ) => patchLinearPattern({ countZ })}
                onCountYChange={(countY) => patchLinearPattern({ countY })}
                onSpacingXChange={(spacingX) => patchLinearPattern({ spacingX })}
                onSpacingZChange={(spacingZ) => patchLinearPattern({ spacingZ })}
                onSpacingYChange={(spacingY) => patchLinearPattern({ spacingY })}
                onApply={applyLinearPattern}
                onCancel={cancelLinearPattern}
                applyLabel={linearPattern.editing ? "Update" : "Apply"}
                editing={Boolean(linearPattern.editing)}
                positionClampWarning={linearPatternWouldClamp(
                  shapes.filter((shape) => linearPattern.sourceIds.includes(shape.id)),
                  linearPattern,
                  linearPattern,
                )}
              />
            ) : circularPattern ? (
              <CircularPatternPanel
                sourceCount={circularPatternSources.length}
                pivotName={circularPatternPivot?.name ?? null}
                count={circularPattern.count}
                radiusMm={circularPatternRadius}
                rotationDeg={circularPattern.rotation}
                hasPivot={Boolean((circularPattern.pivotId && circularPattern.center) || (circularPattern.editing && circularPattern.center))}
                canApply={Boolean(circularPattern.center && circularPattern.preview?.length)}
                workspace={workspaceSettings}
                onCountChange={patchCircularPatternCount}
                onRadiusChange={patchCircularPatternRadius}
                onRotationChange={patchCircularPatternRotation}
                onApply={applyCircularPattern}
                onCancel={cancelCircularPattern}
                applyLabel={circularPattern.editing ? "Update" : "Apply"}
                editing={Boolean(circularPattern.editing)}
                positionClampWarning={Boolean(
                  circularPattern.center
                  && circularPatternWouldClamp(circularPattern.center, circularPattern.radius, circularPattern.count),
                )}
              />
            ) : null
          }
          />
          {modelLoadingName || exactStepSaveProgress ? (
            <div className="model-loading-overlay" role="status" aria-live="polite">
              <div className="model-loading-card">
                <span className="model-loading-wheel" aria-hidden="true" />
                <strong>{exactStepSaveProgress ? "Saving exact STEP…" : "Loading model…"}</strong>
                <span className="model-loading-file">
                  {exactStepSaveProgress
                    ? `${exactStepSaveProgress.done} / ${exactStepSaveProgress.total} imported ${exactStepSaveProgress.total === 1 ? "body" : "bodies"}`
                    : modelLoadingName}
                </span>
              </div>
            </div>
          ) : null}
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
      {renderedTopPanel ? (
        <TopActionPanel
          panel={renderedTopPanel}
          closing={topPanelClosing}
          shapeCount={exportableShapeCount}
          scopeLabel={exportScopeLabel}
          stepPreflight={exportPreflight}
          onClose={() => {
            setStlSeatPrompt(null);
            setTopPanel(null);
          }}
          onExport={exportDesign}
          onExportStep={exportStepDesign}
          onExportBlueprint={() => {
            setTopPanel(null);
            openBlueprintExport();
          }}
          blueprintExporting={blueprintExporting}
          stepExporting={stepExporting}
          onImportFiles={selectFiles}
          onPickFile={() => fileInputRef.current?.click()}
          importAsHole={importAsHole}
          onImportAsHoleChange={setImportAsHole}
          stlSeatFileName={stlSeatPrompt?.name ?? null}
          stlSeatUnitLabel={lengthDisplayUnit(workspaceSettings).label}
          onLayStlFlat={() => void placeStlImport("lay-flat")}
          onKeepStlOrientation={() => void placeStlImport("keep-orientation")}
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
  closing = false,
  shapeCount,
  scopeLabel,
  stepPreflight,
  onClose,
  onExport,
  onExportStep,
  onExportBlueprint,
  blueprintExporting = false,
  stepExporting,
  onImportFiles,
  onPickFile,
  importAsHole = false,
  onImportAsHoleChange,
  stlSeatFileName = null,
  stlSeatUnitLabel = "mm",
  onLayStlFlat,
  onKeepStlOrientation,
}: {
  panel: Exclude<TopPanel, null>;
  closing?: boolean;
  shapeCount: number;
  scopeLabel: "selected" | "total";
  stepPreflight: StepPreflightRow[];
  onClose: () => void;
  onExport: (format: ExportFormat) => void;
  onExportStep: () => void;
  onExportBlueprint?: () => void;
  blueprintExporting?: boolean;
  stepExporting: boolean;
  onImportFiles: (files: FileList | File[]) => void;
  onPickFile: () => void;
  importAsHole?: boolean;
  onImportAsHoleChange?: (hole: boolean) => void;
  stlSeatFileName?: string | null;
  stlSeatUnitLabel?: string;
  onLayStlFlat?: () => void;
  onKeepStlOrientation?: () => void;
}) {
  const title =
    panel === "tips"
      ? "Tips"
      : panel === "export"
        ? "Export"
        : "Import";

  return (
    <div className={`top-action-panel${closing ? " is-closing" : ""}`} role="dialog" aria-label={title}>
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
          <label className="import-as-hole">
            <input
              type="checkbox"
              checked={importAsHole}
              onChange={(event) => onImportAsHoleChange?.(event.currentTarget.checked)}
            />
            Import as hole
          </label>
          {stlSeatFileName ? (
            <div className="import-seat-choice">
              <p>{stlSeatFileName} is ready. Choose how it should sit.</p>
              <p>1 file unit imports as 1 {stlSeatUnitLabel}, the workplane unit.</p>
              <button type="button" className="export-primary" onClick={onLayStlFlat}>
                Lay flat
              </button>
              <button type="button" onClick={onKeepStlOrientation}>
                Keep orientation
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {panel === "export" ? (
        <div className="top-action-body export-panel-body">
          <p>{shapeCount} {scopeLabel} solid shape{shapeCount === 1 ? "" : "s"} ready to export.</p>
          <button className="export-primary" onClick={onExportStep} disabled={stepExporting}>
            <ToolbarExportIcon />
            {stepExporting ? "Building STEP…" : "Download STEP"}
          </button>
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
            {onExportBlueprint ? (
              <button onClick={onExportBlueprint} disabled={blueprintExporting} aria-busy={blueprintExporting}>
                <ToolbarExportIcon />
                {blueprintExporting ? "Building blueprint…" : "Download blueprint"}
              </button>
            ) : null}
          </div>
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

