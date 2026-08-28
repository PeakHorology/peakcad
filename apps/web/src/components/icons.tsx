import type { CSSProperties, ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
type SpriteRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const toolbarSprite = "assets/sketchforge/toolbar-sprite.svg?v=2";
const vectorToolbarSprite = "assets/sketchforge/vector-toolbar-icons.svg?v=1";

function ToolbarSpriteIcon({ rect, className, style }: IconProps & { rect: SpriteRect }) {
  const size = 35;
  const scale = size / rect.height;

  return (
    <span
      aria-hidden="true"
      className={["toolbar-sprite-icon", className].filter(Boolean).join(" ")}
      style={
        {
          "--sprite-x": `${-rect.x * scale}px`,
          "--sprite-y": `${-rect.y * scale}px`,
          "--sprite-width": `${260 * scale}px`,
          "--sprite-height": `${80 * scale}px`,
          width: `${rect.width * scale}px`,
          height: `${size}px`,
          backgroundImage: `url(${toolbarSprite})`,
          ...(style as CSSProperties),
        } as CSSProperties
      }
    />
  );
}

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

type ToolbarCommandImageProps = { file: string; className?: string };

function ToolbarCommandImage({ file, className }: ToolbarCommandImageProps) {
  const assetClassName = `toolbar-art-${file.replace(/\.png$/i, "")}`;
  return <img aria-hidden="true" className={["toolbar-command-icon", assetClassName, className].filter(Boolean).join(" ")} src={"/assets/sketchforge/" + file} alt="" draggable={false} />;
}

export function ToolbarHomeIcon() {
  return <ToolbarCommandImage file="toolbar-home.png" className="toolbar-user-art-icon" />;
}

export function ToolbarCopyIcon() {
  return <ToolbarCommandImage file="toolbar-copy.png" className="toolbar-user-art-icon" />;
}

export function ToolbarPasteIcon() {
  return <ToolbarCommandImage file="toolbar-paste.png" className="toolbar-user-art-icon" />;
}

export function ToolbarDuplicateIcon() {
  return <ToolbarCommandImage file="toolbar-duplicate.png" className="toolbar-user-art-icon" />;
}

export function ToolbarDuplicateRepeatIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect x="8" y="18" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <rect x="18" y="10" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <path d="M30 30h8v8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M30 38l10-10" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function ToolbarTrashIcon() {
  return <ToolbarCommandImage file="toolbar-delete.png" className="toolbar-user-art-icon" />;
}

export function ToolbarUndoIcon() {
  return <ToolbarCommandImage file="toolbar-undo.png" className="toolbar-user-art-icon" />;
}

export function ToolbarRedoIcon() {
  return <ToolbarCommandImage file="toolbar-redo.png" className="toolbar-user-art-icon" />;
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

export function ToolbarSettingsIcon() {
  return <ToolbarCommandImage file="toolbar-settings.png" className="toolbar-user-art-icon" />;
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

export function ToolbarGroupIcon() {
  return <ToolbarCommandImage file="toolbar-group.png" />;
}

export function ToolbarUngroupIcon() {
  return <ToolbarCommandImage file="toolbar-ungroup.png" />;
}

export function ToolbarIntersectionIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <circle cx="19" cy="24" r="13" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="29" cy="24" r="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeDasharray="4 3" />
      <path d="M24 11.99A13 13 0 0 1 24 36.01A13 13 0 0 1 24 11.99Z" fill="currentColor" opacity="0.82" />
    </svg>
  );
}

export function ToolbarAlignIcon(props: IconProps) {
  return <ToolbarSpriteIcon rect={{ x: 97.3, y: 46.7, width: 29.1, height: 32.5 }} {...props} />;
}

export function ToolbarMirrorIcon() {
  return <ToolbarCommandImage file="toolbar-mirror.png" className="toolbar-user-art-icon" />;
}

export function ToolbarChamferIcon() {
  return <ToolbarCommandImage file="toolbar-chamfer.png" className="toolbar-user-art-icon" />;
}

export function ToolbarFilletIcon() {
  return <ToolbarCommandImage file="toolbar-fillet.png" className="toolbar-user-art-icon" />;
}

export function ToolbarCircularPatternIcon() {
  return <ToolbarCommandImage file="toolbar-circular-pattern.png" className="toolbar-user-art-icon" />;
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

export function ToolbarSnapGridIcon() {
  return <ToolbarCommandImage file="toolbar-snap-grid.png" className="toolbar-user-art-icon" />;
}

export function ToolbarExportIcon(props: IconProps) {
  return <ToolbarVectorExportIcon {...props} />;
}

export function ToolbarWorkplaneIcon() {
  return <ToolbarCommandImage file="toolbar-workplane.png" className="toolbar-user-art-icon" />;
}

export function ToolbarDropToWorkplaneIcon() {
  return <ToolbarCommandImage file="toolbar-drop-workplane.png" className="toolbar-user-art-icon" />;
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
