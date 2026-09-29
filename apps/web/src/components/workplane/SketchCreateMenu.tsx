"use client";

function SketchCreateIcon({ kind }: { kind: "new" | "edit" }) {
  return (
    <svg className="sketch-create-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "new" ? (
        <>
          <path d="M4 16.5 12 20l8-3.5-8-3.5Z" />
          <path d="M12 12.5V6" />
          <path d="m12 6-2 2M12 6l2 2" />
        </>
      ) : (
        <>
          <path d="M4 16.5 12 20l8-3.5-8-3.5Z" />
          <path d="M14.5 5.5 18 9l-7 7H7.5v-3.5l7-7Z" />
        </>
      )}
    </svg>
  );
}

/** Floating menu under the Sketch mode tab when not actively sketching. */
export function SketchCreateMenu({
  canEditSketch,
  onNewSketch,
  onEditSketch,
}: {
  canEditSketch: boolean;
  onNewSketch: () => void;
  onEditSketch: () => void;
}) {
  return (
    <div className="sketch-create-menu" role="menu" aria-label="Sketch options">
      <button className="sketch-create-menu-item primary" type="button" role="menuitem" onClick={onNewSketch}>
        <SketchCreateIcon kind="new" />
        <span>New sketch</span>
      </button>
      <button
        className={`sketch-create-menu-item ${canEditSketch ? "" : "disabled"}`}
        type="button"
        role="menuitem"
        onClick={onEditSketch}
        disabled={!canEditSketch}
      >
        <SketchCreateIcon kind="edit" />
        <span>Edit sketch</span>
      </button>
    </div>
  );
}
