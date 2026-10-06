import { describe, expect, it } from "vitest";
import { restoreGroupedChildren } from "@/lib/editorBoolean";
import { bakedEdgeTreatmentPreview } from "@/lib/editorEdgeTreatments";
import type { WorkplaneShape } from "@/types/sketchforge";

function shape(partial: Partial<WorkplaneShape> & Pick<WorkplaneShape, "id">): WorkplaneShape {
  return {
    name: partial.id,
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    elevation: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
    ...partial,
  };
}

describe("restoreGroupedChildren", () => {
  it("keeps a turned group openable and carries the angle onto the children", () => {
    const group = shape({
      id: "group",
      kind: "mesh",
      x: 0,
      z: 0,
      width: 20,
      depth: 10,
      height: 10,
      size: 20,
      rotation: 90,
      groupedBaseWidth: 20,
      groupedBaseDepth: 10,
      groupedBaseHeight: 10,
      groupedShapes: [
        shape({ id: "child", x: 5, z: 0, width: 10, depth: 10, height: 10, size: 10 }),
      ],
    });

    const [child] = restoreGroupedChildren(group, { preserveIds: true });
    expect(child.id).toBe("child");
    expect(child.x).toBeCloseTo(0, 3);
    expect(child.z).toBeCloseTo(-5, 3);
    expect(child.elevation).toBeCloseTo(0, 3);
    expect(child.width).toBeCloseTo(10, 3);
    expect(child.rotation).toBeCloseTo(90, 3);
  });

  it("keeps a filleted group ungroupable in the same place", () => {
    const group = shape({
      id: "group",
      x: 10,
      z: 4,
      width: 20,
      depth: 10,
      height: 10,
      size: 20,
      rotation: 90,
      groupedBaseWidth: 20,
      groupedBaseDepth: 10,
      groupedBaseHeight: 10,
      groupedShapes: [
        shape({ id: "child", x: 5, z: 0, width: 10, depth: 10, height: 10, size: 10 }),
      ],
    });
    const filleted = shape({
      id: "group",
      kind: "mesh",
      x: 12,
      z: 3,
      elevation: 1,
      width: 20,
      depth: 10,
      height: 10,
      size: 20,
      rotation: 0,
      importedMesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangleCount: 1, baseWidth: 20, baseDepth: 10, baseHeight: 10 },
    });

    const kept = bakedEdgeTreatmentPreview(filleted, group);
    expect(kept.groupedShapes?.map((child) => child.id)).toEqual(["child"]);
    const [before] = restoreGroupedChildren(group, { preserveIds: true });
    const [after] = restoreGroupedChildren(kept, { preserveIds: true });
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.z).toBeCloseTo(before.z, 3);
    expect(after.elevation).toBeCloseTo(before.elevation, 3);
    expect(after.rotation).toBeCloseTo(before.rotation, 3);
    expect(after.width).toBeCloseTo(before.width, 3);
  });
});
