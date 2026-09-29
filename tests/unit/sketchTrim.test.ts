import { describe, expect, it } from "vitest";
import { trimClickedSpan } from "@/lib/sketch/editOps";
import { createEmptySketchDoc } from "@/lib/sketch";
import { defaultSketchPlane } from "@/lib/sketchPlane";
import type { SketchDoc } from "@/lib/sketch";

function linesCross(): SketchDoc {
  const doc = createEmptySketchDoc(defaultSketchPlane(), "trim");
  doc.entities = [
    { kind: "point", id: "a", x: 0, z: 0 },
    { kind: "point", id: "b", x: 40, z: 0 },
    { kind: "point", id: "c", x: 20, z: -20 },
    { kind: "point", id: "d", x: 20, z: 20 },
    { kind: "line", id: "horiz", startId: "a", endId: "b" },
    { kind: "line", id: "vert", startId: "c", endId: "d" },
  ];
  return doc;
}

function lineOf(doc: SketchDoc, id: string) {
  const line = doc.entities.find((entity) => entity.id === id && entity.kind === "line");
  if (!line || line.kind !== "line") return null;
  const start = doc.entities.find((entity) => entity.id === line.startId && entity.kind === "point");
  const end = doc.entities.find((entity) => entity.id === line.endId && entity.kind === "point");
  if (!start || start.kind !== "point" || !end || end.kind !== "point") return null;
  return { start, end };
}

describe("trimClickedSpan", () => {
  it("removes only the clicked side of a line, up to the intersection", () => {
    const next = trimClickedSpan(linesCross(), "horiz", { x: 10, z: 0 });
    expect(next.entities.some((entity) => entity.id === "horiz")).toBe(false);
    expect(next.entities.some((entity) => entity.id === "vert")).toBe(true);
    const kept = next.entities.filter((entity) => entity.kind === "line" && entity.id !== "vert");
    expect(kept).toHaveLength(1);
    const piece = lineOf(next, kept[0].id);
    expect(piece).not.toBeNull();
    const xs = [piece!.start.x, piece!.end.x].sort((left, right) => left - right);
    expect(xs[0]).toBeCloseTo(20);
    expect(xs[1]).toBeCloseTo(40);
    expect(next.entities.some((entity) => entity.id === "a")).toBe(false);
  });

  it("deletes a line that does not meet anything", () => {
    const doc = createEmptySketchDoc(defaultSketchPlane(), "trim-lone");
    doc.entities = [
      { kind: "point", id: "a", x: 0, z: 0 },
      { kind: "point", id: "b", x: 10, z: 0 },
      { kind: "line", id: "lone", startId: "a", endId: "b" },
    ];
    const next = trimClickedSpan(doc, "lone", { x: 5, z: 0 });
    expect(next.entities.some((entity) => entity.kind === "line")).toBe(false);
  });

  it("opens a circle into the arc that was not clicked", () => {
    const doc = createEmptySketchDoc(defaultSketchPlane(), "trim-circle");
    doc.entities = [
      { kind: "point", id: "c", x: 0, z: 0 },
      { kind: "point", id: "l0", x: -20, z: 0 },
      { kind: "point", id: "l1", x: 20, z: 0 },
      { kind: "circle", id: "circ", centerId: "c", radius: 10 },
      { kind: "line", id: "axis", startId: "l0", endId: "l1" },
    ];
    const next = trimClickedSpan(doc, "circ-s4", { x: 0, z: -10 });
    expect(next.entities.some((entity) => entity.kind === "circle")).toBe(false);
    const arc = next.entities.find((entity) => entity.kind === "arc");
    expect(arc && arc.kind === "arc").toBeTruthy();
    if (!arc || arc.kind !== "arc") return;
    const start = next.entities.find((entity) => entity.id === arc.startId && entity.kind === "point");
    const end = next.entities.find((entity) => entity.id === arc.endId && entity.kind === "point");
    expect(start && start.kind === "point" && end && end.kind === "point").toBeTruthy();
    if (!start || start.kind !== "point" || !end || end.kind !== "point") return;
    // The click was the top of the circle (negative z). The surviving arc stays on the other side.
    expect(start.z + end.z).toBeGreaterThan(0);
  });
});
