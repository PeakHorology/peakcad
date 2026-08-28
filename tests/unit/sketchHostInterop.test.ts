import { describe, expect, it } from "vitest";
import {
  defaultSketchPlane,
  isDefaultSketchPlane,
  isFaceHostedSketch,
  mergeSketchPlanes,
} from "../../apps/web/src/lib/sketchPlane";
import { sketchProfileToDoc } from "../../apps/web/src/lib/sketch/migrate";
import { withHoleMode } from "../../apps/web/src/lib/workplaneShapes";
import type { WorkplaneShape } from "../../apps/web/src/types/sketchforge";

describe("sketch ↔ 3D host interop", () => {
  it("treats top-face sketches with hostShapeId as face-hosted even when orientation matches workplane", () => {
    const topFace = {
      ...defaultSketchPlane(),
      hostShapeId: "box-1",
    };
    expect(isDefaultSketchPlane(topFace)).toBe(false);
    expect(isFaceHostedSketch(topFace)).toBe(true);
  });

  it("treats face reference loops as face-hosted when hostShapeId was dropped", () => {
    const plane = defaultSketchPlane();
    expect(isDefaultSketchPlane(plane)).toBe(true);
    expect(isFaceHostedSketch(plane, [[{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }]])).toBe(true);
  });

  it("merges hostShapeId from either plane side", () => {
    const withHost = { ...defaultSketchPlane(), hostShapeId: "cyl-9" };
    const merged = mergeSketchPlanes(defaultSketchPlane(), withHost);
    expect(merged.hostShapeId).toBe("cyl-9");
    const clearedProfile = sketchProfileToDoc(
      { points: [], segments: [], sketchPlane: defaultSketchPlane() },
      "sketch-1",
      withHost,
    );
    expect(clearedProfile.plane.hostShapeId).toBe("cyl-9");
  });

  it("does not flip child hole roles when toggling a boolean cut group", () => {
    const group = {
      id: "grouped-manifold-cut-abc",
      name: "Cut",
      kind: "mesh",
      color: "#d41721",
      hole: false,
      x: 0,
      z: 0,
      size: 10,
      width: 10,
      depth: 10,
      height: 10,
      rotation: 0,
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 10,
        triangleCount: 1,
        sourceFormat: "json",
      },
      groupedShapes: [
        {
          id: "solid-child",
          name: "Box",
          kind: "box",
          color: "#d41721",
          hole: false,
          x: 0,
          z: 0,
          size: 10,
          width: 10,
          depth: 10,
          height: 10,
          rotation: 0,
        },
        {
          id: "hole-child",
          name: "Hole",
          kind: "mesh",
          color: "#b8c2cc",
          hole: true,
          x: 0,
          z: 0,
          size: 4,
          width: 4,
          depth: 4,
          height: 4,
          rotation: 0,
        },
      ],
    } as WorkplaneShape;

    const asHole = withHoleMode(group, true);
    expect(asHole.hole).toBe(true);
    expect(asHole.groupedShapes?.[0].hole).toBe(false);
    expect(asHole.groupedShapes?.[1].hole).toBe(true);
  });
});
