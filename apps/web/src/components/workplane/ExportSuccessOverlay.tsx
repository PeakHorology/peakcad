"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Check } from "lucide-react";

export type ExportSuccessPayload = {
  id: number;
  format: string;
  detail?: string;
};

export function ExportSuccessOverlay({
  event,
}: {
  event: ExportSuccessPayload | null;
}) {
  const [visible, setVisible] = useState(false);
  const [payload, setPayload] = useState<ExportSuccessPayload | null>(null);

  useEffect(() => {
    if (!event) return;
    setPayload(event);
    setVisible(true);
    const hide = window.setTimeout(() => setVisible(false), 1600);
    const clear = window.setTimeout(() => setPayload(null), 1900);
    return () => {
      window.clearTimeout(hide);
      window.clearTimeout(clear);
    };
  }, [event]);

  if (!payload) return null;

  return (
    <div
      className={`export-success-overlay${visible ? " is-visible" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={`${payload.format} exported`}
    >
      <div className="export-success-card" key={payload.id}>
        <span className="export-success-ring" aria-hidden="true" />
        <span className="export-success-burst" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => (
            <i key={index} style={{ "--i": index } as CSSProperties} />
          ))}
        </span>
        <span className="export-success-check" aria-hidden="true">
          <Check size={28} strokeWidth={2.75} />
        </span>
        <div className="export-success-copy">
          <strong>Exported</strong>
          <span>{payload.format}{payload.detail ? ` · ${payload.detail}` : ""}</span>
        </div>
      </div>
    </div>
  );
}
