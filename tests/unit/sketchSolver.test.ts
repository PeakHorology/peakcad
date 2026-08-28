import { describe, expect, it } from "vitest";
import { addConstraints, createEmptySketchDoc, solveSketchDoc } from "../../apps/web/src/lib/sketch";
import { defaultSketchPlane } from "../../apps/web/src/lib/sketchPlane";

function docWithLineAndCircle() {
  const doc = createEmptySketchDoc(defaultSketchPlane());
  doc.entities = [
    { kind: "point", id: "p0", x: 0, z: 0 },
    { kind: "point", id: "p1", x: 20, z: 0 },
    { kind: "point", id: "c0", x: 10, z: 8 },
    { kind: "line", id: "l0", startId: "p0", endId: "p1" },
    { kind: "circle", id: "circ0", centerId: "c0", radius: 5 },
  ];
  return doc;
}

describe("sketch solver", () => {
  it("solves line–circle tangent so center distance ≈ radius", () => {
    const base = docWithLineAndCircle();
    const withConstraint = addConstraints(base, [{ kind: "tangent", entityIds: ["l0", "circ0"] }]);
    const solved = solveSketchDoc(withConstraint, 80);
    const center = solved.doc.entities.find((e) => e.id === "c0" && e.kind === "point");
    const lineA = solved.doc.entities.find((e) => e.id === "p0" && e.kind === "point");
    const lineB = solved.doc.entities.find((e) => e.id === "p1" && e.kind === "point");
    const circle = solved.doc.entities.find((e) => e.id === "circ0" && e.kind === "circle");
    expect(center && lineA && lineB && circle && circle.kind === "circle").toBeTruthy();
    if (!center || center.kind !== "point" || !lineA || lineA.kind !== "point" || !lineB || lineB.kind !== "point" || !circle || circle.kind !== "circle") {
      return;
    }
    const dx = lineB.x - lineA.x;
    const dz = lineB.z - lineA.z;
    const len = Math.hypot(dx, dz) || 1;
    const dist = Math.abs(((center.x - lineA.x) * (-dz) + (center.z - lineA.z) * dx) / len);
    expect(Math.abs(dist - circle.radius)).toBeLessThan(0.15);
  });

  it("solves point symmetry across a vertical axis", () => {
    const doc = createEmptySketchDoc(defaultSketchPlane());
    doc.entities = [
      { kind: "point", id: "axisA", x: 0, z: -10 },
      { kind: "point", id: "axisB", x: 0, z: 10 },
      { kind: "point", id: "left", x: -8, z: 3 },
      { kind: "point", id: "right", x: 2, z: 3 },
      { kind: "line", id: "axis", startId: "axisA", endId: "axisB" },
    ];
    const withConstraint = addConstraints(doc, [{
      kind: "symmetry",
      entityIds: ["left", "right", "axis"],
      pointIds: ["left", "right"],
    }]);
    const solved = solveSketchDoc(withConstraint, 80);
    const left = solved.doc.entities.find((e) => e.id === "left" && e.kind === "point");
    const right = solved.doc.entities.find((e) => e.id === "right" && e.kind === "point");
    expect(left && right && left.kind === "point" && right.kind === "point").toBeTruthy();
    if (!left || left.kind !== "point" || !right || right.kind !== "point") return;
    expect(Math.abs(left.x + right.x)).toBeLessThan(0.2);
    expect(Math.abs(left.z - right.z)).toBeLessThan(0.2);
  });
});
