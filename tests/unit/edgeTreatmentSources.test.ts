import { describe, expect, it } from "vitest";
import { cadModifierPrimitiveForAnalyticBox } from "@/lib/cadBakeMetadata";
import { edgeTreatmentSourceParts } from "@/lib/edgeTreatmentSources";
import type { WorkplaneShape } from "@/types/sketchforge";

function box(partial: Partial<WorkplaneShape> & Pick<WorkplaneShape, "id">): WorkplaneShape {
  return {
    name: partial.id,
    kind: "box",
    color: "#d41721",
    x: 0,
    z: 0,
    elevation: 0,
    size: 20,
    width: 20,
    depth: 10,
    height: 4,
    rotation: 0,
    ...partial,
  };
}

describe("edgeTreatmentSourceParts", () => {
  it("rebuilds a slotted plate from the plate and each slot instead of the display mesh", () => {
    const plate = box({ id: "plate", width: 80, depth: 30, height: 6, size: 80 });
    const slots = [0, 1, 2, 3].map((index) => box({
      id: `slot-${index}`,
      name: `Slot ${index}`,
      hole: true,
      x: -30 + index * 12,
      width: 8,
      depth: 34,
      height: 8,
      size: 34,
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
        baseWidth: 8,
        baseDepth: 34,
        baseHeight: 8,
        triangleCount: 1,
        sourceFormat: "json",
      },
    }));
    const group = box({
      id: "rack",
      kind: "mesh",
      width: 80,
      depth: 34,
      height: 8,
      size: 80,
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
        baseWidth: 80,
        baseDepth: 34,
        baseHeight: 8,
        triangleCount: 1,
        sourceFormat: "json",
      },
      groupedShapes: [plate, ...slots].map((shape) => ({
        ...shape,
        x: shape.x,
        z: shape.z,
      })),
      groupedBaseWidth: 80,
      groupedBaseDepth: 34,
      groupedBaseHeight: 8,
    });

    const parts = edgeTreatmentSourceParts(group);
    expect(parts).toHaveLength(5);
    expect(parts.filter((part) => part.hole)).toHaveLength(4);
    expect(parts.filter((part) => !part.hole)).toHaveLength(1);
    expect(parts.every((part) => cadModifierPrimitiveForAnalyticBox(part)?.kind === "box")).toBe(true);
  });

  it("opens a nested group of slots under the plate", () => {
    const plate = box({ id: "plate", width: 80, depth: 30, height: 6, size: 80 });
    const nested = box({
      id: "slots",
      kind: "mesh",
      hole: true,
      x: 0,
      width: 40,
      depth: 30,
      height: 6,
      size: 40,
      groupedShapes: [
        box({ id: "slot-a", hole: true, x: -8, width: 6, depth: 30, height: 8, size: 30 }),
        box({ id: "slot-b", hole: true, x: 8, width: 6, depth: 30, height: 8, size: 30 }),
      ],
    });
    const group = box({
      id: "rack",
      kind: "mesh",
      width: 80,
      depth: 30,
      height: 6,
      size: 80,
      groupedShapes: [plate, nested],
    });

    const parts = edgeTreatmentSourceParts(group);
    expect(parts).toHaveLength(3);
    expect(parts.filter((part) => part.hole)).toHaveLength(2);
    expect(parts.every((part) => cadModifierPrimitiveForAnalyticBox(part)?.kind === "box")).toBe(true);
  });

  it("keeps a finished fillet mesh instead of rebuilding the old slots", () => {
    const finished = box({
      id: "filleted",
      kind: "mesh",
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 4,
        triangleCount: 1,
        sourceFormat: "json",
      },
      groupedShapes: [box({ id: "plate" })],
      edgeTreatments: [{ kind: "fillet", amount: 0.5, edgeCount: 1 }],
    });
    expect(edgeTreatmentSourceParts(finished, { keepResultMesh: true }).map((part) => part.id)).toEqual(["filleted"]);
  });
});
