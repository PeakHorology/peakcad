import { describe, expect, it } from "vitest";
import { collectEditableSketchLeaves, resolveEditableSketchShape, shapeHasEditableSketch } from "@/lib/sketch/session";
import type { WorkplaneShape } from "@/types/sketchforge";

function baseShape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
  return {
    id: "shape",
    name: "Shape",
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

describe("resolveEditableSketchShape", () => {
  it("prefers face-hosted cut features over the host extrusion sketch", () => {
    const hostSketch = baseShape({
      id: "extrusion",
      sketchFinish: "extrude",
      sketchProfile: { points: [], segments: [] },
    });
    const faceHole = baseShape({
      id: "face-hole",
      hole: true,
      sketchFinish: "extrude",
      sketchProfile: { points: [], segments: [] },
      sketchPlane: {
        origin: { x: 0, y: 10, z: 0 },
        uAxis: { x: 1, y: 0, z: 0 },
        vAxis: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: 1, z: 0 },
        hostShapeId: "body",
      },
    });
    const body = baseShape({
      id: "body",
      kind: "mesh",
      csg: { op: "subtract", version: 1 },
      groupedShapes: [hostSketch, faceHole],
    });

    expect(shapeHasEditableSketch(body)).toBe(true);
    expect(resolveEditableSketchShape(body)?.id).toBe("face-hole");
    expect(collectEditableSketchLeaves(body).map((leaf) => leaf.id)).toEqual(["extrusion", "face-hole"]);
  });

  it("honors preferred feature id from Alt-click / Features list", () => {
    const a = baseShape({ id: "a", sketchFinish: "extrude", sketchProfile: { points: [], segments: [] } });
    const b = baseShape({
      id: "b",
      hole: true,
      sketchFinish: "extrude",
      sketchProfile: { points: [], segments: [] },
      sketchPlane: {
        origin: { x: 0, y: 10, z: 0 },
        uAxis: { x: 1, y: 0, z: 0 },
        vAxis: { x: 0, y: 0, z: 1 },
        normal: { x: 0, y: 1, z: 0 },
        hostShapeId: "body",
      },
    });
    const body = baseShape({ id: "body", groupedShapes: [a, b] });

    expect(resolveEditableSketchShape(body, { preferredId: "a" })?.id).toBe("a");
  });

  it("falls back to the body's own sketch when there are no face features", () => {
    const extrusion = baseShape({
      id: "only",
      sketchFinish: "extrude",
      sketchProfile: { points: [], segments: [] },
    });
    expect(resolveEditableSketchShape(extrusion)?.id).toBe("only");
  });
});
