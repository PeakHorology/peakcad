import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { read3mfUnitScale } from "@/lib/threeMfImport";

function packageWithUnit(unit?: string) {
  const unitAttr = unit === undefined ? "" : ` unit="${unit}"`;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model${unitAttr} xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" type="model"><mesh><vertices /><triangles /></mesh></object></resources>
  <build><item objectid="1" /></build>
</model>
`;
  const zip = zipSync({ "3D/3dmodel.model": strToU8(model) }, { level: 6 });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

describe("read3mfUnitScale", () => {
  it("converts each unit the 3MF core spec allows", () => {
    expect(read3mfUnitScale(packageWithUnit("millimeter"))).toBe(1);
    expect(read3mfUnitScale(packageWithUnit("inch"))).toBeCloseTo(25.4, 10);
    expect(read3mfUnitScale(packageWithUnit("foot"))).toBeCloseTo(304.8, 10);
    expect(read3mfUnitScale(packageWithUnit("meter"))).toBe(1000);
    expect(read3mfUnitScale(packageWithUnit("centimeter"))).toBe(10);
    expect(read3mfUnitScale(packageWithUnit("micron"))).toBeCloseTo(0.001, 10);
  });

  it("is case insensitive", () => {
    expect(read3mfUnitScale(packageWithUnit("Inch"))).toBeCloseTo(25.4, 10);
  });

  it("falls back to millimetres when the unit is absent or unrecognised", () => {
    expect(read3mfUnitScale(packageWithUnit())).toBe(1);
    expect(read3mfUnitScale(packageWithUnit("furlong"))).toBe(1);
  });

  it("falls back to millimetres for a package it cannot read", () => {
    expect(read3mfUnitScale(new Uint8Array([1, 2, 3, 4]).buffer)).toBe(1);
  });
});
