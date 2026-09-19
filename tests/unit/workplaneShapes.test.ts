import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import {
  canonicalizeShape,
  cleanNearZero,
  cleanRotationDegrees,
  coneBaseRadius,
  coneMaxRadius,
  conePatchForFootprint,
  conePatchForRadii,
  coneTopRadius,
  roofPatchForFootprint,
  roofPatchForHeight,
  coneUnitBaseScale,
  coneUnitTopScale,
  fallbackSolidColor,
  mirroredAxisCount,
  mirrorSign,
  normalizeDegrees,
  proportionalResizeScale,
  groupedChildrenDisplayScale,
  preservesEdgeTreatmentSize,
  resizedImportedCoordinates,
  resizedImportedMeshPositions,
  resizedShapeSize,
  serializeShapesForSync,
  shapeDepth,
  shapeWidth,
  withHoleMode,
  workplaneShapesEqual,
} from "@/lib/workplaneShapes";

function shape(overrides: Partial<WorkplaneShape> = {}): WorkplaneShape {
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

describe("workplane shape helpers", () => {
  it("normalizes and cleans rotations", () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(450)).toBe(90);
    expect(cleanRotationDegrees(Number.NaN)).toBe(0);
    expect(cleanRotationDegrees(-0.2)).toBe(0);
    expect(cleanRotationDegrees(359.8)).toBe(0);
    expect(cleanRotationDegrees(12.34)).toBe(12.3);
  });

  it("cleans near-zero values and derives dimensions", () => {
    const base = shape({ size: 30, width: 18, depth: 24 });
    expect(cleanNearZero(0.004)).toBe(0);
    expect(cleanNearZero(0.006)).toBe(0.006);
    expect(shapeWidth(base)).toBe(18);
    expect(shapeDepth(base)).toBe(24);
    expect(resizedShapeSize(18, 24)).toBe(24);
  });

  it("does not shrink patterned group children to a wrapper AABB", () => {
    const grouped = shape({
      width: 80,
      depth: 80,
      height: 10,
      groupedBaseWidth: 80,
      groupedBaseDepth: 80,
      groupedBaseHeight: 10,
    });
    expect(groupedChildrenDisplayScale(grouped)).toEqual({ x: 1, y: 1, z: 1 });
    expect(groupedChildrenDisplayScale({ ...grouped, width: 40, depth: 40, height: 5 })).toEqual({
      x: 0.5,
      y: 0.5,
      z: 0.5,
    });
  });

  it("uses proportional scale instead of square dimensions while shift-resizing", () => {
    expect(proportionalResizeScale(50, 100, 100, 150)).toBe(2);
    expect(proportionalResizeScale(50, 100, 60, 200)).toBe(2);
    expect(proportionalResizeScale(50, 100, 25, 80)).toBe(0.5);
  });

  it("canonicalizes mirror flags and nested group rotations", () => {
    const canonical = canonicalizeShape(
      shape({
        rotation: 360,
        rotationX: -0.1,
        rotationZ: 45.04,
        mirrorX: false,
        mirrorY: true,
        groupedShapes: [shape({ id: "child", rotation: 720, mirrorZ: false })],
      }),
    );

    expect(canonical.rotation).toBe(0);
    expect(canonical.rotationX).toBe(0);
    expect(canonical.rotationZ).toBe(45);
    expect(canonical.mirrorX).toBeUndefined();
    expect(canonical.mirrorY).toBe(true);
    expect(canonical.groupedShapes?.[0].rotation).toBe(0);
    expect(canonical.groupedShapes?.[0].mirrorZ).toBeUndefined();
  });

  it("keeps shallow equality strict for shape payload references", () => {
    const importedMesh = { positions: [0, 0, 0], baseWidth: 1, baseDepth: 1, baseHeight: 1, triangleCount: 0, sourceFormat: "json" as const };
    const first = shape({ importedMesh });
    const sameReference = shape({ importedMesh });
    const sameValues = shape({ importedMesh: { ...importedMesh, positions: [...importedMesh.positions] } });

    expect(workplaneShapesEqual(first, sameReference)).toBe(true);
    expect(workplaneShapesEqual(first, sameValues)).toBe(false);
  });

  it("serializes canonical shapes for sync", () => {
    expect(JSON.parse(serializeShapesForSync([shape({ rotation: 359.9, mirrorX: false })]))).toEqual([
      expect.objectContaining({
        id: "box-1",
        rotation: 0,
        rotationX: 0,
        rotationZ: 0,
      }),
    ]);
  });

  it("maps helper flags and fallback colors", () => {
    expect(mirrorSign(true)).toBe(-1);
    expect(mirrorSign(false)).toBe(1);
    expect(mirroredAxisCount(shape({ mirrorX: true, mirrorY: true }))).toBe(2);
    expect(fallbackSolidColor(shape({ kind: "sphere" }))).toBe("#0098c7");
    expect(fallbackSolidColor(shape({ kind: "box" }))).toBe("#d41721");
  });

  it("applies an explicitly selected group color to every nested child", () => {
    const grouped = shape({
      kind: "mesh",
      color: "#111111",
      groupedShapes: [
        shape({ id: "child-box", color: "#222222" }),
        shape({
          id: "child-group",
          kind: "mesh",
          color: "#333333",
          groupedShapes: [shape({ id: "grandchild", kind: "sphere", color: "#444444" })],
        }),
      ],
    });

    const recolored = withHoleMode(grouped, false, "#12abef");

    expect(recolored.color).toBe("#12abef");
    expect(recolored.groupedShapes?.map((child) => child.color)).toEqual(["#12abef", "#12abef"]);
    expect(recolored.groupedShapes?.[1].groupedShapes?.[0].color).toBe("#12abef");
    expect(grouped.groupedShapes?.[0].color).toBe("#222222");
  });

  it("can resize the body while preserving fillet and chamfer boundary distances", () => {
    const modified = shape({
      kind: "mesh",
      width: 40,
      depth: 20,
      height: 40,
      edgeResizeMode: "preserve",
      edgeTreatments: [{ kind: "fillet", amount: 1, edgeCount: 1 }],
      importedMesh: {
        positions: [-10, 0, 0, -9, 1, 0, 0, 10, 0, 9, 19, 0, 10, 20, 0],
        baseWidth: 20,
        baseDepth: 20,
        baseHeight: 20,
        triangleCount: 1,
        sourceFormat: "json",
      },
    });

    expect(preservesEdgeTreatmentSize(modified)).toBe(true);
    expect(resizedImportedMeshPositions(modified)).toEqual([
      -20, 0, 0,
      -19, 1, 0,
      0, 20, 0,
      19, 39, 0,
      20, 40, 0,
    ]);
    expect(resizedImportedMeshPositions({ ...modified, edgeResizeMode: "scale" })[3]).toBe(-18);
    expect(resizedImportedCoordinates(modified, [-9, 1, 0, 9, 19, 0])).toEqual([-19, 1, 0, 19, 39, 0]);
  });

  it("uses child edge features when preserving the size of grouped treatments", () => {
    const grouped = shape({
      kind: "mesh",
      edgeResizeMode: "preserve",
      importedMesh: {
        positions: [-10, 0, 0, -8, 2, 0, 8, 18, 0, 10, 20, 0],
        baseWidth: 20,
        baseDepth: 20,
        baseHeight: 20,
        triangleCount: 1,
        sourceFormat: "json",
      },
      groupedShapes: [shape({ edgeTreatments: [{ kind: "fillet", amount: 2, edgeCount: 1 }] })],
      width: 40,
      height: 40,
    });

    expect(preservesEdgeTreatmentSize(grouped)).toBe(true);
    expect(resizedImportedMeshPositions(grouped)).toEqual([-20, 0, 0, -18, 2, 0, 18, 38, 0, 20, 40, 0]);
  });

  it("expands overall cone footprint when a radius outgrows Length/Width", () => {
    const cone = shape({
      kind: "cone",
      width: 28,
      depth: 28,
      size: 28,
      height: 40,
      baseRadius: 14,
      topRadius: 5,
    });
    expect(coneMaxRadius(cone)).toBe(14);
    expect(coneUnitBaseScale(cone)).toBeCloseTo(1, 5);
    expect(coneUnitTopScale(cone)).toBeCloseTo(5 / 14, 5);

    const grown = conePatchForRadii(cone, 20, 14);
    expect(grown.topRadius).toBe(20);
    expect(grown.baseRadius).toBe(14);
    expect(grown.width).toBeCloseTo(40, 5);
    expect(grown.depth).toBeCloseTo(40, 5);
  });

  it("shrinks overall cone footprint when the larger radius is reduced", () => {
    const cone = shape({
      kind: "cone",
      width: 64.5,
      depth: 64.5,
      size: 64.5,
      height: 2,
      baseRadius: 31,
      topRadius: 32.25,
    });
    const shrunk = conePatchForRadii(cone, 20, 31);
    expect(shrunk.topRadius).toBe(20);
    expect(shrunk.baseRadius).toBe(31);
    expect(shrunk.width).toBeCloseTo(62, 5);
    expect(shrunk.depth).toBeCloseTo(62, 5);
  });

  it("scales both cone radii when overall footprint changes", () => {
    const cone = shape({
      kind: "cone",
      width: 40,
      depth: 40,
      size: 40,
      height: 40,
      baseRadius: 14,
      topRadius: 20,
    });
    const scaled = conePatchForFootprint(cone, 80, 80);
    expect(scaled.width).toBe(80);
    expect(scaled.depth).toBe(80);
    expect(scaled.baseRadius).toBeCloseTo(28, 5);
    expect(scaled.topRadius).toBeCloseTo(40, 5);
  });

  it("scales cone radii from a single-axis footprint edit", () => {
    const cone = shape({
      kind: "cone",
      width: 40,
      depth: 40,
      size: 40,
      height: 40,
      baseRadius: 14,
      topRadius: 20,
    });
    const scaled = conePatchForFootprint(cone, 60, 40);
    expect(scaled.width).toBe(60);
    expect(scaled.depth).toBe(40);
    expect(scaled.baseRadius).toBeCloseTo(21, 5);
    expect(scaled.topRadius).toBeCloseTo(30, 5);
  });

  it("scales a triangle height with width so the base angles stay put", () => {
    const triangle = shape({
      kind: "roof",
      width: 40,
      depth: 24,
      size: 40,
      height: 20,
      leftAngle: 45,
      rightAngle: 45,
    });
    const scaled = roofPatchForFootprint(triangle, 80, 24);
    expect(scaled.width).toBe(80);
    expect(scaled.depth).toBe(24);
    expect(scaled.height).toBeCloseTo(40, 5);
    expect(scaled.leftAngle).toBe(45);
    expect(scaled.rightAngle).toBe(45);
  });

  it("scales a triangle base with height so the silhouette stays similar", () => {
    const triangle = shape({
      kind: "roof",
      width: 40,
      depth: 24,
      size: 40,
      height: 20,
      leftAngle: 30,
      rightAngle: 60,
    });
    const scaled = roofPatchForHeight(triangle, 40);
    expect(scaled.height).toBe(40);
    expect(scaled.width).toBeCloseTo(80, 5);
    expect(scaled.depth).toBe(24);
    expect(scaled.leftAngle).toBe(30);
    expect(scaled.rightAngle).toBe(60);
  });

  it("does not change triangle height when only extrusion length changes", () => {
    const triangle = shape({
      kind: "roof",
      width: 40,
      depth: 24,
      size: 40,
      height: 20,
      leftAngle: 45,
      rightAngle: 45,
    });
    const scaled = roofPatchForFootprint(triangle, 40, 48);
    expect(scaled.width).toBe(40);
    expect(scaled.depth).toBe(48);
    expect(scaled.height).toBeCloseTo(20, 5);
    expect(scaled.leftAngle).toBe(45);
    expect(scaled.rightAngle).toBe(45);
  });
});
