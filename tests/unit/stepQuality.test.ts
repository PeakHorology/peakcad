import { describe, expect, it } from "vitest";
import {
  buildStepExportPreflight,
  OCCT_MESH_FALLBACK_NOTICE,
  occtMeshFallbackNotice,
  selectionSupportsOcctCsg,
  shapeExportQualityHint,
  shapeExportQualityHintInScene,
} from "@/lib/stepQuality";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "s1",
    name: "Shape",
    kind: "box",
    color: "#fff",
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...overrides,
  };
}

describe("stepQuality", () => {
  it("marks native boxes exact", () => {
    expect(shapeExportQualityHint(shape())).toBe("exact");
  });

  it("does not promise a STEP for a body whose geometry lives only in the viewport", () => {
    // Text glyphs are built from a font at render time, so the STEP writer has nothing to
    // consume and drops the body. Reporting "faceted" promised an export that never happened.
    expect(shapeExportQualityHint(shape({ kind: "text", text: "Hi" }))).toBe("unsupported");
    expect(shapeExportQualityHint(shape({ kind: "icosahedron" }))).toBe("unsupported");
  });

  it("still reports faceted for a specialty solid that carries a mesh", () => {
    // Threads are faceted by nature but always carry their generated mesh.
    expect(shapeExportQualityHint(shape({
      kind: "thread",
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 6,
        baseDepth: 6,
        baseHeight: 20,
        triangleCount: 1,
        sourceFormat: "json",
      },
    }))).toBe("faceted");
  });

  it("tells the preflight reader what to do instead", () => {
    const rows = buildStepExportPreflight([shape({ kind: "text", name: "Label", text: "Hi" })]);
    expect(rows[0].quality).toBe("unsupported");
    expect(rows[0].detail).toContain("STL");
  });

  it("marks dirty CSG as pending", () => {
    expect(shapeExportQualityHint(shape({
      kind: "mesh",
      csg: { op: "subtract", version: 1, dirty: true },
      groupedShapes: [shape({ id: "a" }), shape({ id: "b", hole: true })],
    }))).toBe("pending");
  });

  it("supports OCCT CSG when every operand is exact-capable", () => {
    expect(selectionSupportsOcctCsg([
      shape({ id: "a" }),
      shape({ id: "b", kind: "cylinder", hole: true }),
    ])).toBe(true);
    expect(selectionSupportsOcctCsg([
      shape({ id: "a" }),
      shape({ id: "b", kind: "text", hole: true, text: "x" }),
    ])).toBe(false);
  });

  it("builds preflight rows for solids only", () => {
    const rows = buildStepExportPreflight([
      shape({ id: "a", name: "Plate" }),
      shape({ id: "b", name: "Hole", hole: true, kind: "cylinder" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Plate");
    expect(rows[0].quality).toBe("exact");
  });

  describe("a loose cutter with no exact B-Rep", () => {
    // The writer tessellates such a cutter and bores the part with it, so the cut walls come out
    // faceted. Judging the part on its own reported "exact" right up to the download.
    const meshCutter = shape({
      id: "cut",
      name: "Scan cutter",
      kind: "mesh",
      hole: true,
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 10,
        triangleCount: 1,
        sourceFormat: "stl",
      },
    });

    it("downgrades a part it reaches, and says why", () => {
      const rows = buildStepExportPreflight([shape({ id: "a", name: "Plate" }), meshCutter]);
      expect(rows).toHaveLength(1);
      expect(rows[0].quality).toBe("faceted");
      expect(rows[0].detail).toContain("Scan cutter");
    });

    it("leaves a part it cannot reach alone", () => {
      const rows = buildStepExportPreflight([
        shape({ id: "a", name: "Plate", x: 500 }),
        meshCutter,
      ]);
      expect(rows[0].quality).toBe("exact");
      expect(rows[0].detail).toBe("native analytic solid");
    });

    it("leaves an evaluated body alone, since the writer does not re-cut it", () => {
      const body = shape({
        id: "body",
        name: "Bracket",
        kind: "mesh",
        csg: { op: "subtract", version: 1 },
        groupedShapes: [shape({ id: "a" }), shape({ id: "b", hole: true, kind: "cylinder" })],
        importedMesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          baseWidth: 10,
          baseDepth: 10,
          baseHeight: 10,
          triangleCount: 1,
          sourceFormat: "step",
          brepStep: "ISO-10303-21;",
        },
      });
      expect(buildStepExportPreflight([body, meshCutter])[0].quality).toBe("exact");
    });

    it("is reflected in the inspector badge too", () => {
      const plate = shape({ id: "a", name: "Plate" });
      expect(shapeExportQualityHint(plate)).toBe("exact");
      expect(shapeExportQualityHintInScene(plate, [plate, meshCutter])).toBe("faceted");
      expect(shapeExportQualityHintInScene(plate, [plate])).toBe("exact");
    });

    it("ignores a cutter that is hidden or suppressed", () => {
      const plate = shape({ id: "a", name: "Plate" });
      expect(shapeExportQualityHintInScene(plate, [plate, { ...meshCutter, hidden: true }])).toBe("exact");
      expect(shapeExportQualityHintInScene(plate, [plate, { ...meshCutter, suppressed: true }])).toBe("exact");
    });
  });

  it("keeps a part exact when the cutter reaching it is exact", () => {
    const plate = shape({ id: "a", name: "Plate" });
    const drill = shape({ id: "b", name: "Bore", kind: "cylinder", hole: true });
    expect(shapeExportQualityHintInScene(plate, [plate, drill])).toBe("exact");
  });

  it("names the mesh Group fallback only when OCCT was eligible and failed", () => {
    expect(occtMeshFallbackNotice({
      occtEligible: true,
      resultHasExactBrep: false,
    })).toBe(OCCT_MESH_FALLBACK_NOTICE);
    expect(occtMeshFallbackNotice({
      skipOcct: true,
      occtEligible: true,
      resultHasExactBrep: false,
    })).toBeUndefined();
    expect(occtMeshFallbackNotice({
      occtEligible: true,
      resultHasExactBrep: true,
    })).toBeUndefined();
    expect(occtMeshFallbackNotice({
      occtEligible: false,
      resultHasExactBrep: false,
    })).toBeUndefined();
  });
});
