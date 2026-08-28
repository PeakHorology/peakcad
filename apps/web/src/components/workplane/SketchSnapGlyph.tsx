import type { SketchSnapKind } from "@/lib/sketch";

type ActiveSnapKind = Exclude<SketchSnapKind, "grid">;

const SNAP_LABELS: Record<ActiveSnapKind, string> = {
  endpoint: "End",
  midpoint: "Mid",
  center: "Center",
  intersection: "Int",
  nearest: "On",
  quadrant: "Quad",
  horizontal: "H",
  vertical: "V",
};

type SketchSnapGlyphProps = {
  kind: ActiveSnapKind;
  x: number;
  z: number;
  screenUnit: number;
};

function SnapMark({ kind, s }: { kind: ActiveSnapKind; s: number }) {
  const stroke = Math.max(1.1, 1.25 * s);

  switch (kind) {
    case "endpoint":
      return (
        <rect
          className="sketch-snap-mark"
          x={-5 * s}
          y={-5 * s}
          width={10 * s}
          height={10 * s}
          rx={1.25 * s}
          strokeWidth={stroke}
        />
      );
    case "midpoint":
      return (
        <polygon
          className="sketch-snap-mark"
          points={`0,${-6.5 * s} ${6.5 * s},${5.5 * s} ${-6.5 * s},${5.5 * s}`}
          strokeWidth={stroke}
        />
      );
    case "center":
      return (
        <g>
          <circle className="sketch-snap-mark" r={6.5 * s} strokeWidth={stroke} />
          <line className="sketch-snap-cross" x1={-3.5 * s} y1={0} x2={3.5 * s} y2={0} strokeWidth={stroke} />
          <line className="sketch-snap-cross" x1={0} y1={-3.5 * s} x2={0} y2={3.5 * s} strokeWidth={stroke} />
        </g>
      );
    case "intersection":
      return (
        <g>
          <circle className="sketch-snap-mark sketch-snap-mark-soft" r={6 * s} strokeWidth={stroke} />
          <line className="sketch-snap-cross" x1={-4.5 * s} y1={-4.5 * s} x2={4.5 * s} y2={4.5 * s} strokeWidth={stroke} />
          <line className="sketch-snap-cross" x1={4.5 * s} y1={-4.5 * s} x2={-4.5 * s} y2={4.5 * s} strokeWidth={stroke} />
        </g>
      );
    case "quadrant":
      return (
        <g>
          <circle className="sketch-snap-mark" r={6 * s} strokeWidth={stroke} />
          <line className="sketch-snap-cross" x1={0} y1={-6 * s} x2={0} y2={6 * s} strokeWidth={stroke} />
          <line className="sketch-snap-cross" x1={-6 * s} y1={0} x2={6 * s} y2={0} strokeWidth={stroke} />
        </g>
      );
    case "nearest":
      return (
        <polygon
          className="sketch-snap-mark"
          points={`0,${-6 * s} ${6 * s},0 0,${6 * s} ${-6 * s},0`}
          strokeWidth={stroke}
        />
      );
    case "horizontal":
    case "vertical":
      return (
        <g>
          <circle className="sketch-snap-mark sketch-snap-mark-soft" r={4.5 * s} strokeWidth={stroke} />
          <circle className="sketch-snap-dot" r={1.6 * s} />
        </g>
      );
    default:
      return <circle className="sketch-snap-mark" r={5 * s} strokeWidth={stroke} />;
  }
}

export function SketchSnapGlyph({ kind, x, z, screenUnit }: SketchSnapGlyphProps) {
  const s = screenUnit;
  const label = SNAP_LABELS[kind];
  const chipW = Math.max(22, label.length * 7 + 14) * s;
  const chipH = 17 * s;
  const chipY = -(14 * s + chipH);
  const guide = 52 * s;

  return (
    <g className={`sketch-snap-glyph snap-${kind}`} pointerEvents="none" transform={`translate(${x} ${z})`}>
      {kind === "horizontal" ? (
        <line className="sketch-snap-guide" x1={-guide} y1={0} x2={guide} y2={0} />
      ) : null}
      {kind === "vertical" ? (
        <line className="sketch-snap-guide" x1={0} y1={-guide} x2={0} y2={guide} />
      ) : null}
      <SnapMark kind={kind} s={s} />
      <g className="sketch-snap-chip" transform={`translate(${-chipW / 2} ${chipY})`}>
        <rect width={chipW} height={chipH} rx={chipH / 2} ry={chipH / 2} />
        <text x={chipW / 2} y={chipH * 0.68} fontSize={11 * s}>
          {label}
        </text>
      </g>
    </g>
  );
}
