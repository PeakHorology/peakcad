"use client";

import { CONSTRAINT_LABELS, type SketchDefinitionStatus, type SketchDoc } from "@/lib/sketch";

const STATUS_LABEL: Record<SketchDefinitionStatus, string> = {
  empty: "Empty",
  "under-defined": "Under-defined",
  "fully-defined": "Fully defined",
  "over-constrained": "Over-constrained",
  unsolved: "Not solved",
};

export function SketchPalette({
  doc,
  status,
  dof,
  conflicts,
  focusMode,
  selectedProfileCount,
  onToggleFocusMode,
  onPatchSettings,
  onRemoveConstraint,
  onToggleConstructionMode,
}: {
  doc: SketchDoc;
  status: SketchDefinitionStatus;
  dof: number;
  conflicts: string[];
  focusMode: "3d" | "2d";
  selectedProfileCount: number;
  onToggleFocusMode: () => void;
  onPatchSettings: (patch: Partial<SketchDoc["settings"]>) => void;
  onRemoveConstraint: (constraintId: string) => void;
  onToggleConstructionMode: () => void;
}) {
  return (
    <aside className="sketch-palette" aria-label="Sketch palette">
      <header className="sketch-palette-header">
        <strong>Sketch</strong>
        <span className={`sketch-palette-status status-${status}`}>{STATUS_LABEL[status]}</span>
      </header>
      <div className="sketch-palette-meta">
        <span>DOF {dof}</span>
        <span>{selectedProfileCount} profile{selectedProfileCount === 1 ? "" : "s"} selected</span>
      </div>
      {conflicts.length ? (
        <ul className="sketch-palette-conflicts">
          {conflicts.map((conflict) => {
            const constraint = doc.constraints.find((entry) => entry.id === conflict);
            const label = constraint
              ? `${CONSTRAINT_LABELS[constraint.kind]} conflict`
              : conflict;
            return <li key={conflict}>{label}</li>;
          })}
        </ul>
      ) : null}
      <div className="sketch-palette-toggles">
        <label>
          <input
            type="checkbox"
            checked={doc.settings.showConstraints}
            onChange={(event) => onPatchSettings({ showConstraints: event.target.checked })}
          />
          Constraints
        </label>
        <label>
          <input
            type="checkbox"
            checked={doc.settings.showDimensions}
            onChange={(event) => onPatchSettings({ showDimensions: event.target.checked })}
          />
          Dimensions
        </label>
        <label>
          <input
            type="checkbox"
            checked={doc.settings.showConstruction}
            onChange={(event) => onPatchSettings({ showConstruction: event.target.checked })}
          />
          Construction
        </label>
        <label>
          <input
            type="checkbox"
            checked={doc.settings.constructionMode}
            onChange={onToggleConstructionMode}
          />
          Draw as construction
        </label>
      </div>
      <div className="sketch-palette-actions">
        <button type="button" onClick={onToggleFocusMode}>
          {focusMode === "2d" ? "Sketch in 3D view" : "Focus 2D"}
        </button>
      </div>
      {doc.settings.showConstraints && doc.constraints.length > 0 ? (
        <section className="sketch-palette-list" aria-label="Constraints">
          <div className="sketch-palette-list-title">Constraints</div>
          <ul>
            {doc.constraints.map((constraint) => (
              <li key={constraint.id} className={constraint.suppressed ? "suppressed" : ""}>
                <span>{CONSTRAINT_LABELS[constraint.kind]}</span>
                <button type="button" onClick={() => onRemoveConstraint(constraint.id)} aria-label="Remove constraint">
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {doc.settings.showDimensions && doc.dimensions.length > 0 ? (
        <section className="sketch-palette-list" aria-label="Dimensions">
          <div className="sketch-palette-list-title">Dimensions</div>
          <ul>
            {doc.dimensions.map((dimension) => (
              <li key={dimension.id}>
                <span>
                  {dimension.kind} {dimension.value.toFixed(2)}
                  {dimension.driving ? "" : " (driven)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}
