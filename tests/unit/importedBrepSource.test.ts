import { describe, expect, it } from "vitest";
import type { WorkplaneShape } from "@/types/sketchforge";
import {
  bakeImportedBrepStepsForSave,
  importedBrepStepsAwaitingSave,
  importedMeshHasExactSource,
  registerPendingImportedBrep,
} from "@/lib/importedBrepSource";

function stepShape(name: string, offset: number): WorkplaneShape {
  const positions = [0, 0, 0, 1 + offset, 0, 0, 0, 1 + offset, 0, 0, 0, 1 + offset];
  return {
    id: name,
    name,
    kind: "mesh",
    color: "#0098c7",
    x: 0,
    z: 0,
    size: 1,
    width: 1,
    depth: 1,
    height: 1,
    rotation: 0,
    importedMesh: {
      positions,
      indices: [0, 1, 2, 0, 2, 3],
      baseWidth: 1,
      baseDepth: 1,
      baseHeight: 1,
      triangleCount: 2,
      sourceFormat: "step",
    },
  };
}

describe("bakeImportedBrepStepsForSave", () => {
  it("bakes every pending body, keeps going past a failure, and attaches the text", async () => {
    const good = stepShape("Good", 0.25);
    const bad = stepShape("Bad", 0.5);
    registerPendingImportedBrep(good.importedMesh!, async () => "ISO-10303-21; good");
    registerPendingImportedBrep(bad.importedMesh!, async () => {
      throw new Error("kernel refused");
    });
    const grouped: WorkplaneShape = { ...stepShape("Group", 2), importedMesh: undefined, groupedShapes: [good] };
    const duplicate = { ...good, id: "Good copy" };

    expect(importedBrepStepsAwaitingSave([grouped, bad, duplicate]).map((entry) => entry.name)).toEqual(["Good", "Bad"]);

    const progress: Array<[number, number]> = [];
    const result = await bakeImportedBrepStepsForSave([grouped, bad, duplicate], (done, total) => {
      progress.push([done, total]);
    });

    expect(result.baked).toBe(1);
    expect(result.failedNames).toEqual(["Bad"]);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(result.shapes[0].groupedShapes?.[0].importedMesh?.brepStep).toBe("ISO-10303-21; good");
    expect(result.shapes[2].importedMesh?.brepStep).toBe("ISO-10303-21; good");
    expect(result.shapes[1].importedMesh?.brepStep).toBeUndefined();
    // The failed body falls back to faceted and is no longer counted as awaiting a save.
    expect(importedMeshHasExactSource(bad.importedMesh)).toBe(false);
    expect(importedBrepStepsAwaitingSave(result.shapes)).toEqual([]);
  });

  it("reports nothing to bake for meshes that already carry STEP text or were never registered", async () => {
    const stored = stepShape("Stored", 3);
    stored.importedMesh = { ...stored.importedMesh!, brepStep: "ISO-10303-21; stored" };
    const reloaded = stepShape("Reloaded", 4);
    expect(importedBrepStepsAwaitingSave([stored, reloaded])).toEqual([]);
    const result = await bakeImportedBrepStepsForSave([stored, reloaded]);
    expect(result.baked).toBe(0);
    expect(result.failedNames).toEqual([]);
  });
});
