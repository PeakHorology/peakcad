import { describe, expect, it } from "vitest";
import {
  cleanupBooleanPositions,
  csgTreeContainsId,
  faceHoleCutDepthMm,
  findCsgBodyOwningLeaf,
  findShapeInTree,
  inferCsgOp,
  migrateShapeCsg,
  planarizeThinSolidPositions,
  reorderCsgChild,
  replaceLeafInCsgTree,
  setCsgChildSuppressed,
  shouldExpandGroupForBoolean,
  withCsgMeta,
} from "../../apps/web/src/lib/csgTree";
import type { WorkplaneShape } from "../../apps/web/src/types/sketchforge";

function boxChild(id: string, hole = false): WorkplaneShape {
  return {
    id,
    name: hole ? "Hole" : "Box",
    kind: "box",
    color: "#d41721",
    hole,
    x: 0,
    z: 0,
    size: 10,
    width: 10,
    depth: 10,
    height: 10,
    rotation: 0,
  };
}

describe("csgTree", () => {
  it("infers subtract when a group has solid + hole children", () => {
    const group = {
      ...boxChild("group"),
      kind: "mesh" as const,
      groupedShapes: [boxChild("a"), boxChild("b", true)],
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 10,
        triangleCount: 1,
        sourceFormat: "json" as const,
      },
    };
    expect(inferCsgOp(group)).toBe("subtract");
    expect(migrateShapeCsg(group).csg?.op).toBe("subtract");
  });

  it("infers union for baked solid-only groups", () => {
    const group = {
      ...boxChild("group"),
      kind: "mesh" as const,
      groupedShapes: [boxChild("a"), boxChild("b")],
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 10,
        triangleCount: 1,
        sourceFormat: "json" as const,
      },
    };
    expect(inferCsgOp(group)).toBe("union");
  });

  it("attaches csg metadata via withCsgMeta", () => {
    const next = withCsgMeta(boxChild("g"), "union", 3);
    expect(next.csg).toEqual({ op: "union", version: 3, dirty: undefined });
  });

  it("cleanupBooleanPositions drops degenerate triangles", () => {
    // One real triangle + one zero-area triangle (duplicate verts).
    const positions = [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      2, 2, 2, 2, 2, 2, 2, 2, 2,
    ];
    const cleaned = cleanupBooleanPositions(positions);
    expect(cleaned.length).toBe(9);
  });

  it("keeps a shallow feature on a thin subtract result", () => {
    // A 4mm plate whose top carries a 0.02mm-deep engraving floor at y=3.98. The planarize
    // band is 0.03mm, so running it here snapped the floor up to 4.0 and erased the feature.
    // No stagger is ever applied to a subtract, so the cleanup must leave this alone.
    const positions = [
      0, 0, 0, 10, 0, 0, 0, 4.0, 0,
      0, 0, 5, 10, 0, 5, 0, 3.98, 5,
    ];
    const cleaned = cleanupBooleanPositions(positions);
    expect(cleaned).toHaveLength(18);
    const tops = [cleaned[7], cleaned[16]].sort((a, b) => a - b);
    expect(tops[0]).toBeCloseTo(3.98, 5);
    expect(tops[1]).toBeCloseTo(4.0, 5);
  });

  it("still erases the stagger scar when the union actually staggered", () => {
    const positions = [
      0, 0, 0, 10, 0, 0, 0, 1.0, 0,
      0, 0, 5, 10, 0, 5, 0, 1.01, 5,
    ];
    const cleaned = cleanupBooleanPositions(positions, undefined, { staggeredUnion: true });
    expect(cleaned[7]).toBeCloseTo(1.0, 5);
    expect(cleaned[16]).toBeCloseTo(1.0, 5);
  });

  it("planarizeThinSolidPositions collapses elevation-stagger ridges on thin plates", () => {
    // Bottom at 0, mixed tops at 1.00 and 1.01 (union stagger scar).
    const positions = [
      0, 0, 0, 1, 0, 0, 0, 1.00, 0,
      0, 0, 0, 1, 0, 0, 0, 1.01, 0,
    ];
    const flat = planarizeThinSolidPositions(positions);
    expect(flat[7]).toBeCloseTo(1.0, 5);
    expect(flat[16]).toBeCloseTo(1.0, 5);
  });

  it("finds and replaces leaves under a CSG body without discarding siblings", () => {
    const body = withCsgMeta({
      ...boxChild("body"),
      kind: "mesh" as const,
      groupedShapes: [boxChild("solid"), boxChild("hole", true)],
    }, "subtract");
    expect(csgTreeContainsId(body, "hole")).toBe(true);
    expect(findCsgBodyOwningLeaf([body], "hole")?.id).toBe("body");
    expect(findShapeInTree([body], "hole")?.id).toBe("hole");
    const nextHole = { ...boxChild("hole", true), width: 6, depth: 6, size: 6 };
    const replaced = replaceLeafInCsgTree(body, "hole", nextHole);
    expect(replaced.csg?.dirty).toBe(true);
    expect(replaced.groupedShapes?.[0].id).toBe("solid");
    expect(replaced.groupedShapes?.[1].width).toBe(6);

    // A metadata-only swap (attaching a bake) must not claim the body needs a rebuild: dirty makes
    // the export badge read "pending", so recording the exact solid would downgrade the body.
    const annotated = replaceLeafInCsgTree(
      body,
      "hole",
      { ...boxChild("hole", true), importedMesh: { positions: [], triangleCount: 0, brepStep: "ISO-10303-21;" } },
      { markDirty: false },
    );
    expect(annotated.csg?.dirty).toBeFalsy();
    expect(annotated.csg?.version).toBe(body.csg?.version);
    expect(annotated.groupedShapes?.[1].importedMesh?.brepStep).toBe("ISO-10303-21;");
  });

  it("scales face-hole cut depth with overshoot on the cut axis only", () => {
    expect(faceHoleCutDepthMm(10)).toBeGreaterThan(10);
    expect(faceHoleCutDepthMm(10)).toBeLessThan(12);
  });

  it("reorders and suppresses CSG children while bumping dirty version", () => {
    const body = withCsgMeta({
      ...boxChild("body"),
      kind: "mesh" as const,
      groupedShapes: [boxChild("a"), boxChild("b"), boxChild("c", true)],
    }, "subtract");
    const reordered = reorderCsgChild(body, "c", "up");
    expect(reordered.groupedShapes?.map((child) => child.id)).toEqual(["a", "c", "b"]);
    // Listing order cannot change what a node evaluates to, so it must not force a rebuild.
    expect(reordered.csg?.dirty).toBeFalsy();
    expect(reordered.csg?.version).toBe(body.csg?.version);
    const suppressed = setCsgChildSuppressed(body, "c", true);
    expect(suppressed.groupedShapes?.[2].suppressed).toBe(true);
    expect(suppressed.csg?.dirty).toBe(true);
  });

  it("keeps a baked solid+hole group sealed so a later Group cannot reapply the hole", () => {
    const bakedSubtract: WorkplaneShape = {
      ...boxChild("cut-body"),
      kind: "mesh",
      groupedShapes: [boxChild("solid"), boxChild("hole", true)],
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 10,
        triangleCount: 1,
        sourceFormat: "json",
      },
      csg: { op: "subtract", version: 1 },
    };
    const nextBox = boxChild("next");
    expect(shouldExpandGroupForBoolean(bakedSubtract)).toBe(false);
    expect(shouldExpandGroupForBoolean(nextBox)).toBe(false);
  });

  it("still expands assemblies and CSG bodies that have no mesh cache", () => {
    const assembly: WorkplaneShape = {
      ...boxChild("asm"),
      groupedShapes: [boxChild("a"), boxChild("b")],
    };
    expect(inferCsgOp(assembly)).toBe("assemble");
    expect(shouldExpandGroupForBoolean(assembly)).toBe(true);

    const emptySubtract: WorkplaneShape = {
      ...boxChild("cut-body"),
      groupedShapes: [boxChild("solid"), boxChild("hole", true)],
      csg: { op: "subtract", version: 1 },
    };
    expect(shouldExpandGroupForBoolean(emptySubtract)).toBe(true);
  });
});
