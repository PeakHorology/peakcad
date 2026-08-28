import type { CadModifierQuality } from "@/lib/cadModifierTypes";
import { hardwareProfile } from "@/lib/desktopHardware";
import type { DisplayQuality, ShapeKind, WorkplaneShape } from "@/types/sketchforge";

export const DEFAULT_DISPLAY_QUALITY: DisplayQuality = "smooth";

export const DISPLAY_QUALITY_OPTIONS: DisplayQuality[] = ["draft", "standard", "smooth"];

/**
 * Facet counts baked into shapes by older catalog builds, per kind. Those were never a user
 * choice, so they still mean “follow display quality”.
 *
 * Matching is per-kind on purpose. A single global value set both swallowed deliberate user
 * input (a cylinder set to 144 sides jumped to 192) and missed real auto values for other
 * kinds (a draft round roof stored 48, which no quality default could then update).
 */
const LEGACY_BAKED_SIDES: Partial<Record<ShapeKind, number>> = {
  cylinder: 96,
  cone: 96,
  roundRoof: 64,
};

const LEGACY_BAKED_STEPS: Partial<Record<ShapeKind, number>> = {
  box: 10,
  sphere: 24,
  halfSphere: 32,
};

const SIDE_DEFAULTS: Record<DisplayQuality, Partial<Record<ShapeKind, number>>> = {
  draft: { cylinder: 64, cone: 64, roundRoof: 48, tube: 96, ring: 96, thread: 48 },
  standard: { cylinder: 128, cone: 128, roundRoof: 96, tube: 192, ring: 192, thread: 96 },
  smooth: { cylinder: 192, cone: 192, roundRoof: 128, tube: 256, ring: 256, thread: 128 },
};

const STEP_DEFAULTS: Record<DisplayQuality, Partial<Record<ShapeKind, number>>> = {
  draft: { sphere: 16, torus: 16, halfSphere: 20, box: 6 },
  standard: { sphere: 48, torus: 48, halfSphere: 40, box: 12 },
  smooth: { sphere: 64, torus: 64, halfSphere: 56, box: 16 },
};

const HOLLOW_SEGMENTS: Record<DisplayQuality, number> = {
  draft: 96,
  standard: 192,
  smooth: 256,
};

let activeDisplayQuality: DisplayQuality = DEFAULT_DISPLAY_QUALITY;

export function normalizeDisplayQuality(value: unknown, fallback: DisplayQuality = DEFAULT_DISPLAY_QUALITY): DisplayQuality {
  return DISPLAY_QUALITY_OPTIONS.includes(value as DisplayQuality) ? (value as DisplayQuality) : fallback;
}

export function setActiveDisplayQuality(quality: DisplayQuality) {
  activeDisplayQuality = normalizeDisplayQuality(quality);
}

export function getActiveDisplayQuality() {
  return activeDisplayQuality;
}

export function isCurvedTessellationKind(kind: ShapeKind) {
  return (
    kind === "cylinder"
    || kind === "cone"
    || kind === "sphere"
    || kind === "torus"
    || kind === "halfSphere"
    || kind === "roundRoof"
    || kind === "tube"
    || kind === "ring"
    || kind === "thread"
  );
}

function clampSides(value: number) {
  return Math.max(3, Math.min(hardwareProfile().maxShapeSides, Math.round(value)));
}

function clampSteps(value: number) {
  return Math.max(6, Math.min(128, Math.round(value)));
}

export function defaultSidesForKind(kind: ShapeKind, quality: DisplayQuality = getActiveDisplayQuality()) {
  return SIDE_DEFAULTS[quality][kind];
}

export function defaultStepsForKind(kind: ShapeKind, quality: DisplayQuality = getActiveDisplayQuality()) {
  return STEP_DEFAULTS[quality][kind];
}

/** True when `stored` is a value this kind gets automatically, rather than a user override. */
function followsDisplayQuality(
  stored: number,
  kind: ShapeKind,
  defaults: Record<DisplayQuality, Partial<Record<ShapeKind, number>>>,
  legacy: Partial<Record<ShapeKind, number>>,
) {
  return stored === legacy[kind] || DISPLAY_QUALITY_OPTIONS.some((quality) => defaults[quality][kind] === stored);
}

export function resolveShapeSides(
  kind: ShapeKind,
  stored: number | undefined,
  quality: DisplayQuality = getActiveDisplayQuality(),
) {
  const target = defaultSidesForKind(kind, quality);
  if (target == null) {
    return stored;
  }
  if (stored == null || followsDisplayQuality(stored, kind, SIDE_DEFAULTS, LEGACY_BAKED_SIDES)) {
    return clampSides(target);
  }
  return clampSides(stored);
}

export function resolveShapeSteps(
  kind: ShapeKind,
  stored: number | undefined,
  quality: DisplayQuality = getActiveDisplayQuality(),
) {
  const target = defaultStepsForKind(kind, quality);
  if (target == null) {
    return stored;
  }
  if (stored == null || followsDisplayQuality(stored, kind, STEP_DEFAULTS, LEGACY_BAKED_STEPS)) {
    return clampSteps(target);
  }
  return clampSteps(stored);
}

export function resolveHollowCylinderSegments(quality: DisplayQuality = getActiveDisplayQuality()) {
  return clampSides(HOLLOW_SEGMENTS[quality]);
}

export function resolveIcosahedronDetail(quality: DisplayQuality = getActiveDisplayQuality()) {
  if (quality === "draft") return 1;
  if (quality === "smooth") return 2;
  return 1;
}

/** Barrel / radial hole meshes follow the same display budget. */
export function resolveHoleRadialSegments(radiusMm: number, quality: DisplayQuality = getActiveDisplayQuality()) {
  const cap = quality === "draft" ? 96 : quality === "smooth" ? 256 : 192;
  const floor = quality === "draft" ? 32 : 48;
  const density = quality === "draft" ? 4 : quality === "smooth" ? 8 : 6;
  return Math.min(cap, Math.max(floor, Math.ceil(Math.max(0.01, radiusMm) * density)));
}

export function modifierQualityForDisplay(quality: DisplayQuality = getActiveDisplayQuality()): CadModifierQuality {
  if (quality === "draft") return "draft";
  if (quality === "smooth") return "ultra";
  return "fine";
}

export function catalogSidesForKind(kind: ShapeKind, quality: DisplayQuality = getActiveDisplayQuality()) {
  if (kind === "pyramid") return 4;
  if (kind === "polygon") return 6;
  return defaultSidesForKind(kind, quality);
}

export function catalogStepsForKind(kind: ShapeKind, quality: DisplayQuality = getActiveDisplayQuality()) {
  return defaultStepsForKind(kind, quality);
}

export function shapeTessellationFingerprint(shape: Pick<WorkplaneShape, "kind" | "sides" | "steps">, quality: DisplayQuality) {
  if (!isCurvedTessellationKind(shape.kind) && shape.kind !== "box" && shape.kind !== "icosahedron") {
    return "";
  }
  return `|dq:${quality}:s${resolveShapeSides(shape.kind, shape.sides, quality) ?? "-"}:t${resolveShapeSteps(shape.kind, shape.steps, quality) ?? "-"}:i${resolveIcosahedronDetail(quality)}:h${resolveHollowCylinderSegments(quality)}`;
}
