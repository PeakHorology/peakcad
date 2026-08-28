import { describe, expect, it } from "vitest";
import {
  addConstraints,
  addLinearDimension,
  closedProfilesFromLegacy,
  createEmptySketchDoc,
  projectEdgesOntoSketch,
  rectangularPattern,
  setConstruction,
  sketchDocToProfile,
  sketchProfileToDoc,
  snapSketchPoint,
  solveSketchDoc,
  trimEntity,
} from "../../apps/web/src/lib/sketch";
import { defaultSketchPlane } from "../../apps/web/src/lib/sketchPlane";

describe("sketch document foundations", () => {
  it("migrates legacy profiles to SketchDoc and back", () => {
    const profile = {
      points: [
        { id: "p1", x: 0, z: 0 },
        { id: "p2", x: 10, z: 0 },
        { id: "p3", x: 10, z: 10 },
        { id: "p4", x: 0, z: 10 },
      ],
      segments: [
        { id: "s1", startId: "p1", endId: "p2", kind: "line" as const },
        { id: "s2", startId: "p2", endId: "p3", kind: "line" as const },
        { id: "s3", startId: "p3", endId: "p4", kind: "line" as const },
        { id: "s4", startId: "p4", endId: "p1", kind: "line" as const },
      ],
      sketchPlane: defaultSketchPlane(),
    };
    const doc = sketchProfileToDoc(profile, "sketch-test");
    expect(doc.entities.filter((e) => e.kind === "point")).toHaveLength(4);
    expect(doc.entities.filter((e) => e.kind === "line")).toHaveLength(4);
    const roundTrip = sketchDocToProfile(doc);
    expect(roundTrip.points).toHaveLength(4);
    expect(closedProfilesFromLegacy(roundTrip)).toHaveLength(1);
  });

  it("snaps to endpoints and horizontal inference", () => {
    const profile = {
      points: [{ id: "p1", x: 0, z: 0 }],
      segments: [],
    };
    const endpoint = snapSketchPoint(profile, {
      cursor: { x: 0.2, z: 0.1 },
      screenUnit: 0.05,
      from: null,
    });
    expect(endpoint.kind).toBe("endpoint");
    const horiz = snapSketchPoint(profile, {
      cursor: { x: 12, z: 0.1 },
      screenUnit: 0.05,
      from: { x: 0, z: 0 },
    });
    expect(horiz.kind).toBe("horizontal");
    expect(horiz.z).toBe(0);
  });

  it("solves horizontal constraints and driving dimensions", () => {
    let doc = createEmptySketchDoc(defaultSketchPlane(), "solve-test");
    doc.entities = [
      { kind: "point", id: "a", x: 0, z: 0 },
      { kind: "point", id: "b", x: 10, z: 3 },
      { kind: "line", id: "l1", startId: "a", endId: "b" },
    ];
    doc = addConstraints(doc, [{ kind: "horizontal", entityIds: ["l1"] }]);
    let solved = solveSketchDoc(doc);
    const a = solved.doc.entities.find((e) => e.id === "a" && e.kind === "point");
    const b = solved.doc.entities.find((e) => e.id === "b" && e.kind === "point");
    expect(a && a.kind === "point" && b && b.kind === "point").toBe(true);
    if (a?.kind === "point" && b?.kind === "point") {
      expect(Math.abs(a.z - b.z)).toBeLessThan(0.05);
    }
    solved = addLinearDimension(solved.doc, { entityId: "l1", value: 20, driving: true });
    const a2 = solved.doc.entities.find((e) => e.id === "a" && e.kind === "point");
    const b2 = solved.doc.entities.find((e) => e.id === "b" && e.kind === "point");
    if (a2?.kind === "point" && b2?.kind === "point") {
      expect(Math.hypot(b2.x - a2.x, b2.z - a2.z)).toBeCloseTo(20, 0);
    }
  });

  it("supports construction, trim, pattern, and project ops", () => {
    let doc = createEmptySketchDoc(defaultSketchPlane(), "ops-test");
    doc.entities = [
      { kind: "point", id: "a", x: 0, z: 0 },
      { kind: "point", id: "b", x: 10, z: 0 },
      { kind: "line", id: "l1", startId: "a", endId: "b" },
    ];
    doc = setConstruction(doc, ["l1"], true);
    expect(doc.entities.find((e) => e.id === "l1")?.construction).toBe(true);
    doc = setConstruction(doc, ["l1"], false);
    const patterned = rectangularPattern(doc, ["l1", "a", "b"], 2, 1, 12, 0);
    expect(patterned.entities.filter((e) => e.kind === "line").length).toBeGreaterThanOrEqual(2);
    const trimmed = trimEntity(patterned, "l1");
    expect(trimmed.entities.some((e) => e.id === "l1")).toBe(false);
    const projected = projectEdgesOntoSketch(createEmptySketchDoc(defaultSketchPlane()), [
      {
        sourceId: "box:edge:0",
        worldPoints: [
          { x: -5, y: 0, z: -5 },
          { x: 5, y: 0, z: -5 },
        ],
      },
    ]);
    expect(projected.addedEntityIds.length).toBeGreaterThan(0);
    expect(projected.doc.entities.some((e) => e.projected)).toBe(true);
  });
});
