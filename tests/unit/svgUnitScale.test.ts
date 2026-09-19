import { describe, expect, it } from "vitest";
import { svgUserUnitToMm } from "@/lib/svgImport";

/** Minimal stand-in for the root <svg> element's attribute lookup. */
function svgRoot(attributes: Record<string, string>): Element {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
  } as unknown as Element;
}

describe("svgUserUnitToMm", () => {
  it("scales an Illustrator-style file saved in millimetres", () => {
    // 100mm across a 283.46-unit (96dpi px) viewBox. Treating user units as millimetres imported
    // this 2.83x oversized.
    const scale = svgUserUnitToMm(svgRoot({
      width: "100mm",
      height: "50mm",
      viewBox: "0 0 283.46 141.73",
    }));
    expect(283.46 * scale).toBeCloseTo(100, 4);
  });

  it("returns 1 when the viewBox already matches the declared millimetres", () => {
    const scale = svgUserUnitToMm(svgRoot({
      width: "100mm",
      height: "50mm",
      viewBox: "0 0 100 50",
    }));
    expect(scale).toBeCloseTo(1, 9);
  });

  it("handles inches, centimetres and points", () => {
    expect(svgUserUnitToMm(svgRoot({ width: "2in", viewBox: "0 0 200 100" })) * 200).toBeCloseTo(50.8, 6);
    expect(svgUserUnitToMm(svgRoot({ width: "5cm", viewBox: "0 0 100 50" })) * 100).toBeCloseTo(50, 6);
    expect(svgUserUnitToMm(svgRoot({ width: "72pt", viewBox: "0 0 100 50" })) * 100).toBeCloseTo(25.4, 6);
  });

  it("falls back to the height when the width carries no physical unit", () => {
    const scale = svgUserUnitToMm(svgRoot({ width: "100%", height: "20mm", viewBox: "0 0 400 200" }));
    expect(200 * scale).toBeCloseTo(20, 6);
  });

  it("leaves px and unitless documents at 1 unit per millimetre", () => {
    // Changing these would shrink files that currently import at the intended size.
    expect(svgUserUnitToMm(svgRoot({ width: "283.46", height: "141.73", viewBox: "0 0 283.46 141.73" }))).toBe(1);
    expect(svgUserUnitToMm(svgRoot({ width: "800px", height: "600px", viewBox: "0 0 800 600" }))).toBe(1);
  });

  it("leaves a document with no viewBox alone", () => {
    expect(svgUserUnitToMm(svgRoot({ width: "100mm", height: "50mm" }))).toBe(1);
  });

  it("ignores a malformed or degenerate viewBox", () => {
    expect(svgUserUnitToMm(svgRoot({ width: "100mm", viewBox: "0 0 abc 50" }))).toBe(1);
    expect(svgUserUnitToMm(svgRoot({ width: "100mm", viewBox: "0 0 0 0" }))).toBe(1);
    expect(svgUserUnitToMm(svgRoot({ width: "0mm", viewBox: "0 0 100 50" }))).toBe(1);
    expect(svgUserUnitToMm(svgRoot({ width: "-100mm", viewBox: "0 0 100 50" }))).toBe(1);
  });

  it("ignores an unknown unit rather than guessing", () => {
    expect(svgUserUnitToMm(svgRoot({ width: "10furlongs", viewBox: "0 0 100 50" }))).toBe(1);
  });

  it("accepts comma-separated viewBox values", () => {
    const scale = svgUserUnitToMm(svgRoot({ width: "50mm", viewBox: "0,0,100,50" }));
    expect(100 * scale).toBeCloseTo(50, 6);
  });
});
