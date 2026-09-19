import { describe, expect, it } from "vitest";
import {
  patternFeatureLabel,
  rebuildLinearPatternFeature,
  replacePatternFeature,
  tagLinearPatternInstances,
} from "@/lib/patternFeature";
import { linearPatternInstances } from "@/lib/linearPattern";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(partial: Partial<WorkplaneShape> & Pick<WorkplaneShape, "id" | "x" | "z">): WorkplaneShape {
  return {
    name: "Box",
    kind: "box",
    color: "#fff",
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...partial,
  };
}

describe("pattern features", () => {
  it("tags the source and copies so count edits can rebuild", () => {
    const source = box({ id: "src", x: 0, z: 0 });
    const params = { countX: 3, countZ: 1, countY: 1, spacingX: 12, spacingZ: 8, spacingY: 12 };
    const tagged = tagLinearPatternInstances(linearPatternInstances([source], params, params), source, params, "feat-1");
    expect(tagged).toHaveLength(3);
    expect(tagged[0].patternFeature).toMatchObject({ role: "source", sourceId: "src", kind: "linear" });
    expect(tagged[1].patternFeature).toMatchObject({ role: "instance", sourceId: "src" });
    expect(patternFeatureLabel(tagged[0].patternFeature!)).toBe("Linear pattern ×3");
  });

  it("rebuilds copies when spacing changes and drops extras when count shrinks", () => {
    const source = box({ id: "src", x: 0, z: 0 });
    const first = rebuildLinearPatternFeature(
      source,
      { countX: 3, countZ: 1, countY: 1, spacingX: 12, spacingZ: 8, spacingY: 12 },
      "feat-1",
    );
    const next = rebuildLinearPatternFeature(
      { ...first[0], x: 5 },
      { countX: 2, countZ: 1, countY: 1, spacingX: 20, spacingZ: 8, spacingY: 12 },
      "feat-1",
    );
    const scene = replacePatternFeature(
      [box({ id: "other", x: -40, z: 0 }), ...first],
      next,
      "feat-1",
    );
    expect(scene.map((shape) => shape.id)).toEqual([
      "other",
      "src",
      next[1].id,
    ]);
    expect(next[1].x).toBe(25);
  });
});
