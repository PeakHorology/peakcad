import { describe, expect, it } from "vitest";
import {
  importedShapeFromStl,
  importedShapeFromTriangleSoup,
  importExtensionSupported,
  stlMillimetersPerFileUnit,
} from "@/lib/stlImport";
import { displayToMillimeters, lengthDisplayUnit, millimetersToDisplay } from "@/lib/measurementUnits";

/** Axis-aligned box as a triangle soup, sized w x h x d about the origin. */
function boxSoup(width: number, height: number, depth: number) {
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const corner = (sx: number, sy: number, sz: number) => [sx * x, sy * y, sz * z];
  const quad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => [
    ...corner(...a), ...corner(...b), ...corner(...c),
    ...corner(...a), ...corner(...c), ...corner(...d),
  ];
  return [
    ...quad([-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]),
    ...quad([-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]),
    ...quad([-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]),
    ...quad([-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]),
  ];
}

describe("importExtensionSupported", () => {
  it("accepts STL, SVG, and 3MF imports", () => {
    expect(importExtensionSupported("part.stl")).toBe(true);
    expect(importExtensionSupported("logo.svg")).toBe(true);
    expect(importExtensionSupported("profile.SVG")).toBe(true);
    expect(importExtensionSupported("print.3mf")).toBe(true);
    expect(importExtensionSupported("PRINT.3MF")).toBe(true);
  });

  it("rejects unsupported dashboard import extensions", () => {
    expect(importExtensionSupported("drawing.png")).toBe(false);
    expect(importExtensionSupported("assembly.step")).toBe(false);
  });
});

describe("importedShapeFromTriangleSoup", () => {
  it("keeps sub-millimetre parts at their true size", () => {
    // A 0.6mm shim used to be declared 1.00mm. Since resizes scale by height/baseHeight,
    // typing 2.00 afterwards produced 1.2mm of real material.
    const shim = importedShapeFromTriangleSoup("shim.stl", boxSoup(12, 0.6, 8), undefined);

    expect(shim.height).toBeCloseTo(0.6, 6);
    expect(shim.importedMesh?.baseHeight).toBeCloseTo(0.6, 6);
  });

  it("declares dimensions that match the imported mesh extent", () => {
    const part = importedShapeFromTriangleSoup("part.stl", boxSoup(30, 12, 18), undefined);

    expect(part.width).toBeCloseTo(part.importedMesh!.baseWidth!, 6);
    expect(part.height).toBeCloseTo(part.importedMesh!.baseHeight!, 6);
    expect(part.depth).toBeCloseTo(part.importedMesh!.baseDepth!, 6);
  });
});

/** ASCII STL text for a triangle soup (normals left zero; the loader keeps them as given). */
function asciiStl(positions: number[]) {
  const lines = ["solid test"];
  for (let i = 0; i < positions.length; i += 9) {
    lines.push("facet normal 0 0 0", "outer loop");
    for (let v = 0; v < 9; v += 3) {
      lines.push(`vertex ${positions[i + v]} ${positions[i + v + 1]} ${positions[i + v + 2]}`);
    }
    lines.push("endloop", "endfacet");
  }
  lines.push("endsolid test");
  return new TextEncoder().encode(lines.join("\n")).buffer as ArrayBuffer;
}

describe("STL workplane units", () => {
  const METRIC_MM = { units: "Metric (Default)", scale: "1:1 (millimeters)" };
  const METRIC_CM = { units: "Metric (Default)", scale: "1:10 (centimeters)" };
  const METRIC_M = { units: "Metric (Default)", scale: "1:1000 (meters)" };
  const INCHES = { units: "Imperial", scale: "1:1 (inches)" };
  const FEET = { units: "Imperial", scale: "1:1 (feet)" };
  const STUDS = { units: "Bricks", scale: "1:1 (studs)" };

  const displayed = (part: { width: number; height: number; depth: number }, unit: typeof INCHES) => ({
    width: millimetersToDisplay(part.width, unit),
    height: millimetersToDisplay(part.height, unit),
    depth: millimetersToDisplay(part.depth, unit),
  });

  it.each([
    ["mm", METRIC_MM],
    ["cm", METRIC_CM],
    ["m", METRIC_M],
    ["in", INCHES],
    ["ft", FEET],
    ["stud", STUDS],
  ])("shows a 10 x 4 x 6 STL as 10 x 4 x 6 %s on that workplane", (label, unit) => {
    const part = importedShapeFromStl("part.stl", asciiStl(boxSoup(10, 4, 6)), "keep-orientation", unit);
    const shown = displayed(part, unit);

    expect(lengthDisplayUnit(unit).label).toBe(label);
    expect(shown.width).toBeCloseTo(10, 4);
    expect(shown.height).toBeCloseTo(4, 4);
    expect(shown.depth).toBeCloseTo(6, 4);
  });

  it("stores an imported STL in the same unit as a native box of the same displayed size", () => {
    const part = importedShapeFromStl("part.stl", asciiStl(boxSoup(10, 4, 6)), "keep-orientation", INCHES);

    expect(part.width).toBeCloseTo(displayToMillimeters(10, INCHES), 4);
    expect(part.height).toBeCloseTo(displayToMillimeters(4, INCHES), 4);
    expect(part.depth).toBeCloseTo(displayToMillimeters(6, INCHES), 4);
  });

  it("maps one STL unit to one workplane unit in millimetres", () => {
    expect(stlMillimetersPerFileUnit()).toBe(1);
    expect(stlMillimetersPerFileUnit(METRIC_MM)).toBe(1);
    expect(stlMillimetersPerFileUnit(METRIC_CM)).toBe(10);
    expect(stlMillimetersPerFileUnit(METRIC_M)).toBe(1000);
    expect(stlMillimetersPerFileUnit(INCHES)).toBe(25.4);
    expect(stlMillimetersPerFileUnit(FEET)).toBe(304.8);
    expect(stlMillimetersPerFileUnit(STUDS)).toBe(8);
  });

  it("keeps a millimetre workplane import at 1:1", () => {
    const buffer = asciiStl(boxSoup(30, 12, 18));
    const part = importedShapeFromStl("part.stl", buffer, "keep-orientation", METRIC_MM);
    const unspecified = importedShapeFromStl("part.stl", buffer, "keep-orientation");

    expect(part.width).toBeCloseTo(30, 4);
    expect(part.height).toBeCloseTo(12, 4);
    expect(part.depth).toBeCloseTo(18, 4);
    expect(unspecified.height).toBeCloseTo(part.height, 6);
  });

  it("shows a 1 x 2 x 3 STL as 1 x 2 x 3 in on an inch workplane and seats it on the floor", () => {
    const part = importedShapeFromStl("part.stl", asciiStl(boxSoup(1, 2, 3)), "keep-orientation", INCHES);
    const ys = part.importedMesh!.positions.filter((_, index) => index % 3 === 1);
    const shown = displayed(part, INCHES);

    expect(shown.width).toBeCloseTo(1, 4);
    expect(shown.height).toBeCloseTo(2, 4);
    expect(shown.depth).toBeCloseTo(3, 4);
    expect(millimetersToDisplay(Math.max(...ys), INCHES)).toBeCloseTo(2, 4);

    expect(part.width).toBeCloseTo(25.4, 4);
    expect(part.height).toBeCloseTo(50.8, 4);
    expect(part.depth).toBeCloseTo(76.2, 4);
    expect(part.importedMesh!.baseHeight).toBeCloseTo(50.8, 4);
    expect(Math.min(...ys)).toBeCloseTo(0, 4);
    expect(Math.max(...ys)).toBeCloseTo(50.8, 4);
  });

  it("shows a laid-flat STL in centimetres on a centimetre workplane", () => {
    const part = importedShapeFromStl("part.stl", asciiStl(boxSoup(4, 1, 2)), "lay-flat", METRIC_CM);
    const shown = displayed(part, METRIC_CM);
    const dims = [shown.width, shown.height, shown.depth].sort((a, b) => a - b);

    expect(dims[0]).toBeCloseTo(1, 4);
    expect(dims[1]).toBeCloseTo(2, 4);
    expect(dims[2]).toBeCloseTo(4, 4);
    const ys = part.importedMesh!.positions.filter((_, index) => index % 3 === 1);
    expect(Math.min(...ys)).toBeCloseTo(0, 4);
  });
});
