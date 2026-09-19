import { describe, expect, it } from "vitest";
import {
  buildPeakcadDocument,
  parsePeakcadDocument,
  peakcadFilename,
  peakcadNamesMatch,
  serializePeakcadDocument,
} from "@/lib/peakcadDocument";
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

describe("peakcad document", () => {
  it("round-trips a project with imported mesh typed arrays", () => {
    const document = buildPeakcadDocument({
      project: {
        id: "project-1",
        name: "Watch plate",
        createdAt: 10,
        updatedAt: 20,
        accent: "gold",
        shapes: 1,
      },
      shapes: [
        box({
          importedMesh: {
            positions: new Float32Array([0, 1, 2, 3, 4, 5]) as unknown as number[],
            indices: new Uint32Array([0, 1, 2]) as unknown as number[],
            baseWidth: 20,
            baseDepth: 20,
            baseHeight: 20,
            triangleCount: 1,
            sourceFormat: "stl",
          },
        }),
      ],
    });

    const parsed = parsePeakcadDocument(serializePeakcadDocument(document));
    expect(parsed.project.name).toBe("Watch plate");
    expect(parsed.shapes[0]?.importedMesh?.positions).toEqual([0, 1, 2, 3, 4, 5]);
    expect(parsed.shapes[0]?.importedMesh?.indices).toEqual([0, 1, 2]);
  });

  it("rejects a non-PeakCAD JSON file", () => {
    expect(() => parsePeakcadDocument(JSON.stringify({ name: "nope" }))).toThrow(/not a PeakCAD project/i);
  });

  it("builds a safe Windows filename", () => {
    expect(peakcadFilename('Case / "A"')).toBe("Case A.peakcad");
    expect(peakcadFilename("   ")).toBe("Untitled design.peakcad");
  });

  it("treats a design title as matching its saved .peakcad name", () => {
    expect(peakcadNamesMatch("Design · Sep 9", "Design · Sep 9.peakcad")).toBe(true);
    expect(peakcadNamesMatch("Design · Sep 9.peakcad", "Design · Sep 9.peakcad")).toBe(true);
    expect(peakcadNamesMatch("Design · Sep 9", "Case plate.peakcad")).toBe(false);
    expect(peakcadNamesMatch("  Watch plate  ", "Watch plate")).toBe(true);
  });

  it("round-trips native PeakCAD pieces and a group without an imported STL", () => {
    const cylinder: WorkplaneShape = {
      id: "cyl-1",
      name: "Cylinder",
      kind: "cylinder",
      color: "#e67e22",
      x: 30,
      z: 0,
      elevation: 0,
      size: 16,
      width: 16,
      depth: 16,
      height: 24,
      rotation: 0,
      locked: false,
      hidden: false,
    };
    const groupedChild: WorkplaneShape = {
      ...box({ id: "box-2", name: "Inner box", x: 4 }),
    };
    const document = buildPeakcadDocument({
      project: {
        id: "project-native",
        name: "Native pieces",
        createdAt: 10,
        updatedAt: 20,
        accent: "cyan",
        shapes: 3,
      },
      shapes: [
        box({ id: "box-1", name: "Bottom" }),
        cylinder,
        {
          ...box({ id: "group-1", name: "Group", kind: "box", x: 60 }),
          groupedShapes: [groupedChild],
          groupedBaseWidth: 20,
          groupedBaseDepth: 20,
          groupedBaseHeight: 20,
        },
      ],
    });

    const parsed = parsePeakcadDocument(serializePeakcadDocument(document));
    expect(parsed.shapes).toHaveLength(3);
    expect(parsed.shapes.map((shape) => shape.kind)).toEqual(["box", "cylinder", "box"]);
    expect(parsed.shapes[0]?.importedMesh).toBeUndefined();
    expect(parsed.shapes[1]).toMatchObject({ name: "Cylinder", width: 16, height: 24, x: 30 });
    expect(parsed.shapes[2]?.groupedShapes).toHaveLength(1);
    expect(parsed.shapes[2]?.groupedShapes?.[0]?.name).toBe("Inner box");
    expect(parsed.project.shapes).toBe(3);
  });
});
