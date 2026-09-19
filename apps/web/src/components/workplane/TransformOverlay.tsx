"use client";

import type { CSSProperties } from "react";
import * as THREE from "three";
import { PeakTipButton } from "@/components/workplane/ToolNameTooltip";
import {
  measureKeyForHandle,
  ROTATION_RING_INNER,
  ROTATION_RING_OUTER,
  ROTATION_RING_POINTER,
  ROTATION_SNAP_STEP,
  type TransformOverlayProps,
  type TransformOverlayState,
} from "@/components/workplane/transformOverlayTypes";

export {
  getElevationMeasureKey,
  measureKeyForHandle,
  ROTATION_RING_INNER,
  ROTATION_RING_OUTER,
  ROTATION_RING_POINTER,
  ROTATION_RING_LOCAL_EXTENT,
  ROTATION_SNAP_STEP,
  rotationWheelRadiiFromPlaneRadius,
  type DimensionMark,
  type EditingDimension,
  type EditingRotation,
  type PinnedRotationWheelView,
  type RotationAxis,
  type RotationPlaneView,
  type RotationReadout,
  type RotationWheelView,
  type TransformHandleKind,
  type TransformOverlayState,
} from "@/components/workplane/transformOverlayTypes";

function describeRotationWedge(startDeg: number, endDeg: number, innerRadius: number, outerRadius: number) {
  let deltaDeg = endDeg - startDeg;
  while (deltaDeg > 180) deltaDeg -= 360;
  while (deltaDeg < -180) deltaDeg += 360;
  if (Math.abs(deltaDeg) < 0.01) {
    return null;
  }
  const toPoint = (degrees: number, radius: number) => {
    const radians = THREE.MathUtils.degToRad(degrees - 90);
    return [Math.cos(radians) * radius, Math.sin(radians) * radius] as const;
  };
  const [ox1, oy1] = toPoint(startDeg, outerRadius);
  const [ox2, oy2] = toPoint(endDeg, outerRadius);
  const [ix2, iy2] = toPoint(endDeg, innerRadius);
  const [ix1, iy1] = toPoint(startDeg, innerRadius);
  const largeArc = Math.abs(deltaDeg) > 180 ? 1 : 0;
  const sweep = deltaDeg >= 0 ? 1 : 0;
  return `M ${ox1} ${oy1} A ${outerRadius} ${outerRadius} 0 ${largeArc} ${sweep} ${ox2} ${oy2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 ${largeArc} ${sweep ? 0 : 1} ${ix1} ${iy1} Z`;
}

function protractorPoint(degrees: number, radius: number) {
  const radians = THREE.MathUtils.degToRad(degrees - 90);
  return {
    x: Math.cos(radians) * radius,
    y: Math.sin(radians) * radius,
  };
}

export function TransformOverlay({
  box,
  measureKey,
  editingDimension,
  editingRotation,
  rotationReadout,
  showRotationWheel,
  hideSelectionChrome,
  hideDimensionMarks,
  rotationWheelAxis,
  pinnedRotationWheelView,
  onBeginTransform,
  onMoveTransform,
  onFinishTransform,
  onHoverMeasure,
  onPinMeasure,
  onBeginDimensionEdit,
  onBeginLiftEdit,
  onDropSelectionToWorkplane,
  onEditingDimensionChange,
  onCommitDimensionEdit,
  onCancelDimensionEdit,
  onBeginRotationEdit,
  onEditingRotationChange,
  onCommitRotationEdit,
  onCancelRotationEdit,
  onCycleStackedSelection,
}: TransformOverlayProps) {
  const marks = measureKey ? (box.dimensions[measureKey] ?? []) : (box.dimensions.selection ?? []);
  const visibleMarks = (hideDimensionMarks ? [] : marks).filter((mark) => mark.key !== editingDimension?.key);
  const handleMeasureKey = (handle: TransformOverlayState["handles"][number]) => measureKeyForHandle(handle.kind, handle.key, box);
  // Indexed ticks live in the inner circle; the outer band is the free-rotation ring.
  const protractorTicks = Array.from({ length: 16 }, (_, index) => {
    const degrees = index * ROTATION_SNAP_STEP - 90;
    const radians = THREE.MathUtils.degToRad(degrees);
    const major = index % 2 === 0;
    const tickOuter = ROTATION_RING_INNER;
    const tickInner = major ? ROTATION_RING_INNER - 16 : ROTATION_RING_INNER - 10;
    return {
      key: `tick-${index}`,
      major,
      x1: Math.cos(radians) * tickInner,
      y1: Math.sin(radians) * tickInner,
      x2: Math.cos(radians) * tickOuter,
      y2: Math.sin(radians) * tickOuter,
    };
  });
  const pointerAngle = rotationReadout?.pointerAngle ?? 0;
  const startPointerAngle = rotationReadout?.startPointerAngle ?? pointerAngle;
  const activeLine = protractorPoint(pointerAngle, ROTATION_RING_POINTER);
  const startLine = protractorPoint(startPointerAngle, ROTATION_RING_POINTER);
  const activeWedge = describeRotationWedge(startPointerAngle, pointerAngle, ROTATION_RING_INNER, ROTATION_RING_OUTER);
  const snapMode = rotationReadout?.snapMode ?? "stepped";
  const pinnedWheel = pinnedRotationWheelView?.axis === rotationWheelAxis ? pinnedRotationWheelView : null;
  const plane = pinnedWheel?.plane ?? box.rotationPlanes[rotationWheelAxis];
  const wheel = pinnedWheel?.wheel ?? box.rotationWheels[rotationWheelAxis] ?? box.rotationWheel;
  return (
    <div className={`transform-overlay ${hideSelectionChrome ? "hide-selection-chrome" : ""}`} aria-hidden="true">
      {showRotationWheel && wheel && plane ? (
        <svg
          className={`rotation-protractor-plane axis-${rotationWheelAxis} snap-${snapMode}`}
          viewBox={`0 0 ${box.width} ${box.height}`}
          preserveAspectRatio="none"
          onPointerDown={(event) => {
            if (onCycleStackedSelection?.(event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onBeginTransform("rotate", `rotate-wheel-${rotationWheelAxis}`, event);
          }}
          onPointerMove={(event) => onMoveTransform(event.clientX, event.clientY, event.shiftKey, event.altKey)}
          onPointerUp={onFinishTransform}
          onPointerCancel={onFinishTransform}
        >
          <g transform={`matrix(${plane.a} ${plane.b} ${plane.c} ${plane.d} ${plane.x} ${plane.y})`}>
            <circle className="rotation-protractor-outer" cx="0" cy="0" r={ROTATION_RING_OUTER} />
            <circle className="rotation-protractor-inner" cx="0" cy="0" r={ROTATION_RING_INNER} />
            {activeWedge ? <path className="rotation-active-wedge" d={activeWedge} /> : null}
            {protractorTicks.map((tick) => (
              <line
                key={tick.key}
                className={tick.major ? "rotation-tick major" : "rotation-tick"}
                x1={tick.x1}
                y1={tick.y1}
                x2={tick.x2}
                y2={tick.y2}
              />
            ))}
            <line className="rotation-zero-line" x1="0" y1="0" x2={startLine.x} y2={startLine.y} />
            <line className="rotation-current-line" x1="0" y1="0" x2={activeLine.x} y2={activeLine.y} />
            <circle className="rotation-pointer-dot" cx={activeLine.x} cy={activeLine.y} r="3.2" />
            <text
              className="rotation-zero-label"
              x={startLine.x * ((ROTATION_RING_INNER - 7) / ROTATION_RING_POINTER)}
              y={startLine.y * ((ROTATION_RING_INNER - 7) / ROTATION_RING_POINTER)}
            >
              0&deg;
            </text>
          </g>
        </svg>
      ) : null}
      <svg className="transform-guides" viewBox={`0 0 ${box.width} ${box.height}`} preserveAspectRatio="none">
        <defs>
          <marker id="dimension-arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0 4 L8 0 L5.2 4 L8 8 Z" />
          </marker>
        </defs>
        {box.guides.map((line, index) => (
          <line key={`guide-${index}`} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
        ))}
        {visibleMarks.map((mark) => (
          <g key={mark.key} className="dimension-mark">
            <line className="dimension-extension" x1={mark.e1x1} y1={mark.e1y1} x2={mark.e1x2} y2={mark.e1y2} />
            <line className="dimension-extension" x1={mark.e2x1} y1={mark.e2y1} x2={mark.e2x2} y2={mark.e2y2} />
            <line className="dimension-line" x1={mark.x1} y1={mark.y1} x2={mark.x2} y2={mark.y2} />
          </g>
        ))}
      </svg>
      {visibleMarks.map((mark) => (
        <button
          key={`${mark.key}-label`}
          className="dimension-label"
          type="button"
          style={{ "--overlay-x": `${mark.labelX}px`, "--overlay-y": `${mark.labelY}px` } as CSSProperties}
          onPointerDown={(event) => {
            if (onCycleStackedSelection?.(event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            event.stopPropagation();
          }}
          onClick={(event) => {
            if (event.detail >= 2) {
              return;
            }
            onBeginDimensionEdit(mark);
          }}
        >
          {mark.label}
        </button>
      ))}
      {editingDimension ? (
        <input
          className="dimension-input"
          style={{ "--overlay-x": `${editingDimension.x}px`, "--overlay-y": `${editingDimension.y}px` } as CSSProperties}
          value={editingDimension.value}
          autoFocus
          onPointerDown={(event) => event.stopPropagation()}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onEditingDimensionChange(event.target.value)}
          onBlur={onCommitDimensionEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommitDimensionEdit();
            }
            if (event.key === "Escape") {
              onCancelDimensionEdit();
            }
          }}
        />
      ) : null}
      {editingRotation ? (
        <label className="rotation-edit" style={{ "--overlay-x": `${editingRotation.x}px`, "--overlay-y": `${editingRotation.y}px` } as CSSProperties}>
          <input
            value={editingRotation.value}
            autoFocus
            inputMode="decimal"
            onPointerDown={(event) => event.stopPropagation()}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onEditingRotationChange(event.target.value)}
            onBlur={() => {
              // Commit only if the user typed a new angle; otherwise just close/bake.
              if (editingRotation && editingRotation.value.trim() !== editingRotation.initialValue.trim()) {
                onCommitRotationEdit();
                return;
              }
              onCancelRotationEdit();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                // Blur so commit/cancel runs once through onBlur.
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelRotationEdit();
              }
            }}
          />
          <span>&deg;</span>
        </label>
      ) : null}
      {box.handles.map((handle) => (
        <PeakTipButton
          key={handle.key}
          label={handle.title}
          className={`transform-handle ${handle.className}`}
          style={{ "--overlay-x": `${handle.x}px`, "--overlay-y": `${handle.y}px` } as CSSProperties}
          onPointerEnter={() => onHoverMeasure(handle.kind === "lift" ? null : handleMeasureKey(handle))}
          onPointerLeave={() => onHoverMeasure(null)}
          onPointerDown={(event) => {
            if (handle.kind !== "lift" && onCycleStackedSelection?.(event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onPinMeasure(handleMeasureKey(handle));
            onBeginTransform(handle.kind, handle.key, event);
          }}
          onPointerMove={(event) => onMoveTransform(event.clientX, event.clientY, event.shiftKey, event.altKey)}
          onPointerUp={onFinishTransform}
          onPointerCancel={onFinishTransform}
          onClick={(event) => {
            if (handle.kind === "lift") {
              event.stopPropagation();
              // Double-click is handled separately (drop to workplane).
              if (event.detail >= 2) {
                return;
              }
              onBeginLiftEdit(handle.key, handle.x + 42, handle.y - 32);
            }
          }}
          onDoubleClick={(event) => {
            if (handle.kind !== "lift" || !onDropSelectionToWorkplane) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onCancelDimensionEdit();
            onDropSelectionToWorkplane();
          }}
        />
      ))}
      {box.rotateHandles.map((handle) => {
        const isYaw = handle.className.includes("axis-y");
        return (
        <PeakTipButton
          key={handle.key}
          label={handle.title ?? "Rotate"}
          className={`rotate-handle ${handle.className}${isYaw ? " yaw-arrows" : " tilt-circle"}`}
          style={{
            "--overlay-x": `${handle.x}px`,
            "--overlay-y": `${handle.y}px`,
            // Both handles follow the projected world tangent so icons stay model-parallel (not screen-billboarded).
            "--rotate-handle-angle": `${handle.angle}deg`,
          } as CSSProperties}
          onPointerDown={(event) => {
            if (onCycleStackedSelection?.(event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            onBeginTransform("rotate", handle.key, event);
          }}
          onPointerMove={(event) => onMoveTransform(event.clientX, event.clientY, event.shiftKey, event.altKey)}
          onPointerUp={onFinishTransform}
          onPointerCancel={onFinishTransform}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail >= 2) {
              return;
            }
            onBeginRotationEdit(handle.key, handle.x + 34, handle.y - 28);
          }}
        >
          <span className="rotate-handle-icon" aria-hidden="true">
            {isYaw ? (
              <svg viewBox="0 0 48 28" focusable="false">
                {/*
                  Arc ends feed into bases; heads are rotated to the end tangents
                  (left tip up-left, right tip up-right).
                */}
                <path
                  className="rotate-handle-icon-halo"
                  d="M10 13.5Q24 20 38 13.5"
                  fill="none"
                  strokeLinecap="round"
                />
                <path
                  className="rotate-handle-icon-arc"
                  d="M10 13.5Q24 20 38 13.5"
                  fill="none"
                  strokeLinecap="round"
                />
                <path className="rotate-handle-icon-head" d="M1 9.3 12.7 7.6 7.3 19.4Z" />
                <path className="rotate-handle-icon-head" d="M47 9.3 40.7 19.4 35.3 7.6Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" focusable="false">
                {/* Single continuous rotate-cw glyph (arc + corner tip) — avoids a detached head. */}
                <g className="rotate-handle-icon-halo" fill="none" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                </g>
                <g className="rotate-handle-icon-arc" fill="none" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                </g>
              </svg>
            )}
          </span>
        </PeakTipButton>
        );
      })}
      {!hideDimensionMarks && rotationReadout ? (
        <div
          className={`rotation-readout ${rotationReadout.snapMode ? `snap-${rotationReadout.snapMode}` : ""}`}
          style={{ "--overlay-x": `${rotationReadout.x}px`, "--overlay-y": `${rotationReadout.y}px` } as CSSProperties}
        >
          {rotationReadout.text}
        </div>
      ) : null}
    </div>
  );
}
