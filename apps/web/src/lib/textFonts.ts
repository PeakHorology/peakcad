import { FontLoader, type Font, type FontData } from "three/examples/jsm/loaders/FontLoader.js";
import droidMonoFontJson from "three/examples/fonts/droid/droid_sans_mono_regular.typeface.json";
import droidSansBoldFontJson from "three/examples/fonts/droid/droid_sans_bold.typeface.json";
import droidSansRegularFontJson from "three/examples/fonts/droid/droid_sans_regular.typeface.json";
import droidSerifBoldFontJson from "three/examples/fonts/droid/droid_serif_bold.typeface.json";
import droidSerifRegularFontJson from "three/examples/fonts/droid/droid_serif_regular.typeface.json";
import gentilisBoldFontJson from "three/examples/fonts/gentilis_bold.typeface.json";
import gentilisRegularFontJson from "three/examples/fonts/gentilis_regular.typeface.json";
import helvetikerBoldFontJson from "three/examples/fonts/helvetiker_bold.typeface.json";
import helvetikerRegularFontJson from "three/examples/fonts/helvetiker_regular.typeface.json";
import optimerBoldFontJson from "three/examples/fonts/optimer_bold.typeface.json";
import optimerRegularFontJson from "three/examples/fonts/optimer_regular.typeface.json";

export const DEFAULT_TEXT_FONT = "Multilanguage";

/** Display names shown in the Text shape inspector. */
export const TEXT_FONT_OPTIONS = [
  "Multilanguage",
  "Sans",
  "Sans Light",
  "Serif",
  "Serif Light",
  "Script",
  "Script Light",
  "Monospace",
  "Rounded",
  "Rounded Light",
  "Clean",
  "Stencil",
] as const;

export type TextFontName = (typeof TEXT_FONT_OPTIONS)[number];

const fontLoader = new FontLoader();

function parseFont(data: unknown): Font {
  return fontLoader.parse(data as FontData);
}

/**
 * Three.js ships a small set of typeface.json fonts. We expose every distinct
 * face (including regular weights) under readable PeakCAD names. Stencil reuses
 * Helvetiker Bold with reduced curve segments at geometry time.
 */
const textFonts: Record<string, Font> = {
  Multilanguage: parseFont(helvetikerBoldFontJson),
  Sans: parseFont(droidSansBoldFontJson),
  "Sans Light": parseFont(droidSansRegularFontJson),
  Serif: parseFont(droidSerifBoldFontJson),
  "Serif Light": parseFont(droidSerifRegularFontJson),
  Script: parseFont(gentilisBoldFontJson),
  "Script Light": parseFont(gentilisRegularFontJson),
  Monospace: parseFont(droidMonoFontJson),
  Rounded: parseFont(optimerBoldFontJson),
  "Rounded Light": parseFont(optimerRegularFontJson),
  Clean: parseFont(helvetikerRegularFontJson),
  Stencil: parseFont(helvetikerBoldFontJson),
};

export function resolveTextFont(fontName?: string | null): Font {
  if (fontName && textFonts[fontName]) return textFonts[fontName];
  return textFonts[DEFAULT_TEXT_FONT];
}

export function textFontCurveSegments(fontName?: string | null): number {
  return fontName === "Stencil" ? 1 : 8;
}
