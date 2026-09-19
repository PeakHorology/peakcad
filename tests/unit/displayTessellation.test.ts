import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_QUALITY,
  modifierQualityForDisplay,
  resolveHollowCylinderSegments,
  resolveShapeSides,
  resolveShapeSteps,
  setActiveDisplayQuality,
} from "@/lib/displayTessellation";

describe("display tessellation", () => {
  it("defaults to smooth display quality", () => {
    expect(DEFAULT_DISPLAY_QUALITY).toBe("smooth");
    expect(modifierQualityForDisplay("smooth")).toBe("ultra");
    expect(modifierQualityForDisplay("standard")).toBe("fine");
    expect(modifierQualityForDisplay("draft")).toBe("draft");
  });

  it("upgrades legacy cylinder/sphere tessellation with display quality", () => {
    setActiveDisplayQuality("smooth");
    expect(resolveShapeSides("cylinder", 96, "smooth")).toBe(192);
    expect(resolveShapeSteps("sphere", 24, "smooth")).toBe(64);
    expect(resolveHollowCylinderSegments("smooth")).toBe(256);

    setActiveDisplayQuality("draft");
    expect(resolveShapeSides("cylinder", 96, "draft")).toBe(64);
    expect(resolveShapeSteps("sphere", 24, "draft")).toBe(16);
  });

  it("keeps custom low facet counts for intentional polygons", () => {
    expect(resolveShapeSides("cylinder", 12, "smooth")).toBe(12);
    expect(resolveShapeSides("polygon", 6, "smooth")).toBe(6);
  });

  it("keeps deliberate facet counts that collide with another kind's default", () => {
    // 144 and 256 are defaults for other kinds, never for a cylinder.
    expect(resolveShapeSides("cylinder", 144, "smooth")).toBe(144);
    expect(resolveShapeSides("cylinder", 256, "smooth")).toBe(256);
    // 20, 32, 40 and 56 belong to halfSphere, not to a sphere.
    for (const steps of [20, 32, 40, 56]) {
      expect(resolveShapeSteps("sphere", steps, "smooth")).toBe(steps);
    }
    // A box set to 20 must not be pulled down to the smooth default of 16.
    expect(resolveShapeSteps("box", 20, "smooth")).toBe(20);
  });

  it("still follows quality for values a lower quality assigned automatically", () => {
    // A draft round roof stores 48; raising quality must upgrade it.
    expect(resolveShapeSides("roundRoof", 48, "smooth")).toBe(128);
    // Same for a draft box (6) and a standard box (12).
    expect(resolveShapeSteps("box", 6, "smooth")).toBe(16);
    expect(resolveShapeSteps("box", 12, "smooth")).toBe(16);
  });
});
