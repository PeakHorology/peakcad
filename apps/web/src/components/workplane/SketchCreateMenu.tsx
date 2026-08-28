"use client";

const sketchCreateIcons = {
  newSketch: "sketch-tool-sketch-to-3d.png",
  editSketch: "sketch-tool-edit-sketch-to-3d.png",
} as const;

function SketchCreateIcon({ name }: { name: keyof typeof sketchCreateIcons }) {
  return (
    <img
      className="sketch-create-menu-icon"
      src={`/assets/sketchforge/${sketchCreateIcons[name]}`}
      alt=""
      draggable={false}
    />
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
        <SketchCreateIcon name="newSketch" />
        <span>New sketch</span>
      </button>
      <button
        className={`sketch-create-menu-item ${canEditSketch ? "" : "disabled"}`}
        type="button"
        role="menuitem"
        onClick={onEditSketch}
        disabled={!canEditSketch}
      >
        <SketchCreateIcon name="editSketch" />
        <span>Edit sketch</span>
      </button>
    </div>
  );
}
