import { describe, expect, it } from "vitest";
import { importExtensionSupported } from "@/lib/stlImport";

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
