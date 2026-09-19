import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOTKEY_BINDINGS,
  eventToChord,
  findHotkeyConflict,
  formatHotkeyChord,
  matchHotkeyAction,
  normalizeHotkeyBindings,
  setHotkeyBinding,
} from "@/lib/hotkeys";

function keyEvent(partial: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}) {
  return {
    key: partial.key,
    ctrlKey: Boolean(partial.ctrlKey),
    metaKey: Boolean(partial.metaKey),
    shiftKey: Boolean(partial.shiftKey),
    altKey: Boolean(partial.altKey),
  };
}

describe("matchHotkeyAction", () => {
  it("matches default undo / redo / duplicate variants", () => {
    const bindings = DEFAULT_HOTKEY_BINDINGS;
    expect(matchHotkeyAction(keyEvent({ key: "z", ctrlKey: true }), bindings)).toBe("undo");
    expect(matchHotkeyAction(keyEvent({ key: "z", ctrlKey: true, shiftKey: true }), bindings)).toBe("redo");
    expect(matchHotkeyAction(keyEvent({ key: "y", metaKey: true }), bindings)).toBe("redo");
    expect(matchHotkeyAction(keyEvent({ key: "d", ctrlKey: true }), bindings)).toBe("duplicate");
    expect(matchHotkeyAction(keyEvent({ key: "d", ctrlKey: true, shiftKey: true }), bindings)).toBe("duplicateRepeat");
  });

  it("prefers more specific modifier chords", () => {
    expect(matchHotkeyAction(keyEvent({ key: "h", ctrlKey: true, shiftKey: true }), DEFAULT_HOTKEY_BINDINGS)).toBe("showHidden");
    expect(matchHotkeyAction(keyEvent({ key: "h", ctrlKey: true }), DEFAULT_HOTKEY_BINDINGS)).toBe("toggleHidden");
    expect(matchHotkeyAction(keyEvent({ key: "h" }), DEFAULT_HOTKEY_BINDINGS)).toBe("holeMode");
  });

  it("lets L and D mean geometry tools unless Sketch is preferred", () => {
    const bindings = DEFAULT_HOTKEY_BINDINGS;
    expect(matchHotkeyAction(keyEvent({ key: "l" }), bindings)).toBe("align");
    expect(matchHotkeyAction(keyEvent({ key: "d" }), bindings)).toBe("dropToWorkplane");
    expect(matchHotkeyAction(keyEvent({ key: "l" }), bindings, undefined, { preferCategory: "Sketch" })).toBe("sketchLine");
    expect(matchHotkeyAction(keyEvent({ key: "d" }), bindings, undefined, { preferCategory: "Sketch" })).toBe("sketchDimension");
  });
});

describe("setHotkeyBinding", () => {
  it("clears conflicting bindings when requested", () => {
    const next = setHotkeyBinding(DEFAULT_HOTKEY_BINDINGS, "pattern", [eventToChord(keyEvent({ key: "m" }))], {
      clearConflicts: true,
    });
    expect(matchHotkeyAction(keyEvent({ key: "m" }), next)).toBe("pattern");
    expect(next.mirror).toEqual([]);
    expect(findHotkeyConflict(next, "pattern", eventToChord(keyEvent({ key: "m" })))).toBeNull();
  });

  it("lets Sketch line and Align share L across modes", () => {
    expect(findHotkeyConflict(DEFAULT_HOTKEY_BINDINGS, "align", eventToChord(keyEvent({ key: "l" })))).toBeNull();
    expect(findHotkeyConflict(DEFAULT_HOTKEY_BINDINGS, "sketchLine", eventToChord(keyEvent({ key: "l" })))).toBeNull();
    const next = setHotkeyBinding(DEFAULT_HOTKEY_BINDINGS, "align", [eventToChord(keyEvent({ key: "l" }))], {
      clearConflicts: true,
    });
    expect(next.sketchLine).toEqual(DEFAULT_HOTKEY_BINDINGS.sketchLine);
  });
});

describe("normalizeHotkeyBindings", () => {
  it("fills missing actions from defaults", () => {
    const normalized = normalizeHotkeyBindings({ undo: [{ key: "u", ctrl: true }] });
    expect(normalized.undo).toEqual([{ key: "u", ctrl: true }]);
    expect(normalized.copy).toEqual(DEFAULT_HOTKEY_BINDINGS.copy);
  });
});

describe("formatHotkeyChord", () => {
  it("formats modifier chords for the settings UI", () => {
    expect(formatHotkeyChord({ key: "z", ctrl: true, shift: true })).toBe("Ctrl + Shift + Z");
    expect(formatHotkeyChord({ key: "arrowup" })).toBe("↑");
  });
});
