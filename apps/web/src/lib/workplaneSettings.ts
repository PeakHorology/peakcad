import type { DisplayQuality, GridSize, MeasurementAccuracy, WorkplaneWorkspaceSettings } from "@/types/sketchforge";
import { DEFAULT_DISPLAY_QUALITY, normalizeDisplayQuality } from "@/lib/displayTessellation";
import { normalizeScaleForUnits } from "@/lib/measurementUnits";
import { DEFAULT_LIGHT_VIEWPORT_BACKGROUND } from "@/lib/uiTheme";

export const DEFAULT_SNAP_GRID: GridSize = "1.0 mm";
export const GLOBAL_WORKSPACE_DEFAULT_STORAGE_KEY = "peakcad:workspaceDefault";

export type WorkspaceDefaultsBundle = {
  workspace: WorkplaneWorkspaceSettings;
  snap: GridSize;
};

export const DEFAULT_WORKPLANE_WORKSPACE: WorkplaneWorkspaceSettings = {
  width: 200,
  depth: 200,
  sizePreset: "200 x 200 mm",
  gridBlockSize: 5,
  gridBlockPreset: "5 mm",
  background: DEFAULT_LIGHT_VIEWPORT_BACKGROUND,
  showShadows: true,
  showGrid: true,
  cruiseShapes: true,
  zoomSpeed: 5,
  units: "Metric (Default)",
  scale: "1:1 (millimeters)",
  accuracy: 2,
  displayQuality: DEFAULT_DISPLAY_QUALITY,
};

const snapGridOptions: GridSize[] = ["Off", "0.1 mm", "0.25 mm", "0.5 mm", "1.0 mm", "2.0 mm", "5.0 mm", "Brick"];

function numberOrDefault(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOrDefault(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function accuracyOrDefault(value: unknown, fallback: MeasurementAccuracy) {
  return value === 1 || value === 2 || value === 3 ? value : fallback;
}

function displayQualityOrDefault(value: unknown, fallback: DisplayQuality) {
  return normalizeDisplayQuality(value, fallback);
}

export function normalizeSnapGrid(value: unknown, fallback: GridSize = DEFAULT_SNAP_GRID): GridSize {
  return snapGridOptions.includes(value as GridSize) ? (value as GridSize) : fallback;
}

export function normalizeWorkspaceSettings(value: unknown, fallback: WorkplaneWorkspaceSettings = DEFAULT_WORKPLANE_WORKSPACE): WorkplaneWorkspaceSettings {
  const candidate = value && typeof value === "object" ? (value as Partial<WorkplaneWorkspaceSettings>) : {};
  const units = stringOrDefault(candidate.units, fallback.units);
  return {
    width: numberOrDefault(candidate.width, fallback.width),
    depth: numberOrDefault(candidate.depth, fallback.depth),
    sizePreset: stringOrDefault(candidate.sizePreset, fallback.sizePreset),
    gridBlockSize: numberOrDefault(candidate.gridBlockSize, fallback.gridBlockSize),
    gridBlockPreset: stringOrDefault(candidate.gridBlockPreset, fallback.gridBlockPreset),
    background: stringOrDefault(candidate.background, fallback.background),
    showShadows: booleanOrDefault(candidate.showShadows, fallback.showShadows),
    showGrid: booleanOrDefault(candidate.showGrid, fallback.showGrid),
    cruiseShapes: booleanOrDefault(candidate.cruiseShapes, fallback.cruiseShapes),
    zoomSpeed: numberOrDefault(candidate.zoomSpeed, fallback.zoomSpeed),
    units,
    scale: normalizeScaleForUnits(units, stringOrDefault(candidate.scale, fallback.scale)),
    accuracy: accuracyOrDefault(candidate.accuracy, fallback.accuracy),
    displayQuality: displayQualityOrDefault(candidate.displayQuality, fallback.displayQuality),
  };
}

export function workplaneSettingsFingerprint(workspace: WorkplaneWorkspaceSettings, snapGrid: GridSize) {
  return JSON.stringify({ workspace, snapGrid });
}

export function loadGlobalWorkspaceDefaults(): WorkspaceDefaultsBundle {
  if (typeof window === "undefined") {
    return { workspace: DEFAULT_WORKPLANE_WORKSPACE, snap: DEFAULT_SNAP_GRID };
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GLOBAL_WORKSPACE_DEFAULT_STORAGE_KEY) ?? "null") as {
      workspace?: unknown;
      snap?: unknown;
    } | null;
    if (!parsed) {
      return { workspace: DEFAULT_WORKPLANE_WORKSPACE, snap: DEFAULT_SNAP_GRID };
    }
    return {
      workspace: normalizeWorkspaceSettings(parsed.workspace),
      snap: normalizeSnapGrid(parsed.snap, DEFAULT_SNAP_GRID),
    };
  } catch {
    return { workspace: DEFAULT_WORKPLANE_WORKSPACE, snap: DEFAULT_SNAP_GRID };
  }
}

export function saveGlobalWorkspaceDefaults(workspace: WorkplaneWorkspaceSettings, snap: GridSize) {
  if (typeof window === "undefined") return;
  try {
    const bundle: WorkspaceDefaultsBundle = {
      workspace: normalizeWorkspaceSettings(workspace),
      snap: normalizeSnapGrid(snap, DEFAULT_SNAP_GRID),
    };
    window.localStorage.setItem(GLOBAL_WORKSPACE_DEFAULT_STORAGE_KEY, JSON.stringify(bundle));
  } catch {
    // Defaults still apply in-memory for this session.
  }
}

export function workspaceHydrationSyncDecision(pendingFingerprint: string | null, currentFingerprint: string) {
  if (pendingFingerprint === null) {
    return { shouldSync: true, pendingFingerprint: null };
  }
  return {
    shouldSync: false,
    pendingFingerprint: currentFingerprint === pendingFingerprint ? null : pendingFingerprint,
  };
}
