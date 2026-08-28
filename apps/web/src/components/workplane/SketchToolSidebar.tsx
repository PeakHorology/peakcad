"use client";

import type { ReactNode } from "react";
import {
  Check,
  Circle,
  Cylinder,
  Hexagon,
  Minus,
  MoveDiagonal2,
  Plus,
  RectangleHorizontal,
  RotateCw,
  Square,
  Star,
  Triangle,
  Waypoints,
  X,
} from "lucide-react";
import type { SketchTool } from "@/components/SketchWorkspace";
import {
  SketchConstraintEqualIcon,
  SketchConstraintHorizontalIcon,
  SketchConstraintParallelIcon,
  SketchConstraintPerpendicularIcon,
  SketchConstraintSymmetryIcon,
  SketchConstraintTangentIcon,
  SketchConstraintVerticalIcon,
  SketchDimensionIcon,
  SketchRectPatternIcon,
  SketchTrimIcon,
  ToolbarChamferIcon,
  ToolbarFilletIcon,
  ToolbarMirrorIcon,
} from "@/components/icons";
import { usePeakContextHelp } from "@/components/workplane/ToolNameTooltip";
import { MAX_SKETCH_POLYGON_SIDES, MIN_SKETCH_POLYGON_SIDES } from "@/lib/sketchDrawShapes";
import { TOOL_DESCRIPTIONS } from "@/lib/toolDescriptions";

const sketchReferenceIcons = {
  line: "sketch-tool-line.png",
  bezier: "sketch-tool-bezier-curve.png",
  smooth: "sketch-tool-smooth-curve.png",
  select: "sketch-tool-select.png",
  image: "sketch-tool-add-image.png",
  refine: "sketch-tool-add-or-remove-points.png",
  erase: "sketch-tool-erase.png",
  measure: "sketch-tool-measure.png",
} as const;

function SketchReferenceIcon({
  name,
  className,
}: {
  name: keyof typeof sketchReferenceIcons;
  /** Extra class, e.g. "sketch-tool-icon" for consistent Draw-tool sizing. */
  className?: string;
}) {
  return (
    <img
      className={`sketch-reference-icon${className ? ` ${className}` : ""}`}
      src={`/assets/sketchforge/${sketchReferenceIcons[name]}`}
      alt=""
      draggable={false}
    />
  );
}

function SketchToolButton({
  label,
  description,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  description: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { onContextMenu, helpPortal } = usePeakContextHelp(label, description);
  return (
    <button
      className={`editor-tool-sidebar-item sketch-tool-item ${disabled ? "disabled" : ""} ${active ? "active" : ""}`}
      type="button"
      aria-label={label}
      onClick={onClick}
      onContextMenu={onContextMenu}
      disabled={disabled}
    >
      {children}
      <span>{label}</span>
      {helpPortal}
    </button>
  );
}

/** Draw tools (right rail while actively sketching). */
export function SketchToolSidebar({
  sketchTool,
  polygonSides,
  onSketchTool,
  onPolygonSidesChange,
}: {
  sketchTool: SketchTool;
  polygonSides: number;
  onSketchTool: (tool: SketchTool) => void;
  onPolygonSidesChange: (sides: number) => void;
}) {
  return (
    <aside className="editor-tool-sidebar editor-tool-sidebar-right" aria-label="Sketch draw tools">
      <div className="editor-tool-sidebar-scroll">
        <section className="editor-tool-sidebar-section">
          <div className="editor-tool-sidebar-header">Draw</div>
          <div className="editor-tool-sidebar-list">
            <SketchToolButton label="Line" description={TOOL_DESCRIPTIONS.line} active={sketchTool === "line"} onClick={() => onSketchTool("line")}>
              <SketchReferenceIcon name="line" className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Bezier" description={TOOL_DESCRIPTIONS.bezier} active={sketchTool === "bezier"} onClick={() => onSketchTool("bezier")}>
              <SketchReferenceIcon name="bezier" className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Smooth" description={TOOL_DESCRIPTIONS.smooth} active={sketchTool === "smooth"} onClick={() => onSketchTool("smooth")}>
              <SketchReferenceIcon name="smooth" className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Circle" description={TOOL_DESCRIPTIONS.circle} active={sketchTool === "circle"} onClick={() => onSketchTool("circle")}>
              <Circle size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Ellipse" description={TOOL_DESCRIPTIONS.ellipse} active={sketchTool === "ellipse"} onClick={() => onSketchTool("ellipse")}>
              <Circle size={22} strokeWidth={2.2} className="sketch-tool-icon sketch-tool-ellipse-icon" />
            </SketchToolButton>
            <SketchToolButton label="Square" description={TOOL_DESCRIPTIONS.square} active={sketchTool === "square"} onClick={() => onSketchTool("square")}>
              <Square size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Rect" description={TOOL_DESCRIPTIONS.rect} active={sketchTool === "rectangle"} onClick={() => onSketchTool("rectangle")}>
              <RectangleHorizontal size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Round" description={TOOL_DESCRIPTIONS.roundRect} active={sketchTool === "roundRect"} onClick={() => onSketchTool("roundRect")}>
              <Square size={22} strokeWidth={2.2} className="sketch-tool-icon sketch-tool-round-rect-icon" />
            </SketchToolButton>
            <SketchToolButton label="Slot" description={TOOL_DESCRIPTIONS.slot} active={sketchTool === "slot"} onClick={() => onSketchTool("slot")}>
              <Cylinder size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Triangle" description={TOOL_DESCRIPTIONS.triangle} active={sketchTool === "triangle"} onClick={() => onSketchTool("triangle")}>
              <Triangle size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Polygon" description={TOOL_DESCRIPTIONS.polygon} active={sketchTool === "polygon"} onClick={() => onSketchTool("polygon")}>
              <Hexagon size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Star" description={TOOL_DESCRIPTIONS.star} active={sketchTool === "star"} onClick={() => onSketchTool("star")}>
              <Star size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Arc" description={TOOL_DESCRIPTIONS.arc} active={sketchTool === "arc"} onClick={() => onSketchTool("arc")}>
              <Waypoints size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
            <SketchToolButton label="Offset" description={TOOL_DESCRIPTIONS.offset} active={sketchTool === "offset"} onClick={() => onSketchTool("offset")}>
              <MoveDiagonal2 size={22} strokeWidth={2.2} className="sketch-tool-icon" />
            </SketchToolButton>
          </div>
        </section>
        {sketchTool === "polygon" ? (
          <section className="editor-tool-sidebar-section">
            <div className="editor-tool-sidebar-header">Sides</div>
            <div className="sketch-polygon-sides" aria-label="Polygon side count">
              <button
                type="button"
                aria-label="Fewer sides"
                disabled={polygonSides <= MIN_SKETCH_POLYGON_SIDES}
                onClick={() => onPolygonSidesChange(polygonSides - 1)}
              >
                <Minus size={14} strokeWidth={2.4} />
              </button>
              <span>{polygonSides}</span>
              <button
                type="button"
                aria-label="More sides"
                disabled={polygonSides >= MAX_SKETCH_POLYGON_SIDES}
                onClick={() => onPolygonSidesChange(polygonSides + 1)}
              >
                <Plus size={14} strokeWidth={2.4} />
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

/** Floating finish actions — Extrude / Revolve / Cancel (top-right of sketch stage). */
export function SketchFinishToolbar({
  onSketchExtrude,
  onSketchRevolve,
  onSketchCancel,
  revolveDisabled = false,
}: {
  onSketchExtrude: () => void;
  onSketchRevolve: () => void;
  onSketchCancel: () => void;
  revolveDisabled?: boolean;
}) {
  const extrudeHelp = usePeakContextHelp("Extrude", TOOL_DESCRIPTIONS.extrude);
  const revolveHelp = usePeakContextHelp("Revolve", TOOL_DESCRIPTIONS.revolve);
  const cancelHelp = usePeakContextHelp("Cancel", TOOL_DESCRIPTIONS.cancelSketch);

  return (
    <section className="sketch-finish-toolbar" aria-label="Finish sketch">
      <div className="sketch-finish-toolbar-header">Finish</div>
      <div className="sketch-finish-toolbar-list">
        <button className="editor-tool-sidebar-action primary" type="button" onClick={onSketchExtrude} onContextMenu={extrudeHelp.onContextMenu}>
          <Check size={18} strokeWidth={2.6} />
          <span>Extrude</span>
          {extrudeHelp.helpPortal}
        </button>
        <button
          className={`editor-tool-sidebar-action${revolveDisabled ? " disabled" : ""}`}
          type="button"
          onClick={onSketchRevolve}
          disabled={revolveDisabled}
          title={revolveDisabled ? "Revolve is only available on workplane sketches" : undefined}
          onContextMenu={revolveHelp.onContextMenu}
        >
          <RotateCw size={18} strokeWidth={2.6} />
          <span>Revolve</span>
          {revolveHelp.helpPortal}
        </button>
        <button className="editor-tool-sidebar-action cancel" type="button" onClick={onSketchCancel} onContextMenu={cancelHelp.onContextMenu}>
          <X size={18} strokeWidth={2.6} />
          <span>Cancel</span>
          {cancelHelp.helpPortal}
        </button>
      </div>
    </section>
  );
}

/** Left rail while sketching: select, inspect, constrain, modify. */
export function SketchUtilitySidebar({
  sketchTool,
  onSketchTool,
  onSketchImage,
}: {
  sketchTool: SketchTool;
  onSketchTool: (tool: SketchTool) => void;
  onSketchImage: () => void;
}) {
  return (
    <aside className="editor-tool-sidebar sketch-utility-sidebar" aria-label="Sketch utility tools">
      <div className="editor-tool-sidebar-scroll">
        <section className="editor-tool-sidebar-section">
          <div className="editor-tool-sidebar-header">Select</div>
          <div className="editor-tool-sidebar-list">
            <SketchToolButton label="Select" description={TOOL_DESCRIPTIONS.select} active={sketchTool === "select"} onClick={() => onSketchTool("select")}>
              <SketchReferenceIcon name="select" />
            </SketchToolButton>
            <SketchToolButton label="Image" description={TOOL_DESCRIPTIONS.image} disabled={sketchTool !== "select"} onClick={onSketchImage}>
              <SketchReferenceIcon name="image" />
            </SketchToolButton>
            <SketchToolButton label="Refine" description={TOOL_DESCRIPTIONS.refine} active={sketchTool === "refine"} onClick={() => onSketchTool("refine")}>
              <SketchReferenceIcon name="refine" />
            </SketchToolButton>
            <SketchToolButton label="Erase" description={TOOL_DESCRIPTIONS.erase} active={sketchTool === "erase"} onClick={() => onSketchTool("erase")}>
              <SketchReferenceIcon name="erase" />
            </SketchToolButton>
          </div>
        </section>
        <section className="editor-tool-sidebar-section">
          <div className="editor-tool-sidebar-header">Inspect</div>
          <div className="editor-tool-sidebar-list">
            <SketchToolButton label="Dimension" description="Add a driving length dimension (Fusion D)." active={sketchTool === "dimension"} onClick={() => onSketchTool("dimension")}>
              <SketchDimensionIcon />
            </SketchToolButton>
          </div>
        </section>
        <section className="editor-tool-sidebar-section">
          <div className="editor-tool-sidebar-header">Constraints</div>
          <div className="editor-tool-sidebar-list">
            <SketchToolButton label="Horiz" description="Make a line horizontal." active={sketchTool === "constrain-h"} onClick={() => onSketchTool("constrain-h")}>
              <SketchConstraintHorizontalIcon />
            </SketchToolButton>
            <SketchToolButton label="Vert" description="Make a line vertical." active={sketchTool === "constrain-v"} onClick={() => onSketchTool("constrain-v")}>
              <SketchConstraintVerticalIcon />
            </SketchToolButton>
            <SketchToolButton label="Equal" description="Make two lines equal length." active={sketchTool === "constrain-equal"} onClick={() => onSketchTool("constrain-equal")}>
              <SketchConstraintEqualIcon />
            </SketchToolButton>
            <SketchToolButton label="Parallel" description="Make two lines parallel." active={sketchTool === "constrain-parallel"} onClick={() => onSketchTool("constrain-parallel")}>
              <SketchConstraintParallelIcon />
            </SketchToolButton>
            <SketchToolButton label="Perp" description="Make two lines perpendicular." active={sketchTool === "constrain-perp"} onClick={() => onSketchTool("constrain-perp")}>
              <SketchConstraintPerpendicularIcon />
            </SketchToolButton>
            <SketchToolButton label="Tangent" description="Make a line tangent to a circle (select line + circle center)." active={sketchTool === "constrain-tangent"} onClick={() => onSketchTool("constrain-tangent")}>
              <SketchConstraintTangentIcon />
            </SketchToolButton>
            <SketchToolButton label="Symmetry" description="Mirror two points or lines across an axis (select pair + axis line)." active={sketchTool === "constrain-symmetry"} onClick={() => onSketchTool("constrain-symmetry")}>
              <SketchConstraintSymmetryIcon />
            </SketchToolButton>
          </div>
        </section>
        <section className="editor-tool-sidebar-section">
          <div className="editor-tool-sidebar-header">Modify</div>
          <div className="editor-tool-sidebar-list">
            <SketchToolButton label="Trim" description="Remove a sketch segment." active={sketchTool === "trim"} onClick={() => onSketchTool("trim")}>
              <SketchTrimIcon />
            </SketchToolButton>
            <SketchToolButton label="Fillet" description="Round a sketch corner." active={sketchTool === "fillet"} onClick={() => onSketchTool("fillet")}>
              <ToolbarFilletIcon />
            </SketchToolButton>
            <SketchToolButton label="Chamfer" description="Chamfer a sketch corner." active={sketchTool === "chamfer"} onClick={() => onSketchTool("chamfer")}>
              <ToolbarChamferIcon />
            </SketchToolButton>
            <SketchToolButton label="Mirror" description="Mirror selection across a line." active={sketchTool === "mirror"} onClick={() => onSketchTool("mirror")}>
              <ToolbarMirrorIcon />
            </SketchToolButton>
            <SketchToolButton label="Pattern" description="Rectangular pattern of the selection." active={sketchTool === "pattern"} onClick={() => onSketchTool("pattern")}>
              <SketchRectPatternIcon />
            </SketchToolButton>
          </div>
        </section>
      </div>
    </aside>
  );
}
