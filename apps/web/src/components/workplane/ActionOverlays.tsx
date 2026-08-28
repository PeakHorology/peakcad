"use client";

import type { CSSProperties } from "react";
import { PeakTipButton } from "@/components/workplane/ToolNameTooltip";
import type { AlignAxis, AlignHandleStatus, AlignTarget } from "@/types/sketchforge";

export type AlignOverlayState = {
  guides: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }>;
  handles: Array<AlignHandleStatus & { key: string; x: number; y: number }>;
};

export type MirrorOverlayState = {
  guides: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }>;
  handles: Array<{ axis: AlignAxis; key: string; x: number; y: number; angle: number; title: string }>;
};

export function AlignOverlay({
  overlay,
  onAlign,
  onPreview,
  onPreviewClear,
}: {
  overlay: AlignOverlayState;
  onAlign: (axis: AlignAxis, target: AlignTarget) => void;
  onPreview: (axis: AlignAxis, target: AlignTarget) => void;
  onPreviewClear: () => void;
}) {
  return (
    <div className="align-overlay" aria-label="Alignment handles">
      <svg className="align-guides" width="100%" height="100%" aria-hidden="true">
        {overlay.guides.map((guide) => (
          <line key={guide.key} x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2} />
        ))}
      </svg>
      {overlay.handles.map((handle) => (
        <PeakTipButton
          key={handle.key}
          label={handle.title}
          className={`align-dot axis-${handle.axis} target-${handle.target} ${handle.disabled ? "disabled" : ""} ${handle.aligned ? "aligned" : ""}`}
          style={{ left: handle.x, top: handle.y }}
          disabled={handle.disabled}
          onPointerEnter={() => {
            if (!handle.disabled) {
              onPreview(handle.axis, handle.target);
            }
          }}
          onPointerLeave={onPreviewClear}
          onFocus={() => {
            if (!handle.disabled) {
              onPreview(handle.axis, handle.target);
            }
          }}
          onBlur={onPreviewClear}
          onClick={(event) => {
            event.stopPropagation();
            onPreviewClear();
            onAlign(handle.axis, handle.target);
          }}
        />
      ))}
    </div>
  );
}

export function MirrorOverlay({
  overlay,
  onMirror,
  onPreview,
  onPreviewClear,
}: {
  overlay: MirrorOverlayState;
  onMirror: (axis: AlignAxis) => void;
  onPreview: (axis: AlignAxis) => void;
  onPreviewClear: () => void;
}) {
  return (
    <div className="mirror-overlay" aria-label="Mirror handles">
      <svg className="mirror-guides" width="100%" height="100%" aria-hidden="true">
        {overlay.guides.map((guide) => (
          <line key={guide.key} x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2} />
        ))}
      </svg>
      {overlay.handles.map((handle) => (
        <PeakTipButton
          key={handle.key}
          label={handle.title}
          className={`mirror-handle axis-${handle.axis}`}
          style={{ left: handle.x, top: handle.y, "--mirror-angle": `${handle.angle}deg` } as CSSProperties}
          onPointerEnter={() => onPreview(handle.axis)}
          onPointerLeave={onPreviewClear}
          onFocus={() => onPreview(handle.axis)}
          onBlur={onPreviewClear}
          onClick={(event) => {
            event.stopPropagation();
            onPreviewClear();
            onMirror(handle.axis);
          }}
        >
          <svg className="mirror-handle-icon" viewBox="0 0 64 24" aria-hidden="true">
            <path d="M11 12h42" />
            <path d="m19 4-8 8 8 8" />
            <path d="m45 4 8 8-8 8" />
          </svg>
        </PeakTipButton>
      ))}
    </div>
  );
}

export type CircularPatternOverlayState = {
  cx: number;
  cy: number;
  radiusPx: number;
};

export function CircularPatternOverlay({ overlay }: { overlay: CircularPatternOverlayState }) {
  const size = Math.max(8, overlay.radiusPx * 2);
  return (
    <div className="circular-pattern-overlay" aria-hidden="true">
      <div
        className="circular-pattern-ring"
        style={{
          left: overlay.cx,
          top: overlay.cy,
          width: size,
          height: size,
        }}
      />
      <div className="circular-pattern-center" style={{ left: overlay.cx, top: overlay.cy }} />
    </div>
  );
}
