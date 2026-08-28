"use client";

import { useEffect, useRef, useState } from "react";
import { displayToMillimeters, formatMeasurementNumber, lengthDisplayUnit, millimetersToDisplay } from "@/lib/measurementUnits";
import type { WorkplaneWorkspaceSettings } from "@/types/sketchforge";

const MIN_WORKSPACE_SIZE_MM = 60;
const MAX_WORKSPACE_SIZE_MM = 2000;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function displayDraft(valueMm: number, workspace: WorkplaneWorkspaceSettings) {
  return formatMeasurementNumber(millimetersToDisplay(valueMm, workspace), workspace.accuracy);
}

export function WorkplaneDimensionsControl({
  workspace,
  onChange,
}: {
  workspace: WorkplaneWorkspaceSettings;
  onChange: (next: WorkplaneWorkspaceSettings) => void;
}) {
  const unit = lengthDisplayUnit(workspace).label;
  const focusedKeyRef = useRef<"width" | "depth" | null>(null);
  const [drafts, setDrafts] = useState(() => ({
    width: displayDraft(workspace.width, workspace),
    depth: displayDraft(workspace.depth, workspace),
  }));

  useEffect(() => {
    if (focusedKeyRef.current) {
      return;
    }
    setDrafts({
      width: displayDraft(workspace.width, workspace),
      depth: displayDraft(workspace.depth, workspace),
    });
  }, [workspace.accuracy, workspace.depth, workspace.scale, workspace.units, workspace.width]);

  const commit = (key: "width" | "depth", raw: string) => {
    const parsed = Number.parseFloat(raw.trim());
    const fallbackDisplay = millimetersToDisplay(workspace[key], workspace);
    const nextDisplay = clamp(
      Number.isFinite(parsed) ? parsed : fallbackDisplay,
      millimetersToDisplay(MIN_WORKSPACE_SIZE_MM, workspace),
      millimetersToDisplay(MAX_WORKSPACE_SIZE_MM, workspace),
    );
    const nextMm = clamp(displayToMillimeters(nextDisplay, workspace), MIN_WORKSPACE_SIZE_MM, MAX_WORKSPACE_SIZE_MM);
    const nextDraft = formatMeasurementNumber(millimetersToDisplay(nextMm, workspace), workspace.accuracy);
    setDrafts((current) => ({ ...current, [key]: nextDraft }));
    if (Math.abs(nextMm - workspace[key]) < 1e-6) {
      return;
    }
    onChange({
      ...workspace,
      [key]: nextMm,
      sizePreset: "Custom",
    });
  };

  return (
    <div
      className="workplane-dimensions-control"
      aria-label="Workplane dimensions"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <label className="workplane-dimensions-field">
        <span>W</span>
        <input
          type="text"
          inputMode="decimal"
          value={drafts.width}
          aria-label={`Workplane width (${unit})`}
          onFocus={() => {
            focusedKeyRef.current = "width";
          }}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDrafts((current) => ({ ...current, width: value }));
          }}
          onBlur={(event) => {
            focusedKeyRef.current = null;
            commit("width", event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      <span className="workplane-dimensions-sep" aria-hidden="true">×</span>
      <label className="workplane-dimensions-field">
        <span>L</span>
        <input
          type="text"
          inputMode="decimal"
          value={drafts.depth}
          aria-label={`Workplane length (${unit})`}
          onFocus={() => {
            focusedKeyRef.current = "depth";
          }}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setDrafts((current) => ({ ...current, depth: value }));
          }}
          onBlur={(event) => {
            focusedKeyRef.current = null;
            commit("depth", event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      <span className="workplane-dimensions-unit">{unit}</span>
    </div>
  );
}
