import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import { appendEditorHistorySnapshot, editorHistoryEntry, expandHistoryShapes, type EditorHistoryEntry } from "@/lib/editorHistory";
import {
  createCollectingSink,
  dehydrateHistoryEntry,
  dehydrateShape,
  hydrateStoredProjectRecord,
  isStoredProjectRecord,
  mergeHistoryHead,
  migrateLegacyProjectRecord,
  PROJECT_RECORD_FORMAT,
  type StoredProjectRecord,
} from "@/lib/projectMeshBlobs";

function meshShape(id: string, positions: number[], extra: Partial<NonNullable<WorkplaneShape["importedMesh"]>> = {}): WorkplaneShape {
  return {
    id,
    name: id,
    kind: "mesh",
    color: "#b08d57",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    importedMesh: {
      positions,
      baseWidth: 10,
      baseDepth: 10,
      baseHeight: 10,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "step",
      ...extra,
    },
  };
}

// Awkward values on purpose: -0, subnormals, huge magnitudes and non-terminating decimals.
const tricky = [0.1, -0, 5e-324, 1e308, -123.456789012345, 1 / 3, 2, 3, 4];

function indexedMesh() {
  return {
    positions: [...tricky, 7, 8, 9],
    indices: [0, 1, 2, 1, 2, 3],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  };
}

function roundTrip(record: StoredProjectRecord, blobs: ReturnType<typeof createCollectingSink>["blobs"]) {
  // Structured clone mirrors what IndexedDB / postMessage do to the stored record and typed arrays.
  return hydrateStoredProjectRecord(structuredClone(record), structuredClone(blobs));
}

describe("project mesh blobs", () => {
  it("round-trips shapes losslessly, including nested groups, feature history and STEP text", () => {
    const mesh = indexedMesh();
    const child = meshShape("child", mesh.positions, { indices: mesh.indices, normals: mesh.normals, brepStep: "ISO-10303-21;\nDATA;\nENDSEC;" });
    const group: WorkplaneShape = {
      ...meshShape("group", [...tricky]),
      kind: "group",
      groupedShapes: [child],
      edgeTreatmentHistory: [{ id: "e1", createdAt: 1, feature: "fillet", before: meshShape("before", [...tricky]) } as never],
    };
    const shapes = [group, meshShape("plain", [1, 2, 3, 4, 5, 6, 7, 8, 9])];

    const { sink, blobs } = createCollectingSink();
    const keys = new Set<string>();
    const dehydrated = shapes.map((shape) => dehydrateShape(shape, sink, keys));
    expect(JSON.stringify(dehydrated)).not.toContain("1e+308");
    expect(dehydrated[0].groupedShapes![0].importedMesh!.positions).toEqual([]);

    const record: StoredProjectRecord = {
      id: "p",
      revision: 1,
      format: PROJECT_RECORD_FORMAT,
      updatedAt: 1,
      shapes: dehydrated,
      blobKeys: [...keys],
    };
    const hydrated = roundTrip(record, blobs);
    expect(hydrated.missing).toEqual([]);
    expect(hydrated.shapes).toEqual(shapes);
    expect(Object.is(hydrated.shapes[0].groupedShapes![0].importedMesh!.positions[1], -0)).toBe(true);
  });

  it("stores one blob for geometry shared by the scene and every undo entry", () => {
    const shape = meshShape("body", indexedMesh().positions, { indices: indexedMesh().indices });
    const moved = { ...shape, x: 25 };
    let entries: EditorHistoryEntry[] = [editorHistoryEntry([shape], [])];
    const next = appendEditorHistorySnapshot(entries, 0, editorHistoryEntry([moved], []));
    entries = next.entries;
    expect(entries).toHaveLength(2);

    const { sink, blobs } = createCollectingSink();
    const keys = new Set<string>();
    dehydrateShape(moved, sink, keys);
    entries.forEach((entry) => dehydrateHistoryEntry(entry, sink, keys));
    const geometryKeys = [...blobs.keys()].filter((key) => key.startsWith("g:"));
    expect(geometryKeys).toHaveLength(1);
    expect(keys.size).toBe(1);
  });

  it("restores meshes on undo after the history went through the blob store", () => {
    const shape = meshShape("body", indexedMesh().positions, { indices: indexedMesh().indices, normals: indexedMesh().normals });
    const moved = { ...shape, x: 25 };
    const first = editorHistoryEntry([shape], ["body"]);
    const { entries, index } = appendEditorHistorySnapshot([first], 0, editorHistoryEntry([moved], ["body"]));

    const { sink, blobs } = createCollectingSink();
    const shapeKeys = new Set<string>();
    const historyKeys = new Set<string>();
    const record: StoredProjectRecord = {
      id: "p",
      revision: 2,
      format: PROJECT_RECORD_FORMAT,
      updatedAt: 2,
      shapes: [dehydrateShape(moved, sink, shapeKeys)],
      history: entries.map((entry) => dehydrateHistoryEntry(entry, sink, historyKeys)),
      historyIndex: index,
      historyKeys: [...historyKeys],
      blobKeys: [...new Set([...shapeKeys, ...historyKeys])],
    };
    const hydrated = roundTrip(record, blobs);
    expect(hydrated.historyIndex).toBe(1);
    const undone = expandHistoryShapes(hydrated.history![0].shapes, hydrated.history![0].meshVault);
    expect(undone[0].x).toBe(0);
    expect(undone[0].importedMesh!.positions).toEqual(shape.importedMesh!.positions);
    expect(undone[0].importedMesh!.indices).toEqual(shape.importedMesh!.indices);
    expect(undone[0].importedMesh!.normals).toEqual(shape.importedMesh!.normals);
    // Scene and history share one array per blob after load.
    expect(hydrated.shapes[0].importedMesh!.positions).toBe(hydrated.history![1].meshVault![Object.keys(hydrated.history![1].meshVault!)[0]].positions);
  });

  it("migrates a legacy inline record without losing shapes or history", () => {
    const shape = meshShape("body", indexedMesh().positions, { indices: indexedMesh().indices, brepStep: "STEP-TEXT" });
    const history = [editorHistoryEntry([shape], [])];
    const legacy = structuredClone({ id: "old", revision: 7, shapes: [shape], history, historyIndex: 0, updatedAt: 7 });

    const { record, blobs, seeds } = migrateLegacyProjectRecord(legacy);
    expect(isStoredProjectRecord(record)).toBe(true);
    expect(isStoredProjectRecord(legacy)).toBe(false);
    expect(record.revision).toBe(7);
    expect([...seeds.values()][0].stepKey).toMatch(/^s:/);

    const hydrated = roundTrip(record, blobs);
    expect(hydrated.shapes).toEqual(legacy.shapes);
    expect(hydrated.history).toEqual(legacy.history);
    expect(hydrated.historyIndex).toBe(0);
  });

  it("keeps non-integer index payloads exact", () => {
    const shape = meshShape("odd", [...tricky], { indices: [0, 1, 2.5] });
    const { sink, blobs } = createCollectingSink();
    const keys = new Set<string>();
    const record: StoredProjectRecord = {
      id: "p", revision: 1, format: PROJECT_RECORD_FORMAT, updatedAt: 1,
      shapes: [dehydrateShape(shape, sink, keys)], blobKeys: [...keys],
    };
    expect(roundTrip(record, blobs).shapes[0].importedMesh!.indices).toEqual([0, 1, 2.5]);
  });

  it("reports missing blobs instead of inventing geometry", () => {
    const shape = meshShape("body", [...tricky]);
    const { sink } = createCollectingSink();
    const keys = new Set<string>();
    const record: StoredProjectRecord = {
      id: "p", revision: 1, format: PROJECT_RECORD_FORMAT, updatedAt: 1,
      shapes: [dehydrateShape(shape, sink, keys)], blobKeys: [...keys],
    };
    const hydrated = hydrateStoredProjectRecord(record, new Map());
    expect(hydrated.missing).toEqual([...keys]);
    expect(hydrated.shapes[0].importedMesh!.positions).toEqual([]);
  });
});

describe("mergeHistoryHead", () => {
  const entry = (fingerprint: string) => ({ shapes: [], selectedIds: [], fingerprint, estimatedBytes: 0 }) as EditorHistoryEntry;

  it("keeps the checkpoint when the head is its cursor", () => {
    const history = [entry("a"), entry("b")];
    expect(mergeHistoryHead(history, 1, entry("b"))).toEqual({ history, historyIndex: 1 });
  });

  it("moves the cursor for undo/redo inside the checkpoint", () => {
    const history = [entry("a"), entry("b"), entry("c")];
    expect(mergeHistoryHead(history, 2, entry("a")).historyIndex).toBe(0);
  });

  it("appends a new edit after the checkpoint cursor and drops the redo tail", () => {
    const history = [entry("a"), entry("b"), entry("c")];
    const merged = mergeHistoryHead(history, 1, entry("d"));
    expect(merged.history!.map((item) => item.fingerprint)).toEqual(["a", "b", "d"]);
    expect(merged.historyIndex).toBe(2);
  });

  it("starts a history from the head when there is no checkpoint", () => {
    expect(mergeHistoryHead(undefined, undefined, entry("x"))).toEqual({ history: [entry("x")], historyIndex: 0 });
  });
});
