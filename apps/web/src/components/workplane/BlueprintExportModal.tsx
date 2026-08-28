"use client";

import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { PeakTipButton } from "@/components/workplane/ToolNameTooltip";
import {
  BLUEPRINT_FORMAT_OPTIONS,
  loadBlueprintFormats,
  saveBlueprintFormats,
  type BlueprintExportFormat,
} from "@/lib/blueprintExport";

function toggleFormat(current: BlueprintExportFormat[], id: BlueprintExportFormat) {
  return current.includes(id) ? current.filter((format) => format !== id) : [...current, id];
}

export function BlueprintExportModal({
  exporting = false,
  onExport,
  onClose,
}: {
  exporting?: boolean;
  onExport: (formats: BlueprintExportFormat[]) => void;
  onClose: () => void;
}) {
  const [formats, setFormats] = useState<BlueprintExportFormat[]>(() => loadBlueprintFormats());
  const canExport = formats.length > 0 && !exporting;
  const summary = useMemo(
    () => formats.map((id) => BLUEPRINT_FORMAT_OPTIONS.find((option) => option.id === id)?.label ?? id).join(" + "),
    [formats],
  );

  return (
    <div className="workspace-modal blueprint-export-modal" role="dialog" aria-modal="true" aria-label="Export 2D blueprint">
      <div className="workspace-modal-card blueprint-export-card" onPointerDown={(event) => event.stopPropagation()}>
        <header className="workspace-modal-header">
          <strong>Export 2D blueprint</strong>
          <PeakTipButton label="Close" onClick={onClose}>
            <X size={20} strokeWidth={2.5} />
          </PeakTipButton>
        </header>

        <div className="blueprint-export-body">
          <p className="blueprint-export-lead">
            Choose one or more formats. The same third-angle drawing is written to each file.
          </p>

          <div className="blueprint-export-formats" role="group" aria-label="Blueprint formats">
            {BLUEPRINT_FORMAT_OPTIONS.map((option) => {
              const checked = formats.includes(option.id);
              return (
                <label key={option.id} className={`blueprint-export-format${checked ? " selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={exporting}
                    onChange={() => setFormats((current) => toggleFormat(current, option.id))}
                  />
                  <span className="blueprint-export-format-copy">
                    <strong>{option.label}</strong>
                    <span>{option.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="blueprint-export-footer">
          <button type="button" className="blueprint-export-cancel" disabled={exporting} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="blueprint-export-confirm"
            disabled={!canExport}
            onClick={() => {
              saveBlueprintFormats(formats);
              onExport(formats);
            }}
          >
            {exporting ? "Exporting…" : summary ? `Export ${summary}` : "Select a format"}
          </button>
        </div>
      </div>
      <button className="workspace-modal-backdrop" aria-label="Close blueprint export" type="button" onClick={onClose} />
    </div>
  );
}
