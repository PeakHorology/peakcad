"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { X } from "lucide-react";

export type InlineValueField = {
  key: string;
  label: string;
  value: string;
  /** Hint under the field, e.g. "mm". */
  unit?: string;
  min?: number;
  step?: string;
  inputMode?: "decimal" | "numeric" | "text";
};

type InlineValueDialogProps = {
  title: string;
  fields: InlineValueField[];
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (values: Record<string, string>) => void;
  /** Optional footer note. */
  note?: ReactNode;
};

/** Peak-styled replacement for window.prompt — keeps focus in the editor. */
export function InlineValueDialog({
  title,
  fields,
  confirmLabel = "Apply",
  onCancel,
  onConfirm,
  note,
}: InlineValueDialogProps) {
  const titleId = useId();
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.value])),
  );

  useEffect(() => {
    setDrafts(Object.fromEntries(fields.map((field) => [field.key, field.value])));
  }, [fields]);

  useEffect(() => {
    firstInputRef.current?.focus();
    firstInputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConfirm(drafts);
  };

  return (
    <div className="inline-value-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="inline-value-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <header className="inline-value-dialog-header">
          <strong id={titleId}>{title}</strong>
          <button type="button" className="inline-value-dialog-close" aria-label="Cancel" onClick={onCancel}>
            <X size={16} strokeWidth={2.5} />
          </button>
        </header>
        <div className="inline-value-dialog-body">
          {fields.map((field, index) => (
            <label key={field.key} className="inline-value-dialog-field">
              <span>{field.label}</span>
              <span className="inline-value-dialog-input-wrap">
                <input
                  ref={index === 0 ? firstInputRef : undefined}
                  value={drafts[field.key] ?? ""}
                  inputMode={field.inputMode ?? "decimal"}
                  min={field.min}
                  step={field.step ?? "any"}
                  onChange={(event) => setDrafts((current) => ({ ...current, [field.key]: event.target.value }))}
                />
                {field.unit ? <small>{field.unit}</small> : null}
              </span>
            </label>
          ))}
          {note ? <p className="inline-value-dialog-note">{note}</p> : null}
        </div>
        <footer className="inline-value-dialog-footer">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
