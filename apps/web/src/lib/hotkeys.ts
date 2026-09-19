/** Remappable editor hotkeys (app-level, stored in localStorage). */

export const HOTKEYS_STORAGE_KEY = "peakcad:hotkeys";
export const HOTKEYS_CHANGED_EVENT = "peakcad:hotkeys-changed";

let hotkeyRecordingActive = false;

/** While true, editor shortcuts should ignore keydown (settings is capturing). */
export function setHotkeyRecordingActive(active: boolean) {
  hotkeyRecordingActive = active;
}

export function isHotkeyRecordingActive() {
  return hotkeyRecordingActive;
}

export type HotkeyChord = {
  /** Normalized key: "a", "arrowup", "delete", "escape", "home", "=", "-", … */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type HotkeyActionId =
  | "undo"
  | "redo"
  | "copy"
  | "cut"
  | "paste"
  | "delete"
  | "duplicate"
  | "duplicateRepeat"
  | "selectAll"
  | "group"
  | "ungroup"
  | "toggleLocked"
  | "toggleHidden"
  | "showHidden"
  | "raise"
  | "lower"
  | "nudgeLeft"
  | "nudgeRight"
  | "nudgeUp"
  | "nudgeDown"
  | "dropToWorkplane"
  | "holeMode"
  | "solidMode"
  | "align"
  | "mirror"
  | "pattern"
  | "chamfer"
  | "fillet"
  | "escape"
  | "cameraHome"
  | "zoomIn"
  | "zoomOut"
  | "sketchLine"
  | "sketchCircle"
  | "sketchRectangle"
  | "sketchDimension"
  | "sketchExtrude"
  | "sketchFocusToggle";

export type HotkeyCategory = "Edit" | "Selection" | "Transform" | "Tools" | "View" | "Sketch";

export type HotkeyActionMeta = {
  id: HotkeyActionId;
  label: string;
  description: string;
  category: HotkeyCategory;
  /** When true, Shift is ignored for matching (used as a speed/step modifier). */
  ignoreShift?: boolean;
};

export const HOTKEY_ACTIONS: readonly HotkeyActionMeta[] = [
  { id: "undo", label: "Undo", description: "Undo the last change (sketch or geometry).", category: "Edit" },
  { id: "redo", label: "Redo", description: "Redo the last undone change.", category: "Edit" },
  { id: "copy", label: "Copy", description: "Copy the selection to the clipboard.", category: "Edit" },
  { id: "cut", label: "Cut", description: "Cut the selection to the clipboard.", category: "Edit" },
  { id: "paste", label: "Paste", description: "Paste from the clipboard.", category: "Edit" },
  { id: "delete", label: "Delete", description: "Delete the selection.", category: "Edit" },
  { id: "duplicate", label: "Duplicate", description: "Duplicate the selected shapes.", category: "Edit" },
  { id: "duplicateRepeat", label: "Duplicate and repeat", description: "Duplicate with the last repeat offset.", category: "Edit" },
  { id: "selectAll", label: "Select all", description: "Select all visible shapes.", category: "Selection" },
  { id: "escape", label: "Clear / cancel", description: "Clear selection or cancel the current chain.", category: "Selection" },
  { id: "toggleLocked", label: "Lock / unlock", description: "Toggle locked on the selection.", category: "Selection" },
  { id: "toggleHidden", label: "Hide / show", description: "Toggle hidden on the selection (Ctrl+H). H alone is Hole mode.", category: "Selection" },
  { id: "showHidden", label: "Show all hidden", description: "Reveal every hidden shape.", category: "Selection" },
  { id: "group", label: "Group", description: "Group the selected shapes.", category: "Transform" },
  { id: "ungroup", label: "Ungroup", description: "Ungroup the last group one level. Repeat to unwrap nested groups.", category: "Transform" },
  { id: "raise", label: "Raise", description: "Raise the selection’s elevation.", category: "Transform", ignoreShift: true },
  { id: "lower", label: "Lower", description: "Lower the selection’s elevation.", category: "Transform", ignoreShift: true },
  { id: "nudgeLeft", label: "Nudge left", description: "Nudge the selection left in the view.", category: "Transform", ignoreShift: true },
  { id: "nudgeRight", label: "Nudge right", description: "Nudge the selection right in the view.", category: "Transform", ignoreShift: true },
  { id: "nudgeUp", label: "Nudge up", description: "Nudge the selection up in the view.", category: "Transform", ignoreShift: true },
  { id: "nudgeDown", label: "Nudge down", description: "Nudge the selection down in the view.", category: "Transform", ignoreShift: true },
  { id: "dropToWorkplane", label: "Drop to workplane", description: "Drop the selection onto the workplane (geometry). In a sketch, D is Dimension.", category: "Transform" },
  { id: "holeMode", label: "Hole mode", description: "Set the selection to hole (geometry). H alone; Ctrl+H hides instead.", category: "Tools" },
  { id: "solidMode", label: "Solid mode", description: "Set the selection to solid mode.", category: "Tools" },
  { id: "align", label: "Align", description: "Toggle align mode (geometry). In a sketch, L is the line tool.", category: "Tools" },
  { id: "mirror", label: "Mirror", description: "Toggle mirror mode.", category: "Tools" },
  { id: "pattern", label: "Circular pattern", description: "Toggle circular pattern mode.", category: "Tools" },
  { id: "chamfer", label: "Chamfer", description: "Start chamfer, or edit the last chamfer on the selection.", category: "Tools" },
  { id: "fillet", label: "Fillet", description: "Start fillet, or edit the last fillet on the selection.", category: "Tools" },
  { id: "cameraHome", label: "Camera home", description: "Reset the camera to the home view.", category: "View" },
  { id: "zoomIn", label: "Zoom in", description: "Zoom the camera closer.", category: "View" },
  { id: "zoomOut", label: "Zoom out", description: "Zoom the camera farther.", category: "View" },
  { id: "sketchLine", label: "Sketch line", description: "Line tool while sketching. In geometry, L is Align.", category: "Sketch" },
  { id: "sketchCircle", label: "Sketch circle", description: "Activate the sketch circle tool.", category: "Sketch" },
  { id: "sketchRectangle", label: "Sketch rectangle", description: "Activate the sketch rectangle tool.", category: "Sketch" },
  { id: "sketchDimension", label: "Sketch dimension", description: "Dimension tool while sketching. In geometry, D drops to the workplane.", category: "Sketch" },
  { id: "sketchExtrude", label: "Sketch extrude", description: "Finish the sketch with Extrude.", category: "Sketch" },
  { id: "sketchFocusToggle", label: "Toggle sketch focus", description: "Switch between 2D focus and 3D sketch view.", category: "Sketch" },
] as const;

export const HOTKEY_CATEGORIES: readonly HotkeyCategory[] = [
  "Edit",
  "Selection",
  "Transform",
  "Tools",
  "View",
  "Sketch",
];

export type HotkeyBindings = Record<HotkeyActionId, HotkeyChord[]>;

const chord = (key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): HotkeyChord => ({
  key,
  ...(mods.ctrl ? { ctrl: true } : {}),
  ...(mods.shift ? { shift: true } : {}),
  ...(mods.alt ? { alt: true } : {}),
});

/** Defaults match the existing editor shortcuts. */
export const DEFAULT_HOTKEY_BINDINGS: HotkeyBindings = {
  undo: [chord("z", { ctrl: true })],
  redo: [chord("z", { ctrl: true, shift: true }), chord("y", { ctrl: true })],
  copy: [chord("c", { ctrl: true })],
  cut: [chord("x", { ctrl: true })],
  paste: [chord("v", { ctrl: true })],
  delete: [chord("delete"), chord("backspace")],
  duplicate: [chord("d", { ctrl: true })],
  duplicateRepeat: [chord("d", { ctrl: true, shift: true })],
  selectAll: [chord("a", { ctrl: true })],
  group: [chord("g", { ctrl: true })],
  ungroup: [chord("g", { ctrl: true, shift: true })],
  toggleLocked: [chord("l", { ctrl: true })],
  toggleHidden: [chord("h", { ctrl: true })],
  showHidden: [chord("h", { ctrl: true, shift: true })],
  raise: [chord("arrowup", { ctrl: true })],
  lower: [chord("arrowdown", { ctrl: true })],
  nudgeLeft: [chord("arrowleft")],
  nudgeRight: [chord("arrowright")],
  nudgeUp: [chord("arrowup")],
  nudgeDown: [chord("arrowdown")],
  dropToWorkplane: [chord("d")],
  holeMode: [chord("h")],
  solidMode: [chord("s")],
  align: [chord("l")],
  mirror: [chord("m")],
  pattern: [],
  chamfer: [],
  fillet: [],
  escape: [chord("escape")],
  cameraHome: [chord("f"), chord("home")],
  zoomIn: [chord("="), chord("+")],
  zoomOut: [chord("-"), chord("_")],
  sketchLine: [chord("l")],
  sketchCircle: [chord("c")],
  sketchRectangle: [chord("r")],
  sketchDimension: [chord("d")],
  sketchExtrude: [chord("e")],
  sketchFocusToggle: [chord("tab")],
};

export function normalizeKey(key: string) {
  if (key === " ") return "space";
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

export function eventToChord(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): HotkeyChord {
  return {
    key: normalizeKey(event.key),
    ...(event.ctrlKey || event.metaKey ? { ctrl: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
  };
}

export function chordsEqual(a: HotkeyChord, b: HotkeyChord) {
  return (
    a.key === b.key
    && Boolean(a.ctrl) === Boolean(b.ctrl)
    && Boolean(a.shift) === Boolean(b.shift)
    && Boolean(a.alt) === Boolean(b.alt)
  );
}

export function formatHotkeyChord(value: HotkeyChord) {
  const parts: string[] = [];
  if (value.ctrl) parts.push("Ctrl");
  if (value.alt) parts.push("Alt");
  if (value.shift) parts.push("Shift");
  const keyLabel = (() => {
    switch (value.key) {
      case "arrowup": return "↑";
      case "arrowdown": return "↓";
      case "arrowleft": return "←";
      case "arrowright": return "→";
      case "escape": return "Esc";
      case "backspace": return "Backspace";
      case "delete": return "Delete";
      case "home": return "Home";
      case "space": return "Space";
      case " ": return "Space";
      default: return value.key.length === 1 ? value.key.toUpperCase() : value.key;
    }
  })();
  parts.push(keyLabel);
  return parts.join(" + ");
}

export function formatHotkeyBinding(chords: HotkeyChord[]) {
  if (!chords.length) return "None";
  return chords.map(formatHotkeyChord).join("  or  ");
}

export function cloneHotkeyBindings(bindings: HotkeyBindings): HotkeyBindings {
  const next = {} as HotkeyBindings;
  for (const action of HOTKEY_ACTIONS) {
    next[action.id] = (bindings[action.id] ?? []).map((entry) => ({ ...entry }));
  }
  return next;
}

export function normalizeHotkeyBindings(input: unknown): HotkeyBindings {
  const base = cloneHotkeyBindings(DEFAULT_HOTKEY_BINDINGS);
  if (!input || typeof input !== "object") return base;
  const record = input as Record<string, unknown>;
  for (const action of HOTKEY_ACTIONS) {
    const raw = record[action.id];
    if (!Array.isArray(raw)) continue;
    const chords: HotkeyChord[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const key = typeof (entry as HotkeyChord).key === "string" ? normalizeKey((entry as HotkeyChord).key) : "";
      if (!key) continue;
      chords.push({
        key,
        ...((entry as HotkeyChord).ctrl ? { ctrl: true } : {}),
        ...((entry as HotkeyChord).shift ? { shift: true } : {}),
        ...((entry as HotkeyChord).alt ? { alt: true } : {}),
      });
    }
    base[action.id] = chords;
  }
  return base;
}

export function loadHotkeyBindings(): HotkeyBindings {
  if (typeof window === "undefined") return cloneHotkeyBindings(DEFAULT_HOTKEY_BINDINGS);
  try {
    const raw = window.localStorage.getItem(HOTKEYS_STORAGE_KEY);
    if (!raw) return cloneHotkeyBindings(DEFAULT_HOTKEY_BINDINGS);
    return normalizeHotkeyBindings(JSON.parse(raw));
  } catch {
    return cloneHotkeyBindings(DEFAULT_HOTKEY_BINDINGS);
  }
}

export function saveHotkeyBindings(bindings: HotkeyBindings) {
  const normalized = normalizeHotkeyBindings(bindings);
  if (typeof window === "undefined") return normalized;
  try {
    window.localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new Event(HOTKEYS_CHANGED_EVENT));
  } catch {
    // Ignore storage failures.
  }
  return normalized;
}

export function resetHotkeyBindings() {
  return saveHotkeyBindings(DEFAULT_HOTKEY_BINDINGS);
}

function chordScore(value: HotkeyChord) {
  return (value.ctrl ? 1 : 0) + (value.shift ? 1 : 0) + (value.alt ? 1 : 0);
}

function metaFor(action: HotkeyActionId) {
  return HOTKEY_ACTIONS.find((entry) => entry.id === action);
}

/** Find which action a keyboard event should trigger, if any. */
export function matchHotkeyAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  bindings: HotkeyBindings,
  allowed?: readonly HotkeyActionId[],
  options?: { preferCategory?: HotkeyCategory },
): HotkeyActionId | null {
  const eventChord = eventToChord(event);
  let best: HotkeyActionId | null = null;
  let bestScore = -1;
  let bestCategory: HotkeyCategory | null = null;

  for (const action of HOTKEY_ACTIONS) {
    if (allowed && !allowed.includes(action.id)) continue;
    if (action.category === "Sketch" && options?.preferCategory !== "Sketch") continue;
    const chords = bindings[action.id] ?? [];
    for (const binding of chords) {
      const left = action.ignoreShift ? { ...eventChord, shift: undefined } : eventChord;
      const right = action.ignoreShift ? { ...binding, shift: undefined } : binding;
      if (!chordsEqual(left, right)) continue;
      const score = chordScore(binding);
      const prefer = options?.preferCategory;
      const beatsScore = score > bestScore;
      const tiesPrefer =
        score === bestScore
        && prefer
        && bestCategory !== prefer
        && action.category === prefer;
      if (beatsScore || tiesPrefer) {
        bestScore = score;
        best = action.id;
        bestCategory = action.category;
      }
    }
  }
  return best;
}

function hotkeyCategoriesOverlap(a: HotkeyCategory, b: HotkeyCategory) {
  return (a === "Sketch") === (b === "Sketch");
}

/** Return another action that already uses this chord, if any. */
export function findHotkeyConflict(
  bindings: HotkeyBindings,
  actionId: HotkeyActionId,
  chordValue: HotkeyChord,
): HotkeyActionId | null {
  const sourceCategory = metaFor(actionId)?.category;
  for (const action of HOTKEY_ACTIONS) {
    if (action.id === actionId) continue;
    if (sourceCategory && !hotkeyCategoriesOverlap(sourceCategory, action.category)) continue;
    const ignoreShift = Boolean(metaFor(action.id)?.ignoreShift || metaFor(actionId)?.ignoreShift);
    for (const existing of bindings[action.id] ?? []) {
      const left = ignoreShift ? { ...existing, shift: undefined } : existing;
      const right = ignoreShift ? { ...chordValue, shift: undefined } : chordValue;
      if (chordsEqual(left, right)) return action.id;
    }
  }
  return null;
}

export function setHotkeyBinding(
  bindings: HotkeyBindings,
  actionId: HotkeyActionId,
  chords: HotkeyChord[],
  options?: { clearConflicts?: boolean },
): HotkeyBindings {
  const next = cloneHotkeyBindings(bindings);
  next[actionId] = chords.map((entry) => ({ ...entry }));
  if (options?.clearConflicts) {
    for (const chordValue of chords) {
      const conflict = findHotkeyConflict(next, actionId, chordValue);
      if (!conflict) continue;
      next[conflict] = (next[conflict] ?? []).filter((entry) => !chordsEqual(entry, chordValue));
    }
  }
  return next;
}
