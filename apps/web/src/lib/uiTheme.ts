/** App-wide UI theme (chrome + dashboard). Stored in localStorage. */

export const UI_THEME_STORAGE_KEY = "peakcad:uiTheme";
/** Legacy key from an earlier PeakCAD / SketchForge theme path. */
const LEGACY_THEME_STORAGE_KEY = "sketchForge.theme";
export const UI_THEME_CHANGED_EVENT = "peakcad:ui-theme-changed";

export type UiTheme = "light" | "dark";

export const DEFAULT_UI_THEME: UiTheme = "light";
export const DEFAULT_LIGHT_VIEWPORT_BACKGROUND = "#f8fbfc";
export const DEFAULT_DARK_VIEWPORT_BACKGROUND = "#141a18";

export function isUiTheme(value: unknown): value is UiTheme {
  return value === "light" || value === "dark";
}

export function loadUiTheme(): UiTheme {
  if (typeof window === "undefined") return DEFAULT_UI_THEME;
  try {
    const stored = window.localStorage.getItem(UI_THEME_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (isUiTheme(stored)) return stored;
  } catch {
    // Storage unavailable — keep light.
  }
  return DEFAULT_UI_THEME;
}

export function saveUiTheme(theme: UiTheme) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
  } catch {
    // Theme still applies in-memory for this session.
  }
}

export function applyUiTheme(theme: UiTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") {
    root.dataset.theme = "dark";
  } else {
    delete root.dataset.theme;
  }
  root.style.colorScheme = theme;
}

export function setUiTheme(theme: UiTheme) {
  applyUiTheme(theme);
  saveUiTheme(theme);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UI_THEME_CHANGED_EVENT, { detail: { theme } }));
  }
}

export function readAppliedUiTheme(): UiTheme {
  if (typeof document === "undefined") return DEFAULT_UI_THEME;
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Use a dark clear color when the project still has the stock light background. */
export function resolveViewportBackground(storedBackground: string, theme: UiTheme = readAppliedUiTheme()): string {
  if (theme === "dark" && (!storedBackground || storedBackground === DEFAULT_LIGHT_VIEWPORT_BACKGROUND)) {
    return DEFAULT_DARK_VIEWPORT_BACKGROUND;
  }
  return storedBackground || DEFAULT_LIGHT_VIEWPORT_BACKGROUND;
}

export function resolveWorkplaneBaseColor(theme: UiTheme = readAppliedUiTheme()): string {
  return theme === "dark" ? "#243640" : "#ddf8ff";
}
