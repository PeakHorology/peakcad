"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  displayStepFromMillimeters,
  displayToMillimeters,
  formatMeasurementNumber,
  lengthDisplayUnit,
  millimetersToDisplay,
} from "@/lib/measurementUnits";
import type { PlacementOffsets } from "@/lib/placementRuler";
import type { WorkplaneWorkspaceSettings } from "@/types/sketchforge";

function OffsetField({
  axis,
  value,
  workspace,
  autoFocus,
  onCommit,
}: {
  axis: keyof PlacementOffsets;
  value: number;
  workspace: WorkplaneWorkspaceSettings;
  autoFocus?: boolean;
  onCommit: (axis: keyof PlacementOffsets, millimeters: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const controlValue = millimetersToDisplay(value, workspace);
  const step = displayStepFromMillimeters(0.1, workspace);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatMeasurementNumber(controlValue, workspace.accuracy, step));

  useEffect(() => {
    if (!editing) {
      setDraft(formatMeasurementNumber(controlValue, workspace.accuracy, step));
    }
  }, [controlValue, editing, step, workspace.accuracy]);

  useEffect(() => {
    if (!autoFocus) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [autoFocus]);

  return (
    <label className="placement-ruler-field">
      <span>{axis.toUpperCase()}</span>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={editing ? draft : formatMeasurementNumber(controlValue, workspace.accuracy, step)}
        aria-label={`${axis.toUpperCase()} offset`}
        onFocus={() => {
          setDraft(formatMeasurementNumber(controlValue, workspace.accuracy, step));
          setEditing(true);
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          const next = Number(draft);
          onCommit(axis, displayToMillimeters(Number.isFinite(next) ? next : controlValue, workspace));
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <em>{lengthDisplayUnit(workspace).label}</em>
    </label>
  );
}

export function PlacementRulerPanel({
  offsets,
  workspace,
  autoFocusFirst = false,
  onOffsetChange,
  onCancel,
}: {
  offsets: PlacementOffsets | null;
  workspace: WorkplaneWorkspaceSettings;
  autoFocusFirst?: boolean;
  onOffsetChange: (axis: keyof PlacementOffsets, millimeters: number) => void;
  onCancel: () => void;
}) {
  const visibleOffsets = offsets ?? { x: 0, y: 0, z: 0 };

  return (
    <aside className="placement-ruler-panel" aria-label="Placement ruler">
      <div className="placement-ruler-header">
        <div>
          <strong>Placement ruler</strong>
          <p>Type how far to move this object. X/Y are on the workplane, Z is up.</p>
        </div>
        <button type="button" className="icon-button" aria-label="Close placement ruler" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>
      <div className="placement-ruler-fields">
        <OffsetField axis="x" value={visibleOffsets.x} workspace={workspace} autoFocus={autoFocusFirst} onCommit={onOffsetChange} />
        <OffsetField axis="y" value={visibleOffsets.y} workspace={workspace} onCommit={onOffsetChange} />
        <OffsetField axis="z" value={visibleOffsets.z} workspace={workspace} onCommit={onOffsetChange} />
      </div>
    </aside>
  );
}
