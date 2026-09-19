"use client";

import { Ellipsis } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import {
  ToolbarAlignIcon,
  ToolbarChamferIcon,
  ToolbarCircularPatternIcon,
  ToolbarCopyIcon,
  ToolbarLinearPatternIcon,
  ToolbarDuplicateIcon,
  ToolbarDuplicateRepeatIcon,
  ToolbarFilletIcon,
  ToolbarGroupIcon,
  ToolbarIntersectionIcon,
  ToolbarMirrorIcon,
  ToolbarPasteIcon,
  ToolbarRedoIcon,
  ToolbarTrashIcon,
  ToolbarUngroupIcon,
  ToolbarUndoIcon,
} from "@/components/icons";
import { PeakTooltip, usePeakContextHelp, usePeakTooltip } from "@/components/workplane/ToolNameTooltip";
import { TOOL_DESCRIPTIONS } from "@/lib/toolDescriptions";
import type { CadModifierKind } from "@/lib/cadModifierTypes";
import { formatHotkeyBinding, HOTKEYS_CHANGED_EVENT, loadHotkeyBindings, type HotkeyActionId, type HotkeyBindings } from "@/lib/hotkeys";

type ToolbarMode = "geometry" | "sketch";

type ToolDef = {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  iconClassName?: string;
  action: () => void;
  enabled: boolean;
  active?: boolean;
  shortcut?: string;
  disabledReason?: string;
};

type ToolSection = {
  title: string;
  tools: ToolDef[];
};

const TOOL_SLOT_PX = 42;
const MORE_SLOT_PX = 42;

/** Live hotkey bindings so toolbar tooltips reflect any user remaps. */
function useHotkeyBindings(): HotkeyBindings {
  const [bindings, setBindings] = useState<HotkeyBindings>(() => loadHotkeyBindings());
  useEffect(() => {
    const refresh = () => setBindings(loadHotkeyBindings());
    window.addEventListener(HOTKEYS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(HOTKEYS_CHANGED_EVENT, refresh);
  }, []);
  return bindings;
}

function shortcutLabel(bindings: HotkeyBindings, actionId: HotkeyActionId) {
  const label = formatHotkeyBinding(bindings[actionId] ?? []);
  return label === "None" ? undefined : label;
}

function ToolbarButton({ tool }: { tool: ToolDef }) {
  const Icon = tool.icon;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hasDescription = Boolean(tool.description && tool.description.trim() && tool.description.trim() !== tool.label);
  const disabledHint = !tool.enabled ? tool.disabledReason : undefined;
  const { open, tooltipProps, hide } = usePeakTooltip(tool.shortcut || hasDescription || disabledHint ? 500 : undefined);
  const { onContextMenu, helpPortal } = usePeakContextHelp(tool.label, tool.description);

  return (
    <button
      ref={buttonRef}
      className={`toolbar-icon ${tool.enabled ? "" : "disabled"} ${tool.active ? "active" : ""}`}
      type="button"
      aria-label={tool.label}
      aria-disabled={!tool.enabled}
      data-toolbar-tool={tool.label}
      {...tooltipProps}
      onMouseDown={(event) => {
        event.preventDefault();
        hide();
      }}
      onContextMenu={onContextMenu}
      onClick={() => {
        if (!tool.enabled) return;
        tool.action();
      }}
    >
      <Icon className={tool.iconClassName} />
      <PeakTooltip
        label={tool.label}
        open={open}
        anchorRef={buttonRef}
        shortcut={tool.enabled ? tool.shortcut : undefined}
        hint={disabledHint ?? (hasDescription ? "Right-click for help" : undefined)}
      />
      {helpPortal}
    </button>
  );
}

function pickVisibleLabels(tools: ToolDef[], availablePx: number): string[] {
  const labels = tools.map((tool) => tool.label);
  const allWidth = labels.length * TOOL_SLOT_PX;
  if (allWidth <= availablePx) {
    return labels;
  }
  const slots = Math.max(0, Math.floor((availablePx - MORE_SLOT_PX) / TOOL_SLOT_PX));
  if (slots >= labels.length) {
    return labels;
  }
  const visible = new Set(labels.slice(0, slots));
  for (const tool of tools) {
    if (!tool.active || visible.has(tool.label)) {
      continue;
    }
    const victim = [...visible].reverse().find((label) => !tools.find((candidate) => candidate.label === label)?.active);
    if (victim) {
      visible.delete(victim);
      visible.add(tool.label);
    }
  }
  return labels.filter((label) => visible.has(label));
}

function OverflowToolRow({
  sections,
  align = "start",
}: {
  sections: ToolSection[];
  align?: "start" | "end";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tools = sections.flatMap((section) => section.tools);
  const [visibleLabels, setVisibleLabels] = useState<string[]>(() => tools.map((tool) => tool.label));
  const [menuOpen, setMenuOpen] = useState(false);

  const toolFingerprint = tools.map((tool) => `${tool.label}:${tool.active ? "1" : "0"}`).join("|");

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const measure = () => {
      setVisibleLabels(pickVisibleLabels(tools, host.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
    // tools is rebuilt each render; fingerprint captures layout-relevant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolFingerprint]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (hostRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const visible = new Set(visibleLabels);
  const overflow = tools.filter((tool) => !visible.has(tool.label));
  const overflowActive = overflow.some((tool) => tool.active);

  return (
    <div ref={hostRef} className={`toolbar-overflow-cluster toolbar-overflow-cluster--${align}`}>
      {sections.map((section) => {
        const shown = section.tools.filter((tool) => visible.has(tool.label));
        if (shown.length === 0) {
          return null;
        }
        return (
          <div key={section.title} className="toolbar-section compact toolbar-section--no-label" aria-label={section.title}>
            <div className="toolbar-section-tools">
              {shown.map((tool) => (
                <ToolbarButton key={tool.label} tool={tool} />
              ))}
            </div>
          </div>
        );
      })}
      {overflow.length > 0 ? (
        <div className="toolbar-overflow-more">
          <button
            className={`toolbar-icon ${overflowActive || menuOpen ? "active" : ""}`}
            type="button"
            aria-label="More tools"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Ellipsis size={22} strokeWidth={2.2} aria-hidden="true" />
          </button>
          {menuOpen ? (
            <div ref={menuRef} className="toolbar-overflow-menu" role="menu" aria-label="More tools">
              {overflow.map((tool) => {
                const Icon = tool.icon;
                return (
                  <button
                    key={tool.label}
                    type="button"
                    role="menuitem"
                    className={`${tool.enabled ? "" : "disabled"} ${tool.active ? "active" : ""}`}
                    aria-disabled={!tool.enabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (!tool.enabled) {
                        return;
                      }
                      tool.action();
                      setMenuOpen(false);
                    }}
                  >
                    <Icon className={tool.iconClassName} />
                    <span>{tool.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function EditorModeStrip({
  canUndo,
  canRedo,
  canCopy,
  canPaste,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
}: {
  toolbarMode?: ToolbarMode;
  onToolbarModeChange?: (mode: ToolbarMode) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
}) {
  const hotkeys = useHotkeyBindings();
  if (!onUndo || !onRedo) {
    return null;
  }
  return (
    <OverflowToolRow
      sections={[
        {
          title: "Edit",
          tools: [
            { label: "Undo", description: TOOL_DESCRIPTIONS.undo, icon: ToolbarUndoIcon, action: onUndo, enabled: Boolean(canUndo), shortcut: shortcutLabel(hotkeys, "undo") },
            { label: "Redo", description: TOOL_DESCRIPTIONS.redo, icon: ToolbarRedoIcon, action: onRedo, enabled: Boolean(canRedo), shortcut: shortcutLabel(hotkeys, "redo") },
            ...(onCopy
              ? [{ label: "Copy", description: TOOL_DESCRIPTIONS.copy, icon: ToolbarCopyIcon, action: onCopy, enabled: Boolean(canCopy), shortcut: shortcutLabel(hotkeys, "copy") }]
              : []),
            ...(onPaste
              ? [{ label: "Paste", description: TOOL_DESCRIPTIONS.paste, icon: ToolbarPasteIcon, action: onPaste, enabled: Boolean(canPaste), shortcut: shortcutLabel(hotkeys, "paste") }]
              : []),
          ],
        },
      ]}
    />
  );
}

export function EditorViewportToolbar({
  cluster = "all",
  canUndo,
  canRedo,
  hasClipboard,
  hasSelection,
  canGroup,
  canIntersect,
  canUngroup,
  alignMode,
  canAlign,
  canEdgeModify,
  edgeModifierKind,
  circularPatternActive,
  canCircularPattern,
  linearPatternActive,
  canLinearPattern,
  mirrorMode,
  onCopy,
  onPaste,
  onDuplicate,
  onDuplicateAndRepeat,
  onDelete,
  onUndo,
  onRedo,
  onGroup,
  onUngroup,
  onIntersect,
  onAlign,
  onMirror,
  onCircularPattern,
  onLinearPattern,
  onChamfer,
  onFillet,
}: {
  cluster?: "all" | "edit" | "modify";
  toolbarMode?: ToolbarMode;
  onToolbarModeChange?: (mode: ToolbarMode) => void;
  canUndo: boolean;
  canRedo: boolean;
  hasClipboard: boolean;
  hasSelection: boolean;
  canGroup: boolean;
  canIntersect: boolean;
  canUngroup: boolean;
  alignMode: boolean;
  canAlign: boolean;
  canEdgeModify: boolean;
  edgeModifierKind: CadModifierKind | null;
  circularPatternActive: boolean;
  canCircularPattern: boolean;
  linearPatternActive: boolean;
  canLinearPattern: boolean;
  mirrorMode: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onDuplicateAndRepeat: () => void;
  onDelete: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onIntersect: () => void;
  onAlign: () => void;
  onMirror: () => void;
  onCircularPattern: () => void;
  onLinearPattern: () => void;
  onChamfer: () => void;
  onFillet: () => void;
}) {
  const hotkeys = useHotkeyBindings();

  const editSection: ToolSection = {
    title: "Edit",
    tools: [
        { label: "Undo", description: TOOL_DESCRIPTIONS.undo, icon: ToolbarUndoIcon, action: onUndo, enabled: canUndo, shortcut: shortcutLabel(hotkeys, "undo"), disabledReason: "Nothing to undo" },
        { label: "Redo", description: TOOL_DESCRIPTIONS.redo, icon: ToolbarRedoIcon, action: onRedo, enabled: canRedo, shortcut: shortcutLabel(hotkeys, "redo"), disabledReason: "Nothing to redo" },
        { label: "Copy", description: TOOL_DESCRIPTIONS.copy, icon: ToolbarCopyIcon, action: onCopy, enabled: hasSelection, shortcut: shortcutLabel(hotkeys, "copy"), disabledReason: "Select a shape first" },
        { label: "Paste", description: TOOL_DESCRIPTIONS.paste, icon: ToolbarPasteIcon, action: onPaste, enabled: hasClipboard, shortcut: shortcutLabel(hotkeys, "paste"), disabledReason: "Nothing to paste" },
        { label: "Duplicate", description: TOOL_DESCRIPTIONS.duplicate, icon: ToolbarDuplicateIcon, action: onDuplicate, enabled: hasSelection, shortcut: shortcutLabel(hotkeys, "duplicate"), disabledReason: "Select a shape first" },
        { label: "Duplicate and repeat", description: TOOL_DESCRIPTIONS.duplicateRepeat, icon: ToolbarDuplicateRepeatIcon, action: onDuplicateAndRepeat, enabled: hasSelection, shortcut: shortcutLabel(hotkeys, "duplicateRepeat"), disabledReason: "Select a shape first" },
        { label: "Delete", description: TOOL_DESCRIPTIONS.delete, icon: ToolbarTrashIcon, action: onDelete, enabled: hasSelection, shortcut: shortcutLabel(hotkeys, "delete"), disabledReason: "Select a shape first" },
    ],
  };
  const combineSection: ToolSection = {
    title: "Combine",
    tools: [
        { label: "Group", description: TOOL_DESCRIPTIONS.group, icon: ToolbarGroupIcon, action: onGroup, enabled: canGroup, shortcut: shortcutLabel(hotkeys, "group"), disabledReason: "Select two or more shapes to group" },
        { label: "Ungroup", description: TOOL_DESCRIPTIONS.ungroup, icon: ToolbarUngroupIcon, action: onUngroup, enabled: canUngroup, shortcut: shortcutLabel(hotkeys, "ungroup"), disabledReason: "Select a grouped shape to ungroup" },
        { label: "Intersect", description: TOOL_DESCRIPTIONS.intersect, icon: ToolbarIntersectionIcon, action: onIntersect, enabled: canIntersect, disabledReason: "Select a solid and a hole shape" },
    ],
  };
  const modifySection: ToolSection = {
    title: "Modify",
    tools: [
        { label: "Align", description: TOOL_DESCRIPTIONS.align, icon: ToolbarAlignIcon, action: onAlign, enabled: canAlign, active: alignMode, shortcut: shortcutLabel(hotkeys, "align"), disabledReason: "Select two or more shapes to align" },
        { label: "Mirror", description: TOOL_DESCRIPTIONS.mirror, icon: ToolbarMirrorIcon, action: onMirror, enabled: hasSelection, active: mirrorMode, shortcut: shortcutLabel(hotkeys, "mirror"), disabledReason: "Select a shape first" },
        { label: "Circular pattern", description: TOOL_DESCRIPTIONS.pattern, icon: ToolbarCircularPatternIcon, action: onCircularPattern, enabled: canCircularPattern || circularPatternActive, active: circularPatternActive, shortcut: shortcutLabel(hotkeys, "pattern"), disabledReason: "Select an unlocked shape first" },
        { label: "Linear pattern", description: TOOL_DESCRIPTIONS.linearPattern, icon: ToolbarLinearPatternIcon, action: onLinearPattern, enabled: canLinearPattern || linearPatternActive, active: linearPatternActive, disabledReason: "Select an unlocked shape first" },
        { label: "Chamfer", description: TOOL_DESCRIPTIONS.chamfer, icon: ToolbarChamferIcon, action: onChamfer, enabled: canEdgeModify, active: edgeModifierKind === "chamfer", shortcut: shortcutLabel(hotkeys, "chamfer"), disabledReason: "Select a single unlocked shape first" },
        { label: "Fillet", description: TOOL_DESCRIPTIONS.fillet, icon: ToolbarFilletIcon, action: onFillet, enabled: canEdgeModify, active: edgeModifierKind === "fillet", shortcut: shortcutLabel(hotkeys, "fillet"), disabledReason: "Select a single unlocked shape first" },
    ],
  };

  const sections =
    cluster === "edit" ? [editSection]
      : cluster === "modify" ? [combineSection, modifySection]
        : [editSection, combineSection, modifySection];

  return <OverflowToolRow sections={sections} align={cluster === "modify" ? "end" : "start"} />;
}
