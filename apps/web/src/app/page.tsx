"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, EllipsisVertical, FolderPlus, Grid3X3, List, Pencil, Plus, Search, Settings, SlidersHorizontal, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { SketchForgeEditor } from "@/components/SketchForgeEditor";
import { hydrateEditorHistoryState, projectShapesFingerprint, type EditorHistoryEntry } from "@/lib/editorHistory";
import { DOWNLOAD_FOLDER_STORAGE_KEY } from "@/lib/downloadFile";
import { hardwareProfile } from "@/lib/desktopHardware";
import { createLocalId } from "@/lib/localIds";
import { WorkspaceSettingsModal } from "@/components/workplane/WorkspaceSettingsModal";
import { applyUiTheme, loadUiTheme, readAppliedUiTheme, UI_THEME_CHANGED_EVENT, type UiTheme } from "@/lib/uiTheme";
import {
  DEFAULT_SNAP_GRID,
  DEFAULT_WORKPLANE_WORKSPACE,
  loadGlobalWorkspaceDefaults,
  normalizeSnapGrid,
  normalizeWorkspaceSettings,
  saveGlobalWorkspaceDefaults,
  workplaneSettingsFingerprint,
} from "@/lib/workplaneSettings";
import type { GridSize, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

type AppView = "dashboard" | "editor";
type ViewMode = "grid" | "list";

type DashboardProject = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  shapes: number;
  accent: "cyan" | "green" | "gold" | "red";
  thumbnailUrl?: string | null;
  thumbnailUrlDark?: string | null;
  thumbnailVersion?: number;
  revision?: number;
  workspace?: WorkplaneWorkspaceSettings;
  snapGrid?: GridSize;
  folderId?: string | null;
};

type DashboardFolder = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  heroProjectId: string | null;
};

type StoredDashboardProject = Partial<DashboardProject> & {
  designShapes?: unknown;
};

type StoredDashboardFolder = Partial<DashboardFolder>;

type ProjectShapeCacheEntry = {
  revision: number;
  shapes: WorkplaneShape[];
  history: EditorHistoryEntry[];
  historyIndex: number;
};

type ProjectShapeRecord = {
  id: string;
  revision: number;
  shapes: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  updatedAt: number;
};

const PROJECTS_STORAGE_KEY = "sketchForge.projects";
const FOLDERS_STORAGE_KEY = "sketchForge.folders";
const PROJECT_FOLDER_MAP_KEY = "sketchForge.projectFolderMap";
const DASHBOARD_ORDER_KEY = "sketchForge.dashboardOrder";
const PROJECT_DRAG_MIME = "application/x-peakcad-project-id";
const ARRANGE_DRAG_MIME = "application/x-peakcad-arrange";
const PROJECT_SHAPES_DB_NAME = "sketchForge.projectShapes";
const PROJECT_SHAPES_STORE_NAME = "projectShapes";
const PROJECT_THUMBNAILS_STORE_NAME = "projectThumbnails";
const PROJECT_SHAPES_DB_VERSION = 2;
const PROJECT_THUMBNAIL_MAX_SIZE = hardwareProfile().thumbnailSize;
const PROJECT_ACCENTS: DashboardProject["accent"][] = ["cyan", "green", "gold", "red"];
const STATIC_EXPORT_BUILD = process.env.NEXT_PUBLIC_STATIC_EXPORT === "true";
/** Projects section: 5 columns × 2 rows. */
const PROJECTS_PER_PAGE = 10;
/** Folders section: 5 columns × 1 row. */
const FOLDERS_PER_PAGE = 5;

type DashboardOrder = {
  folders: string[];
  projects: string[];
  byFolder: Record<string, string[]>;
};

type ArrangeDragPayload = {
  id: string;
  kind: "project" | "folder";
};

type ProjectThumbnailRecord = {
  id: string;
  dataUrl: string;
  dataUrlDark?: string;
  version: number;
  updatedAt: number;
};

function projectThumbnailApiUrl(projectId: string, version: number, theme: UiTheme = "light") {
  const themeQuery = theme === "dark" ? "&theme=dark" : "";
  return `/api/project-thumbnail?projectId=${encodeURIComponent(projectId)}&v=${version}${themeQuery}`;
}

function formatUpdated(timestamp: number) {
  const age = Date.now() - timestamp;
  if (age < 60_000) return "Just now";
  if (age < 3_600_000) return `${Math.max(1, Math.round(age / 60_000))} min ago`;
  if (age < 86_400_000) return "Today";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function projectShapeCacheEntry(
  revision: number,
  shapes: WorkplaneShape[],
  history?: EditorHistoryEntry[],
  historyIndex?: number,
): ProjectShapeCacheEntry {
  // Keep the live scene meshes. History entries intentionally strip CSG tessellation
  // caches for undo memory; using those as `shapes` made grouped bodies invisible.
  const canonicalShapes = shapes.map((shape) => ({ ...shape }));
  // Autosave path: trust already-compacted editor history instead of rehydrating
  // (re-compacting) every mesh on each debounced save — only when the current
  // scene fingerprint still matches the history cursor entry.
  if (
    Array.isArray(history)
    && history.length > 0
    && typeof historyIndex === "number"
    && history.every((entry) => typeof entry?.fingerprint === "string" && Array.isArray(entry?.shapes))
  ) {
    const index = Math.min(Math.max(0, historyIndex), history.length - 1);
    if (history[index]?.fingerprint === projectShapesFingerprint(canonicalShapes)) {
      return {
        revision,
        shapes: canonicalShapes,
        history,
        historyIndex: index,
      };
    }
  }
  const hydrated = hydrateEditorHistoryState(canonicalShapes, history, historyIndex);
  return {
    revision,
    shapes: canonicalShapes,
    history: hydrated.entries,
    historyIndex: hydrated.index,
  };
}

function openProjectShapesDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("Project shape storage is unavailable"));
      return;
    }

    const request = window.indexedDB.open(PROJECT_SHAPES_DB_NAME, PROJECT_SHAPES_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_SHAPES_STORE_NAME)) {
        database.createObjectStore(PROJECT_SHAPES_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PROJECT_THUMBNAILS_STORE_NAME)) {
        database.createObjectStore(PROJECT_THUMBNAILS_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open project shape storage"));
    request.onsuccess = () => resolve(request.result);
  });
}

async function loadProjectShapes(projectId: string) {
  const database = await openProjectShapesDb();
  return new Promise<ProjectShapeRecord | null>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_SHAPES_STORE_NAME, "readonly");
    const request = transaction.objectStore(PROJECT_SHAPES_STORE_NAME).get(projectId);
    request.onerror = () => reject(request.error ?? new Error("Could not load project shapes"));
    request.onsuccess = () => resolve((request.result as ProjectShapeRecord | undefined) ?? null);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not load project shapes"));
    };
  });
}

async function saveProjectShapes(projectId: string, entry: ProjectShapeCacheEntry) {
  const database = await openProjectShapesDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_SHAPES_STORE_NAME, "readwrite");
    const store = transaction.objectStore(PROJECT_SHAPES_STORE_NAME);
    const existingRequest = store.get(projectId);
    existingRequest.onerror = () => {
      transaction.abort();
    };
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as ProjectShapeRecord | undefined;
      if (existing && existing.revision > entry.revision) {
        return;
      }
      store.put({ id: projectId, ...entry, updatedAt: Date.now() } satisfies ProjectShapeRecord);
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save project shapes"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save project shapes"));
    };
  });
}

async function deleteProjectShapes(projectId: string) {
  const database = await openProjectShapesDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_SHAPES_STORE_NAME, "readwrite");
    transaction.objectStore(PROJECT_SHAPES_STORE_NAME).delete(projectId);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not delete project shapes"));
    };
  });
}

async function saveProjectThumbnail(
  projectId: string,
  dataUrl: string,
  version: number,
  dataUrlDark?: string | null,
) {
  const database = await openProjectShapesDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_THUMBNAILS_STORE_NAME, "readwrite");
    transaction.objectStore(PROJECT_THUMBNAILS_STORE_NAME).put({
      id: projectId,
      dataUrl,
      dataUrlDark: typeof dataUrlDark === "string" && dataUrlDark.length > 100 ? dataUrlDark : undefined,
      version,
      updatedAt: Date.now(),
    } satisfies ProjectThumbnailRecord);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save project thumbnail"));
    };
  });
}

async function loadProjectThumbnail(projectId: string, theme: UiTheme = "light") {
  const database = await openProjectShapesDb();
  return new Promise<string | null>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_THUMBNAILS_STORE_NAME, "readonly");
    const request = transaction.objectStore(PROJECT_THUMBNAILS_STORE_NAME).get(projectId);
    request.onerror = () => reject(request.error ?? new Error("Could not load project thumbnail"));
    request.onsuccess = () => {
      const record = request.result as ProjectThumbnailRecord | undefined;
      if (theme === "dark" && typeof record?.dataUrlDark === "string") {
        resolve(record.dataUrlDark);
        return;
      }
      resolve(typeof record?.dataUrl === "string" ? record.dataUrl : null);
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not load project thumbnail"));
    };
  });
}

async function deleteProjectThumbnail(projectId: string) {
  const database = await openProjectShapesDb();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PROJECT_THUMBNAILS_STORE_NAME, "readwrite");
    transaction.objectStore(PROJECT_THUMBNAILS_STORE_NAME).delete(projectId);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not delete project thumbnail"));
    };
  });
}

async function downscaleThumbnailDataUrl(dataUrl: string, maxSize = PROJECT_THUMBNAIL_MAX_SIZE) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("Could not read project thumbnail"));
    element.src = dataUrl;
  });
  // Match dashboard tiles (16:9): cover-crop the capture so the model keeps more pixels,
  // then scale with high-quality smoothing (letterboxing was wasting resolution on bars).
  const width = Math.max(1, Math.round(maxSize));
  const height = Math.max(1, Math.round((maxSize * 9) / 16));
  const targetAspect = width / height;
  const sourceWidth = Math.max(1, image.width);
  const sourceHeight = Math.max(1, image.height);
  const sourceAspect = sourceWidth / sourceHeight;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceAspect > targetAspect) {
    sw = Math.max(1, Math.round(sourceHeight * targetAspect));
    sx = Math.max(0, Math.round((sourceWidth - sw) / 2));
  } else if (sourceAspect < targetAspect) {
    sh = Math.max(1, Math.round(sourceWidth / targetAspect));
    sy = Math.max(0, Math.round((sourceHeight - sh) / 2));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return dataUrl;
  }
  context.fillStyle = "#eaf8fd";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  // Step down in halves when shrinking a lot — sharper than a single big drawImage.
  let drawSource: CanvasImageSource = image;
  let drawSx = sx;
  let drawSy = sy;
  let drawSw = sw;
  let drawSh = sh;
  while (drawSw > width * 2 && drawSh > height * 2) {
    const nextW = Math.max(width, Math.round(drawSw / 2));
    const nextH = Math.max(height, Math.round(drawSh / 2));
    const next = document.createElement("canvas");
    next.width = nextW;
    next.height = nextH;
    const nextContext = next.getContext("2d");
    if (!nextContext) {
      break;
    }
    nextContext.imageSmoothingEnabled = true;
    nextContext.imageSmoothingQuality = "high";
    nextContext.drawImage(drawSource, drawSx, drawSy, drawSw, drawSh, 0, 0, nextW, nextH);
    drawSource = next;
    drawSx = 0;
    drawSy = 0;
    drawSw = nextW;
    drawSh = nextH;
  }
  context.drawImage(drawSource, drawSx, drawSy, drawSw, drawSh, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

function isInlineThumbnailUrl(thumbnailUrl: string | null | undefined) {
  return typeof thumbnailUrl === "string" && thumbnailUrl.startsWith("data:");
}

function readStoredProjects() {
  const legacyShapes: Record<string, ProjectShapeCacheEntry> = {};
  if (typeof window === "undefined") return { projects: [] as DashboardProject[], legacyShapes };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROJECTS_STORAGE_KEY) ?? "[]") as StoredDashboardProject[];
    const projects = parsed
      .filter((project) => typeof project.id === "string" && typeof project.name === "string")
      .map((project, index) => {
        const id = project.id as string;
        const updatedAt = typeof project.updatedAt === "number" ? project.updatedAt : Date.now();
        const revision = typeof project.revision === "number" ? project.revision : updatedAt;
        const designShapes = Array.isArray(project.designShapes) ? (project.designShapes as WorkplaneShape[]) : null;
        if (designShapes) {
          legacyShapes[id] = projectShapeCacheEntry(revision, designShapes);
        }
        return {
          id,
          name: project.name as string,
          createdAt: typeof project.createdAt === "number" ? project.createdAt : Date.now(),
          updatedAt,
          shapes: typeof project.shapes === "number" ? project.shapes : (designShapes?.length ?? 0),
          accent: PROJECT_ACCENTS.includes(project.accent as DashboardProject["accent"]) ? (project.accent as DashboardProject["accent"]) : PROJECT_ACCENTS[index % PROJECT_ACCENTS.length],
          thumbnailUrl:
            STATIC_EXPORT_BUILD && isInlineThumbnailUrl(typeof project.thumbnailUrl === "string" ? project.thumbnailUrl : null)
              ? null
              : typeof project.thumbnailUrl === "string"
                ? project.thumbnailUrl
                : null,
          thumbnailUrlDark:
            STATIC_EXPORT_BUILD && isInlineThumbnailUrl(typeof project.thumbnailUrlDark === "string" ? project.thumbnailUrlDark : null)
              ? null
              : typeof project.thumbnailUrlDark === "string"
                ? project.thumbnailUrlDark
                : null,
          thumbnailVersion: typeof project.thumbnailVersion === "number" ? project.thumbnailVersion : undefined,
          revision,
          workspace: normalizeWorkspaceSettings(project.workspace),
          snapGrid: normalizeSnapGrid(project.snapGrid),
          folderId: typeof project.folderId === "string" ? project.folderId : null,
        };
      });
    return { projects, legacyShapes };
  } catch {
    return { projects: [], legacyShapes };
  }
}

function readFolders(): DashboardFolder[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FOLDERS_STORAGE_KEY) ?? "[]") as StoredDashboardFolder[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((folder) => typeof folder.id === "string" && typeof folder.name === "string")
      .map((folder) => ({
        id: folder.id as string,
        name: folder.name as string,
        createdAt: typeof folder.createdAt === "number" ? folder.createdAt : Date.now(),
        updatedAt: typeof folder.updatedAt === "number" ? folder.updatedAt : Date.now(),
        heroProjectId: typeof folder.heroProjectId === "string" ? folder.heroProjectId : null,
      }));
  } catch {
    return [];
  }
}

function readProjectFolderMap(): Record<string, string | null> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROJECT_FOLDER_MAP_KEY) ?? "{}") as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string | null> = {};
    for (const [projectId, folderId] of Object.entries(parsed)) {
      map[projectId] = typeof folderId === "string" ? folderId : null;
    }
    return map;
  } catch {
    return {};
  }
}

function writeProjectFolderMap(map: Record<string, string | null>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECT_FOLDER_MAP_KEY, JSON.stringify(map));
  } catch {
    // Folder membership still lives in memory for this session.
  }
}

function applyProjectFolderMap(projects: DashboardProject[], map: Record<string, string | null>): DashboardProject[] {
  let changed = false;
  const next = projects.map((project) => {
    if (!Object.prototype.hasOwnProperty.call(map, project.id)) {
      return project;
    }
    const folderId = map[project.id] ?? null;
    if ((project.folderId ?? null) === folderId) {
      return project;
    }
    changed = true;
    return { ...project, folderId };
  });
  return changed ? next : projects;
}

function seedProjectFolderMap(projects: DashboardProject[], existing: Record<string, string | null>) {
  const map = { ...existing };
  let changed = false;
  for (const project of projects) {
    if (Object.prototype.hasOwnProperty.call(map, project.id)) continue;
    if (project.folderId) {
      map[project.id] = project.folderId;
      changed = true;
    }
  }
  return { map, changed };
}

function emptyDashboardOrder(): DashboardOrder {
  return { folders: [], projects: [], byFolder: {} };
}

function normalizeDashboardOrder(order: Partial<DashboardOrder> | null | undefined): DashboardOrder {
  const legacyRoot =
    order && Array.isArray((order as { root?: unknown }).root)
      ? ((order as { root: unknown[] }).root.filter((id): id is string => typeof id === "string") as string[])
      : [];
  return {
    folders: Array.isArray(order?.folders) ? order.folders.filter((id): id is string => typeof id === "string") : legacyRoot,
    projects: Array.isArray(order?.projects) ? order.projects.filter((id): id is string => typeof id === "string") : legacyRoot,
    byFolder:
      order?.byFolder && typeof order.byFolder === "object" && !Array.isArray(order.byFolder)
        ? Object.fromEntries(
            Object.entries(order.byFolder).map(([folderId, ids]) => [
              folderId,
              Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
            ]),
          )
        : {},
  };
}

function readDashboardOrder(): DashboardOrder {
  if (typeof window === "undefined") return emptyDashboardOrder();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DASHBOARD_ORDER_KEY) ?? "{}") as Partial<DashboardOrder> & {
      root?: unknown;
    };
    return normalizeDashboardOrder(parsed);
  } catch {
    return emptyDashboardOrder();
  }
}

function writeDashboardOrder(order: DashboardOrder) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DASHBOARD_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Arrangement still applies for this session.
  }
}

function syncIdOrder(preferred: string[] | null | undefined, available: string[]) {
  const availableSet = new Set(available);
  const next = (Array.isArray(preferred) ? preferred : []).filter((id) => availableSet.has(id));
  for (const id of available) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

function moveIdInOrder(order: string[], fromId: string, toId: string) {
  const fromIndex = order.indexOf(fromId);
  const toIndex = order.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return order;
  }
  const next = [...order];
  const [item] = next.splice(fromIndex, 1);
  // After removal, find where the hover target sits and place the dragged
  // tile into that slot so every tile between shifts to fill the gap.
  let insertIndex = next.indexOf(toId);
  if (insertIndex < 0) {
    next.push(item);
    return next;
  }
  if (fromIndex < toIndex) {
    // Moving right: land on/after the hovered tile.
    insertIndex += 1;
  }
  next.splice(insertIndex, 0, item);
  return next;
}

function sortByIdOrder<T extends { id: string }>(items: T[], order: string[] | null | undefined) {
  const safeOrder = Array.isArray(order) ? order : [];
  const rank = new Map(safeOrder.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

function chunkPages<T>(items: T[], pageSize: number): T[][] {
  if (pageSize <= 0) return [items];
  if (items.length === 0) return [[]];
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += pageSize) {
    pages.push(items.slice(index, index + pageSize));
  }
  return pages;
}

function folderForStorage(folder: DashboardFolder): DashboardFolder {
  return {
    id: folder.id,
    name: folder.name,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    heroProjectId: folder.heroProjectId,
  };
}

function newFolder(name: string): DashboardFolder {
  const now = Date.now();
  return {
    id: createLocalId("folder"),
    name,
    createdAt: now,
    updatedAt: now,
    heroProjectId: null,
  };
}

function projectsInFolder(projects: DashboardProject[], folderId: string) {
  return projects.filter((project) => project.folderId === folderId);
}

function resolveFolderHero(folder: DashboardFolder, projects: DashboardProject[]) {
  const members = projectsInFolder(projects, folder.id);
  if (members.length === 0) return null;
  if (folder.heroProjectId && members.some((project) => project.id === folder.heroProjectId)) {
    return members.find((project) => project.id === folder.heroProjectId) ?? null;
  }
  return members[0] ?? null;
}

function withValidFolderHeroes(folders: DashboardFolder[], projects: DashboardProject[]) {
  return folders.map((folder) => {
    const hero = resolveFolderHero(folder, projects);
    const nextHeroId = hero?.id ?? null;
    return nextHeroId === folder.heroProjectId ? folder : { ...folder, heroProjectId: nextHeroId };
  });
}

function readProjects() {
  return readStoredProjects().projects;
}

function mergeProjectForStorage(project: DashboardProject, storedProject?: DashboardProject) {
  if (!storedProject) {
    return project;
  }
  const projectRevision = project.revision ?? 0;
  const storedRevision = storedProject.revision ?? 0;
  // Folder membership is updated without bumping revision, so prefer the newer updatedAt.
  const folderId =
    (project.updatedAt ?? 0) >= (storedProject.updatedAt ?? 0)
      ? (project.folderId ?? null)
      : (storedProject.folderId ?? project.folderId ?? null);
  if (storedRevision <= projectRevision) {
    return {
      ...project,
      folderId,
    };
  }
  return {
    ...project,
    revision: storedProject.revision,
    shapes: storedProject.shapes || project.shapes,
    thumbnailUrl: project.thumbnailUrl ?? storedProject.thumbnailUrl,
    thumbnailUrlDark: project.thumbnailUrlDark ?? storedProject.thumbnailUrlDark,
    thumbnailVersion: project.thumbnailVersion ?? storedProject.thumbnailVersion,
    updatedAt: Math.max(project.updatedAt, storedProject.updatedAt),
    workspace: project.workspace ?? storedProject.workspace,
    snapGrid: project.snapGrid ?? storedProject.snapGrid,
    folderId,
  };
}

function projectForStorage(project: DashboardProject): DashboardProject {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    shapes: project.shapes,
    accent: project.accent,
    thumbnailUrl: STATIC_EXPORT_BUILD ? null : (project.thumbnailUrl ?? null),
    thumbnailUrlDark: STATIC_EXPORT_BUILD ? null : (project.thumbnailUrlDark ?? null),
    thumbnailVersion: project.thumbnailVersion,
    revision: project.revision,
    workspace: normalizeWorkspaceSettings(project.workspace),
    snapGrid: normalizeSnapGrid(project.snapGrid),
    folderId: project.folderId ?? null,
  };
}

function mergeProjectsForStorage(projects: DashboardProject[]) {
  const storedProjects = readProjects();
  const storedById = new Map(storedProjects.map((project) => [project.id, project]));
  return projects.map((project) => projectForStorage(mergeProjectForStorage(project, storedById.get(project.id))));
}

function newProject(name: string, index: number, shapeCount = 0, folderId: string | null = null): DashboardProject {
  const defaults = loadGlobalWorkspaceDefaults();
  const now = Date.now();
  return {
    id: createLocalId("project"),
    name,
    createdAt: now,
    updatedAt: now,
    shapes: shapeCount,
    accent: PROJECT_ACCENTS[index % PROJECT_ACCENTS.length],
    revision: now,
    workspace: defaults.workspace,
    snapGrid: defaults.snap,
    folderId,
  };
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<AppView>("dashboard");
  const [editorStarted, setEditorStarted] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [folders, setFolders] = useState<DashboardFolder[]>([]);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sortMode, setSortMode] = useState("custom");
  const [dashboardOrder, setDashboardOrder] = useState<DashboardOrder>(emptyDashboardOrder);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloadFolder, setDownloadFolder] = useState("");
  const [dashboardNotice, setDashboardNotice] = useState("");
  const [projectShapesById, setProjectShapesById] = useState<Record<string, ProjectShapeCacheEntry>>({});
  const projectsJsonRef = useRef("");
  const foldersJsonRef = useRef("");
  const nextProjectRevisionRef = useRef(0);
  const projectShapeSaveQueuesRef = useRef<Record<string, Promise<void>>>({});
  const projectsRef = useRef<DashboardProject[]>([]);
  const projectFolderMapRef = useRef<Record<string, string | null>>({});
  const dashboardOrderRef = useRef<DashboardOrder>(emptyDashboardOrder());
  projectsRef.current = projects;
  dashboardOrderRef.current = dashboardOrder;

  useEffect(() => {
    applyUiTheme(loadUiTheme());
    const { projects: storedProjects, legacyShapes } = readStoredProjects();
    const seeded = seedProjectFolderMap(storedProjects, readProjectFolderMap());
    projectFolderMapRef.current = seeded.map;
    if (seeded.changed) {
      writeProjectFolderMap(seeded.map);
    }
    const projectsWithFolders = applyProjectFolderMap(storedProjects, projectFolderMapRef.current);
    const storedFolders = withValidFolderHeroes(readFolders(), projectsWithFolders);
    const folderIds = storedFolders.map((folder) => folder.id);
    const rootProjectIds = projectsWithFolders.filter((project) => !project.folderId).map((project) => project.id);
    const storedOrder = readDashboardOrder();
    const nextOrder: DashboardOrder = {
      folders: syncIdOrder(storedOrder.folders, folderIds),
      projects: syncIdOrder(storedOrder.projects, rootProjectIds),
      byFolder: Object.fromEntries(
        storedFolders.map((folder) => [
          folder.id,
          syncIdOrder(
            storedOrder.byFolder[folder.id] ?? [],
            projectsWithFolders.filter((project) => project.folderId === folder.id).map((project) => project.id),
          ),
        ]),
      ),
    };
    dashboardOrderRef.current = nextOrder;
    setDashboardOrder(nextOrder);
    writeDashboardOrder(nextOrder);
    setProjects(projectsWithFolders);
    setFolders(storedFolders);
    foldersJsonRef.current = JSON.stringify(storedFolders.map(folderForStorage));
    if (STATIC_EXPORT_BUILD) {
      storedProjects.forEach((project) => {
        const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as StoredDashboardProject[];
          const stored = parsed.find((entry) => entry.id === project.id);
          const legacyUrl = typeof stored?.thumbnailUrl === "string" ? stored.thumbnailUrl : null;
          if (!legacyUrl || !isInlineThumbnailUrl(legacyUrl)) return;
          const version = project.thumbnailVersion ?? Date.now();
          void downscaleThumbnailDataUrl(legacyUrl)
            .then(async (compact) => {
              await saveProjectThumbnail(project.id, compact, version);
              setProjects((current) =>
                current.map((entry) =>
                  entry.id === project.id
                    ? { ...entry, thumbnailUrl: compact, thumbnailVersion: version }
                    : entry,
                ),
              );
            })
            .catch(() => {
              setDashboardNotice("Could not migrate project thumbnails to larger storage");
            });
        } catch {
          // Legacy thumbnail migration is best-effort.
        }
      });
    }
    if (Object.keys(legacyShapes).length > 0) {
      // Prefer IndexedDB when it already has equal/newer data. Writing equal-revision
      // legacy localStorage shapes used to clobber newer IDB after app updates.
      void (async () => {
        const migrated: Record<string, ProjectShapeCacheEntry> = {};
        for (const [projectId, entry] of Object.entries(legacyShapes)) {
          try {
            const existing = await loadProjectShapes(projectId);
            if (existing && existing.revision >= entry.revision) {
              migrated[projectId] = projectShapeCacheEntry(
                existing.revision,
                existing.shapes ?? [],
                existing.history,
                existing.historyIndex,
              );
              continue;
            }
            await saveProjectShapes(projectId, entry);
            migrated[projectId] = entry;
          } catch {
            setDashboardNotice("Could not migrate project shapes to larger storage");
          }
        }
        if (Object.keys(migrated).length > 0) {
          setProjectShapesById((current) => {
            const next = { ...current };
            for (const [projectId, entry] of Object.entries(migrated)) {
              const existing = next[projectId];
              if (!existing || existing.revision < entry.revision) {
                next[projectId] = entry;
              }
            }
            return next;
          });
        }
        try {
          const raw = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
          if (!raw) return;
          const parsed = JSON.parse(raw) as StoredDashboardProject[];
          if (!Array.isArray(parsed) || !parsed.some((project) => Array.isArray(project.designShapes))) {
            return;
          }
          const cleaned = parsed.map((project) => {
            const { designShapes: _legacy, ...rest } = project;
            return rest;
          });
          window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(cleaned));
        } catch {
          // Stripping legacy designShapes is best-effort.
        }
      })();
    }
    setDownloadFolder(window.localStorage.getItem(DOWNLOAD_FOLDER_STORAGE_KEY) ?? "");

    const params = new URLSearchParams(window.location.search);
    if (params.has("codexBooleanCase") || params.get("editor") === "1") {
      const requestedProjectId = params.get("project");
      if (requestedProjectId && storedProjects.some((project) => project.id === requestedProjectId)) {
        setActiveProjectId(requestedProjectId);
      }
      setEditorStarted(true);
      setView("editor");
    }
    setMounted(true);
  }, []);

  const persistProjectsList = useCallback((nextProjects: DashboardProject[]) => {
    const storageProjects = mergeProjectsForStorage(nextProjects);
    const serialized = JSON.stringify(storageProjects);
    if (projectsJsonRef.current === serialized) {
      return storageProjects;
    }
    try {
      window.localStorage.setItem(PROJECTS_STORAGE_KEY, serialized);
      projectsJsonRef.current = serialized;
    } catch (error) {
      // Freeing the old value can make room for a larger one, but the retry uses the same
      // payload and may fail too — so keep the previous index and put it back if it does.
      // Leaving the key deleted would erase every project on the next load.
      const previous = window.localStorage.getItem(PROJECTS_STORAGE_KEY);
      try {
        window.localStorage.removeItem(PROJECTS_STORAGE_KEY);
        window.localStorage.setItem(PROJECTS_STORAGE_KEY, serialized);
        projectsJsonRef.current = serialized;
      } catch {
        if (previous !== null) {
          try {
            window.localStorage.setItem(PROJECTS_STORAGE_KEY, previous);
          } catch {
            // Best-effort: the quota may no longer admit even the original value.
          }
        }
        setDashboardNotice(error instanceof Error ? error.message : "Could not save project list");
      }
    }
    return storageProjects;
  }, []);

  useEffect(() => {
    if (!mounted) return;
    // Write-only: never feed merged storage back into React state. That feedback
    // loop was clobbering in-memory folderId right after drag-move.
    persistProjectsList(projects);
  }, [mounted, persistProjectsList, projects]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const repaired = applyProjectFolderMap(projects, projectFolderMapRef.current);
    if (repaired === projects) return;
    projectsRef.current = repaired;
    setProjects(repaired);
  }, [mounted, projects]);

  useEffect(() => {
    if (!mounted) return;
    const serialized = JSON.stringify(folders.map(folderForStorage));
    if (foldersJsonRef.current === serialized) return;
    try {
      window.localStorage.setItem(FOLDERS_STORAGE_KEY, serialized);
      foldersJsonRef.current = serialized;
    } catch (error) {
      setDashboardNotice(error instanceof Error ? error.message : "Could not save folders");
    }
  }, [folders, mounted]);

  useEffect(() => {
    if (!mounted) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === PROJECTS_STORAGE_KEY) {
        // Ignore echoes of our own writes (some hosts notify the same document).
        if ((event.newValue ?? "[]") === projectsJsonRef.current) {
          return;
        }
        projectsJsonRef.current = event.newValue ?? "[]";
        const stored = readProjects();
        setProjects((current) => {
          const currentById = new Map(current.map((project) => [project.id, project]));
          return stored.map((project) => {
            const live = currentById.get(project.id);
            if (!live) return project;
            // Keep newer in-memory folder assignment if storage is behind.
            if ((live.updatedAt ?? 0) >= (project.updatedAt ?? 0)) {
              return { ...project, folderId: live.folderId ?? null, updatedAt: Math.max(project.updatedAt, live.updatedAt) };
            }
            return project;
          });
        });
      }
      if (event.key === FOLDERS_STORAGE_KEY) {
        if ((event.newValue ?? "[]") === foldersJsonRef.current) {
          return;
        }
        foldersJsonRef.current = event.newValue ?? "[]";
        setFolders(readFolders());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    setFolders((current) => {
      const next = withValidFolderHeroes(current, projects);
      const unchanged = next.length === current.length && next.every((folder, index) => folder.heroProjectId === current[index]?.heroProjectId);
      return unchanged ? current : next;
    });
  }, [mounted, projects]);

  useEffect(() => {
    if (!activeProjectId) return;
    if (projects.some((project) => project.id === activeProjectId)) return;
    setActiveProjectId(null);
    setView("dashboard");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  }, [activeProjectId, projects]);

  useEffect(() => {
    if (!mounted || !activeProjectId) return;
    const activeProject = projects.find((project) => project.id === activeProjectId);
    if (!activeProject) return;
    const targetRevision = activeProject.revision ?? 0;
    const cached = projectShapesById[activeProjectId];
    if (cached && cached.revision >= targetRevision) return;

    let canceled = false;
    void loadProjectShapes(activeProjectId)
      .then((record) => {
        if (canceled) return;
        const revision = Math.max(targetRevision, record?.revision ?? 0, Date.now());
        const entry = projectShapeCacheEntry(revision, record?.shapes ?? [], record?.history, record?.historyIndex);
        setProjectShapesById((current) => {
          const existing = current[activeProjectId];
          if (existing && existing.revision >= Math.max(targetRevision, record?.revision ?? 0)) {
            return current;
          }
          return {
            ...current,
            [activeProjectId]: entry,
          };
        });
      })
      .catch((error) => {
        if (!canceled) {
          setDashboardNotice(error instanceof Error ? error.message : "Could not load project shapes");
          setProjectShapesById((current) => {
            const existing = current[activeProjectId];
            if (existing && existing.revision >= targetRevision) {
              return current;
            }
            return {
              ...current,
              [activeProjectId]: projectShapeCacheEntry(targetRevision || Date.now(), []),
            };
          });
        }
      });
    return () => {
      canceled = true;
    };
  }, [activeProjectId, mounted, projects]);

  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(DOWNLOAD_FOLDER_STORAGE_KEY, downloadFolder);
    } catch {
      // A full or blocked store must not take the dashboard down; the folder still applies
      // in-memory for this session.
    }
  }, [downloadFolder, mounted]);

  useEffect(() => {
    if (!mounted) return;
    const folderIds = folders.map((folder) => folder.id);
    const rootProjectIds = projects.filter((project) => !project.folderId).map((project) => project.id);
    setDashboardOrder((current) => {
      const safeCurrent = normalizeDashboardOrder(current);
      const next: DashboardOrder = {
        folders: syncIdOrder(safeCurrent.folders, folderIds),
        projects: syncIdOrder(safeCurrent.projects, rootProjectIds),
        byFolder: Object.fromEntries(
          folders.map((folder) => [
            folder.id,
            syncIdOrder(
              safeCurrent.byFolder[folder.id] ?? [],
              projects.filter((project) => project.folderId === folder.id).map((project) => project.id),
            ),
          ]),
        ),
      };
      const unchanged =
        next.folders.length === safeCurrent.folders.length &&
        next.folders.every((id, index) => id === safeCurrent.folders[index]) &&
        next.projects.length === safeCurrent.projects.length &&
        next.projects.every((id, index) => id === safeCurrent.projects[index]) &&
        folders.every((folder) => {
          const a = next.byFolder[folder.id] ?? [];
          const b = safeCurrent.byFolder[folder.id] ?? [];
          return a.length === b.length && a.every((id, index) => id === b[index]);
        });
      if (unchanged) return safeCurrent === current ? current : safeCurrent;
      dashboardOrderRef.current = next;
      writeDashboardOrder(next);
      return next;
    });
  }, [folders, mounted, projects]);

  const updateDashboardOrder = useCallback((updater: (current: DashboardOrder) => DashboardOrder) => {
    setDashboardOrder((current) => {
      const next = normalizeDashboardOrder(updater(normalizeDashboardOrder(current)));
      dashboardOrderRef.current = next;
      writeDashboardOrder(next);
      return next;
    });
    setSortMode("custom");
  }, []);

  const setFolderSectionOrder = useCallback(
    (folderIds: string[]) => {
      updateDashboardOrder((current) => ({
        ...current,
        folders: syncIdOrder(folderIds, current.folders),
      }));
    },
    [updateDashboardOrder],
  );

  const setProjectSectionOrder = useCallback(
    (projectIds: string[]) => {
      updateDashboardOrder((current) => ({
        ...current,
        projects: syncIdOrder(projectIds, current.projects),
      }));
    },
    [updateDashboardOrder],
  );

  const setFolderMemberOrder = useCallback(
    (folderId: string, memberIds: string[]) => {
      updateDashboardOrder((current) => ({
        ...current,
        byFolder: {
          ...current.byFolder,
          [folderId]: syncIdOrder(memberIds, current.byFolder[folderId] ?? memberIds),
        },
      }));
    },
    [updateDashboardOrder],
  );

  const rootFolders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matched = folders.filter((folder) => {
      if (!normalizedQuery) return true;
      if (folder.name.toLowerCase().includes(normalizedQuery)) return true;
      return projectsInFolder(projects, folder.id).some((project) => project.name.toLowerCase().includes(normalizedQuery));
    });
    if (sortMode === "name") return [...matched].sort((a, b) => a.name.localeCompare(b.name));
    if (sortMode === "recent") return [...matched].sort((a, b) => b.updatedAt - a.updatedAt);
    return sortByIdOrder(matched, dashboardOrder.folders);
  }, [dashboardOrder.folders, folders, projects, query, sortMode]);

  const rootProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matched = projects.filter((project) => {
      if (project.folderId) return false;
      if (!normalizedQuery) return true;
      return project.name.toLowerCase().includes(normalizedQuery);
    });
    if (sortMode === "name") return [...matched].sort((a, b) => a.name.localeCompare(b.name));
    if (sortMode === "recent") return [...matched].sort((a, b) => b.updatedAt - a.updatedAt);
    return sortByIdOrder(matched, dashboardOrder.projects);
  }, [dashboardOrder.projects, projects, query, sortMode]);

  const openEditor = (projectId: string | null, options: { allowMissingFromStorage?: boolean } = {}) => {
    if (projectId && typeof window !== "undefined" && !options.allowMissingFromStorage) {
      const storedProjects = readProjects();
      const storedProject = storedProjects.find((project) => project.id === projectId);
      let missing = false;
      setProjects((current) => {
        const existsInMemory = current.some((project) => project.id === projectId);
        if (!storedProject && !existsInMemory) {
          missing = true;
          return storedProjects;
        }
        // Keep in-memory folder membership; never clobber it with a stale localStorage snapshot.
        const base = current.length > 0 ? current : storedProjects;
        return base.map((project) => (project.id === projectId ? { ...project, updatedAt: Date.now() } : project));
      });
      if (missing) {
        setActiveProjectId(null);
        setView("dashboard");
        window.history.replaceState(null, "", "/");
        return;
      }
    } else if (projectId) {
      setProjects((current) => current.map((project) => (project.id === projectId ? { ...project, updatedAt: Date.now() } : project)));
    }
    setActiveProjectId(projectId);
    setEditorStarted(true);
    setView("editor");
    if (typeof window !== "undefined") {
      const nextUrl = projectId ? `/?editor=1&project=${encodeURIComponent(projectId)}` : "/?editor=1";
      window.history.replaceState(null, "", nextUrl);
    }
  };

  const updateProjectSnapshot = useCallback((snapshot: {
    image: string;
    imageDark?: string;
    projectId: string;
    shapes: number;
  }) => {
    // Home captures then navigates to the dashboard immediately. Do not abort the
    // async save when view leaves "editor" — that was dropping desktop thumbnails.
    if (!snapshot.image || snapshot.image.length < 100 || !snapshot.projectId) {
      return;
    }
    const version = Date.now();
    if (STATIC_EXPORT_BUILD) {
      setProjects((current) =>
        current.map((project) =>
          project.id === snapshot.projectId
            ? { ...project, shapes: snapshot.shapes, updatedAt: version }
            : project,
        ),
      );
      void Promise.all([
        downscaleThumbnailDataUrl(snapshot.image),
        snapshot.imageDark && snapshot.imageDark.length > 100
          ? downscaleThumbnailDataUrl(snapshot.imageDark)
          : Promise.resolve(null),
      ])
        .then(async ([compact, compactDark]) => {
          await saveProjectThumbnail(snapshot.projectId, compact, version, compactDark);
          setProjects((current) =>
            current.map((project) =>
              project.id === snapshot.projectId
                ? {
                  ...project,
                  shapes: snapshot.shapes,
                  thumbnailUrl: compact,
                  thumbnailUrlDark: compactDark,
                  thumbnailVersion: version,
                  updatedAt: version,
                }
                : project,
            ),
          );
        })
        .catch(() => {
          setDashboardNotice("Could not save project thumbnail");
        });
      return;
    }

    setProjects((current) =>
      current.map((project) => (project.id === snapshot.projectId ? { ...project, shapes: snapshot.shapes, updatedAt: version } : project)),
    );
    void fetch("/api/project-thumbnail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataUrl: snapshot.image,
        dataUrlDark: snapshot.imageDark,
        projectId: snapshot.projectId,
      }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { version?: number } | null) => {
        const nextVersion = payload?.version ?? Date.now();
        const thumbnailUrl = projectThumbnailApiUrl(snapshot.projectId, nextVersion, "light");
        const thumbnailUrlDark = projectThumbnailApiUrl(snapshot.projectId, nextVersion, "dark");
        setProjects((current) =>
          current.map((project) =>
            project.id === snapshot.projectId
              ? {
                ...project,
                shapes: snapshot.shapes,
                thumbnailUrl,
                thumbnailUrlDark,
                thumbnailVersion: nextVersion,
                updatedAt: nextVersion,
              }
              : project,
          ),
        );
      })
      .catch(() => {
        setProjects((current) =>
          current.map((project) => (project.id === snapshot.projectId ? { ...project, shapes: snapshot.shapes, updatedAt: version } : project)),
        );
      });
  }, []);

  const updateProjectShapes = useCallback((snapshot: {
    projectId: string;
    shapes: WorkplaneShape[];
    history: EditorHistoryEntry[];
    historyIndex: number;
  }) => {
    // The editor flushes its final snapshot from an unmount cleanup, which runs *after* the view
    // state has already flipped to "dashboard". Gating on the view discarded every edit made since
    // the last 120ms debounce — and all of an in-progress drag, whose only persistence path is that
    // flush. Ordering is enforced by the revision guards below, so all this needs to reject is a
    // snapshot for a project that no longer exists.
    if (!projectsRef.current.some((project) => project.id === snapshot.projectId)) {
      return;
    }
    const revision = Math.max(Date.now(), nextProjectRevisionRef.current + 1);
    nextProjectRevisionRef.current = revision;
    const entry = projectShapeCacheEntry(revision, snapshot.shapes, snapshot.history, snapshot.historyIndex);
    setProjectShapesById((current) => {
      const existing = current[snapshot.projectId];
      if (existing && existing.revision > revision) {
        return current;
      }
      return {
        ...current,
        [snapshot.projectId]: entry,
      };
    });

    const previousSave = projectShapeSaveQueuesRef.current[snapshot.projectId] ?? Promise.resolve();
    const queuedSave = previousSave.catch(() => undefined).then(() => saveProjectShapes(snapshot.projectId, entry));
    projectShapeSaveQueuesRef.current[snapshot.projectId] = queuedSave;

    void queuedSave
      .then(() => {
        setProjects((current) =>
          current.map((project) =>
            project.id === snapshot.projectId && (project.revision ?? 0) <= revision
              ? { ...project, shapes: snapshot.shapes.length, updatedAt: revision, revision }
              : project,
          ),
        );
      })
      .catch((error) => {
        if (projectShapeSaveQueuesRef.current[snapshot.projectId] === queuedSave) {
          setDashboardNotice(error instanceof Error ? error.message : "Could not save project shapes");
        }
      })
      .finally(() => {
        if (projectShapeSaveQueuesRef.current[snapshot.projectId] === queuedSave) {
          delete projectShapeSaveQueuesRef.current[snapshot.projectId];
        }
      });
  }, []);

  const updateProjectWorkspace = useCallback((snapshot: { projectId: string; workspace: WorkplaneWorkspaceSettings; snap: GridSize }) => {
    // Same reason as updateProjectShapes: a settings change made just before leaving the editor
    // arrives once the view has already flipped, and gating on that dropped it.
    if (!projectsRef.current.some((project) => project.id === snapshot.projectId)) {
      return;
    }
    const version = Date.now();
    const workspace = normalizeWorkspaceSettings(snapshot.workspace);
    const snapGrid = normalizeSnapGrid(snapshot.snap);
    const nextFingerprint = workplaneSettingsFingerprint(workspace, snapGrid);
    setProjects((current) => {
      let changed = false;
      const next = current.map((project) => {
        if (project.id !== snapshot.projectId) return project;
        const currentFingerprint = workplaneSettingsFingerprint(
          normalizeWorkspaceSettings(project.workspace),
          normalizeSnapGrid(project.snapGrid),
        );
        if (currentFingerprint === nextFingerprint) return project;
        changed = true;
        return {
          ...project,
          workspace,
          snapGrid,
          updatedAt: version,
        };
      });
      return changed ? next : current;
    });
  }, []);

  const createAndOpenProject = (name?: string) => {
    const project = newProject(name ?? `Untitled design ${projects.length + 1}`, projects.length);
    const shapeEntry = projectShapeCacheEntry(project.revision ?? project.updatedAt, []);
    // Seed shapes + project list before switching views so the editor never mounts
    // against a missing cache entry (that unmount/remount cycle was blanking WebGL).
    setProjectShapesById((current) => ({
      ...current,
      [project.id]: shapeEntry,
    }));
    void saveProjectShapes(project.id, shapeEntry).catch(() => {
      setDashboardNotice("Could not prepare project shape storage");
    });
    updateDashboardOrder((current) => ({
      ...current,
      projects: current.projects.includes(project.id) ? current.projects : [...current.projects, project.id],
    }));
    setProjects((current) => [project, ...current.filter((entry) => entry.id !== project.id)]);
    setActiveProjectId(project.id);
    setEditorStarted(true);
    setView("editor");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `/?editor=1&project=${encodeURIComponent(project.id)}`);
    }
  };

  const openDashboard = () => {
    if (activeProjectId) {
      setProjects((current) => current.map((project) => (project.id === activeProjectId ? { ...project, updatedAt: Date.now() } : project)));
    }
    setView("dashboard");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/");
    }
  };

  const deleteProject = (projectId: string) => {
    if (Object.prototype.hasOwnProperty.call(projectFolderMapRef.current, projectId)) {
      const nextMap = { ...projectFolderMapRef.current };
      delete nextMap[projectId];
      projectFolderMapRef.current = nextMap;
      writeProjectFolderMap(nextMap);
    }
    setProjects((current) => current.filter((project) => project.id !== projectId));
    setFolders((current) =>
      current.map((folder) =>
        folder.heroProjectId === projectId ? { ...folder, heroProjectId: null, updatedAt: Date.now() } : folder,
      ),
    );
    setProjectShapesById((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
    if (activeProjectId === projectId) {
      setActiveProjectId(null);
    }
    if (!STATIC_EXPORT_BUILD) {
      void fetch(`/api/project-thumbnail?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
    } else {
      void deleteProjectThumbnail(projectId).catch(() => {
        setDashboardNotice("Could not delete project thumbnail from local storage");
      });
    }
    void deleteProjectShapes(projectId).catch(() => {
      setDashboardNotice("Could not delete project shapes from local storage");
    });
  };

  const renameProject = (projectId: string, name: string) => {
    const nextName = name.trim().slice(0, 80);
    if (!nextName) return;
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? { ...project, name: nextName, updatedAt: Date.now() } : project)),
    );
  };

  const createFolder = (name?: string) => {
    const folder = newFolder((name?.trim() || `Folder ${folders.length + 1}`).slice(0, 80));
    updateDashboardOrder((current) => ({
      ...current,
      folders: current.folders.includes(folder.id) ? current.folders : [...current.folders, folder.id],
      byFolder: { ...current.byFolder, [folder.id]: current.byFolder[folder.id] ?? [] },
    }));
    setFolders((current) => [folder, ...current]);
    return folder.id;
  };

  const renameFolder = (folderId: string, name: string) => {
    const nextName = name.trim().slice(0, 80);
    if (!nextName) return;
    setFolders((current) =>
      current.map((folder) => (folder.id === folderId ? { ...folder, name: nextName, updatedAt: Date.now() } : folder)),
    );
  };

  const deleteFolder = (folderId: string) => {
    const now = Date.now();
    const nextMap = { ...projectFolderMapRef.current };
    let mapChanged = false;
    for (const [projectId, mappedFolderId] of Object.entries(nextMap)) {
      if (mappedFolderId === folderId) {
        nextMap[projectId] = null;
        mapChanged = true;
      }
    }
    if (mapChanged) {
      projectFolderMapRef.current = nextMap;
      writeProjectFolderMap(nextMap);
    }
    setProjects((current) =>
      current.map((project) => (project.folderId === folderId ? { ...project, folderId: null, updatedAt: now } : project)),
    );
    setFolders((current) => current.filter((folder) => folder.id !== folderId));
  };

  const moveProjectToFolder = (projectId: string, folderId: string | null) => {
    const now = Date.now();
    const previousFolderId =
      (Object.prototype.hasOwnProperty.call(projectFolderMapRef.current, projectId)
        ? projectFolderMapRef.current[projectId]
        : projectsRef.current.find((entry) => entry.id === projectId)?.folderId) ?? null;
    if (previousFolderId === folderId) {
      return;
    }
    const nextMap = { ...projectFolderMapRef.current, [projectId]: folderId };
    projectFolderMapRef.current = nextMap;
    writeProjectFolderMap(nextMap);
    updateDashboardOrder((current) => {
      const nextProjects = current.projects.filter((id) => id !== projectId);
      const byFolder = Object.fromEntries(
        Object.entries(current.byFolder).map(([id, members]) => [id, members.filter((memberId) => memberId !== projectId)]),
      );
      if (folderId) {
        byFolder[folderId] = [...(byFolder[folderId] ?? []), projectId];
      } else {
        nextProjects.push(projectId);
      }
      return { ...current, projects: nextProjects, byFolder };
    });
    setProjects((current) => {
      const project = current.find((entry) => entry.id === projectId);
      if (!project) {
        return current;
      }
      const next = current.map((entry) => (entry.id === projectId ? { ...entry, folderId, updatedAt: now } : entry));
      projectsRef.current = next;
      persistProjectsList(next);
      return next;
    });
    setFolders((current) =>
      current.map((folder) => {
        if (folderId && folder.id === folderId) {
          return {
            ...folder,
            updatedAt: now,
            heroProjectId: folder.heroProjectId ?? projectId,
          };
        }
        if (folder.heroProjectId === projectId && folder.id !== folderId) {
          return { ...folder, heroProjectId: null, updatedAt: now };
        }
        return folder;
      }),
    );
  };

  const setFolderHero = (folderId: string, projectId: string) => {
    const now = Date.now();
    setFolders((current) =>
      current.map((folder) => (folder.id === folderId ? { ...folder, heroProjectId: projectId, updatedAt: now } : folder)),
    );
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? { ...project, updatedAt: now } : project)),
    );
  };

  if (!mounted) {
    return null;
  }

  const activeProject = activeProjectId ? projects.find((project) => project.id === activeProjectId) ?? null : null;
  const activeProjectShapeEntry = activeProjectId ? projectShapesById[activeProjectId] : null;
  const canRenderEditor = !activeProjectId || (Boolean(activeProject) && Boolean(activeProjectShapeEntry));
  const projectDebugSummary = projects.map((project) => ({
    id: project.id,
    revision: project.revision,
    shapes: project.shapes,
    designShapes: projectShapesById[project.id]?.shapes.length ?? null,
    thumbnail: Boolean(project.thumbnailUrl),
    workspace: Boolean(project.workspace),
    snapGrid: project.snapGrid ?? null,
  }));

  return (
    <>
      <pre data-codex-projects hidden>
        {JSON.stringify(projectDebugSummary)}
      </pre>
      {view === "dashboard" ? (
        <Dashboard
          dashboardNotice={dashboardNotice}
          downloadFolder={downloadFolder}
          folders={folders}
          projects={projects}
          query={query}
          dashboardOrder={dashboardOrder}
          rootFolders={rootFolders}
          rootProjects={rootProjects}
          settingsOpen={settingsOpen}
          sortMode={sortMode}
          viewMode={viewMode}
          onCloseSettings={() => setSettingsOpen(false)}
          onCreate={() => createAndOpenProject()}
          onCreateFolder={createFolder}
          onDeleteFolder={deleteFolder}
          onDeleteProject={deleteProject}
          onDownloadFolderChange={setDownloadFolder}
          onMoveProjectToFolder={moveProjectToFolder}
          onOpenProject={openEditor}
          onOpenSettings={() => setSettingsOpen(true)}
          onQueryChange={setQuery}
          onRenameFolder={renameFolder}
          onRenameProject={renameProject}
          onSetFolderMemberOrder={setFolderMemberOrder}
          onSetFolderSectionOrder={setFolderSectionOrder}
          onSetProjectSectionOrder={setProjectSectionOrder}
          onSetFolderHero={setFolderHero}
          onSortModeChange={setSortMode}
          onViewModeChange={setViewMode}
        />
      ) : null}
      {view === "editor" && editorStarted && canRenderEditor ? (
        <div className="editor-stage active">
          <SketchForgeEditor
            key={activeProjectId ?? "draft"}
            initialShapes={activeProjectShapeEntry?.shapes ?? []}
            initialHistory={activeProjectShapeEntry?.history}
            initialHistoryIndex={activeProjectShapeEntry?.historyIndex}
            initialSnap={activeProject?.snapGrid ?? DEFAULT_SNAP_GRID}
            initialWorkspace={activeProject?.workspace ?? DEFAULT_WORKPLANE_WORKSPACE}
            onHome={openDashboard}
            onProjectShapesChange={updateProjectShapes}
            onProjectSnapshot={updateProjectSnapshot}
            onProjectWorkspaceChange={updateProjectWorkspace}
            projectId={activeProjectId}
            projectName={activeProject?.name}
            projectRevision={activeProjectShapeEntry?.revision ?? activeProject?.revision ?? 0}
            onProjectNameChange={(name) => {
              if (activeProjectId) {
                renameProject(activeProjectId, name);
              }
            }}
          />
        </div>
      ) : null}
    </>
  );
}

function Dashboard({
  dashboardNotice,
  dashboardOrder,
  downloadFolder,
  folders,
  projects,
  query,
  rootFolders,
  rootProjects,
  settingsOpen,
  sortMode,
  viewMode,
  onCloseSettings,
  onCreate,
  onCreateFolder,
  onDeleteFolder,
  onDeleteProject,
  onDownloadFolderChange,
  onMoveProjectToFolder,
  onOpenProject,
  onOpenSettings,
  onQueryChange,
  onRenameFolder,
  onRenameProject,
  onSetFolderMemberOrder,
  onSetFolderSectionOrder,
  onSetProjectSectionOrder,
  onSetFolderHero,
  onSortModeChange,
  onViewModeChange,
}: {
  dashboardNotice: string;
  dashboardOrder: DashboardOrder;
  downloadFolder: string;
  folders: DashboardFolder[];
  projects: DashboardProject[];
  query: string;
  rootFolders: DashboardFolder[];
  rootProjects: DashboardProject[];
  settingsOpen: boolean;
  sortMode: string;
  viewMode: ViewMode;
  onCloseSettings: () => void;
  onCreate: () => void;
  onCreateFolder: (name?: string) => string;
  onDeleteFolder: (folderId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onDownloadFolderChange: (value: string) => void;
  onMoveProjectToFolder: (projectId: string, folderId: string | null) => void;
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onQueryChange: (value: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRenameProject: (projectId: string, name: string) => void;
  onSetFolderMemberOrder: (folderId: string, memberIds: string[]) => void;
  onSetFolderSectionOrder: (folderIds: string[]) => void;
  onSetProjectSectionOrder: (projectIds: string[]) => void;
  onSetFolderHero: (folderId: string, projectId: string) => void;
  onSortModeChange: (value: string) => void;
  onViewModeChange: (value: ViewMode) => void;
}) {
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [appWorkspace, setAppWorkspace] = useState<WorkplaneWorkspaceSettings>(() => loadGlobalWorkspaceDefaults().workspace);
  const [appSnap, setAppSnap] = useState<GridSize>(() => loadGlobalWorkspaceDefaults().snap);

  useEffect(() => {
    if (!settingsOpen) return;
    const defaults = loadGlobalWorkspaceDefaults();
    setAppWorkspace(defaults.workspace);
    setAppSnap(defaults.snap);
  }, [settingsOpen]);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [arrangeTargetId, setArrangeTargetId] = useState<string | null>(null);
  const [arrangePreviewOrder, setArrangePreviewOrder] = useState<string[] | null>(null);
  const [arrangeScope, setArrangeScope] = useState<"folders" | "projects" | "folderMembers" | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(null);
  const draggingItemRef = useRef<ArrangeDragPayload | null>(null);
  const arrangePreviewOrderRef = useRef<string[] | null>(null);
  const arrangeScopeRef = useRef<"folders" | "projects" | "folderMembers" | null>(null);
  const arrangeCommittedRef = useRef(false);
  const suppressProjectOpenRef = useRef(false);
  const suppressProjectOpenTimerRef = useRef<number | null>(null);
  const [projectPendingDeleteId, setProjectPendingDeleteId] = useState<string | null>(null);
  const [projectPendingRenameId, setProjectPendingRenameId] = useState<string | null>(null);
  const [folderPendingDeleteId, setFolderPendingDeleteId] = useState<string | null>(null);
  const [folderPendingRenameId, setFolderPendingRenameId] = useState<string | null>(null);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [moveProjectId, setMoveProjectId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [folderPage, setFolderPage] = useState(1);
  const [projectPage, setProjectPage] = useState(1);

  const projectPendingDelete = projects.find((project) => project.id === projectPendingDeleteId) ?? null;
  const projectPendingRename = projects.find((project) => project.id === projectPendingRenameId) ?? null;
  const folderPendingDelete = folders.find((folder) => folder.id === folderPendingDeleteId) ?? null;
  const folderPendingRename = folders.find((folder) => folder.id === folderPendingRenameId) ?? null;
  const moveProject = projects.find((project) => project.id === moveProjectId) ?? null;
  const openFolder = openFolderId ? folders.find((folder) => folder.id === openFolderId) ?? null : null;
  const normalizedQuery = query.trim().toLowerCase();
  const folderMembers = openFolder
    ? (() => {
        const members = projectsInFolder(projects, openFolder.id).filter(
          (project) => !normalizedQuery || project.name.toLowerCase().includes(normalizedQuery),
        );
        if (sortMode === "name") return [...members].sort((a, b) => a.name.localeCompare(b.name));
        if (sortMode === "recent") return [...members].sort((a, b) => b.updatedAt - a.updatedAt);
        return sortByIdOrder(members, dashboardOrder.byFolder[openFolder.id] ?? []);
      })()
    : [];

  const occupiedFolders = useMemo(() => {
    if (query.trim()) return rootFolders;
    return rootFolders.filter((folder) => projectsInFolder(projects, folder.id).length > 0);
  }, [projects, query, rootFolders]);

  const folderTotalPages = Math.max(1, Math.ceil(occupiedFolders.length / FOLDERS_PER_PAGE));
  const projectTotalPages = Math.max(
    1,
    Math.ceil((openFolder ? folderMembers.length : rootProjects.length) / PROJECTS_PER_PAGE),
  );
  const safeFolderPage = Math.min(folderPage, folderTotalPages);
  const safeProjectPage = Math.min(projectPage, projectTotalPages);
  const rootFolderPages = chunkPages(occupiedFolders, FOLDERS_PER_PAGE);
  const rootProjectPages = chunkPages(rootProjects, PROJECTS_PER_PAGE);
  const folderMemberPages = chunkPages(folderMembers, PROJECTS_PER_PAGE);
  const folderArrangeIds = occupiedFolders.map((folder) => folder.id);
  const projectArrangeIds = openFolder
    ? folderMembers.map((project) => project.id)
    : rootProjects.map((project) => project.id);
  const currentArrangeIds = arrangeScope === "folders" ? folderArrangeIds : projectArrangeIds;
  const arrangeOrderRank = useMemo(() => {
    const order = arrangePreviewOrder ?? currentArrangeIds;
    return new Map(order.map((id, index) => [id, index]));
  }, [arrangePreviewOrder, currentArrangeIds]);
  const folderCount = occupiedFolders.length;
  const folderPageStart = folderCount === 0 ? 0 : (safeFolderPage - 1) * FOLDERS_PER_PAGE + 1;
  const folderPageEnd = Math.min(folderCount, safeFolderPage * FOLDERS_PER_PAGE);
  const projectVisibleCount = openFolder ? folderMembers.length : rootProjects.length;
  const projectPageStart = projectVisibleCount === 0 ? 0 : (safeProjectPage - 1) * PROJECTS_PER_PAGE + 1;
  const projectPageEnd = Math.min(projectVisibleCount, safeProjectPage * PROJECTS_PER_PAGE);

  useEffect(() => {
    setFolderPage(1);
    setProjectPage(1);
    setOpenProjectMenuId(null);
    setOpenFolderMenuId(null);
  }, [query, sortMode, viewMode, openFolderId]);

  useEffect(() => {
    setFolderPage((current) => Math.min(current, Math.max(1, Math.ceil(occupiedFolders.length / FOLDERS_PER_PAGE) || 1)));
  }, [occupiedFolders.length]);

  useEffect(() => {
    const count = openFolderId ? folderMembers.length : rootProjects.length;
    setProjectPage((current) => Math.min(current, Math.max(1, Math.ceil(count / PROJECTS_PER_PAGE) || 1)));
  }, [folderMembers.length, openFolderId, rootProjects.length]);

  useEffect(() => {
    if (!projectPendingDeleteId) return;
    if (projects.some((project) => project.id === projectPendingDeleteId)) return;
    setProjectPendingDeleteId(null);
  }, [projectPendingDeleteId, projects]);

  useEffect(() => {
    if (!folderPendingDeleteId) return;
    if (folders.some((folder) => folder.id === folderPendingDeleteId)) return;
    setFolderPendingDeleteId(null);
  }, [folderPendingDeleteId, folders]);

  useEffect(() => {
    if (!openFolderId) return;
    if (folders.some((folder) => folder.id === openFolderId)) return;
    setOpenFolderId(null);
  }, [openFolderId, folders]);

  const closeMenus = () => {
    setOpenProjectMenuId(null);
    setOpenFolderMenuId(null);
  };

  const confirmProjectDelete = () => {
    if (!projectPendingDelete) return;
    onDeleteProject(projectPendingDelete.id);
    setProjectPendingDeleteId(null);
  };

  const startProjectRename = (project: DashboardProject) => {
    closeMenus();
    setProjectPendingRenameId(project.id);
    setNameDraft(project.name);
  };

  const closeNameDialogs = () => {
    setProjectPendingRenameId(null);
    setFolderPendingRenameId(null);
    setFolderCreateOpen(false);
    setNameDraft("");
  };

  const confirmProjectRename = () => {
    if (!projectPendingRename || !nameDraft.trim()) return;
    onRenameProject(projectPendingRename.id, nameDraft);
    closeNameDialogs();
  };

  const startFolderRename = (folder: DashboardFolder) => {
    closeMenus();
    setFolderPendingRenameId(folder.id);
    setNameDraft(folder.name);
  };

  const confirmFolderRename = () => {
    if (!folderPendingRename || !nameDraft.trim()) return;
    onRenameFolder(folderPendingRename.id, nameDraft);
    closeNameDialogs();
  };

  const confirmFolderCreate = () => {
    const folderId = onCreateFolder(nameDraft.trim() || undefined);
    closeNameDialogs();
    setOpenFolderId(folderId);
  };

  const confirmFolderDelete = () => {
    if (!folderPendingDelete) return;
    onDeleteFolder(folderPendingDelete.id);
    setFolderPendingDeleteId(null);
    if (openFolderId === folderPendingDelete.id) {
      setOpenFolderId(null);
    }
  };

  const openFolderView = (folderId: string) => {
    closeMenus();
    setOpenFolderId(folderId);
    setProjectPage(1);
  };

  const closeFolderView = () => {
    closeMenus();
    setOpenFolderId(null);
    setProjectPage(1);
  };

  const commitArrangePreview = () => {
    if (arrangeCommittedRef.current) return;
    const preview = arrangePreviewOrderRef.current;
    const scope = arrangeScopeRef.current;
    if (!preview || preview.length === 0 || !scope) return;
    const baseline = scope === "folders" ? folderArrangeIds : projectArrangeIds;
    if (preview.length === baseline.length && preview.every((id, index) => id === baseline[index])) {
      return;
    }
    arrangeCommittedRef.current = true;
    if (scope === "folders") {
      onSetFolderSectionOrder(preview);
    } else if (scope === "folderMembers" && openFolder) {
      onSetFolderMemberOrder(openFolder.id, preview);
    } else {
      onSetProjectSectionOrder(preview);
    }
  };

  const beginArrangeDrag = (event: ReactDragEvent, payload: ArrangeDragPayload) => {
    event.stopPropagation();
    if (suppressProjectOpenTimerRef.current !== null) {
      window.clearTimeout(suppressProjectOpenTimerRef.current);
      suppressProjectOpenTimerRef.current = null;
    }
    suppressProjectOpenRef.current = true;
    arrangeCommittedRef.current = false;
    draggingItemRef.current = payload;
    const scope: "folders" | "projects" | "folderMembers" = openFolder
      ? "folderMembers"
      : payload.kind === "folder"
        ? "folders"
        : "projects";
    arrangeScopeRef.current = scope;
    setArrangeScope(scope);
    setDraggingItemId(payload.id);
    setArrangeTargetId(null);
    const baseline = scope === "folders" ? folderArrangeIds : projectArrangeIds;
    arrangePreviewOrderRef.current = baseline;
    setArrangePreviewOrder(baseline);
    setDropTargetFolderId(null);
    event.dataTransfer.setData(ARRANGE_DRAG_MIME, JSON.stringify(payload));
    if (payload.kind === "project") {
      event.dataTransfer.setData(PROJECT_DRAG_MIME, payload.id);
    }
    event.dataTransfer.setData("text/plain", payload.id);
    event.dataTransfer.effectAllowed = "move";
    try {
      event.dataTransfer.setDragImage(event.currentTarget as Element, 28, 28);
    } catch {
      // Some hosts reject custom drag images; native preview is fine.
    }
  };

  const endArrangeDrag = (options?: { commit?: boolean }) => {
    const shouldCommit = options?.commit ?? true;
    // HTML5 DnD often drops onto the dragged tile after CSS `order` shifts,
    // so persist the preview here as well as in the drop handler.
    if (shouldCommit) {
      commitArrangePreview();
    } else {
      arrangeCommittedRef.current = true;
    }
    draggingItemRef.current = null;
    arrangePreviewOrderRef.current = null;
    arrangeScopeRef.current = null;
    setArrangeScope(null);
    setDraggingItemId(null);
    setArrangeTargetId(null);
    setArrangePreviewOrder(null);
    setDropTargetFolderId(null);
    if (suppressProjectOpenTimerRef.current !== null) {
      window.clearTimeout(suppressProjectOpenTimerRef.current);
    }
    suppressProjectOpenTimerRef.current = window.setTimeout(() => {
      suppressProjectOpenRef.current = false;
      suppressProjectOpenTimerRef.current = null;
    }, 200);
  };

  const readArrangePayload = (event: ReactDragEvent): ArrangeDragPayload | null => {
    if (draggingItemRef.current) return draggingItemRef.current;
    const raw = event.dataTransfer.getData(ARRANGE_DRAG_MIME);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ArrangeDragPayload;
        if (parsed && typeof parsed.id === "string" && (parsed.kind === "project" || parsed.kind === "folder")) {
          return parsed;
        }
      } catch {
        // Fall through to project mime.
      }
    }
    const projectId = event.dataTransfer.getData(PROJECT_DRAG_MIME) || event.dataTransfer.getData("text/plain");
    return projectId ? { id: projectId, kind: "project" } : null;
  };

  const handleFolderDragOver = (event: ReactDragEvent, folderId: string) => {
    const payload = draggingItemRef.current;
    if (!payload || payload.kind !== "project" || payload.id === folderId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetFolderId(folderId);
    setArrangeTargetId(null);
  };

  const handleFolderDrop = (event: ReactDragEvent, folderId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = readArrangePayload(event);
    suppressProjectOpenRef.current = true;
    endArrangeDrag({ commit: false });
    if (payload?.kind === "project" && payload.id !== folderId) {
      onMoveProjectToFolder(payload.id, folderId);
    }
  };

  const handleArrangeDragOver = (event: ReactDragEvent, targetId: string) => {
    const payload = draggingItemRef.current;
    if (!payload || payload.id === targetId) {
      return;
    }
    // Projects dropped on folders move into the folder instead of rearranging.
    if (payload.kind === "project" && folders.some((folder) => folder.id === targetId) && !openFolder) {
      return;
    }
    const scope = arrangeScopeRef.current;
    const baseline = scope === "folders" ? folderArrangeIds : projectArrangeIds;
    if (!baseline.includes(targetId) || !baseline.includes(payload.id)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setArrangeTargetId(targetId);
    setDropTargetFolderId(null);
    const nextPreview = moveIdInOrder(baseline, payload.id, targetId);
    arrangePreviewOrderRef.current = nextPreview;
    setArrangePreviewOrder(nextPreview);
  };

  const handleArrangeDrop = (event: ReactDragEvent, targetId: string) => {
    const payload = readArrangePayload(event);
    if (payload?.kind === "project" && folders.some((folder) => folder.id === targetId) && !openFolder) {
      return;
    }
    const scope = arrangeScopeRef.current;
    const baseline = scope === "folders" ? folderArrangeIds : projectArrangeIds;
    if (payload && (!baseline.includes(targetId) || !baseline.includes(payload.id))) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    suppressProjectOpenRef.current = true;
    // Prefer the live preview order; fall back to computing from the drop target.
    if (!arrangePreviewOrderRef.current && payload && payload.id !== targetId) {
      const nextPreview = moveIdInOrder(baseline, payload.id, targetId);
      arrangePreviewOrderRef.current = nextPreview;
      setArrangePreviewOrder(nextPreview);
    }
    endArrangeDrag();
  };

  const tileArrangeStyle = (id: string): CSSProperties | undefined => {
    if (!arrangePreviewOrder || !arrangeScope) return undefined;
    const inFolderSection = arrangeScope === "folders" && folderArrangeIds.includes(id);
    const inProjectSection =
      (arrangeScope === "projects" || arrangeScope === "folderMembers") && projectArrangeIds.includes(id);
    if (!inFolderSection && !inProjectSection) return undefined;
    const rank = arrangeOrderRank.get(id);
    if (rank === undefined) return undefined;
    return { order: rank };
  };

  const openProjectFromCard = (projectId: string) => {
    if (suppressProjectOpenRef.current || draggingItemRef.current) {
      return;
    }
    onOpenProject(projectId);
  };

  const arrangeHandlers = (targetId: string) => ({
    onDragEnter: (event: ReactDragEvent) => handleArrangeDragOver(event, targetId),
    onDragOver: (event: ReactDragEvent) => handleArrangeDragOver(event, targetId),
    onDrop: (event: ReactDragEvent) => handleArrangeDrop(event, targetId),
  });

  const renderProjectCard = (project: DashboardProject, options: { inFolder?: DashboardFolder | null } = {}) => {
    const inFolder = options.inFolder ?? null;
    const isHero = Boolean(inFolder && inFolder.heroProjectId === project.id);
    return (
      <article
        className={`project-card${draggingItemId === project.id ? " is-dragging" : ""}${arrangeTargetId === project.id ? " arrange-target" : ""}`}
        key={project.id}
        draggable
        style={tileArrangeStyle(project.id)}
        onDragStart={(event) => beginArrangeDrag(event, { id: project.id, kind: "project" })}
        onDragEnd={() => endArrangeDrag()}
        {...arrangeHandlers(project.id)}
      >
        <div
          className="project-card-open"
          role="button"
          tabIndex={0}
          onClick={() => openProjectFromCard(project.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openProjectFromCard(project.id);
            }
          }}
        >
          <ProjectPreview
            accent={project.accent}
            projectId={project.id}
            thumbnailUrl={project.thumbnailUrl}
            thumbnailUrlDark={project.thumbnailUrlDark}
            thumbnailVersion={project.thumbnailVersion}
          />
          <span className="project-card-title">
            {isHero ? <Star className="project-hero-star" size={14} strokeWidth={2.4} fill="currentColor" /> : null}
            {project.name}
          </span>
          <span className="project-card-meta">
            {formatUpdated(project.updatedAt)} - {project.shapes} {project.shapes === 1 ? "shape" : "shapes"}
          </span>
        </div>
        <button
          className="project-menu-trigger"
          type="button"
          draggable={false}
          aria-label={`Project options for ${project.name}`}
          aria-expanded={openProjectMenuId === project.id}
          title="Project options"
          onClick={() => {
            setOpenFolderMenuId(null);
            setOpenProjectMenuId((current) => (current === project.id ? null : project.id));
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <EllipsisVertical size={19} strokeWidth={2.5} />
        </button>
        {openProjectMenuId === project.id ? (
          <div className="project-card-menu" role="menu" aria-label={`Options for ${project.name}`}>
            <button type="button" role="menuitem" onClick={() => startProjectRename(project)}>
              <Pencil size={16} />
              <span>Rename</span>
            </button>
            {inFolder ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenus();
                  onSetFolderHero(inFolder.id, project.id);
                }}
              >
                <Star size={16} />
                <span>{isHero ? "Hero project" : "Star as hero"}</span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenus();
                setMoveProjectId(project.id);
              }}
            >
              <FolderPlus size={16} />
              <span>Move to folder…</span>
            </button>
            {inFolder ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenus();
                  onMoveProjectToFolder(project.id, null);
                }}
              >
                <span>Move to home</span>
              </button>
            ) : null}
            <button
              className="delete"
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenus();
                setProjectPendingDeleteId(project.id);
              }}
            >
              <Trash2 size={16} />
              <span>Delete</span>
            </button>
          </div>
        ) : null}
      </article>
    );
  };

  const folderDropHandlers = (folderId: string) => ({
    onDragEnter: (event: ReactDragEvent) => {
      const payload = draggingItemRef.current;
      if (payload?.kind === "folder") {
        handleArrangeDragOver(event, folderId);
        return;
      }
      handleFolderDragOver(event, folderId);
    },
    onDragOver: (event: ReactDragEvent) => {
      const payload = draggingItemRef.current;
      if (payload?.kind === "folder") {
        handleArrangeDragOver(event, folderId);
        return;
      }
      handleFolderDragOver(event, folderId);
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropTargetFolderId((current) => (current === folderId ? null : current));
        setArrangeTargetId((current) => (current === folderId ? null : current));
      }
    },
    onDrop: (event: ReactDragEvent) => {
      const payload = draggingItemRef.current ?? readArrangePayload(event);
      if (payload?.kind === "folder") {
        handleArrangeDrop(event, folderId);
        return;
      }
      handleFolderDrop(event, folderId);
    },
  });

  const renderPagination = (
    label: string,
    totalPages: number,
    safePage: number,
    onPageChange: (page: number) => void,
  ) =>
    totalPages > 1 ? (
      <nav className="project-pagination" aria-label={label}>
        <button
          type="button"
          className="project-page-nav"
          aria-label="Previous page"
          disabled={safePage <= 1}
          onClick={() => {
            closeMenus();
            onPageChange(Math.max(1, safePage - 1));
          }}
        >
          <ChevronLeft size={18} strokeWidth={2.4} />
          <span>Previous</span>
        </button>
        <div className="project-page-numbers">
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
            <button
              key={page}
              type="button"
              className={page === safePage ? "active" : ""}
              aria-label={`Page ${page}`}
              aria-current={page === safePage ? "page" : undefined}
              onClick={() => {
                closeMenus();
                onPageChange(page);
              }}
            >
              {page}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="project-page-nav"
          aria-label="Next page"
          disabled={safePage >= totalPages}
          onClick={() => {
            closeMenus();
            onPageChange(Math.min(totalPages, safePage + 1));
          }}
        >
          <span>Next</span>
          <ChevronRight size={18} strokeWidth={2.4} />
        </button>
      </nav>
    ) : null;

  const folderPagination = renderPagination("Folder pages", folderTotalPages, safeFolderPage, setFolderPage);
  const projectPagination = renderPagination("Project pages", projectTotalPages, safeProjectPage, setProjectPage);

  const renderCarousel = <T,>({
    ariaLabel,
    pages,
    safePage,
    variant,
    renderItem,
  }: {
    ariaLabel: string;
    pages: T[][];
    safePage: number;
    variant: "folders" | "projects";
    renderItem: (item: T) => ReactNode;
  }) => (
    <div className={`dashboard-carousel dashboard-carousel-${variant}`} aria-label={ariaLabel}>
      <div
        className="dashboard-carousel-track"
        style={{ transform: `translate3d(-${(safePage - 1) * 100}%, 0, 0)` }}
      >
        {pages.map((pageItems, pageIndex) => (
          <div
            key={`page-${pageIndex}`}
            className="dashboard-carousel-page"
            aria-hidden={pageIndex !== safePage - 1}
          >
            <div
              className={
                viewMode === "grid"
                  ? `project-grid project-grid-home project-grid-${variant}`
                  : "project-list project-list-carousel"
              }
            >
              {pageItems.map((item) => renderItem(item))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderFolderCard = (folder: DashboardFolder) => {
    const members = projectsInFolder(projects, folder.id);
    const hero = resolveFolderHero(folder, projects);
    const isDropTarget = dropTargetFolderId === folder.id;
    const isArrangeTarget = arrangeTargetId === folder.id;

    return (
      <article
        key={folder.id}
        className={`folder-card${isDropTarget ? " drop-target" : ""}${isArrangeTarget ? " arrange-target" : ""}${draggingItemId === folder.id ? " is-dragging" : ""}`}
        draggable
        style={tileArrangeStyle(folder.id)}
        onDragStart={(event) => beginArrangeDrag(event, { id: folder.id, kind: "folder" })}
        onDragEnd={() => endArrangeDrag()}
        {...folderDropHandlers(folder.id)}
      >
        <button
          className="folder-card-open"
          type="button"
          onClick={() => {
            if (suppressProjectOpenRef.current) {
              return;
            }
            openFolderView(folder.id);
          }}
        >
          <span className="folder-card-tab" aria-hidden="true" />
          <span className="folder-preview-frame">
            {hero ? (
              <ProjectPreview
                accent={hero.accent}
                projectId={hero.id}
                thumbnailUrl={hero.thumbnailUrl}
                thumbnailUrlDark={hero.thumbnailUrlDark}
                thumbnailVersion={hero.thumbnailVersion}
              />
            ) : (
              <span className="folder-preview-empty">
                <span className="preview-grid" />
                <span className="preview-empty-mark">Drop projects here</span>
              </span>
            )}
          </span>
          <span className="project-card-title">{folder.name}</span>
          <span className="project-card-meta">
            {members.length} {members.length === 1 ? "project" : "projects"}
            {hero ? ` · ${hero.name}` : ""}
          </span>
        </button>
        <button
          className="project-menu-trigger"
          type="button"
          aria-label={`Folder options for ${folder.name}`}
          aria-expanded={openFolderMenuId === folder.id}
          title="Folder options"
          onClick={() => {
            setOpenProjectMenuId(null);
            setOpenFolderMenuId((current) => (current === folder.id ? null : folder.id));
          }}
        >
          <EllipsisVertical size={19} strokeWidth={2.5} />
        </button>
        {openFolderMenuId === folder.id ? (
          <div className="project-card-menu" role="menu" aria-label={`Options for ${folder.name}`}>
            <button type="button" role="menuitem" onClick={() => startFolderRename(folder)}>
              <Pencil size={16} />
              <span>Rename</span>
            </button>
            <button
              className="delete"
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenus();
                setFolderPendingDeleteId(folder.id);
              }}
            >
              <Trash2 size={16} />
              <span>Delete folder</span>
            </button>
          </div>
        ) : null}
      </article>
    );
  };

  return (
    <main className="dashboard-shell">
      <header className="dashboard-topbar">
        <button
          className="dashboard-brand"
          type="button"
          aria-label="PeakCAD home"
          onClick={() => {
            if (openFolder) closeFolderView();
          }}
        >
          <img className="peakcad-logo" src="assets/peakcad/peakcad-logo.png" alt="PeakCAD" />
          <span className="dashboard-brand-copy">
            <span className="dashboard-brand-name">PeakCAD</span>
            <span className="dashboard-brand-developer">PeakHorologyLLC</span>
          </span>
        </button>
        {!settingsOpen ? (
          <button className="dashboard-topbar-settings" type="button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
            <Settings size={20} strokeWidth={2.4} />
          </button>
        ) : (
          <span className="dashboard-topbar-settings" aria-hidden="true" />
        )}
      </header>

      <div className="dashboard-layout">
        <section
          className={`dashboard-main${openFolder ? " folder-open" : ""}`}
          aria-label={openFolder ? `Folder ${openFolder.name}` : "Dashboard"}
          {...(openFolder ? folderDropHandlers(openFolder.id) : {})}
        >
          <div className="dashboard-search-band">
            <div className="dashboard-search">
              <Search size={18} strokeWidth={2.4} />
              <input
                value={query}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
                placeholder={openFolder ? "Search in folder" : "Search projects"}
                aria-label={openFolder ? "Search in folder" : "Search projects"}
              />
            </div>
            {!openFolder ? (
              <button
                className="dashboard-secondary"
                type="button"
                onClick={() => {
                  closeMenus();
                  setFolderCreateOpen(true);
                  setNameDraft(`Folder ${folders.length + 1}`);
                }}
              >
                <FolderPlus size={18} strokeWidth={2.4} />
                <span>New folder</span>
              </button>
            ) : null}
            <button className="dashboard-primary" type="button" onClick={onCreate}>
              <Plus size={20} strokeWidth={2.6} />
              <span>Create</span>
            </button>
          </div>
          {dashboardNotice ? (
            <div className="dashboard-import-notice" role="status">
              {dashboardNotice}
            </div>
          ) : null}

          <div className="dashboard-section-header">
            <div>
              {openFolder ? (
                <div className="folder-view-heading">
                  <button className="folder-back-button" type="button" onClick={closeFolderView}>
                    <ArrowLeft size={18} strokeWidth={2.4} />
                    <span>Projects</span>
                  </button>
                  <nav className="folder-breadcrumb" aria-label="Folder location">
                    <button type="button" onClick={closeFolderView}>
                      Projects
                    </button>
                    <span aria-hidden="true">/</span>
                    <span>{openFolder.name}</span>
                  </nav>
                  <h1>{openFolder.name}</h1>
                  <span>
                    {projectVisibleCount === 0
                      ? "0 projects"
                      : `${projectPageStart}-${projectPageEnd} of ${projectVisibleCount}`}
                  </span>
                </div>
              ) : (
                <>
                  <h1>Projects</h1>
                  <span>
                    {folderCount + rootProjects.length === 0
                      ? "0 items"
                      : `${folderCount} ${folderCount === 1 ? "folder" : "folders"} · ${rootProjects.length} ${rootProjects.length === 1 ? "project" : "projects"}`}
                  </span>
                </>
              )}
            </div>
            <div className="dashboard-controls">
              <label className="dashboard-select">
                <SlidersHorizontal size={17} />
                <select value={sortMode} onChange={(event) => onSortModeChange(event.currentTarget.value)} aria-label="Sort projects">
                  <option value="custom">Arrangement</option>
                  <option value="recent">Recent</option>
                  <option value="name">Name</option>
                </select>
              </label>
              <div className="dashboard-segmented" aria-label="Project view">
                <button className={viewMode === "grid" ? "active" : ""} type="button" aria-label="Grid view" onClick={() => onViewModeChange("grid")}>
                  <Grid3X3 size={17} />
                </button>
                <button className={viewMode === "list" ? "active" : ""} type="button" aria-label="List view" onClick={() => onViewModeChange("list")}>
                  <List size={18} />
                </button>
              </div>
            </div>
          </div>

          {openFolder ? (
            <>
              {dropTargetFolderId === openFolder.id ? (
                <div className="folder-drop-banner" role="status">
                  Drop to add to {openFolder.name}
                </div>
              ) : null}
              {folderMembers.length > 0 ? (
                <div className="dashboard-home-section dashboard-home-section-folder">
                  {renderCarousel({
                    ariaLabel: `${openFolder.name} pages`,
                    pages: folderMemberPages,
                    safePage: safeProjectPage,
                    variant: "projects",
                    renderItem: (project) => renderProjectCard(project, { inFolder: openFolder }),
                  })}
                  {projectPagination ?? <div className="project-pagination-spacer" aria-hidden="true" />}
                </div>
              ) : (
                <div className="project-empty">
                  <strong>Empty folder</strong>
                  <span>Drag a project here or use Move to folder…</span>
                </div>
              )}
            </>
          ) : (
            <div className="dashboard-home-sections">
              {occupiedFolders.length > 0 ? (
                <section className="dashboard-home-section" aria-label="Folders">
                  <div className="dashboard-subsection-header">
                    <h2>Folders</h2>
                    <span>
                      {folderCount === 0 ? "0 folders" : `${folderPageStart}-${folderPageEnd} of ${folderCount}`}
                    </span>
                  </div>
                  {renderCarousel({
                    ariaLabel: "Folder pages",
                    pages: rootFolderPages,
                    safePage: safeFolderPage,
                    variant: "folders",
                    renderItem: (folder) => renderFolderCard(folder),
                  })}
                  {folderPagination ?? <div className="project-pagination-spacer" aria-hidden="true" />}
                </section>
              ) : null}

              <section className="dashboard-home-section" aria-label="Projects">
                {projectVisibleCount > 0 ? (
                  <div className="dashboard-subsection-header">
                    <span>
                      {`${projectPageStart}-${projectPageEnd} of ${projectVisibleCount}`}
                    </span>
                  </div>
                ) : null}
                {rootProjects.length > 0 ? (
                  <>
                    {renderCarousel({
                      ariaLabel: "Project pages",
                      pages: rootProjectPages,
                      safePage: safeProjectPage,
                      variant: "projects",
                      renderItem: (project) => renderProjectCard(project),
                    })}
                    {projectPagination ?? <div className="project-pagination-spacer" aria-hidden="true" />}
                  </>
                ) : (
                  <div className="project-empty project-empty-carousel">
                    <strong>{occupiedFolders.length > 0 ? "No loose projects" : "No projects yet"}</strong>
                    <span>
                      {occupiedFolders.length > 0
                        ? "Create a project or open a folder above."
                        : "Create a 3D design or a folder and it will appear here."}
                    </span>
                  </div>
                )}
              </section>
            </div>
          )}
        </section>
      </div>

      {projectPendingDelete ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
          <div className="dashboard-confirm-dialog">
            <header>
              <strong id="delete-project-title">Delete project?</strong>
              <button type="button" aria-label="Cancel project deletion" onClick={() => setProjectPendingDeleteId(null)}>
                <X size={18} />
              </button>
            </header>
            <p>
              Do you actually want the project <span>{projectPendingDelete.name}</span> to be deleted?
            </p>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={() => setProjectPendingDeleteId(null)}>
                Cancel
              </button>
              <button className="dashboard-confirm-delete" type="button" onClick={confirmProjectDelete}>
                Delete
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {folderPendingDelete ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-folder-title">
          <div className="dashboard-confirm-dialog">
            <header>
              <strong id="delete-folder-title">Delete folder?</strong>
              <button type="button" aria-label="Cancel folder deletion" onClick={() => setFolderPendingDeleteId(null)}>
                <X size={18} />
              </button>
            </header>
            <p>
              Delete <span>{folderPendingDelete.name}</span>? Projects inside return to home.
            </p>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={() => setFolderPendingDeleteId(null)}>
                Cancel
              </button>
              <button className="dashboard-confirm-delete" type="button" onClick={confirmFolderDelete}>
                Delete folder
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {projectPendingRename ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
          <form
            className="dashboard-confirm-dialog dashboard-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              confirmProjectRename();
            }}
          >
            <header>
              <strong id="rename-project-title">Rename project</strong>
              <button type="button" aria-label="Cancel project rename" onClick={closeNameDialogs}>
                <X size={18} />
              </button>
            </header>
            <label>
              <span>Project name</span>
              <input
                autoFocus
                maxLength={80}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.currentTarget.value)}
                aria-label="Project name"
              />
            </label>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={closeNameDialogs}>
                Cancel
              </button>
              <button className="dashboard-confirm-save" type="submit" disabled={!nameDraft.trim()}>
                Save
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {folderPendingRename ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-folder-title">
          <form
            className="dashboard-confirm-dialog dashboard-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              confirmFolderRename();
            }}
          >
            <header>
              <strong id="rename-folder-title">Rename folder</strong>
              <button type="button" aria-label="Cancel folder rename" onClick={closeNameDialogs}>
                <X size={18} />
              </button>
            </header>
            <label>
              <span>Folder name</span>
              <input
                autoFocus
                maxLength={80}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.currentTarget.value)}
                aria-label="Folder name"
              />
            </label>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={closeNameDialogs}>
                Cancel
              </button>
              <button className="dashboard-confirm-save" type="submit" disabled={!nameDraft.trim()}>
                Save
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {folderCreateOpen ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="create-folder-title">
          <form
            className="dashboard-confirm-dialog dashboard-rename-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              confirmFolderCreate();
            }}
          >
            <header>
              <strong id="create-folder-title">New folder</strong>
              <button type="button" aria-label="Cancel folder creation" onClick={closeNameDialogs}>
                <X size={18} />
              </button>
            </header>
            <label>
              <span>Folder name</span>
              <input
                autoFocus
                maxLength={80}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.currentTarget.value)}
                aria-label="Folder name"
              />
            </label>
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={closeNameDialogs}>
                Cancel
              </button>
              <button className="dashboard-confirm-save" type="submit" disabled={!nameDraft.trim()}>
                Create
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {moveProject ? (
        <section className="dashboard-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="move-project-title">
          <div className="dashboard-confirm-dialog dashboard-move-dialog">
            <header>
              <strong id="move-project-title">Move “{moveProject.name}”</strong>
              <button type="button" aria-label="Cancel move" onClick={() => setMoveProjectId(null)}>
                <X size={18} />
              </button>
            </header>
            <div className="dashboard-move-list">
              <button
                type="button"
                className={!moveProject.folderId ? "active" : ""}
                onClick={() => {
                  onMoveProjectToFolder(moveProject.id, null);
                  setMoveProjectId(null);
                }}
              >
                Home
              </button>
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  className={moveProject.folderId === folder.id ? "active" : ""}
                  onClick={() => {
                    onMoveProjectToFolder(moveProject.id, folder.id);
                    setMoveProjectId(null);
                    setOpenFolderId(folder.id);
                  }}
                >
                  {folder.name}
                </button>
              ))}
            </div>
            {folders.length === 0 ? <p className="dashboard-move-empty">Create a folder first, then move projects into it.</p> : null}
            <div className="dashboard-confirm-actions">
              <button className="dashboard-confirm-cancel" type="button" onClick={() => setMoveProjectId(null)}>
                Close
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {settingsOpen ? (
        <div className="dashboard-settings-overlay">
          <WorkspaceSettingsModal
            context="app"
            workspace={appWorkspace}
            snap={appSnap}
            downloadFolder={downloadFolder}
            onDownloadFolderChange={onDownloadFolderChange}
            onWorkspaceChange={(next) => {
              setAppWorkspace(next);
              saveGlobalWorkspaceDefaults(next, appSnap);
            }}
            onSnapChange={(next) => {
              setAppSnap(next);
              saveGlobalWorkspaceDefaults(appWorkspace, next);
            }}
            onMakeDefault={() => {
              saveGlobalWorkspaceDefaults(appWorkspace, appSnap);
            }}
            onClose={onCloseSettings}
          />
        </div>
      ) : null}
    </main>
  );
}

function ProjectPreview({
  accent,
  projectId,
  thumbnailUrl,
  thumbnailUrlDark,
  thumbnailVersion,
}: {
  accent: DashboardProject["accent"];
  projectId: string;
  thumbnailUrl?: string | null;
  thumbnailUrlDark?: string | null;
  thumbnailVersion?: number;
}) {
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadUiTheme());
  const [storedThumbnailUrl, setStoredThumbnailUrl] = useState<string | null>(null);
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string | null>(null);
  const themeThumbnailUrl = uiTheme === "dark"
    ? (thumbnailUrlDark
      ?? (typeof thumbnailUrl === "string" && thumbnailUrl.startsWith("/api/project-thumbnail")
        ? projectThumbnailApiUrl(projectId, thumbnailVersion ?? 0, "dark")
        : thumbnailUrl))
    : thumbnailUrl;
  const resolvedThumbnailUrl = themeThumbnailUrl ?? storedThumbnailUrl;
  const showThumbnail = Boolean(resolvedThumbnailUrl && resolvedThumbnailUrl !== failedThumbnailUrl);
  // Until a true dark capture exists, gently darken the light snapshot on the dashboard.
  const isLightFallback = uiTheme === "dark" && !thumbnailUrlDark;

  useEffect(() => {
    const onThemeChange = () => setUiTheme(readAppliedUiTheme());
    window.addEventListener(UI_THEME_CHANGED_EVENT, onThemeChange);
    return () => window.removeEventListener(UI_THEME_CHANGED_EVENT, onThemeChange);
  }, []);

  useEffect(() => {
    setFailedThumbnailUrl(null);
  }, [resolvedThumbnailUrl]);

  useEffect(() => {
    if (!STATIC_EXPORT_BUILD || themeThumbnailUrl) {
      setStoredThumbnailUrl(null);
      return;
    }
    let canceled = false;
    void loadProjectThumbnail(projectId, uiTheme)
      .then((stored) => {
        if (!canceled) {
          setStoredThumbnailUrl(stored);
        }
      })
      .catch(() => {
        if (!canceled) {
          setStoredThumbnailUrl(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [projectId, themeThumbnailUrl, thumbnailVersion, uiTheme]);

  return (
    <span className={`project-preview accent-${accent}`} aria-hidden="true">
      {showThumbnail ? (
        <img
          className={`project-thumbnail-image${isLightFallback ? " is-light-fallback" : ""}`}
          src={resolvedThumbnailUrl ?? ""}
          alt=""
          draggable={false}
          onError={() => setFailedThumbnailUrl(resolvedThumbnailUrl ?? null)}
        />
      ) : (
        <>
          <span className="preview-grid" />
          <span className="preview-empty-mark">No snapshot yet</span>
        </>
      )}
    </span>
  );
}
