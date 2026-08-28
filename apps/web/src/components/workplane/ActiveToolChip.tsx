"use client";

/** Floating chip that shows the active tool and how to exit it. */
export function ActiveToolChip({
  label,
  hint = "Esc to cancel",
  visible,
}: {
  label: string;
  hint?: string;
  visible: boolean;
}) {
  if (!visible || !label) {
    return null;
  }

  return (
    <div className="active-tool-chip" role="status" aria-live="polite">
      <strong>{label}</strong>
      {hint ? <span>{hint}</span> : null}
    </div>
  );
}
