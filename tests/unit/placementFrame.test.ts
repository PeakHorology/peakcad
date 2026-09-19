import { describe, expect, it } from "vitest";
import { dropPatchOntoFrame } from "@/lib/placementFrame";

describe("dropPatchOntoFrame", () => {
  it("drops a shape so its mesh bottom sits on Y=0", () => {
    const patch = dropPatchOntoFrame(
      { x: 4, z: -2, elevation: 20 },
      { minX: 0, maxX: 8, minY: 20, maxY: 30, minZ: -6, maxZ: 2 },
    );
    expect(patch).toEqual({ elevation: 0 });
  });
});
