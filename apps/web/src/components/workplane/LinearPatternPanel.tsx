"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Check, FlipHorizontal2, X } from "lucide-react";
import {
  LINEAR_PATTERN_MAX_COUNT,
  LINEAR_PATTERN_MAX_SPACING,
  LINEAR_PATTERN_MIN_COUNT,
  LINEAR_PATTERN_MIN_SPACING,
  clampLinearPatternCount,
  clampLinearPatternSpacing,
  linearPatternInstanceCount,
} from "@/lib/linearPattern";
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

function CountControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (count: number) => void;
}) {
  const actualValue = clampLinearPatternCount(value);
  const sliderValue = clamp(actualValue, LINEAR_PATTERN_MIN_COUNT, LINEAR_PATTERN_MAX_COUNT);
  const position = ((sliderValue - LINEAR_PATTERN_MIN_COUNT) / Math.max(1, LINEAR_PATTERN_MAX_COUNT - LINEAR_PATTERN_MIN_COUNT)) * 100;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(actualValue));

  useEffect(() => {
    if (!editing) setDraft(String(actualValue));
  }, [actualValue, editing]);

  return (
    <label className="edge-modifier-field edge-modifier-slider range-property" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span className="range-property-header">
        <span className="range-property-name">{label}</span>
        <span className="range-value-control">
          <input
            type="number"
            min={LINEAR_PATTERN_MIN_COUNT}
            max={LINEAR_PATTERN_MAX_COUNT}
            step={1}
            value={editing ? draft : String(actualValue)}
            inputMode="numeric"
            onFocus={() => {
              setDraft(String(actualValue));
              setEditing(true);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => {
              onChange(clampLinearPatternCount(Number(draft)));
              setEditing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </span>
      </span>
      <div className="range-control">
        <input
          type="range"
          min={LINEAR_PATTERN_MIN_COUNT}
          max={LINEAR_PATTERN_MAX_COUNT}
          step={1}
          value={sliderValue}
          onChange={(event) => onChange(clampLinearPatternCount(Number(event.currentTarget.value)))}
        />
      </div>
    </label>
  );
}

function SpacingControl({
  label,
  value,
  workspace,
  onChange,
}: {
  label: string;
  value: number;
  workspace: WorkplaneWorkspaceSettings;
  onChange: (spacingMm: number) => void;
}) {
  const actualValue = clampLinearPatternSpacing(value);
  const controlValue = millimetersToDisplay(actualValue, workspace);
  const controlMin = millimetersToDisplay(-LINEAR_PATTERN_MAX_SPACING, workspace);
  const controlMax = millimetersToDisplay(LINEAR_PATTERN_MAX_SPACING, workspace);
  const controlStep = displayStepFromMillimeters(0.1, workspace);
  const sliderValue = clamp(controlValue, controlMin, controlMax);
  const position = ((sliderValue - controlMin) / Math.max(Number.EPSILON, controlMax - controlMin)) * 100;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatControlValue(controlValue, workspace.accuracy, controlStep));
  const unitLabel = lengthDisplayUnit(workspace).label;

  useEffect(() => {
    if (!editing) setDraft(formatControlValue(controlValue, workspace.accuracy, controlStep));
  }, [controlStep, controlValue, editing, workspace.accuracy]);

  return (
    <label className="edge-modifier-field edge-modifier-slider range-property" style={{ "--slider-pos": `${position}%` } as CSSProperties}>
      <span className="range-property-header">
        <span className="range-property-name">{label}</span>
        <span className="range-value-control">
          <input
            type="number"
            min={controlMin}
            max={controlMax}
            step={controlStep}
            value={editing ? draft : formatControlValue(controlValue, workspace.accuracy, controlStep)}
            inputMode="decimal"
            onFocus={() => {
              setDraft(formatControlValue(controlValue, workspace.accuracy, controlStep));
              setEditing(true);
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => {
              const next = Number(draft);
              onChange(clampLinearPatternSpacing(displayToMillimeters(Number.isFinite(next) ? next : controlValue, workspace)));
              setEditing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          <span className="range-value-unit">{unitLabel}</span>
          <button
            type="button"
            className="icon-button"
            aria-label={`Reverse ${label}`}
            title="Reverse direction"
            onClick={() => onChange(actualValue === 0 ? -LINEAR_PATTERN_MIN_SPACING : -actualValue)}
          >
            <FlipHorizontal2 size={14} />
          </button>
        </span>
      </span>
      <div className="range-control">
        <input
          type="range"
          min={controlMin}
          max={controlMax}
          step={controlStep}
          value={sliderValue}
          onChange={(event) => onChange(clampLinearPatternSpacing(displayToMillimeters(Number(event.currentTarget.value), workspace)))}
        />
      </div>
    </label>
  );
}

export function LinearPatternPanel({
  sourceCount,
  countX,
  countZ,
  countY,
  spacingX,
  spacingZ,
  spacingY,
  canApply,
  workspace,
  onCountXChange,
  onCountZChange,
  onCountYChange,
  onSpacingXChange,
  onSpacingZChange,
  onSpacingYChange,
  onApply,
  onCancel,
  positionClampWarning = false,
  applyLabel = "Apply",
  editing = false,
}: {
  sourceCount: number;
  countX: number;
  countZ: number;
  countY: number;
  spacingX: number;
  spacingZ: number;
  spacingY: number;
  canApply: boolean;
  workspace: WorkplaneWorkspaceSettings;
  onCountXChange: (count: number) => void;
  onCountZChange: (count: number) => void;
  onCountYChange: (count: number) => void;
  onSpacingXChange: (spacingMm: number) => void;
  onSpacingZChange: (spacingMm: number) => void;
  onSpacingYChange: (spacingMm: number) => void;
  onApply: () => void;
  onCancel: () => void;
  positionClampWarning?: boolean;
  applyLabel?: string;
  editing?: boolean;
}) {
  const total = linearPatternInstanceCount({ countX, countZ, countY });

  return (
    <aside className="edge-modifier-panel circular-pattern-panel" aria-label="Linear pattern">
      <div className="edge-modifier-header">
        <div>
          <strong>{editing ? "Edit linear pattern" : "Linear pattern"}</strong>
          <p>{sourceCount} source{sourceCount === 1 ? "" : "s"} · {total} total</p>
        </div>
        <button type="button" className="icon-button" aria-label="Cancel linear pattern" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>

      <CountControl label="Count · Width" value={countX} onChange={onCountXChange} />
      <SpacingControl label="Spacing · Width" value={spacingX} workspace={workspace} onChange={onSpacingXChange} />
      <CountControl label="Count · Length" value={countZ} onChange={onCountZChange} />
      <SpacingControl label="Spacing · Length" value={spacingZ} workspace={workspace} onChange={onSpacingZChange} />
      <CountControl label="Count · Height" value={countY} onChange={onCountYChange} />
      <SpacingControl label="Spacing · Height" value={spacingY} workspace={workspace} onChange={onSpacingYChange} />

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
