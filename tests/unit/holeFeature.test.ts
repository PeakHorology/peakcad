import { describe, expect, it } from "vitest";
import { isConstructionShape } from "@/lib/holeFeature";

describe("isConstructionShape", () => {
  it("is true only when construction is set", () => {
    expect(isConstructionShape({ construction: true })).toBe(true);
    expect(isConstructionShape({ construction: false })).toBe(false);
    expect(isConstructionShape({})).toBe(false);
    expect(isConstructionShape(null)).toBe(false);
  });
});
