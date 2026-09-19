import { describe, expect, it } from "vitest";
import { importedShapeFromTriangleSoup, importExtensionSupported } from "@/lib/stlImport";

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
