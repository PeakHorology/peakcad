import { hydrateClipboardShape, jsonSafeShape } from "@/lib/shapeClipboard";
import { normalizeSnapGrid, normalizeWorkspaceSettings } from "@/lib/workplaneSettings";
import type { EditorHistoryEntry, EditorHistoryMeshBlob } from "@/lib/editorHistory";
import type { GridSize, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export const PEAKCAD_FORMAT = "peakcad";
export const PEAKCAD_DOCUMENT_VERSION = 1;
export const PEAKCAD_FILE_EXTENSION = ".peakcad";
export const PEAKCAD_MAX_BYTES = 80 * 1024 * 1024;

export type PeakcadAccent = "cyan" | "green" | "gold" | "red";

export type PeakcadProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  accent: PeakcadAccent;
  shapes: number;
  revision?: number;
  workspace?: WorkplaneWorkspaceSettings;
  snapGrid?: GridSize;
  thumbnailUrl?: string | null;
  thumbnailUrlDark?: string | null;
  thumbnailVersion?: number;
};

export type PeakcadDocument = {
  format: typeof PEAKCAD_FORMAT;
  version: number;
  savedAt: number;
  project: PeakcadProjectMeta;
  shapes: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
};

const ACCENTS = new Set<PeakcadAccent>(["cyan", "green", "gold", "red"]);

function asFiniteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function jsonSafeMeshBlob(blob: EditorHistoryMeshBlob): EditorHistoryMeshBlob {
  return {
    positions: Array.from(blob.positions),
    ...(blob.indices ? { indices: Array.from(blob.indices) } : {}),
    ...(blob.normals ? { normals: Array.from(blob.normals) } : {}),
    ...(typeof blob.brepStep === "string" ? { brepStep: blob.brepStep } : {}),
  };
}

function jsonSafeHistoryEntry(entry: EditorHistoryEntry): EditorHistoryEntry {
  return {
    ...entry,
    shapes: entry.shapes.map(jsonSafeShape),
    meshVault: entry.meshVault
      ? Object.fromEntries(Object.entries(entry.meshVault).map(([key, blob]) => [key, jsonSafeMeshBlob(blob)]))
      : undefined,
  };
}

export function peakcadFilename(name: string) {
  const trimmed = name.trim() || "Untitled design";
  const safe = trimmed.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  const base = (safe || "Untitled design").slice(0, 80);
  return `${base}${PEAKCAD_FILE_EXTENSION}`;
}

export function peakcadBasename(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function peakcadNormalizedName(name: string) {
  const trimmed = name.trim();
  const withExt = trimmed.toLowerCase().endsWith(PEAKCAD_FILE_EXTENSION)
    ? trimmed
    : peakcadFilename(trimmed);
  return withExt.toLowerCase();
}

export function peakcadNamesMatch(left: string, right: string) {
  return peakcadNormalizedName(left) === peakcadNormalizedName(right);
}

export function buildPeakcadDocument(input: {
  project: PeakcadProjectMeta;
  shapes: WorkplaneShape[];
  history?: EditorHistoryEntry[];
  historyIndex?: number;
  savedAt?: number;
}): PeakcadDocument {
  const shapes = input.shapes.map(jsonSafeShape);
  return {
    format: PEAKCAD_FORMAT,
    version: PEAKCAD_DOCUMENT_VERSION,
    savedAt: input.savedAt ?? Date.now(),
    project: {
      ...input.project,
      name: input.project.name.trim() || "Untitled design",
      shapes: shapes.length,
      workspace: normalizeWorkspaceSettings(input.project.workspace),
      snapGrid: normalizeSnapGrid(input.project.snapGrid),
    },
    shapes,
    history: input.history?.map(jsonSafeHistoryEntry),
    historyIndex: input.historyIndex,
  };
}

function encodePeakcadJson(document: PeakcadDocument) {
  return `${JSON.stringify(document)}\n`;
}

function peakcadByteLength(text: string) {
  return new TextEncoder().encode(text).length;
}

/** Drop remesh caches on grouped / CSG bodies. Children stay; the file can remesh on open. */
function stripDerivedMeshCaches(shapes: WorkplaneShape[]): WorkplaneShape[] {
  return shapes.map((shape) => {
    if (!shape.groupedShapes?.length) return shape;
    return {
      ...shape,
      importedMesh: undefined,
      cadDisplayEdges: undefined,
      csg: shape.csg ? { ...shape.csg, dirty: true } : shape.csg,
      groupedShapes: stripDerivedMeshCaches(shape.groupedShapes),
    };
  });
}

export function serializePeakcadDocument(document: PeakcadDocument) {
  const attempts: PeakcadDocument[] = [
    document,
    { ...document, history: undefined, historyIndex: undefined },
    {
      ...document,
      history: undefined,
      historyIndex: undefined,
      project: { ...document.project, thumbnailUrl: null, thumbnailUrlDark: null },
    },
    {
      ...document,
      history: undefined,
      historyIndex: undefined,
      project: { ...document.project, thumbnailUrl: null, thumbnailUrlDark: null },
      shapes: stripDerivedMeshCaches(document.shapes),
    },
  ];
  let lastError: unknown = new Error("This PeakCAD file is too large to save.");
  for (const attempt of attempts) {
    try {
      const text = encodePeakcadJson(buildPeakcadDocument(attempt));
      if (peakcadByteLength(text) <= PEAKCAD_MAX_BYTES) {
        return text;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("This PeakCAD file is too large to save.");
}

export function parsePeakcadDocument(raw: string): PeakcadDocument {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("This PeakCAD file is empty.");
  }
  if (new TextEncoder().encode(raw).length > PEAKCAD_MAX_BYTES) {
    throw new Error("This PeakCAD file is too large to open.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("This is not a valid PeakCAD file.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("This is not a valid PeakCAD file.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== PEAKCAD_FORMAT) {
    throw new Error("This file is not a PeakCAD project.");
  }
  const version = asFiniteNumber(record.version, 0);
  if (version < 1) {
    throw new Error("This PeakCAD file is too old to open.");
  }
  const projectRaw = record.project;
  if (!projectRaw || typeof projectRaw !== "object") {
    throw new Error("This PeakCAD file is missing project data.");
  }
  const project = projectRaw as Record<string, unknown>;
  if (typeof project.id !== "string" || !project.id.trim()) {
    throw new Error("This PeakCAD file is missing a project id.");
  }
  if (typeof project.name !== "string" || !project.name.trim()) {
    throw new Error("This PeakCAD file is missing a project name.");
  }
  if (!Array.isArray(record.shapes)) {
    throw new Error("This PeakCAD file is missing shapes.");
  }
  const accent = ACCENTS.has(project.accent as PeakcadAccent) ? (project.accent as PeakcadAccent) : "cyan";
  const now = Date.now();
  const shapes = (record.shapes as WorkplaneShape[]).map((shape) => hydrateClipboardShape(shape));
  const history = Array.isArray(record.history)
    ? (record.history as EditorHistoryEntry[]).map((entry) => ({
        ...entry,
        shapes: Array.isArray(entry.shapes) ? entry.shapes.map((shape) => hydrateClipboardShape(shape)) : [],
        selectedIds: Array.isArray(entry.selectedIds) ? entry.selectedIds.filter((id): id is string => typeof id === "string") : [],
        fingerprint: typeof entry.fingerprint === "string" ? entry.fingerprint : "",
        estimatedBytes: asFiniteNumber(entry.estimatedBytes, 0),
      }))
    : undefined;
  return {
    format: PEAKCAD_FORMAT,
    version,
    savedAt: asFiniteNumber(record.savedAt, now),
    project: {
      id: project.id,
      name: project.name.trim(),
      createdAt: asFiniteNumber(project.createdAt, now),
      updatedAt: asFiniteNumber(project.updatedAt, now),
      accent,
      shapes: shapes.length,
      revision: typeof project.revision === "number" ? project.revision : undefined,
      workspace: normalizeWorkspaceSettings(project.workspace),
      snapGrid: normalizeSnapGrid(project.snapGrid),
      thumbnailUrl: typeof project.thumbnailUrl === "string" ? project.thumbnailUrl : null,
      thumbnailUrlDark: typeof project.thumbnailUrlDark === "string" ? project.thumbnailUrlDark : null,
      thumbnailVersion: typeof project.thumbnailVersion === "number" ? project.thumbnailVersion : undefined,
    },
    shapes,
    history,
    historyIndex: typeof record.historyIndex === "number" ? record.historyIndex : undefined,
  };
}
