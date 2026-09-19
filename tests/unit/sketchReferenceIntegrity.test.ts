import { describe, expect, it } from "vitest";
import { splitLineAtPoint, trimEntity } from "@/lib/sketch/editOps";
import { boxEdgesForProjection, projectEdgesOntoSketch, updateProjectedGeometry } from "@/lib/sketch/project";
import { createEmptySketchDoc } from "@/lib/sketch/types";
import type { SketchDoc } from "@/lib/sketch/types";

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  uAxis: { x: 1, y: 0, z: 0 },
};

/** Two lines sharing a mid point, with a constraint and a driving dimension on each. */
function twoLineDoc(): SketchDoc {
  const doc = createEmptySketchDoc(PLANE, "sketch-test");
  doc.entities.push(
    { kind: "point", id: "pa", x: 0, z: 0 },
    { kind: "point", id: "pb", x: 10, z: 0 },
    { kind: "point", id: "pc", x: 20, z: 0 },
    { kind: "line", id: "l1", startId: "pa", endId: "pb" },
    { kind: "line", id: "l2", startId: "pb", endId: "pc" },
  );
  doc.constraints.push(
    { id: "c1", kind: "horizontal", entityIds: ["l1"] },
    { id: "c2", kind: "horizontal", entityIds: ["l2"] },
    { id: "c3", kind: "equal", entityIds: ["l1", "l2"] },
  );
  doc.dimensions.push(
    { id: "d1", kind: "linear", entityIds: ["l1"], value: 10, driving: true },
    { id: "d2", kind: "linear", entityIds: ["l2"], value: 10, driving: true },
  );
  return doc;
}

describe("trimEntity", () => {
  it("removes constraints and dimensions that referenced the trimmed line", () => {
    const next = trimEntity(twoLineDoc(), "l1");
    expect(next.entities.some((e) => e.id === "l1")).toBe(false);
    expect(next.constraints.map((c) => c.id)).toEqual(["c2"]);
    expect(next.dimensions.map((d) => d.id)).toEqual(["d2"]);
  });

  it("keeps references to geometry that survived", () => {
    const next = trimEntity(twoLineDoc(), "l2");
    expect(next.constraints.map((c) => c.id)).toEqual(["c1"]);
    expect(next.dimensions.map((d) => d.id)).toEqual(["d1"]);
  });

  it("drops a constraint whose point was garbage collected as an orphan", () => {
    const doc = twoLineDoc();
    doc.constraints.push({ id: "c4", kind: "fix", entityIds: [], pointIds: ["pa"] });
    // pa is only used by l1, so trimming l1 collects it.
    const next = trimEntity(doc, "l1");
    expect(next.entities.some((e) => e.id === "pa")).toBe(false);
    expect(next.constraints.some((c) => c.id === "c4")).toBe(false);
  });
});

describe("splitLineAtPoint", () => {
  it("does not leave references pointing at the consumed line", () => {
    const next = splitLineAtPoint(twoLineDoc(), "l1", { x: 5, z: 0 });
    const liveIds = new Set(next.entities.map((e) => e.id));
    for (const constraint of next.constraints) {
      expect(constraint.entityIds.every((id) => liveIds.has(id))).toBe(true);
    }
    for (const dimension of next.dimensions) {
      expect(dimension.entityIds.every((id) => liveIds.has(id))).toBe(true);
    }
    // The untouched line keeps everything that only referenced it.
    expect(next.constraints.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("projectEdgesOntoSketch refresh", () => {
  const edges = () => boxEdgesForProjection("shape-1", { x: 0, y: 0, z: 0 }, { width: 20, height: 20, depth: 20 }, PLANE);

  it("keeps constraints attached to a projected point across a refresh", () => {
    const first = projectEdgesOntoSketch(createEmptySketchDoc(PLANE, "sketch-test"), edges());
    const projectedPoint = first.doc.entities.find((e) => e.kind === "point" && e.projected);
    expect(projectedPoint).toBeDefined();

    first.doc.entities.push({ kind: "point", id: "free", x: 4, z: 4 });
    first.doc.constraints.push({
      id: "c-coincident",
      kind: "coincident",
      entityIds: [],
      pointIds: ["free", projectedPoint!.id],
    });

    const refreshed = updateProjectedGeometry(first.doc, edges());
    expect(refreshed.doc.entities.some((e) => e.id === projectedPoint!.id)).toBe(true);
    expect(refreshed.doc.constraints.map((c) => c.id)).toContain("c-coincident");
  });

  it("reuses ids rather than growing the document on repeated refreshes", () => {
    let result = projectEdgesOntoSketch(createEmptySketchDoc(PLANE, "sketch-test"), edges());
    const firstIds = result.doc.entities.map((e) => e.id).sort();
    for (let i = 0; i < 3; i += 1) {
      result = updateProjectedGeometry(result.doc, edges());
    }
    expect(result.doc.entities.map((e) => e.id).sort()).toEqual(firstIds);
  });

  it("sweeps a constraint whose projected point is gone after the edge shortened", () => {
    const longEdge = [{
      sourceId: "shape-1:edge:0",
      worldPoints: [
        { x: 0, y: 0, z: 0 },
        { x: 5, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
      ],
    }];
    const first = projectEdgesOntoSketch(createEmptySketchDoc(PLANE, "sketch-test"), longEdge);
    const points = first.doc.entities.filter((e) => e.kind === "point");
    expect(points).toHaveLength(3);
    first.doc.constraints.push({
      id: "c-last",
      kind: "fix",
      entityIds: [],
      pointIds: [points[2].id],
    });

    const shortened = updateProjectedGeometry(first.doc, [{
      sourceId: "shape-1:edge:0",
      worldPoints: [{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }],
    }]);
    expect(shortened.doc.entities.filter((e) => e.kind === "point")).toHaveLength(2);
    expect(shortened.doc.constraints.some((c) => c.id === "c-last")).toBe(false);
  });
});
