import type { CSSProperties, ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
type SpriteRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const vectorToolbarSprite = "assets/sketchforge/vector-toolbar-icons.svg?v=1";

function VectorToolbarSpriteIcon({ rect, className, style }: IconProps & { rect: SpriteRect }) {
  const size = 35;
  const scale = size / rect.height;

  return (
    <span
      aria-hidden="true"
      className={["vector-toolbar-sprite-icon", className].filter(Boolean).join(" ")}
      style={
        {
          "--vector-sprite-x": `${-rect.x * scale}px`,
          "--vector-sprite-y": `${-rect.y * scale}px`,
          "--vector-sprite-width": `${165 * scale}px`,
          "--vector-sprite-height": `${27 * scale}px`,
          width: `${rect.width * scale}px`,
          height: `${size}px`,
          backgroundImage: `url(${vectorToolbarSprite})`,
          ...(style as CSSProperties),
        } as CSSProperties
      }
    />
  );
}

/** Shared 24px stroke language for command-bar and shape-rail icons. */
function CadGlyph({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function ToolbarHomeIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6.5 10.5V20h11V10.5" />
      <path d="M10 20v-5h4v5" />
    </CadGlyph>
  );
}

export function ToolbarCopyIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="8" y="8" width="12" height="12" rx="1.6" />
      <path d="M16 8V5.6A1.6 1.6 0 0 0 14.4 4H5.6A1.6 1.6 0 0 0 4 5.6v8.8A1.6 1.6 0 0 0 5.6 16H8" />
    </CadGlyph>
  );
}

export function ToolbarPasteIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="8" y="3" width="8" height="3.2" rx="1" />
      <path d="M8 5H6.2A1.8 1.8 0 0 0 4.4 6.8v12.4A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.8-1.8V6.8A1.8 1.8 0 0 0 17.8 5H16" />
    </CadGlyph>
  );
}

export function ToolbarDuplicateIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="3.5" y="8" width="10" height="10" rx="1.4" />
      <rect x="10.5" y="6" width="10" height="10" rx="1.4" />
    </CadGlyph>
  );
}

export function ToolbarDuplicateRepeatIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="2.5" y="10" width="7" height="7" rx="1.2" />
      <rect x="7" y="6.5" width="7" height="7" rx="1.2" />
      <path d="M16.2 16.2a3.4 3.4 0 1 0 .6-3.2" />
      <path d="M16.8 11.2v2.4h2.4" />
    </CadGlyph>
  );
}

export function ToolbarTrashIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V4.8h6V7" />
      <path d="M6.5 7 7.4 20h9.2l.9-13" />
      <path d="M10 11v6M14 11v6" />
    </CadGlyph>
  );
}

export function ToolbarUndoIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </CadGlyph>
  );
}

export function ToolbarRedoIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </CadGlyph>
  );
}

export function ToolbarImportIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <path
        className="icon-fill"
        d="M16 6h12l10 10v24a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z"
      />
      <path
        className="icon-ink"
        d="M16 6h12l10 10v24a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path className="icon-ink" d="M28 6v10h10" strokeWidth="2.5" strokeLinejoin="round" />
      <path className="icon-ink" d="M24 34V20" strokeWidth="2.8" strokeLinecap="round" />
      <path className="icon-ink" d="M18 28l6 6 6-6" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ToolbarVectorExportIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <path
        className="icon-fill"
        d="M16 6h12l10 10v24a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z"
      />
      <path
        className="icon-ink"
        d="M16 6h12l10 10v24a3 3 0 0 1-3 3H16a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path className="icon-ink" d="M28 6v10h10" strokeWidth="2.5" strokeLinejoin="round" />
      <path className="icon-ink" d="M24 18v14" strokeWidth="2.8" strokeLinecap="round" />
      <path className="icon-ink" d="M18 24l6-6 6 6" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ToolbarBlueprintIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      {/* Sheet body */}
      <rect className="icon-fill" x="8" y="8" width="32" height="32" rx="3" />
      <rect className="icon-ink" x="8" y="8" width="32" height="32" rx="3" strokeWidth="2.5" />
      {/* View frames: light panels + dark outlines for contrast against sheet grey */}
      <rect className="icon-panel" x="12" y="12" width="14" height="10" rx="1.2" />
      <rect className="icon-ink" x="12" y="12" width="14" height="10" rx="1.2" strokeWidth="2" />
      <rect className="icon-panel" x="12" y="26" width="14" height="10" rx="1.2" />
      <rect className="icon-ink" x="12" y="26" width="14" height="10" rx="1.2" strokeWidth="2" />
      <rect className="icon-panel" x="30" y="26" width="6" height="10" rx="1.2" />
      <rect className="icon-ink" x="30" y="26" width="6" height="10" rx="1.2" strokeWidth="2" />
      {/* Title block */}
      <rect className="icon-panel" x="28" y="12" width="8" height="10" rx="1.2" />
      <rect className="icon-ink" x="28" y="12" width="8" height="10" rx="1.2" strokeWidth="2" />
      <path className="icon-ink" d="M30 15.5h4M30 19h4" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ToolbarSettingsIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M12.2 2h-.4a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </CadGlyph>
  );
}

export function ToolbarShapeAddIcon(props: IconProps) {
  return <VectorToolbarSpriteIcon rect={{ x: 104, y: 0, width: 29, height: 27 }} {...props} />;
}

export function ToolbarHideSelectedIcon(props: IconProps) {
  return <VectorToolbarSpriteIcon rect={{ x: 138, y: 0, width: 27, height: 27 }} {...props} />;
}

export function ToolbarCaretDownIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <path d="m16 19 8 9 8-9z" fill="currentColor" />
    </svg>
  );
}

export function ToolbarGroupIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" strokeDasharray="2.2 1.8" />
      <rect x="6.2" y="6.2" width="6" height="6" rx="0.8" />
      <circle cx="15.2" cy="15.2" r="3" />
    </CadGlyph>
  );
}

export function ToolbarUngroupIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="2.5" y="2.5" width="8" height="8" rx="1.2" />
      <circle cx="17.5" cy="17.5" r="4" />
      <path d="M11 8h2.2M8 11v2.2" />
      <path d="M13 16h-2.2M16 13v-2.2" />
    </CadGlyph>
  );
}

export function ToolbarIntersectionIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" strokeDasharray="2.2 1.6" />
      <path d="M12 6.8a6 6 0 0 1 0 10.4 6 6 0 0 1 0-10.4z" fill="currentColor" stroke="none" opacity="0.28" />
    </CadGlyph>
  );
}

export function ToolbarAlignIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M4 4v16" />
      <path d="M8 7h12" />
      <path d="M8 12h8" />
      <path d="M8 17h10" />
    </CadGlyph>
  );
}

export function ToolbarMirrorIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M12 3.5v17" strokeDasharray="1.7 1.7" />
      <rect x="3.5" y="7.5" width="5.5" height="9" rx="0.8" />
      <rect x="15" y="7.5" width="5.5" height="9" rx="0.8" strokeDasharray="1.8 1.4" />
    </CadGlyph>
  );
}

export function ToolbarChamferIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M4 20V8h7" />
      <path d="M11 8l7 7" />
      <path d="M18 15v5H4" />
    </CadGlyph>
  );
}

export function ToolbarFilletIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M4 20V8h7" />
      <path d="M11 8a7 7 0 0 1 7 7" />
      <path d="M18 15v5H4" />
    </CadGlyph>
  );
}

export function ToolbarCircularPatternIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M12 5.2a6.8 6.8 0 1 1-5.8 3.2" strokeDasharray="1.8 1.6" />
      <rect x="10" y="2.2" width="4" height="4" rx="0.6" />
      <rect x="16.4" y="14.2" width="4" height="4" rx="0.6" />
      <rect x="3.6" y="14.2" width="4" height="4" rx="0.6" />
    </CadGlyph>
  );
}

export function ToolbarLinearPatternIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="2" y="9" width="5.2" height="6" rx="0.8" />
      <rect x="9.4" y="9" width="5.2" height="6" rx="0.8" />
      <rect x="16.8" y="9" width="5.2" height="6" rx="0.8" />
      <path d="M4.6 7.2V5M12 7.2V5M19.4 7.2V5" />
      <path d="M4.6 17v2.2M12 17v2.2M19.4 17v2.2" />
    </CadGlyph>
  );
}

export function ToolbarThreadIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <path d="M14 8v32M34 8v32" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path
        d="M14 12c6 2 14 2 20 0M14 18c6 2 14 2 20 0M14 24c6 2 14 2 20 0M14 30c6 2 14 2 20 0M14 36c6 2 14 2 20 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ToolbarPreserveEdgeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <path d="M10 35V17c0-4 3-7 7-7h18" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
      <path d="M10 35h25V10" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinejoin="round" />
      <path d="M17 29h13M17 25v8M30 25v8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M18 17a7 7 0 0 1 7-7" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function ToolbarSnapGridIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M4 4h3.2M4 4v3.2M20 4h-3.2M20 4v3.2M4 20h3.2M4 20v-3.2M20 20h-3.2M20 20v-3.2" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="0.6" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
    </CadGlyph>
  );
}

export function ToolbarExportIcon(props: IconProps) {
  return <ToolbarVectorExportIcon {...props} />;
}

export function ToolbarWorkplaneIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <path d="M3 15.5 12 20l9-4.5-9-4.5Z" />
      <path d="M12 10.5V4" />
      <path d="m12 4-2.2 2.2M12 4l2.2 2.2" />
    </CadGlyph>
  );
}

export function ToolbarDropToWorkplaneIcon(props: IconProps) {
  return (
    <CadGlyph {...props}>
      <rect x="8" y="3" width="8" height="6" rx="1" />
      <path d="M12 9.5v5" />
      <path d="m9.2 12.2 2.8 2.8 2.8-2.8" />
      <path d="M4 20h16" />
    </CadGlyph>
  );
}

/** Sketch constraint / modify icons — PeakCAD stroke language (not letter glyphs). */
function SketchGlyphIcon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function SketchDimensionIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M10 34V14M38 34V14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M10 24h28" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M14 20l-4 4 4 4M34 20l4 4-4 4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintHorizontalIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M8 24h32" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
      <path d="M14 18v12M34 18v12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintVerticalIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M24 8v32" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
      <path d="M18 14h12M18 34h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintEqualIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M12 18h24M12 30h24" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintParallelIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M14 38L26 10M22 38L34 10" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintPerpendicularIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M12 36V14h22" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 22h8v8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintTangentIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <circle cx="20" cy="26" r="11" stroke="currentColor" strokeWidth="2.5" />
      <path d="M8 14h32" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="20" cy="14" r="2.2" fill="currentColor" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintCoincidentIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <circle cx="18" cy="24" r="5" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="30" cy="24" r="5" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="24" cy="24" r="2.2" fill="currentColor" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintMidpointIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M8 30h32" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="24" cy="30" r="3.2" fill="currentColor" />
      <path d="M24 12v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintFixIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M24 10v16" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M16 26h16" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M18 34h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="24" cy="10" r="3" fill="currentColor" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintConcentricIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <circle cx="24" cy="24" r="6" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="24" cy="24" r="13" stroke="currentColor" strokeWidth="2.4" />
    </SketchGlyphIcon>
  );
}

export function SketchConstraintSymmetryIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M24 8v32" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="3.5 3" />
      <path d="M10 18l10 6-10 6V18ZM38 18l-10 6 10 6V18Z" fill="currentColor" opacity="0.92" />
    </SketchGlyphIcon>
  );
}

export function SketchTrimIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <path d="M10 14l28 20" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M38 14L24 24" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="4 3.5" />
      <circle cx="24" cy="24" r="3" fill="currentColor" />
      <path d="M18 32c4 4 8 4 12 0" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
    </SketchGlyphIcon>
  );
}

export function SketchRectPatternIcon(props: IconProps) {
  return (
    <SketchGlyphIcon {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2.4" />
      <rect x="28" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2.4" opacity="0.55" />
      <rect x="9" y="28" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2.4" opacity="0.55" />
      <rect x="28" y="28" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2.4" opacity="0.55" />
    </SketchGlyphIcon>
  );
}
