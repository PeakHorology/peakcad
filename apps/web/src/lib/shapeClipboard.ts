import { createLocalId } from "@/lib/localIds";
import { sceneShape } from "@/lib/shapeCatalog";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import type { SketchPlane, WorkplaneShape } from "@/types/sketchforge";

export const SHARED_CLIPBOARD_STORAGE_KEY = "sketchForge.clipboard";
export const SYSTEM_CLIPBOARD_PREFIX = "SKETCHFORGE3D/1\n";
const CLIPBOARD_DB_NAME = "sketchForge.clipboard";
const CLIPBOARD_DB_VERSION = 1;
const CLIPBOARD_STORE_NAME = "payload";
const CLIPBOARD_RECORD_KEY = "current";

type ClipboardRecord = {
  id: typeof CLIPBOARD_RECORD_KEY;
  copiedAt: number;
  shapes: WorkplaneShape[];
};

function numericArrayFromUnknown(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>, Number);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.length === "number" && record.length >= 0) {
      return Array.from(record as unknown as ArrayLike<number>, Number);
    }
    const keys = Object.keys(record);
    if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
      const next: number[] = [];
      for (const key of keys) next[Number(key)] = Number(record[key]);
      return next;
    }
  }
  return undefined;
}

function jsonSafeMesh(mesh: NonNullable<WorkplaneShape["importedMesh"]>): NonNullable<WorkplaneShape["importedMesh"]> {
  return {
    ...mesh,
    positions: Array.from(mesh.positions),
    ...(mesh.indices ? { indices: Array.from(mesh.indices) } : {}),
    ...(mesh.normals ? { normals: Array.from(mesh.normals) } : {}),
  };
}

/** Convert typed arrays to real arrays so JSON stays compact and round-trips as arrays. */
export function jsonSafeShape(shape: WorkplaneShape): WorkplaneShape {
  return canonicalizeShape({
    ...shape,
    importedMesh: shape.importedMesh ? jsonSafeMesh(shape.importedMesh) : undefined,
    groupedShapes: shape.groupedShapes?.map(jsonSafeShape),
    edgeTreatmentHistory: shape.edgeTreatmentHistory?.map((entry) => ({
      ...entry,
      before: jsonSafeShape(entry.before),
    })),
    threadHistory: shape.threadHistory?.map((entry) => ({
      ...entry,
      before: jsonSafeShape(entry.before),
    })),
  });
}

function hydrateMesh(mesh: NonNullable<WorkplaneShape["importedMesh"]>): NonNullable<WorkplaneShape["importedMesh"]> {
  const positions = numericArrayFromUnknown(mesh.positions) ?? [];
  const indices = numericArrayFromUnknown(mesh.indices);
  const normals = numericArrayFromUnknown(mesh.normals);
  return {
    ...mesh,
    positions,
    ...(indices ? { indices } : {}),
    ...(normals ? { normals } : {}),
  };
}

export function hydrateClipboardShape(shape: WorkplaneShape): WorkplaneShape {
  return canonicalizeShape({
    ...shape,
    importedMesh: shape.importedMesh ? hydrateMesh(shape.importedMesh) : undefined,
    groupedShapes: shape.groupedShapes?.map(hydrateClipboardShape),
    edgeTreatmentHistory: shape.edgeTreatmentHistory?.map((entry) => ({
      ...entry,
      before: hydrateClipboardShape(entry.before),
    })),
    threadHistory: shape.threadHistory?.map((entry) => ({
      ...entry,
      before: hydrateClipboardShape(entry.before),
    })),
  });
}

function isClipboardShape(value: unknown): value is Partial<WorkplaneShape> & Pick<WorkplaneShape, "name" | "kind" | "color"> {
  if (!value || typeof value !== "object") return false;
  const shape = value as Partial<WorkplaneShape>;
  return typeof shape.name === "string" && typeof shape.kind === "string" && typeof shape.color === "string";
}

export function parseClipboardShapes(serialized: string): WorkplaneShape[] {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!isClipboardShape(entry)) return [];
      return [hydrateClipboardShape(sceneShape(entry))];
    });
  } catch {
    return [];
  }
}

export function serializeClipboardShapes(shapes: WorkplaneShape[]): string {
  return JSON.stringify(shapes.map(jsonSafeShape));
}

function rewriteSketchPlane(plane: SketchPlane | undefined, idMap: Map<string, string>): SketchPlane | undefined {
  if (!plane?.hostShapeId) return plane;
  const mapped = idMap.get(plane.hostShapeId);
  return mapped ? { ...plane, hostShapeId: mapped } : plane;
}

function collectShapeIds(shape: WorkplaneShape, ids: Set<string>) {
  ids.add(shape.id);
  shape.groupedShapes?.forEach((child) => collectShapeIds(child, ids));
  shape.edgeTreatmentHistory?.forEach((entry) => collectShapeIds(entry.before, ids));
  shape.threadHistory?.forEach((entry) => collectShapeIds(entry.before, ids));
}

function remapShapeTree(shape: WorkplaneShape, idMap: Map<string, string>, sketchMap: Map<string, string>): WorkplaneShape {
  const nextId = idMap.get(shape.id) ?? shape.id;
  const nextSketchId = shape.sketchId
    ? sketchMap.get(shape.sketchId) ?? shape.sketchId
    : undefined;
  const nextDocId = shape.sketchDoc?.id
    ? sketchMap.get(shape.sketchDoc.id) ?? nextSketchId ?? shape.sketchDoc.id
    : undefined;
  return {
    ...shape,
    id: nextId,
    sketchId: nextSketchId ?? shape.sketchId,
    sketchPlane: rewriteSketchPlane(shape.sketchPlane, idMap),
    sketchProfile: shape.sketchProfile
      ? {
          ...shape.sketchProfile,
          sketchPlane: rewriteSketchPlane(shape.sketchProfile.sketchPlane, idMap),
        }
      : shape.sketchProfile,
    sketchDoc: shape.sketchDoc
      ? {
          ...shape.sketchDoc,
          id: nextDocId ?? shape.sketchDoc.id,
          plane: rewriteSketchPlane(shape.sketchDoc.plane, idMap) ?? shape.sketchDoc.plane,
        }
      : shape.sketchDoc,
    groupedShapes: shape.groupedShapes?.map((child) => remapShapeTree(child, idMap, sketchMap)),
    edgeTreatmentHistory: shape.edgeTreatmentHistory?.map((entry) => ({
      ...entry,
      id: createLocalId("edge-history"),
      before: remapShapeTree(entry.before, idMap, sketchMap),
    })),
    threadHistory: shape.threadHistory?.map((entry) => ({
      ...entry,
      id: createLocalId("thread-history"),
      before: remapShapeTree(entry.before, idMap, sketchMap),
    })),
  };
}

function deepCloneShapes(shapes: WorkplaneShape[]): WorkplaneShape[] {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(shapes);
    } catch {
      // Fall through to JSON for values structuredClone rejects.
    }
  }
  return parseClipboardShapes(serializeClipboardShapes(shapes));
}

/**
 * Fresh ids for a paste, including nested group children, fillet/chamfer
 * snapshots, and sketch-host links — so Ungroup in the destination project
 * works the same as in the source.
 */
export function cloneShapesForPaste(shapes: WorkplaneShape[]): WorkplaneShape[] {
  const cloned = deepCloneShapes(shapes).map(hydrateClipboardShape);
  const idMap = new Map<string, string>();
  const sketchMap = new Map<string, string>();
  const ids = new Set<string>();
  cloned.forEach((shape) => collectShapeIds(shape, ids));
  ids.forEach((id) => idMap.set(id, createLocalId(`${id}-paste`)));

  const collectSketchIds = (shape: WorkplaneShape) => {
    if (shape.sketchId && !sketchMap.has(shape.sketchId)) {
      sketchMap.set(shape.sketchId, createLocalId("sketch"));
    }
    if (shape.sketchDoc?.id && !sketchMap.has(shape.sketchDoc.id)) {
      sketchMap.set(shape.sketchDoc.id, shape.sketchId ? sketchMap.get(shape.sketchId)! : createLocalId("sketch"));
    }
    shape.groupedShapes?.forEach(collectSketchIds);
    shape.edgeTreatmentHistory?.forEach((entry) => collectSketchIds(entry.before));
    shape.threadHistory?.forEach((entry) => collectSketchIds(entry.before));
  };
  cloned.forEach(collectSketchIds);

  return cloned.map((shape) => canonicalizeShape(remapShapeTree(shape, idMap, sketchMap)));
}

function copyTextWithSelectionFallback(value: string) {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {
    // The modern Clipboard API below may still succeed.
  }
  textarea.remove();
  previousFocus?.focus({ preventScroll: true });
}

function openClipboardDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("Clipboard storage is unavailable"));
      return;
    }
    const request = window.indexedDB.open(CLIPBOARD_DB_NAME, CLIPBOARD_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CLIPBOARD_STORE_NAME)) {
        database.createObjectStore(CLIPBOARD_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open clipboard storage"));
    request.onsuccess = () => resolve(request.result);
  });
}

async function writeClipboardIdb(shapes: WorkplaneShape[]): Promise<void> {
  const database = await openClipboardDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CLIPBOARD_STORE_NAME, "readwrite");
    transaction.objectStore(CLIPBOARD_STORE_NAME).put({
      id: CLIPBOARD_RECORD_KEY,
      copiedAt: Date.now(),
      shapes,
    } satisfies ClipboardRecord);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save clipboard"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save clipboard"));
    };
  });
}

async function readClipboardIdb(): Promise<WorkplaneShape[]> {
  if (typeof window === "undefined" || !window.indexedDB) return [];
  try {
    const database = await openClipboardDb();
    return await new Promise<WorkplaneShape[]>((resolve, reject) => {
      const transaction = database.transaction(CLIPBOARD_STORE_NAME, "readonly");
      const request = transaction.objectStore(CLIPBOARD_STORE_NAME).get(CLIPBOARD_RECORD_KEY);
      request.onerror = () => reject(request.error ?? new Error("Could not load clipboard"));
      request.onsuccess = () => {
        const record = request.result as ClipboardRecord | undefined;
        resolve(Array.isArray(record?.shapes) ? record.shapes.map(hydrateClipboardShape) : []);
      };
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("Could not load clipboard"));
      };
    });
  } catch {
    return [];
  }
}

export function readSharedClipboard(): WorkplaneShape[] {
  if (typeof window === "undefined") return [];
  return parseClipboardShapes(window.localStorage.getItem(SHARED_CLIPBOARD_STORAGE_KEY) ?? "[]");
}

export async function readSystemClipboard(): Promise<WorkplaneShape[]> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return [];
  try {
    const value = await navigator.clipboard.readText();
    return value.startsWith(SYSTEM_CLIPBOARD_PREFIX)
      ? parseClipboardShapes(value.slice(SYSTEM_CLIPBOARD_PREFIX.length))
      : [];
  } catch {
    return [];
  }
}

export async function writeShapeClipboard(shapes: WorkplaneShape[]): Promise<void> {
  const forStore = typeof structuredClone === "function" ? structuredClone(shapes) : shapes.map(jsonSafeShape);
  try {
    await writeClipboardIdb(forStore);
  } catch {
    // localStorage / system clipboard still carry small copies.
  }
  const serialized = serializeClipboardShapes(shapes);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SHARED_CLIPBOARD_STORAGE_KEY, serialized);
    } catch {
      try {
        window.localStorage.setItem(SHARED_CLIPBOARD_STORAGE_KEY, JSON.stringify({ v: 2, via: "idb" }));
      } catch {
        // IndexedDB still holds the full group tree.
      }
    }
  }
  const systemPayload = `${SYSTEM_CLIPBOARD_PREFIX}${serialized}`;
  copyTextWithSelectionFallback(systemPayload);
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(systemPayload).catch(() => {
      // Same-origin tabs still have IndexedDB + local-storage fallbacks.
    });
  }
}

export async function readShapeClipboard(): Promise<WorkplaneShape[]> {
  const stored = await readClipboardIdb();
  if (stored.length > 0) return stored;
  if (typeof navigator !== "undefined") {
    const system = await readSystemClipboard();
    if (system.length > 0) return system;
  }
  return readSharedClipboard();
}
