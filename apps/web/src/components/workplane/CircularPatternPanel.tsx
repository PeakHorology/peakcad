"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Check, X } from "lucide-react";
import {
  CIRCULAR_PATTERN_MAX_COUNT,
  CIRCULAR_PATTERN_MAX_RADIUS,
  CIRCULAR_PATTERN_MIN_COUNT,
  CIRCULAR_PATTERN_MIN_RADIUS,
  CIRCULAR_PATTERN_RADIUS_STEP,
  CIRCULAR_PATTERN_ROTATION_STEPS,
  clampCircularPatternCount,
  clampCircularPatternRadius,
  clampCircularPatternRotation,
  type CircularPatternRotationStep,
} from "@/lib/circularPattern";
import {
  displayStepFromMillimeters,
  displayToMillimeters,
  formatMeasurementNumber,
  lengthDisplayUnit,
  millimetersToDisplay,
} from "@/lib/measurementUnits";
import type { WorkplaneWorkspaceSettings } from "@/types/sketchforge";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatControlValue(value: number, accuracy: WorkplaneWorkspaceSettings["accuracy"], step: number) {
  if (step >= 1) return String(Math.round(value));
  return formatMeasurementNumber(value, accuracy, step);
}

function RadiusControl({
  value,
  workspace,
  disabled,
  onChange,
}: {
  value: number;
  workspace: WorkplaneWorkspaceSettings;
  disabled?: boolean;
  onChange: (radiusMm: number) => void;
}) {
  const safeMin = CIRCULAR_PATTERN_MIN_RADIUS;
  const safeMax = CIRCULAR_PATTERN_MAX_RADIUS;
  const actualValue = clampCircularPatternRadius(value);
  const controlValue = millimetersToDisplay(actualValue, workspace);
  const controlMin = millimetersToDisplay(safeMin, workspace);
  const controlMax = millimetersToDisplay(safeMax, workspace);
  const controlStep = displayStepFromMillimeters(CIRCULAR_PATTERN_RADIUS_STEP, workspace);
  const sliderValue = clamp(controlValue, controlMin, controlMax);
  const position = ((sliderValue - controlMin) / Math.max(Number.EPSILON, controlMax - controlMin)) * 100;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatControlValue(controlValue, workspace.accuracy, controlStep));
  const unitLabel = lengthDisplayUnit(workspace).label;

  useEffect(() => {
    if (!editing) {
      setDraft(formatControlValue(controlValue, workspace.accuracy, controlStep));
    }
  }, [controlStep, controlValue, editing, workspace.accuracy]);

  const commitDraft = () => {
    const next = Number(draft);
    const finiteNext = Number.isFinite(next) ? next : controlValue;
    onChange(clamp(displayToMillimeters(finiteNext, workspace), safeMin, safeMax));
    setEditing(false);
  };

  return (
    <label className="edge-modifier-field edge-modifier-slider range-property" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span className="range-property-header">
        <span className="range-property-name">Radius</span>
        <span className="range-value-control">
          <input
            type="number"
            min={controlMin}
            max={controlMax}
            step={controlStep}
            value={editing ? draft : formatControlValue(controlValue, workspace.accuracy, controlStep)}
            inputMode="decimal"
            disabled={disabled}
            onFocus={() => {
              setDraft(formatControlValue(controlValue, workspace.accuracy, controlStep));
              setEditing(true);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(formatControlValue(controlValue, workspace.accuracy, controlStep));
                setEditing(false);
                event.currentTarget.blur();
              }
            }}
          />
          <span className="range-value-unit">{unitLabel}</span>
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
          onChange={(event) => {
            const next = clamp(Number(event.currentTarget.value), controlMin, controlMax);
            onChange(clamp(displayToMillimeters(next, workspace), safeMin, safeMax));
            setDraft(formatControlValue(next, workspace.accuracy, controlStep));
          }}
        />
      </div>
    </label>
  );
}

function CountControl({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (count: number) => void;
}) {
  const safeMin = CIRCULAR_PATTERN_MIN_COUNT;
  const safeMax = CIRCULAR_PATTERN_MAX_COUNT;
  const actualValue = clampCircularPatternCount(value);
  const sliderValue = clamp(actualValue, safeMin, safeMax);
  const position = ((sliderValue - safeMin) / Math.max(1, safeMax - safeMin)) * 100;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(actualValue));

  useEffect(() => {
    if (!editing) {
      setDraft(String(actualValue));
    }
  }, [actualValue, editing]);

  const commitDraft = () => {
    const next = Number(draft);
    onChange(clampCircularPatternCount(Number.isFinite(next) ? next : actualValue));
    setEditing(false);
  };

  return (
    <label className="edge-modifier-field edge-modifier-slider range-property" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span className="range-property-header">
        <span className="range-property-name">Count</span>
        <span className="range-value-control">
          <input
            type="number"
            min={safeMin}
            max={safeMax}
            step={1}
            value={editing ? draft : String(actualValue)}
            inputMode="numeric"
            disabled={disabled}
            onFocus={() => {
              setDraft(String(actualValue));
              setEditing(true);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(String(actualValue));
                setEditing(false);
                event.currentTarget.blur();
              }
            }}
          />
        </span>
      </span>
      <div className="range-control">
        <input
          type="range"
          min={safeMin}
          max={safeMax}
          step={1}
          value={sliderValue}
          disabled={disabled}
          onChange={(event) => {
            const next = clampCircularPatternCount(Number(event.currentTarget.value));
            onChange(next);
            setDraft(String(next));
          }}
        />
      </div>
    </label>
  );
}

function RotationControl({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (degrees: CircularPatternRotationStep) => void;
}) {
  const actualValue = clampCircularPatternRotation(value);
  const stepIndex = Math.max(0, CIRCULAR_PATTERN_ROTATION_STEPS.indexOf(actualValue));
  const position = (stepIndex / Math.max(1, CIRCULAR_PATTERN_ROTATION_STEPS.length - 1)) * 100;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(actualValue));

  useEffect(() => {
    if (!editing) {
      setDraft(String(actualValue));
    }
  }, [actualValue, editing]);

  const commitDraft = () => {
    const next = Number(draft);
    onChange(clampCircularPatternRotation(Number.isFinite(next) ? next : actualValue));
    setEditing(false);
  };

  return (
    <label className="edge-modifier-field edge-modifier-slider range-property" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span className="range-property-header">
        <span className="range-property-name">Rotation</span>
        <span className="range-value-control">
          <input
            type="number"
            min={0}
            max={270}
            step={90}
            value={editing ? draft : String(actualValue)}
            inputMode="numeric"
            disabled={disabled}
            onFocus={() => {
              setDraft(String(actualValue));
              setEditing(true);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(String(actualValue));
                setEditing(false);
                event.currentTarget.blur();
              }
            }}
          />
          <span className="range-value-unit">°</span>
        </span>
      </span>
      <div className="range-control">
        <input
          type="range"
          min={0}
          max={270}
          step={90}
          value={actualValue}
          disabled={disabled}
          list="circular-pattern-rotation-steps"
          onChange={(event) => {
            const next = clampCircularPatternRotation(Number(event.currentTarget.value));
            onChange(next);
            setDraft(String(next));
          }}
        />
        <datalist id="circular-pattern-rotation-steps">
          {CIRCULAR_PATTERN_ROTATION_STEPS.map((step) => (
            <option key={step} value={step} />
          ))}
        </datalist>
      </div>
    </label>
  );
}

export function CircularPatternPanel({
  sourceCount,
  pivotName,
  count,
  radiusMm,
  rotationDeg,
  hasPivot,
  canApply,
  workspace,
  onCountChange,
  onRadiusChange,
  onRotationChange,
  onApply,
  onCancel,
  positionClampWarning = false,
  applyLabel = "Apply",
  editing = false,
}: {
  sourceCount: number;
  pivotName: string | null;
  count: number;
  radiusMm: number;
  rotationDeg: number;
  hasPivot: boolean;
  canApply: boolean;
  workspace: WorkplaneWorkspaceSettings;
  onCountChange: (count: number) => void;
  onRadiusChange: (radiusMm: number) => void;
  onRotationChange: (degrees: CircularPatternRotationStep) => void;
  onApply: () => void;
  onCancel: () => void;
  /** True when one or more instances clamp to the ±110 mm workplane bounds. */
  positionClampWarning?: boolean;
  applyLabel?: string;
  editing?: boolean;
}) {
  const [hintOpen, setHintOpen] = useState(false);

  return (
    <aside
      className="edge-modifier-panel circular-pattern-panel"
      aria-label="Circular pattern"
      onContextMenu={(event) => {
        event.preventDefault();
        setHintOpen((open) => !open);
      }}
    >
      <div className="edge-modifier-header">
        <div>
          <strong>{editing ? "Edit circular pattern" : "Circular pattern"}</strong>
          <p>
            {hasPivot
              ? `Orbit around ${pivotName ?? "pivot"} · ${count} total`
              : "Click a shape to orbit around"}
          </p>
        </div>
        <button type="button" className="icon-button" aria-label="Cancel circular pattern" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>

      <div className="edge-modifier-meta">
        <span>{sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
        <span>{hasPivot ? `Pivot: ${pivotName}` : "No pivot"}</span>
      </div>

      <RadiusControl
        value={radiusMm}
        workspace={workspace}
        disabled={!hasPivot}
        onChange={onRadiusChange}
      />

      <CountControl
        value={count}
        disabled={!hasPivot}
        onChange={onCountChange}
      />

      <RotationControl
        value={rotationDeg}
        disabled={!hasPivot}
        onChange={onRotationChange}
      />

      {hintOpen ? (
        <p className="edge-modifier-hint">
          Pick a pivot shape — the pattern centers on it and starts at its radius. Drag the sliders (or type values) to adjust. Rotation snaps to 0°, 90°, 180°, or 270°. Copies sit on the pivot’s top, face the center, and count includes the original.
        </p>
      ) : null}

      {positionClampWarning ? (
        <p className="edge-modifier-hint" role="status">
          Some instances hit the ±110 mm workplane limit and will be clamped.
        </p>
      ) : null}

      <div className="edge-modifier-footer">
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={!canApply} onClick={onApply}>
          <Check size={17} />
          {applyLabel}
        </button>
      </div>
    </aside>
  );
}
