"use client";

import { ChevronDown, ChevronUp, LockKeyhole, LockKeyholeOpen, Split, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { ToolbarHideSelectedIcon } from "@/components/icons";
import { InlineValueDialog } from "@/components/workplane/InlineValueDialog";
import { PeakTipButton, PeakTipLabel } from "@/components/workplane/ToolNameTooltip";
import { displayStepFromMillimeters, displayToMillimeters, formatMeasurementNumber, lengthDisplayUnit, millimetersToDisplay } from "@/lib/measurementUnits";
import {
  clampRoofRidgeX,
  roofAnglesFromProfile,
  roofAnglesFromRidge,
  roofRidgeXFromLeftAngle,
  roofRidgeXFromRightAngle,
} from "@/lib/roofGeometry";
import {
  DEFAULT_THREAD_CLEARANCE,
  DEFAULT_THREAD_SIDES,
  MAX_THREAD_CLEARANCE,
  MAX_THREAD_SIDES,
  MIN_THREAD_CLEARANCE,
  MIN_THREAD_SIDES,
} from "@/lib/metricThreadSolid";
import { METRIC_COARSE_THREADS, type MetricThreadDesignation } from "@/lib/metricThreads";
import { resolveShapeSides, resolveShapeSteps } from "@/lib/displayTessellation";
import { fallbackSolidColor, MAX_SHAPE_SIDES, resizedShapeSize, shapeDepth, shapeWidth, coneBaseRadius, conePatchForFootprint, conePatchForRadii, coneTopRadius } from "@/lib/workplaneShapes";
import { inferCsgOp, isEvaluatedCsgBody } from "@/lib/csgTree";
import {
  shapeExportQualityHint,
  shapeExportQualityHintInScene,
  shapeExportQualityLabel,
  shapeExportQualityTitle,
} from "@/lib/stepQuality";
import { resolveEditableSketchShape } from "@/lib/sketch";
import { DEFAULT_TEXT_FONT, TEXT_FONT_OPTIONS } from "@/lib/textFonts";
import type { GridSize, MeasurementAccuracy, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

const MAX_SHAPE_STEPS = 128;

const METRIC_THREAD_OPTIONS = METRIC_COARSE_THREADS.map((entry) => entry.designation);
const THREAD_STYLE_OPTIONS = ["Screw", "Hole cutter"] as const;

const GRID_SIZES: GridSize[] = ["Off", "0.1 mm", "0.25 mm", "0.5 mm", "1.0 mm", "2.0 mm", "5.0 mm", "Brick"];
const MIN_SHAPE_SIZE = 0.01;
const SOLID_COLORS = [
  "#d41721",
  "#ff4b4b",
  "#ff7a1a",
  "#d97813",
  "#f6a21a",
  "#f2cf10",
  "#f7e65a",
  "#a8d642",
  "#33983d",
  "#1fb66d",
  "#18b99a",
  "#0098c7",
  "#49c7ef",
  "#3b82f6",
  "#294c93",
  "#5b5ce2",
  "#6e2786",
  "#9b3bd2",
  "#c9009a",
  "#f062b6",
  "#8a5a2b",
  "#b98254",
  "#f2caa0",
  "#ffffff",
  "#cfd8df",
  "#8a98a6",
  "#4b5563",
  "#111111",
];
type RangePropertyConfig = {
  type?: "range";
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
};

type TextPropertyConfig = {
  type: "text";
  label: string;
  value: string;
  maxLength?: number;
  onChange: (value: string) => void;
};

type SelectPropertyConfig = {
  type: "select";
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
};

type ShapePropertyConfig = RangePropertyConfig | TextPropertyConfig | SelectPropertyConfig;
export type ShapeInspectorUpdateOptions = { resizeAxis?: "width" | "depth" | "height" };
type ShapeInspectorUpdate = (patch: Partial<WorkplaneShape>, options?: ShapeInspectorUpdateOptions) => void;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatPropertyNumber(value: number, accuracy: MeasurementAccuracy, step: number) {
  if (step >= 1) return String(Math.round(value));
  return formatMeasurementNumber(value, accuracy, step);
}

function propertyUsesLengthUnit(label: string) {
  return ["Radius", "Length", "Width", "Height", "Bevel", "Top Radius", "Base Radius", "Thickness", "Clearance"].includes(label);
}

function propertyUsesDegreeUnit(label: string) {
  return label === "Left Angle" || label === "Right Angle";
}

const MAX_SHAPE_NAME_LENGTH = 48;

function withNameProperty(shape: WorkplaneShape, onUpdate: ShapeInspectorUpdate, properties: ShapePropertyConfig[]): ShapePropertyConfig[] {
  return [
    {
      type: "text",
      label: "Name",
      value: shape.name,
      maxLength: MAX_SHAPE_NAME_LENGTH,
      onChange: (name) => {
        onUpdate({ name: name.replace(/\s+/g, " ").slice(0, MAX_SHAPE_NAME_LENGTH) });
      },
    },
    ...properties,
  ];
}

function getShapeProperties(shape: WorkplaneShape, onUpdate: ShapeInspectorUpdate): ShapePropertyConfig[] {
  if (shape.kind === "thread") {
    const designation = (shape.threadSpec?.designation ?? "M6") as MetricThreadDesignation;
    const part = shape.threadSpec?.part ?? "screw";
    const styleLabel = shape.threadSpec?.style === "hole" || part === "threads" ? "Hole cutter" : "Screw";
    const showStyle = part === "screw" || part === "threads" || shape.threadSpec?.style === "hole";
    const showClearance = styleLabel === "Hole cutter" || part === "threads";
    const nextSpec = (patch: Partial<NonNullable<WorkplaneShape["threadSpec"]>>) => ({
      designation: shape.threadSpec?.designation ?? designation,
      majorDiameter: shape.threadSpec?.majorDiameter ?? 6,
      pitch: shape.threadSpec?.pitch ?? 1,
      style: shape.threadSpec?.style ?? "screw",
      clearance: shape.threadSpec?.clearance ?? (showClearance ? DEFAULT_THREAD_CLEARANCE : 0),
      part: shape.threadSpec?.part ?? "screw",
      ...patch,
    });
    return [
      {
        type: "select",
        label: "Metric size",
        value: designation,
        options: [...METRIC_THREAD_OPTIONS],
        onChange: (next) => {
          const preset = METRIC_COARSE_THREADS.find((entry) => entry.designation === next);
          onUpdate({
            threadSpec: nextSpec({
              designation: next,
              majorDiameter: preset?.majorDiameter ?? shape.threadSpec?.majorDiameter ?? 6,
              pitch: preset?.pitch ?? shape.threadSpec?.pitch ?? 1,
            }),
          });
        },
      },
      ...(showStyle && part !== "shaft"
        ? [{
            type: "select" as const,
            label: "Style",
            value: styleLabel,
            options: [...THREAD_STYLE_OPTIONS],
            onChange: (next: string) => {
              const hole = next === "Hole cutter";
              onUpdate({
                threadSpec: nextSpec({
                  style: hole ? "hole" : "screw",
                  part: hole ? "threads" : "screw",
                  // Clearance only applies to hole cutters; screws always use nominal size.
                  clearance: hole
                    ? Math.max(shape.threadSpec?.clearance ?? 0, DEFAULT_THREAD_CLEARANCE)
                    : 0,
                }),
                hole,
                color: hole ? "#b8c2cc" : fallbackSolidColor(shape),
              });
            },
          }]
        : []),
      ...(showClearance
        ? [{
            label: "Clearance",
            value: shape.threadSpec?.clearance ?? DEFAULT_THREAD_CLEARANCE,
            min: MIN_THREAD_CLEARANCE,
            max: MAX_THREAD_CLEARANCE,
            step: 0.05,
            onChange: (clearance: number) => onUpdate({
              threadSpec: nextSpec({ clearance }),
            }),
          }]
        : []),
      {
        label: "Sides",
        value: shape.sides ?? DEFAULT_THREAD_SIDES,
        min: MIN_THREAD_SIDES,
        max: MAX_THREAD_SIDES,
        step: 1,
        onChange: (sides) => onUpdate({ sides: Math.round(sides) }),
      },
      {
        label: "Height",
        value: shape.height,
        min: MIN_SHAPE_SIZE,
        max: 160,
        onChange: (height) => onUpdate({ height }),
      },
    ];
  }

  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const setWidth = (value: number) => onUpdate({ width: value, size: resizedShapeSize(value, depth) }, { resizeAxis: "width" });
  const setDepth = (value: number) => onUpdate({ depth: value, size: resizedShapeSize(width, value) }, { resizeAxis: "depth" });
  const setConeWidth = (value: number) => onUpdate(conePatchForFootprint(shape, value, depth), { resizeAxis: "width" });
  const setConeDepth = (value: number) => onUpdate(conePatchForFootprint(shape, width, value), { resizeAxis: "depth" });
  const setBaseRadius = (value: number) => onUpdate(conePatchForRadii(shape, coneTopRadius(shape), value), { resizeAxis: "width" });
  const setTopRadius = (value: number) => onUpdate(conePatchForRadii(shape, value, coneBaseRadius(shape)), { resizeAxis: "width" });
  const setHeight = (height: number) => onUpdate({ height }, { resizeAxis: "height" });

  if (shape.kind === "box") {
    return [
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "cylinder") {
    return [
      { label: "Sides", value: resolveShapeSides(shape.kind, shape.sides) ?? 192, min: 3, max: MAX_SHAPE_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "sphere") {
    return [
      { label: "Steps", value: resolveShapeSteps(shape.kind, shape.steps) ?? 64, min: 6, max: MAX_SHAPE_STEPS, step: 1, onChange: (steps) => onUpdate({ steps: Math.round(steps) }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "halfSphere") {
    return [
      { label: "Steps", value: resolveShapeSteps(shape.kind, shape.steps) ?? 56, min: 6, max: MAX_SHAPE_STEPS, step: 1, onChange: (steps) => onUpdate({ steps: Math.round(steps) }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "cone") {
    return [
      { label: "Top Radius", value: shape.topRadius ?? 0, min: 0, max: 80, onChange: setTopRadius },
      { label: "Base Radius", value: shape.baseRadius ?? width / 2, min: MIN_SHAPE_SIZE / 2, max: 80, onChange: setBaseRadius },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setConeDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setConeWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
      { label: "Sides", value: resolveShapeSides(shape.kind, shape.sides) ?? 192, min: 3, max: MAX_SHAPE_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
    ];
  }

  if (shape.kind === "pyramid") {
    return [
      { label: "Sides", value: shape.sides ?? 4, min: 3, max: 24, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "roof") {
    const angles = roofAnglesFromProfile(width, shape.height, shape.leftAngle, shape.rightAngle);
    // Angle edits slide the peak horizontally; width/height stay put so left/right move in tandem.
    const setLeftAngle = (value: number) => {
      const ridgeX = clampRoofRidgeX(width, shape.height, roofRidgeXFromLeftAngle(width, shape.height, value));
      const next = roofAnglesFromRidge(width, shape.height, ridgeX);
      onUpdate({ leftAngle: next.leftAngle, rightAngle: next.rightAngle });
    };
    const setRightAngle = (value: number) => {
      const ridgeX = clampRoofRidgeX(width, shape.height, roofRidgeXFromRightAngle(width, shape.height, value));
      const next = roofAnglesFromRidge(width, shape.height, ridgeX);
      onUpdate({ leftAngle: next.leftAngle, rightAngle: next.rightAngle });
    };
    const setRoofWidth = (value: number) => {
      const nextWidth = Math.max(MIN_SHAPE_SIZE, value);
      const next = roofAnglesFromProfile(nextWidth, shape.height, angles.leftAngle, angles.rightAngle);
      onUpdate(
        {
          width: nextWidth,
          size: resizedShapeSize(nextWidth, depth),
          leftAngle: next.leftAngle,
          rightAngle: next.rightAngle,
        },
        { resizeAxis: "width" },
      );
    };
    const setRoofHeight = (height: number) => {
      const nextHeight = Math.max(MIN_SHAPE_SIZE, height);
      const next = roofAnglesFromProfile(width, nextHeight, angles.leftAngle, angles.rightAngle);
      onUpdate(
        {
          height: nextHeight,
          leftAngle: next.leftAngle,
          rightAngle: next.rightAngle,
        },
        { resizeAxis: "height" },
      );
    };
    return [
      { label: "Left Angle", value: angles.leftAngle, min: 1, max: 179, step: 0.1, onChange: setLeftAngle },
      { label: "Right Angle", value: angles.rightAngle, min: 1, max: 179, step: 0.1, onChange: setRightAngle },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setRoofWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setRoofHeight },
    ];
  }

  if (shape.kind === "roundRoof") {
    return [
      { label: "Sides", value: resolveShapeSides(shape.kind, shape.sides) ?? 128, min: 4, max: MAX_SHAPE_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "torus") {
    // Radius = tube cross-section size (donut thickness), not the overall ring size.
    const maxTubeRadius = Math.max(0.1, Math.min(width, depth) / 2 - 0.2);
    const tubeRadius = clamp(shape.radius ?? shape.height / 2, 0.1, maxTubeRadius);
    return [
      {
        label: "Radius",
        value: tubeRadius,
        min: 0.1,
        max: maxTubeRadius,
        onChange: (radius) => {
          const next = clamp(radius, 0.1, maxTubeRadius);
          onUpdate({ radius: next, height: next * 2 }, { resizeAxis: "height" });
        },
      },
      { label: "Steps", value: resolveShapeSteps(shape.kind, shape.steps) ?? 64, min: 6, max: MAX_SHAPE_STEPS, step: 1, onChange: (steps) => onUpdate({ steps: Math.round(steps) }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      {
        label: "Height",
        value: shape.height,
        min: MIN_SHAPE_SIZE,
        max: 160,
        onChange: (height) => {
          const nextHeight = clamp(height, MIN_SHAPE_SIZE, 160);
          onUpdate({ height: nextHeight, radius: clamp(nextHeight / 2, 0.1, maxTubeRadius) }, { resizeAxis: "height" });
        },
      },
    ];
  }

  if (shape.kind === "tube" || shape.kind === "ring") {
    return [
      { label: "Thickness", value: shape.bevel ?? 4, min: 0.5, max: 20, onChange: (bevel) => onUpdate({ bevel }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "polygon") {
    return [
      { label: "Sides", value: shape.sides ?? 6, min: 3, max: MAX_SHAPE_SIDES, step: 1, onChange: (sides) => onUpdate({ sides: Math.round(sides) }) },
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "icosahedron") {
    return [
      { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
      { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
    ];
  }

  if (shape.kind === "text") {
    return [
      {
        type: "text",
        label: "Text",
        value: shape.text ?? "TEXT",
        onChange: (text) => {
          const nextText = text.slice(0, 24) || " ";
          const nextWidth = clamp(Math.max(46, nextText.length * 19), 46, 260);
          onUpdate({ text: nextText, width: nextWidth, size: nextWidth });
        },
      },
      { type: "select", label: "Font", value: shape.font ?? DEFAULT_TEXT_FONT, options: [...TEXT_FONT_OPTIONS], onChange: (font) => onUpdate({ font }) },
      { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 40, onChange: setHeight },
      { label: "Bevel", value: shape.bevel ?? 0, min: 0, max: 8, onChange: (bevel) => onUpdate({ bevel }) },
      { label: "Segments", value: shape.segments ?? 0, min: 0, max: 24, step: 1, onChange: (segments) => onUpdate({ segments: Math.round(segments) }) },
    ];
  }

  return [
    { label: "Length", value: depth, min: MIN_SHAPE_SIZE, max: 160, onChange: setDepth },
    { label: "Width", value: width, min: MIN_SHAPE_SIZE, max: 160, onChange: setWidth },
    { label: "Height", value: shape.height, min: MIN_SHAPE_SIZE, max: 160, onChange: setHeight },
  ];
}

export function ShapeInspector({
  shape,
  workspace,
  onUpdate,
  onClose,
  onEditSketch,
  onEditSketchDimension,
  canSeparateParts = false,
  onSeparateParts,
  onInteractionActiveChange,
  activeFeatureId = null,
  onSelectFeature,
  onSuppressFeature,
  onReorderFeature,
  onUpdateFeature,
  sceneShapes,
}: {
  shape: WorkplaneShape;
  workspace: WorkplaneWorkspaceSettings;
  onUpdate: ShapeInspectorUpdate;
  onClose: () => void;
  onEditSketch?: () => void;
  onEditSketchDimension?: (dimensionId: string, value: number) => void;
  canSeparateParts?: boolean;
  onSeparateParts?: () => void;
  onInteractionActiveChange?: (active: boolean) => void;
  /** In-body feature selection (CSG child id). */
  activeFeatureId?: string | null;
  onSelectFeature?: (featureId: string | null) => void;
  onSuppressFeature?: (featureId: string, suppressed: boolean) => void;
  onReorderFeature?: (featureId: string, direction: "up" | "down") => void;
  /** Patch a CSG child selected in the model tree (rebuilds the body). */
  onUpdateFeature?: (featureId: string, patch: Partial<WorkplaneShape>, options?: ShapeInspectorUpdateOptions) => void;
  /** Whole scene, so the export badge can account for loose cutters that will reach this body. */
  sceneShapes?: readonly WorkplaneShape[];
}) {
  const feature =
    activeFeatureId
      ? shape.groupedShapes?.find((child) => child.id === activeFeatureId) ?? null
      : null;
  const inspectTarget = feature ?? shape;
  const solidColor = inspectTarget.hole ? fallbackSolidColor(inspectTarget) : inspectTarget.color;
  const locked = Boolean(inspectTarget.locked);
  const updateInspectTarget: ShapeInspectorUpdate = (patch, options) => {
    if (feature && onUpdateFeature) {
      onUpdateFeature(feature.id, patch, options);
      return;
    }
    onUpdate(patch, options);
  };
  const properties = withNameProperty(inspectTarget, updateInspectTarget, getShapeProperties(inspectTarget, updateInspectTarget));
  const sketchFeature = resolveEditableSketchShape(
    feature ?? shape,
    { preferredId: activeFeatureId, preferFaceFeatures: !activeFeatureId },
  );
  const sketchDimensions = sketchFeature?.sketchDoc?.dimensions;
  const csgChildren = shape.groupedShapes ?? [];
  const csgOp = shape.csg?.op ?? inferCsgOp(shape);
  const showFeatureTree = Boolean(csgChildren.length && (isEvaluatedCsgBody(shape) || csgOp));
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [colorOpen, setColorOpen] = useState(false);
  const [featuresOpen, setFeaturesOpen] = useState(true);
  const [dimensionDialog, setDimensionDialog] = useState<{ id: string; value: number } | null>(null);
  const [draftColor, setDraftColor] = useState(solidColor);
  const colorPickingRef = useRef(false);

  useEffect(() => () => onInteractionActiveChange?.(false), [onInteractionActiveChange]);

  useEffect(() => {
    if (!colorPickingRef.current) {
      setDraftColor(solidColor);
    }
  }, [solidColor]);

  return (
    <aside className="shape-inspector" aria-label={`${inspectTarget.name} shape settings`} onPointerDown={(event) => event.stopPropagation()}>
      <div className="shape-inspector-header">
        <PeakTipButton className="inspector-header-icon" label="Close shape settings" onClick={onClose}>
          <X size={22} strokeWidth={2.6} />
        </PeakTipButton>
        <strong>{feature ? `${shape.name} · ${inspectTarget.name}` : shape.name}</strong>
        {(() => {
          const quality = sceneShapes
            ? shapeExportQualityHintInScene(inspectTarget, sceneShapes)
            : shapeExportQualityHint(inspectTarget);
          return (
            <span
              className={`cad-ready-badge${quality === "faceted" ? " cad-ready-badge--mesh" : ""}${quality === "pending" || quality === "unsupported" ? " cad-ready-badge--pending" : ""}`}
              title={shapeExportQualityTitle(quality)}
            >
              {shapeExportQualityLabel(quality)}
            </span>
          );
        })()}
        <div className="inspector-header-actions">
          <PeakTipButton
            className={locked ? "inspector-header-icon active" : "inspector-header-icon"}
            label={locked ? "Unlock shape" : "Lock shape"}
            onClick={() => updateInspectTarget({ locked: !locked })}
          >
            {locked ? <LockKeyhole size={31} strokeWidth={2.4} /> : <LockKeyholeOpen size={31} strokeWidth={2.4} />}
          </PeakTipButton>
          <PeakTipButton
            className={inspectTarget.hidden ? "inspector-header-icon active" : "inspector-header-icon"}
            label={inspectTarget.hidden ? "Show shape" : "Hide shape"}
            onClick={() => updateInspectTarget({ hidden: !inspectTarget.hidden })}
          >
            <ToolbarHideSelectedIcon />
          </PeakTipButton>
        </div>
      </div>

      <div className="shape-state-card" role="group" aria-label="Shape mode">
        <button
          className={!inspectTarget.hole ? "active solid-choice" : "solid-choice"}
          onClick={() => {
            const wasHole = Boolean(inspectTarget.hole);
            updateInspectTarget({ hole: false, color: solidColor });
            setColorOpen((open) => (wasHole ? false : !open));
          }}
          disabled={locked}
          aria-pressed={!inspectTarget.hole}
          aria-expanded={colorOpen}
        >
          <span className="large-solid-swatch" style={{ "--swatch": solidColor } as CSSProperties} />
          <span>Solid</span>
        </button>
        <button
          className={inspectTarget.hole ? "active hole-choice" : "hole-choice"}
          onClick={() => {
            updateInspectTarget({ hole: true, color: "#b8c2cc" });
            setColorOpen(false);
          }}
          disabled={locked}
          aria-pressed={inspectTarget.hole}
        >
          <span className="large-hole-swatch" />
          <span>Hole</span>
        </button>
      </div>

      {colorOpen ? (
        <div className="color-card" aria-label="Shape color">
          <div className="color-card-header">
            <span>Color</span>
            <span className="color-value">{draftColor.toUpperCase()}</span>
          </div>
          <div className="color-grid">
            {SOLID_COLORS.map((color) => (
              <PeakTipButton
                key={color}
                className={solidColor.toLowerCase() === color.toLowerCase() && !inspectTarget.hole ? "selected" : ""}
                label={color.toUpperCase()}
                aria-label={`Set color ${color}`}
                style={{ "--shape-swatch": color } as CSSProperties}
                disabled={locked}
                onClick={() => {
                  updateInspectTarget({ color, hole: false });
                  setColorOpen(false);
                }}
              />
            ))}
            <PeakTipLabel className={locked ? "custom-color disabled" : "custom-color"} label="Custom color">
              <input
                type="color"
                value={draftColor}
                disabled={locked}
                onFocus={() => {
                  colorPickingRef.current = true;
                  onInteractionActiveChange?.(true);
                }}
                onBlur={() => {
                  colorPickingRef.current = false;
                  onInteractionActiveChange?.(false);
                }}
                onInput={(event) => {
                  const next = event.currentTarget.value;
                  setDraftColor(next);
                  updateInspectTarget({ color: next, hole: false });
                }}
                onChange={(event) => {
                  // Commit on change, but keep the color card mounted so the native
                  // picker is not torn down while dragging through the spectrum.
                  const next = event.currentTarget.value;
                  setDraftColor(next);
                  updateInspectTarget({ color: next, hole: false });
                }}
              />
              <span>Custom</span>
            </PeakTipLabel>
          </div>
        </div>
      ) : null}

      {onEditSketch ? (
        <button className="edit-sketch-button" type="button" disabled={locked} onClick={onEditSketch}>
          Edit sketch
        </button>
      ) : null}

      {sketchDimensions?.length ? (
        <div className="sketch-inspector-dimensions" aria-label="Sketch dimensions">
          <strong>Sketch dimensions</strong>
          {sketchDimensions.map((dimension) => (
            <button
              key={dimension.id}
              type="button"
              disabled={locked || !dimension.driving || !onEditSketchDimension}
              onClick={() => {
                if (!onEditSketchDimension || !dimension.driving) return;
                setDimensionDialog({ id: dimension.id, value: dimension.value });
              }}
            >
              {dimension.kind} {dimension.value.toFixed(2)} mm{dimension.driving ? "" : " (driven)"}
            </button>
          ))}
        </div>
      ) : null}

      {canSeparateParts && onSeparateParts ? (
        <button className="inspector-action-button" type="button" disabled={locked} onClick={onSeparateParts}>
          <Split size={17} strokeWidth={2.5} />
          <span>Separate Parts</span>
        </button>
      ) : null}

      <div className="property-card">
        <button
          className="property-card-header"
          type="button"
          aria-expanded={propertiesOpen}
          aria-controls={`properties-${shape.id}`}
          onClick={() => setPropertiesOpen((open) => !open)}
        >
          <span>Properties</span>
          <ChevronUp className={propertiesOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
        </button>
        {propertiesOpen ? (
          <div className="property-list" id={`properties-${shape.id}`}>
            {properties.map((property) => {
              if (property.type === "text") {
                return <TextProperty key={property.label} {...property} disabled={locked} onInteractionActiveChange={onInteractionActiveChange} />;
              }
              if (property.type === "select") {
                return <SelectProperty key={property.label} {...property} disabled={locked} />;
              }
              return <RangeProperty key={property.label} {...property} workspace={workspace} disabled={locked} onInteractionActiveChange={onInteractionActiveChange} />;
            })}
          </div>
        ) : null}
      </div>

      {showFeatureTree ? (
        <div className="property-card csg-feature-tree" aria-label="Model tree">
          <button
            className="property-card-header"
            type="button"
            aria-expanded={featuresOpen}
            aria-controls={`features-${shape.id}`}
            onClick={() => setFeaturesOpen((open) => !open)}
          >
            <span>Model tree</span>
            <ChevronUp className={featuresOpen ? "" : "collapsed"} size={25} strokeWidth={2.8} />
          </button>
          {featuresOpen ? (
            <div className="csg-feature-list" id={`features-${shape.id}`}>
              <div className="csg-feature-meta">
                <span className="csg-feature-op">
                  {csgOp === "assemble" ? "assembly" : csgOp === "subtract" ? "cut" : csgOp === "union" ? "union" : csgOp === "intersect" ? "intersect" : "group"}
                </span>
                <span className="csg-feature-tip">
                  {csgOp === "assemble"
                    ? "Select a part to edit its properties"
                    : "Select a feature to edit · Alt-click in view"}
                </span>
              </div>
              {csgChildren.map((child, index) => {
                const suppressed = Boolean(child.suppressed || child.csg?.suppressed);
                const active = activeFeatureId === child.id;
                const childQuality = shapeExportQualityHint(child);
                return (
                  <div
                    key={child.id}
                    className={`csg-feature-row${active ? " active" : ""}${suppressed ? " suppressed" : ""}`}
                  >
                    <button
                      type="button"
                      className="csg-feature-select"
                      disabled={locked}
                      onClick={() => onSelectFeature?.(active ? null : child.id)}
                      title="Select feature for edit"
                    >
                      <span className={`csg-feature-role ${child.hole ? "cut" : "join"}`}>{child.hole ? "−" : "+"}</span>
                      <span className="csg-feature-name">{child.name || child.kind}</span>
                      <span
                        className={`csg-feature-quality csg-feature-quality--${childQuality}`}
                        title={shapeExportQualityTitle(childQuality)}
                      >
                        {childQuality === "exact"
                          ? "exact"
                          : childQuality === "faceted"
                            ? "mesh"
                            : childQuality === "unsupported"
                              ? "n/a"
                              : "…"}
                      </span>
                    </button>
                    <label className="csg-feature-suppress" title="Suppress feature">
                      <input
                        type="checkbox"
                        checked={suppressed}
                        disabled={locked || !onSuppressFeature}
                        onChange={(event) => onSuppressFeature?.(child.id, event.target.checked)}
                      />
                      <span>Off</span>
                    </label>
                    <div className="csg-feature-reorder">
                      <button
                        type="button"
                        disabled={locked || index === 0 || !onReorderFeature}
                        onClick={() => onReorderFeature?.(child.id, "up")}
                        aria-label="Move feature up"
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        type="button"
                        disabled={locked || index >= csgChildren.length - 1 || !onReorderFeature}
                        onClick={() => onReorderFeature?.(child.id, "down")}
                        aria-label="Move feature down"
                      >
                        <ChevronDown size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {dimensionDialog ? (
        <InlineValueDialog
          title="Edit sketch dimension"
          fields={[{ key: "value", label: "Dimension value", value: String(dimensionDialog.value), unit: "mm", min: 0 }]}
          confirmLabel="Apply"
          onCancel={() => setDimensionDialog(null)}
          onConfirm={(values) => {
            const value = Number.parseFloat(values.value ?? "");
            const { id } = dimensionDialog;
            setDimensionDialog(null);
            if (Number.isFinite(value) && value > 0) onEditSketchDimension?.(id, value);
          }}
        />
      ) : null}
    </aside>
  );
}

export function SnapGridControl({
  snap,
  snapOpen,
  onSnapChange,
  onSnapOpenChange,
}: {
  snap: GridSize;
  snapOpen: boolean;
  onSnapChange: Dispatch<SetStateAction<GridSize>>;
  onSnapOpenChange: Dispatch<SetStateAction<boolean>>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!snapOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      onSnapOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSnapOpenChange(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onSnapOpenChange, snapOpen]);

  return (
    <div className="snap-row" ref={rootRef}>
      <span>Snap Grid</span>
      <button
        type="button"
        className="snap-select"
        aria-haspopup="listbox"
        aria-expanded={snapOpen}
        onClick={() => onSnapOpenChange((value) => !value)}
      >
        {snap}
        <ChevronDown size={12} fill="currentColor" />
      </button>
      {snapOpen ? (
        <div className="snap-menu" role="listbox" aria-label="Snap grid size">
          {GRID_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              role="option"
              aria-selected={size === snap}
              className={size === snap ? "selected" : ""}
              onClick={() => {
                onSnapChange(size);
                onSnapOpenChange(false);
              }}
            >
              {size}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RangeProperty({
  label,
  value,
  min,
  max,
  step = 0.01,
  workspace,
  disabled,
  onChange,
  onInteractionActiveChange,
}: RangePropertyConfig & { workspace: WorkplaneWorkspaceSettings; disabled?: boolean; onInteractionActiveChange?: (active: boolean) => void }) {
  const allowsAboveSliderMax = label === "Length" || label === "Width" || label === "Height";
  const isLength = propertyUsesLengthUnit(label);
  const isAngle = propertyUsesDegreeUnit(label);
  const accuracy = workspace.accuracy;
  const actualValue = Math.max(min, Number.isFinite(value) ? value : min);
  const controlValue = isLength ? millimetersToDisplay(actualValue, workspace) : actualValue;
  const controlMin = isLength ? millimetersToDisplay(min, workspace) : min;
  const controlMax = isLength ? millimetersToDisplay(max, workspace) : max;
  const controlStep = isLength ? displayStepFromMillimeters(step, workspace) : step;
  const sliderValue = clamp(controlValue, controlMin, controlMax);
  const position = ((sliderValue - controlMin) / Math.max(Number.EPSILON, controlMax - controlMin)) * 100;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatPropertyNumber(controlValue, accuracy, controlStep));
  const unit = isLength ? lengthDisplayUnit(workspace).label : isAngle ? "°" : null;
  useEffect(() => {
    if (!editing) {
      setDraft(formatPropertyNumber(controlValue, accuracy, controlStep));
    }
  }, [accuracy, controlStep, controlValue, editing]);
  const toModelValue = (nextValue: number) => isLength ? displayToMillimeters(nextValue, workspace) : nextValue;
  const commitDraft = () => {
    const next = Number(draft);
    const finiteNext = Number.isFinite(next) ? next : controlValue;
    const nextModelValue = toModelValue(finiteNext);
    onChange(allowsAboveSliderMax ? Math.max(min, nextModelValue) : clamp(nextModelValue, min, max));
    setEditing(false);
    onInteractionActiveChange?.(false);
  };
  const handleSliderChange = (nextValue: number) => {
    const next = clamp(Number.isFinite(nextValue) ? nextValue : controlMin, controlMin, controlMax);
    onChange(clamp(toModelValue(next), min, max));
    setDraft(formatPropertyNumber(next, accuracy, controlStep));
  };
  return (
    <label className="range-property" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span className="range-property-header">
        <span className="range-property-name">{label}</span>
        <span className="range-value-control">
          <input
            type="number"
            min={controlMin}
            max={allowsAboveSliderMax ? undefined : controlMax}
            step={controlStep}
            value={editing ? draft : formatPropertyNumber(controlValue, accuracy, controlStep)}
            disabled={disabled}
            inputMode="decimal"
            onFocus={() => {
              onInteractionActiveChange?.(true);
              setDraft(formatPropertyNumber(controlValue, accuracy, controlStep));
              setEditing(true);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setDraft(formatPropertyNumber(controlValue, accuracy, controlStep));
                setEditing(false);
                event.currentTarget.blur();
              }
            }}
          />
          {unit ? <span className="range-value-unit">{unit}</span> : null}
        </span>
      </span>
      <div className="range-control">
        <input
          type="range"
          min={controlMin}
          max={controlMax}
          step={controlStep}
          value={sliderValue}
          disabled={disabled}
          onFocus={() => onInteractionActiveChange?.(true)}
          onBlur={() => onInteractionActiveChange?.(false)}
          onPointerDown={() => onInteractionActiveChange?.(true)}
          onPointerUp={() => onInteractionActiveChange?.(false)}
          onPointerCancel={() => onInteractionActiveChange?.(false)}
          onChange={(event) => handleSliderChange(Number(event.currentTarget.value))}
        />
      </div>
    </label>
  );
}

function TextProperty({
  label,
  value,
  maxLength = 24,
  disabled,
  onChange,
  onInteractionActiveChange,
}: TextPropertyConfig & { disabled?: boolean; onInteractionActiveChange?: (active: boolean) => void }) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <label className="text-property">
      <span>{label}</span>
      <input
        type="text"
        value={draft}
        disabled={disabled}
        maxLength={maxLength}
        spellCheck={false}
        onFocus={() => onInteractionActiveChange?.(true)}
        onBlur={() => {
          onInteractionActiveChange?.(false);
          const committed = draft.replace(/\s+/g, " ").trim();
          if (!committed) {
            const fallback = value.trim() || (label === "Name" ? "Shape" : draft);
            setDraft(fallback);
            if (fallback !== value) {
              onChange(fallback);
            }
            return;
          }
          if (committed !== draft) {
            setDraft(committed);
          }
          if (committed !== value) {
            onChange(committed);
          }
        }}
        onChange={(event) => {
          const next = event.currentTarget.value.slice(0, maxLength);
          setDraft(next);
          onChange(next);
        }}
      />
    </label>
  );
}

function SelectProperty({ label, value, options, disabled, onChange }: SelectPropertyConfig & { disabled?: boolean }) {
  return (
    <label className="select-property">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
