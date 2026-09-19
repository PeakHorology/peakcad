import { describe, expect, it } from "vitest";
import {
  cloneShapesForPaste,
  hydrateClipboardShape,
  jsonSafeShape,
  parseClipboardShapes,
  serializeClipboardShapes,
} from "@/lib/shapeClipboard";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "box-1",
    name: "Box",
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 20,
    height: 20,
    rotation: 0,
    locked: false,
    hidden: false,
    ...overrides,
  };
}

describe("shape clipboard history", () => {
  it("round-trips nested group children through JSON", () => {
    const group = box({
      id: "group-1",
      name: "Group",
      kind: "mesh",
      csg: { op: "assemble", version: 1 },
      groupedShapes: [
        box({ id: "solid", x: -4 }),
        box({
          id: "nested",
          groupedShapes: [box({ id: "hole", hole: true, kind: "cylinder", color: "#d97813" })],
        }),
      ],
    });

    const parsed = parseClipboardShapes(serializeClipboardShapes([group]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].groupedShapes?.map((child) => child.id)).toEqual(["solid", "nested"]);
    expect(parsed[0].groupedShapes?.[1].groupedShapes?.[0].id).toBe("hole");
    expect(parsed[0].groupedShapes?.[1].groupedShapes?.[0].hole).toBe(true);
    expect(parsed[0].csg?.op).toBe("assemble");
  });

  it("hydrates mesh positions stored as JSON objects so the pasted body still ungroups", () => {
    const packed = {
      ...box({
        id: "group-1",
        kind: "mesh",
        groupedShapes: [box({ id: "child" })],
        importedMesh: {
          positions: { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9 } as unknown as number[],
          baseWidth: 20,
          baseDepth: 20,
          baseHeight: 20,
          triangleCount: 1,
          sourceFormat: "stl" as const,
        },
      }),
    };

    const hydrated = hydrateClipboardShape(packed);
    expect(Array.isArray(hydrated.importedMesh?.positions)).toBe(true);
    expect(hydrated.importedMesh?.positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(hydrated.groupedShapes?.[0].id).toBe("child");
  });

  it("writes typed mesh arrays as real JSON arrays", () => {
    const group = jsonSafeShape(box({
      id: "group-1",
      importedMesh: {
        positions: new Float32Array([0, 1, 2]) as unknown as number[],
        baseWidth: 1,
        baseDepth: 1,
        baseHeight: 1,
        triangleCount: 0,
        sourceFormat: "stl",
      },
    }));
    const parsed = JSON.parse(JSON.stringify(group)) as WorkplaneShape;
    expect(Array.isArray(parsed.importedMesh?.positions)).toBe(true);
    expect(parsed.importedMesh?.positions).toEqual([0, 1, 2]);
  });

  it("clones a group for paste with new ids while keeping ungroup children", () => {
    const group = box({
      id: "group-1",
      kind: "mesh",
      groupedShapes: [
        box({ id: "solid", x: -5 }),
        box({ id: "cutter", hole: true, x: 5 }),
      ],
      edgeTreatmentHistory: [
        {
          id: "hist-1",
          createdAt: 1,
          feature: { kind: "chamfer", amount: 1, edgeCount: 2 },
          before: box({ id: "before-1", groupedShapes: [box({ id: "before-child" })] }),
        },
      ],
    });

    const [pasted] = cloneShapesForPaste([group]);
    expect(pasted.id).not.toBe(group.id);
    expect(pasted.groupedShapes).toHaveLength(2);
    expect(pasted.groupedShapes?.map((child) => child.hole)).toEqual([undefined, true]);
    expect(pasted.groupedShapes?.every((child) => child.id !== "solid" && child.id !== "cutter")).toBe(true);
    expect(new Set(pasted.groupedShapes?.map((child) => child.id)).size).toBe(2);
    expect(pasted.edgeTreatmentHistory?.[0].before.groupedShapes?.[0].id).not.toBe("before-child");
    expect(pasted.edgeTreatmentHistory?.[0].before.groupedShapes).toHaveLength(1);
  });
});
