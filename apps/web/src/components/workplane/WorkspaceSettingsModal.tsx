"use client";

import { BookOpen, FolderDown, Grid3X3, Keyboard, Palette, Ruler, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PeakTipButton, PeakTipLabel } from "@/components/workplane/ToolNameTooltip";
import {
  cloneHotkeyBindings,
  eventToChord,
  findHotkeyConflict,
  formatHotkeyBinding,
  HOTKEY_ACTIONS,
  HOTKEY_CATEGORIES,
  loadHotkeyBindings,
  resetHotkeyBindings,
  saveHotkeyBindings,
  setHotkeyBinding,
  setHotkeyRecordingActive,
  type HotkeyActionId,
  type HotkeyBindings,
} from "@/lib/hotkeys";
import { normalizeScaleForUnits, scaleOptionsForUnits, WORKSPACE_UNIT_OPTIONS } from "@/lib/measurementUnits";
import { TOOL_DESCRIPTIONS, TOOL_INDEX, TOOL_INDEX_CATEGORIES } from "@/lib/toolDescriptions";
import { DISPLAY_QUALITY_OPTIONS } from "@/lib/displayTessellation";
import { DOWNLOAD_FOLDER_STORAGE_KEY } from "@/lib/downloadFile";
import { loadUiTheme, setUiTheme, type UiTheme } from "@/lib/uiTheme";
import { DEFAULT_WORKPLANE_WORKSPACE } from "@/lib/workplaneSettings";
import type { DisplayQuality, GridSize, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

type WorkspaceSettings = WorkplaneWorkspaceSettings;
type WorkspaceSettingsSection = "appearance" | "measurement" | "workplane" | "files" | "tools" | "hotkeys";
type WorkspaceSettingsContext = "project" | "app";

function loadDownloadFolder() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(DOWNLOAD_FOLDER_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveDownloadFolder(value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DOWNLOAD_FOLDER_STORAGE_KEY, value);
  } catch {
    // Path still applies for this session via caller state when provided.
  }
}

const GRID_SIZES: GridSize[] = ["Off", "0.1 mm", "0.25 mm", "0.5 mm", "1.0 mm", "2.0 mm", "5.0 mm", "Brick"];
const MIN_WORKSPACE_SIZE = 60;
const MAX_WORKSPACE_SIZE = 2000;
const MIN_GRID_BLOCK_SIZE = 1;
const MAX_GRID_BLOCK_SIZE = 200;
const WORKSPACE_SIZE_PRESETS = [
  { label: "200 x 200 mm", width: 200, depth: 200 },
  { label: "300 x 300 mm", width: 300, depth: 300 },
  { label: "500 x 500 mm", width: 500, depth: 500 },
  { label: "1000 x 1000 mm", width: 1000, depth: 1000 },
  { label: "2000 x 2000 mm", width: 2000, depth: 2000 },
  { label: "Custom", width: 200, depth: 200 },
];
const GRID_BLOCK_PRESETS = ["1 mm", "2.5 mm", "5 mm", "10 mm", "20 mm", "50 mm", "100 mm", "Custom"] as const;

const SETTING_TIPS = {
  showShadows: "Cast soft shadows from shapes onto the workplane to make depth easier to read.",
  showGrid: "Show or hide the grid lines drawn on the workplane.",
  displayQuality: "How densely curved surfaces are tessellated in the viewport and for booleans. Smooth looks rounder; Draft is faster on large scenes.",
  cruiseShapes: "Keep camera orbit and pan available while placing a new shape so you can reframe mid-add.",
  zoomSpeed: "How quickly the camera zooms when you scroll the mouse wheel.",
  units: "Choose metric, imperial, or brick studs for displayed measurements.",
  scale: "Map model units to real-world size, such as 1:1 millimeters or meters.",
  accuracy: "How many decimal places to show for typed and displayed dimensions.",
  snapGrid: "Snap moves and resizes to this spacing. Choose Off to place freely.",
  workplaneSize: "Preset overall size of the modeling plate.",
  width: "Workplane size along X, in the current units.",
  length: "Workplane size along Z (length/depth), in the current units.",
  gridBlockSize: "Spacing between major grid lines on the workplane.",
  blockSize: "Custom spacing between grid lines when Grid block size is set to Custom.",
  makeDefault: "Save these settings as the default for this project.",
  makeDefaultApp: "Save these settings as the default for new projects.",
  uiTheme: "Switch PeakCAD’s chrome between light and dark. Applies to the dashboard and editor.",
  downloadFolder: "Local folder used for exported files and downloads on this computer.",
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function gridBlockSizeForPreset(preset: string, fallback: number) {
  if (preset === "Custom") {
    return clamp(fallback, MIN_GRID_BLOCK_SIZE, MAX_GRID_BLOCK_SIZE);
  }
  return clamp(Number.parseFloat(preset) || DEFAULT_WORKPLANE_WORKSPACE.gridBlockSize, MIN_GRID_BLOCK_SIZE, MAX_GRID_BLOCK_SIZE);
}

export function WorkspaceSettingsModal({
  workspace,
  snap,
  onWorkspaceChange,
  onSnapChange,
  onMakeDefault,
  onClose,
  context = "project",
  downloadFolder,
  onDownloadFolderChange,
}: {
  workspace: WorkspaceSettings;
  snap: GridSize;
  onWorkspaceChange: (next: WorkspaceSettings) => void;
  onSnapChange: (next: GridSize) => void;
  onMakeDefault: () => void;
  onClose: () => void;
  context?: WorkspaceSettingsContext;
  downloadFolder?: string;
  onDownloadFolderChange?: (value: string) => void;
}) {
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [activeSection, setActiveSection] = useState<WorkspaceSettingsSection>("appearance");
  const [uiTheme, setUiThemeState] = useState<UiTheme>(() => loadUiTheme());
  const [localDownloadFolder, setLocalDownloadFolder] = useState(() => downloadFolder ?? loadDownloadFolder());
  const [toolQuery, setToolQuery] = useState("");
  const [hotkeyQuery, setHotkeyQuery] = useState("");
  const [hotkeys, setHotkeys] = useState<HotkeyBindings>(() => loadHotkeyBindings());
  const [recordingAction, setRecordingAction] = useState<HotkeyActionId | null>(null);
  const [hotkeyNotice, setHotkeyNotice] = useState<string | null>(null);
  const [dimensionDrafts, setDimensionDrafts] = useState(() => ({
    width: workspace.width.toFixed(workspace.accuracy),
    depth: workspace.depth.toFixed(workspace.accuracy),
  }));
  const downloadFolderValue = downloadFolder ?? localDownloadFolder;
  const scaleOptions = scaleOptionsForUnits(workspace.units);
  const scaleValue = normalizeScaleForUnits(workspace.units, workspace.scale);

  useEffect(() => {
    if (typeof downloadFolder === "string") {
      setLocalDownloadFolder(downloadFolder);
    }
  }, [downloadFolder]);
  const toolQueryNormalized = toolQuery.trim().toLowerCase();
  const filteredToolIndex = !toolQueryNormalized
    ? TOOL_INDEX
    : TOOL_INDEX.filter((entry) => {
      const description = TOOL_DESCRIPTIONS[entry.key].toLowerCase();
      return (
        entry.label.toLowerCase().includes(toolQueryNormalized)
        || entry.category.toLowerCase().includes(toolQueryNormalized)
        || description.includes(toolQueryNormalized)
      );
    });
  const hotkeyQueryNormalized = hotkeyQuery.trim().toLowerCase();
  const filteredHotkeyActions = !hotkeyQueryNormalized
    ? HOTKEY_ACTIONS
    : HOTKEY_ACTIONS.filter((entry) => (
      entry.label.toLowerCase().includes(hotkeyQueryNormalized)
      || entry.category.toLowerCase().includes(hotkeyQueryNormalized)
      || entry.description.toLowerCase().includes(hotkeyQueryNormalized)
      || formatHotkeyBinding(hotkeys[entry.id]).toLowerCase().includes(hotkeyQueryNormalized)
    ));
  useEffect(() => {
    setDimensionDrafts({
      width: workspace.width.toFixed(workspace.accuracy),
      depth: workspace.depth.toFixed(workspace.accuracy),
    });
  }, [workspace.accuracy, workspace.depth, workspace.width]);
  useEffect(() => {
    setHotkeyRecordingActive(Boolean(recordingAction));
    return () => setHotkeyRecordingActive(false);
  }, [recordingAction]);
  useEffect(() => {
    if (!recordingAction) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const key = event.key;
      if (key === "Escape") {
        setRecordingAction(null);
        setHotkeyNotice("Recording cancelled");
        return;
      }
      if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
        return;
      }
      const nextChord = eventToChord(event);
      const conflict = findHotkeyConflict(hotkeys, recordingAction, nextChord);
      const conflictLabel = conflict
        ? HOTKEY_ACTIONS.find((entry) => entry.id === conflict)?.label ?? conflict
        : null;
      const next = setHotkeyBinding(hotkeys, recordingAction, [nextChord], { clearConflicts: true });
      const saved = saveHotkeyBindings(next);
      setHotkeys(saved);
      setRecordingAction(null);
      setHotkeyNotice(
        conflictLabel
          ? `Mapped · removed from ${conflictLabel}`
          : "Hotkey saved",
      );
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [hotkeys, recordingAction]);
  useEffect(() => {
    if (!hotkeyNotice) return;
    const timer = window.setTimeout(() => setHotkeyNotice(null), 2200);
    return () => window.clearTimeout(timer);
  }, [hotkeyNotice]);
  const patchWorkspace = (patch: Partial<WorkspaceSettings>) => {
    setDefaultSaved(false);
    const next = { ...workspace, ...patch };
    onWorkspaceChange({ ...next, scale: normalizeScaleForUnits(next.units, next.scale) });
  };
  const setDimension = (key: "width" | "depth", value: string) => {
    const parsed = Number.parseFloat(value);
    const next = clamp(Number.isFinite(parsed) ? parsed : workspace[key], MIN_WORKSPACE_SIZE, MAX_WORKSPACE_SIZE);
    setDimensionDrafts((current) => ({ ...current, [key]: next.toFixed(workspace.accuracy) }));
    patchWorkspace({ [key]: next, sizePreset: "Custom" } as Partial<WorkspaceSettings>);
  };
  const setWorkspaceSizePreset = (sizePreset: string) => {
    const preset = WORKSPACE_SIZE_PRESETS.find((entry) => entry.label === sizePreset);
    if (!preset || sizePreset === "Custom") {
      patchWorkspace({ sizePreset: "Custom" });
      return;
    }
    patchWorkspace({ sizePreset, width: preset.width, depth: preset.depth });
  };
  const setGridBlockPreset = (gridBlockPreset: string) => {
    patchWorkspace({ gridBlockPreset, gridBlockSize: gridBlockSizeForPreset(gridBlockPreset, workspace.gridBlockSize) });
  };
  const setGridBlockSize = (value: string) => {
    const next = clamp(Number.parseFloat(value) || DEFAULT_WORKPLANE_WORKSPACE.gridBlockSize, MIN_GRID_BLOCK_SIZE, MAX_GRID_BLOCK_SIZE);
    patchWorkspace({ gridBlockPreset: "Custom", gridBlockSize: next });
  };

  return (
    <div className={`workspace-modal${context === "app" ? " workspace-modal-app" : ""}`} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="workspace-modal-card" onPointerDown={(event) => event.stopPropagation()}>
        <header className="workspace-modal-header">
          <strong>Settings</strong>
          <button aria-label="Close settings" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="workspace-modal-layout">
          <nav className="workspace-settings-nav" aria-label="Settings sections">
            <button className={activeSection === "appearance" ? "active" : ""} aria-current={activeSection === "appearance" ? "page" : undefined} onClick={() => setActiveSection("appearance")}>
              <Palette size={18} />
              <span>Appearance</span>
            </button>
            <button className={activeSection === "measurement" ? "active" : ""} aria-current={activeSection === "measurement" ? "page" : undefined} onClick={() => setActiveSection("measurement")}>
              <Ruler size={18} />
              <span>Measurement</span>
            </button>
            <button className={activeSection === "workplane" ? "active" : ""} aria-current={activeSection === "workplane" ? "page" : undefined} onClick={() => setActiveSection("workplane")}>
              <Grid3X3 size={18} />
              <span>Workplane</span>
            </button>
            <button className={activeSection === "files" ? "active" : ""} aria-current={activeSection === "files" ? "page" : undefined} onClick={() => setActiveSection("files")}>
              <FolderDown size={18} />
              <span>Files</span>
            </button>
            <button className={activeSection === "tools" ? "active" : ""} aria-current={activeSection === "tools" ? "page" : undefined} onClick={() => setActiveSection("tools")}>
              <BookOpen size={18} />
              <span>Tools</span>
            </button>
            <button className={activeSection === "hotkeys" ? "active" : ""} aria-current={activeSection === "hotkeys" ? "page" : undefined} onClick={() => setActiveSection("hotkeys")}>
              <Keyboard size={18} />
              <span>Hotkeys</span>
            </button>
          </nav>

          <div className="workspace-modal-content">
            <div className="workspace-modal-body">
              {activeSection === "appearance" ? (
                <>
                  <div className="workspace-section-heading">
                    <strong>Appearance</strong>
                    <span>Adjust the canvas and navigation behavior.</span>
                  </div>
                  <WorkspaceSelect
                    label="Theme"
                    tip={SETTING_TIPS.uiTheme}
                    value={uiTheme === "dark" ? "Dark" : "Light"}
                    options={["Light", "Dark"]}
                    onChange={(label) => {
                      const next = label === "Dark" ? "dark" : "light";
                      setUiThemeState(next);
                      setUiTheme(next);
                    }}
                  />
                  <WorkspaceToggle
                    label="Show shadows"
                    tip={SETTING_TIPS.showShadows}
                    checked={workspace.showShadows}
                    onChange={(showShadows) => patchWorkspace({ showShadows })}
                  />
                  <WorkspaceToggle
                    label="Show grid"
                    tip={SETTING_TIPS.showGrid}
                    checked={workspace.showGrid}
                    onChange={(showGrid) => patchWorkspace({ showGrid })}
                  />
                  <WorkspaceSelect
                    label="Display quality"
                    tip={SETTING_TIPS.displayQuality}
                    value={workspace.displayQuality === "draft" ? "Draft" : workspace.displayQuality === "standard" ? "Standard" : "Smooth"}
                    options={["Draft", "Standard", "Smooth"]}
                    onChange={(label) => {
                      const displayQuality = (
                        label === "Draft" ? "draft" : label === "Standard" ? "standard" : "smooth"
                      ) as DisplayQuality;
                      if (!DISPLAY_QUALITY_OPTIONS.includes(displayQuality)) return;
                      patchWorkspace({ displayQuality });
                    }}
                  />
                  <WorkspaceToggle
                    label="Cruise when adding new shapes"
                    tip={SETTING_TIPS.cruiseShapes}
                    checked={workspace.cruiseShapes}
                    onChange={(cruiseShapes) => patchWorkspace({ cruiseShapes })}
                  />
                  <PeakTipLabel label={SETTING_TIPS.zoomSpeed} helpTitle="Zoom speed" description={SETTING_TIPS.zoomSpeed} className="workspace-range">
                    <span>Zoom speed</span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={workspace.zoomSpeed}
                      onChange={(event) => patchWorkspace({ zoomSpeed: Number(event.currentTarget.value) })}
                    />
                    <small>
                      <span>Slow</span>
                      <span>Fast</span>
                    </small>
                  </PeakTipLabel>
                  <p className="workspace-about-credit">PeakCAD is made by Peak Horology.</p>
                </>
              ) : null}

              {activeSection === "measurement" ? (
                <>
                  <div className="workspace-section-heading">
                    <strong>Measurement</strong>
                    <span>Choose units, precision, scale, and snapping.</span>
                  </div>
                  <WorkspaceSelect
                    label="Units"
                    tip={SETTING_TIPS.units}
                    value={workspace.units}
                    options={WORKSPACE_UNIT_OPTIONS}
                    onChange={(units) => patchWorkspace({ units })}
                  />
                  <WorkspaceSelect
                    label="Scale"
                    tip={SETTING_TIPS.scale}
                    value={scaleValue}
                    options={scaleOptions}
                    onChange={(scale) => patchWorkspace({ scale })}
                  />
                  <WorkspaceSelect
                    label="Accuracy"
                    tip={SETTING_TIPS.accuracy}
                    value={`0.${"0".repeat(workspace.accuracy)}`}
                    options={["0.0", "0.00", "0.000"]}
                    onChange={(accuracy) => patchWorkspace({ accuracy: accuracy.slice(2).length as WorkspaceSettings["accuracy"] })}
                  />
                  <WorkspaceSelect
                    label="Snap Grid"
                    tip={SETTING_TIPS.snapGrid}
                    value={snap}
                    options={GRID_SIZES}
                    onChange={(next) => {
                      setDefaultSaved(false);
                      onSnapChange(next as GridSize);
                    }}
                  />
                </>
              ) : null}

              {activeSection === "workplane" ? (
                <>
                  <div className="workspace-section-heading">
                    <strong>Workplane</strong>
                    <span>Set the plate dimensions and visible grid spacing.</span>
                  </div>
                  <WorkspaceSelect
                    label="Workplane size"
                    tip={SETTING_TIPS.workplaneSize}
                    value={workspace.sizePreset}
                    options={WORKSPACE_SIZE_PRESETS.map((preset) => preset.label)}
                    onChange={setWorkspaceSizePreset}
                  />
                  <div className="workspace-dimensions">
                    <PeakTipLabel label={SETTING_TIPS.width} helpTitle="Width" description={SETTING_TIPS.width}>
                      <span>Width</span>
                      <input
                        type="number"
                        value={dimensionDrafts.width}
                        min={MIN_WORKSPACE_SIZE}
                        max={MAX_WORKSPACE_SIZE}
                        step={1}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setDimensionDrafts((current) => ({ ...current, width: value }));
                        }}
                        onBlur={(event) => setDimension("width", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </PeakTipLabel>
                    <PeakTipLabel label={SETTING_TIPS.length} helpTitle="Length" description={SETTING_TIPS.length}>
                      <span>Length</span>
                      <input
                        type="number"
                        value={dimensionDrafts.depth}
                        min={MIN_WORKSPACE_SIZE}
                        max={MAX_WORKSPACE_SIZE}
                        step={1}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setDimensionDrafts((current) => ({ ...current, depth: value }));
                        }}
                        onBlur={(event) => setDimension("depth", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </PeakTipLabel>
                  </div>
                  <WorkspaceSelect
                    label="Grid block size"
                    tip={SETTING_TIPS.gridBlockSize}
                    value={workspace.gridBlockPreset}
                    options={GRID_BLOCK_PRESETS}
                    onChange={setGridBlockPreset}
                  />
                  {workspace.gridBlockPreset === "Custom" ? (
                    <div className="workspace-dimensions workspace-grid-dimensions">
                      <PeakTipLabel label={SETTING_TIPS.blockSize} helpTitle="Block size" description={SETTING_TIPS.blockSize}>
                        <span>Block size</span>
                        <input
                          type="number"
                          value={workspace.gridBlockSize.toFixed(workspace.accuracy)}
                          min={MIN_GRID_BLOCK_SIZE}
                          max={MAX_GRID_BLOCK_SIZE}
                          step={0.5}
                          onChange={(event) => setGridBlockSize(event.currentTarget.value)}
                        />
                      </PeakTipLabel>
                    </div>
                  ) : null}
                </>
              ) : null}

              {activeSection === "files" ? (
                <>
                  <div className="workspace-section-heading">
                    <strong>Files</strong>
                    <span>Choose where PeakCAD writes exported files on this computer.</span>
                  </div>
                  <PeakTipLabel
                    label={SETTING_TIPS.downloadFolder}
                    helpTitle="Download folder"
                    description={SETTING_TIPS.downloadFolder}
                    className="workspace-select workspace-download-folder"
                  >
                    <span>Download folder</span>
                    <input
                      type="text"
                      value={downloadFolderValue}
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setLocalDownloadFolder(next);
                        saveDownloadFolder(next);
                        onDownloadFolderChange?.(next);
                      }}
                      placeholder="C:\\Users\\You\\Downloads"
                      aria-label="Download folder path"
                    />
                  </PeakTipLabel>
                </>
              ) : null}

              {activeSection === "tools" ? (
                <>
                  <div className="workspace-section-heading">
                    <strong>Tool index</strong>
                    <span>Descriptions for every editor tool. Tip: right-click a toolbar button for the same help.</span>
                  </div>
                  <label className="workspace-tool-search">
                    <input
                      type="search"
                      value={toolQuery}
                      placeholder="Search tools…"
                      aria-label="Search tools"
                      onChange={(event) => setToolQuery(event.currentTarget.value)}
                    />
                  </label>
                  <div className="workspace-tool-index" role="list">
                    {TOOL_INDEX_CATEGORIES.map((category) => {
                      const entries = filteredToolIndex.filter((entry) => entry.category === category);
                      if (!entries.length) return null;
                      return (
                        <section key={category} className="workspace-tool-category" aria-label={category}>
                          <h3>{category}</h3>
                          <ul>
                            {entries.map((entry) => (
                              <li key={entry.key} role="listitem">
                                <strong>{entry.label}</strong>
                                <p>{TOOL_DESCRIPTIONS[entry.key]}</p>
                              </li>
                            ))}
                          </ul>
                        </section>
                      );
                    })}
                    {!filteredToolIndex.length ? (
                      <p className="workspace-tool-empty">No tools match “{toolQuery.trim()}”.</p>
                    ) : null}
                  </div>
                </>
              ) : null}

              {activeSection === "hotkeys" ? (
                <>
                  <div className="workspace-section-heading">
                    <strong>Hotkeys</strong>
                    <span>Click a shortcut to remap it. Esc cancels recording. Sketch and geometry can share a letter; conflicts in the same mode still clear the other action.</span>
                  </div>
                  <div className="workspace-hotkey-toolbar">
                    <label className="workspace-tool-search">
                      <input
                        type="search"
                        value={hotkeyQuery}
                        placeholder="Search hotkeys…"
                        aria-label="Search hotkeys"
                        onChange={(event) => setHotkeyQuery(event.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="workspace-hotkey-reset"
                      onClick={() => {
                        const next = resetHotkeyBindings();
                        setHotkeys(cloneHotkeyBindings(next));
                        setRecordingAction(null);
                        setHotkeyNotice("Restored default hotkeys");
                      }}
                    >
                      Reset defaults
                    </button>
                  </div>
                  {hotkeyNotice ? <p className="workspace-hotkey-notice">{hotkeyNotice}</p> : null}
                  <div className="workspace-hotkey-index">
                    {HOTKEY_CATEGORIES.map((category) => {
                      const entries = filteredHotkeyActions.filter((entry) => entry.category === category);
                      if (!entries.length) return null;
                      return (
                        <section key={category} className="workspace-hotkey-category" aria-label={category}>
                          <h3>{category}</h3>
                          <ul>
                            {entries.map((entry) => {
                              const recording = recordingAction === entry.id;
                              return (
                                <li key={entry.id}>
                                  <div className="workspace-hotkey-copy">
                                    <strong>{entry.label}</strong>
                                    <p>{entry.description}</p>
                                  </div>
                                  <div className="workspace-hotkey-actions">
                                    <button
                                      type="button"
                                      className={recording ? "workspace-hotkey-bind recording" : "workspace-hotkey-bind"}
                                      onClick={() => {
                                        setRecordingAction(entry.id);
                                        setHotkeyNotice(`Press a key for ${entry.label}…`);
                                      }}
                                    >
                                      {recording ? "Press a key…" : formatHotkeyBinding(hotkeys[entry.id])}
                                    </button>
                                    {(hotkeys[entry.id]?.length ?? 0) > 0 ? (
                                      <button
                                        type="button"
                                        className="workspace-hotkey-clear"
                                        aria-label={`Clear ${entry.label} hotkey`}
                                        onClick={() => {
                                          const next = setHotkeyBinding(hotkeys, entry.id, []);
                                          setHotkeys(saveHotkeyBindings(next));
                                          setHotkeyNotice(`Cleared ${entry.label}`);
                                        }}
                                      >
                                        Clear
                                      </button>
                                    ) : null}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </section>
                      );
                    })}
                    {!filteredHotkeyActions.length ? (
                      <p className="workspace-tool-empty">No hotkeys match “{hotkeyQuery.trim()}”.</p>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>

            <div className="workspace-modal-footer">
              {activeSection === "hotkeys" ? (
                <span>Hotkeys save as you change them. L is Align in geometry and Line in a sketch; D is Drop vs Dimension.</span>
              ) : activeSection === "tools" || activeSection === "files" ? (
                <span>
                  {activeSection === "tools"
                    ? "Tool help is a reference only — it does not change project defaults."
                    : "Download folder is remembered on this computer."}
                </span>
              ) : (
                <>
                  <span>
                    {context === "app"
                      ? "Save these settings as the default for new projects."
                      : "Save the current settings for this project."}
                  </span>
                  <PeakTipButton
                    className="make-default-button"
                    label="Make default"
                    description={context === "app" ? SETTING_TIPS.makeDefaultApp : SETTING_TIPS.makeDefault}
                    onClick={() => {
                      onMakeDefault();
                      setDefaultSaved(true);
                    }}
                  >
                    {defaultSaved ? "Default saved" : "Make default"}
                  </PeakTipButton>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <button className="workspace-modal-backdrop" aria-label="Close settings" onClick={onClose} />
    </div>
  );
}

function WorkspaceToggle({
  label,
  tip,
  checked,
  onChange,
}: {
  label: string;
  tip: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <PeakTipLabel label={tip} helpTitle={label} description={tip} className="workspace-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    </PeakTipLabel>
  );
}

function WorkspaceSelect({
  label,
  tip,
  value,
  options,
  onChange,
}: {
  label: string;
  tip: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <PeakTipLabel label={tip} helpTitle={label} description={tip} className="workspace-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </PeakTipLabel>
  );
}
