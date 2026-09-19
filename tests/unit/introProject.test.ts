import { describe, expect, it } from "vitest";
import { createIntroShapes, INTRO_PROJECT_NAME } from "@/lib/introProject";
import { inferCsgOp } from "@/lib/csgTree";

describe("intro project", () => {
  it("builds a grouped box with a through hole", () => {
    const shapes = createIntroShapes();
    expect(shapes).toHaveLength(1);
    const group = shapes[0];
    expect(group?.name).toBe(INTRO_PROJECT_NAME);
    expect(inferCsgOp(group!)).toBe("subtract");
    expect(group?.csg?.dirty).toBe(true);
    expect(group?.groupedShapes?.map((child) => child.kind)).toEqual(["box", "cylinder"]);
    expect(group?.groupedShapes?.[0]?.hole).toBeFalsy();
    expect(group?.groupedShapes?.[1]?.hole).toBe(true);
    expect((group?.groupedShapes?.[1]?.height ?? 0) > (group?.groupedShapes?.[0]?.height ?? 0)).toBe(true);
  });
});
