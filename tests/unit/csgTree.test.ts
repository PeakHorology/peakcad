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
  pickGroupToUngroup,
  setCsgChildSuppressed,
  shouldExpandGroupForBoolean,
  expandBooleanOperands,
  filterCoplanarDisplayEdges,
  viewportGroupChildren,
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

  it("unifyCoplanar welds leftover same-plane seams without flattening real steps", () => {
    const seam = [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0.02, 0, 0, 1, 0, 0, 0, 1, 0,
    ];
    const defaultClean = cleanupBooleanPositions(seam);
    const unified = cleanupBooleanPositions(seam, undefined, { unifyCoplanar: true });
    expect(defaultClean[9]).toBeCloseTo(0.02, 5);
    expect(unified[9]).toBeCloseTo(unified[0], 5);

    const stepped = [
      0, 0, 0, 10, 0, 0, 0, 1.0, 0,
      0, 0, 5, 10, 0, 5, 0, 1.01, 5,
    ];
    const kept = cleanupBooleanPositions(stepped, undefined, { unifyCoplanar: true });
    expect(kept[7]).toBeCloseTo(1.0, 5);
    expect(kept[16]).toBeCloseTo(1.01, 5);
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

  it("recursively expands nested assemblies but keeps baked groups sealed", () => {
    const bakedKnurl: WorkplaneShape = {
      ...boxChild("knurl"),
      kind: "mesh",
      groupedShapes: [boxChild("tooth-a"), boxChild("tooth-b")],
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 10,
        baseDepth: 10,
        baseHeight: 2,
        triangleCount: 1,
        sourceFormat: "json",
      },
      csg: { op: "union", version: 1 },
    };
    const inner: WorkplaneShape = {
      ...boxChild("inner-asm"),
      groupedShapes: [bakedKnurl, boxChild("block")],
    };
    const outer: WorkplaneShape = {
      ...boxChild("outer-asm"),
      groupedShapes: [inner, boxChild("cap")],
    };
    const expanded = expandBooleanOperands([outer], (shape) => shape.groupedShapes ?? []);
    expect(expanded.map((shape) => shape.id)).toEqual(["knurl", "block", "cap"]);
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

  it("never draws hole cutters after Group, even when the result mesh is missing", () => {
    const body: WorkplaneShape = {
      ...boxChild("cut-body"),
      groupedShapes: [boxChild("solid"), boxChild("hole", true)],
      csg: { op: "subtract", version: 1, dirty: true },
    };
    expect(viewportGroupChildren(body).map((child) => child.id)).toEqual(["solid"]);
  });

  it("draws no live children once a grouped result mesh exists", () => {
    const body: WorkplaneShape = {
      ...boxChild("cut-body"),
      importedMesh: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        baseWidth: 1,
        baseDepth: 1,
        baseHeight: 1,
        triangleCount: 1,
        sourceFormat: "json",
      },
      groupedShapes: [boxChild("solid"), boxChild("hole", true)],
      csg: { op: "subtract", version: 1 },
    };
    expect(viewportGroupChildren(body)).toEqual([]);
  });

  it("drops leftover cutter wires that are not on the result mesh", () => {
    const mesh = [
      0, 0, 0, 20, 0, 0, 0, 0, 20,
      20, 0, 0, 20, 0, 20, 0, 0, 20,
    ];
    const kept = filterCoplanarDisplayEdges(
      [
        { points: [0, 40, 0, 20, 40, 0] },
        { points: [0, 0, 0, 20, 0, 0] },
      ],
      mesh,
    );
    expect(kept).toHaveLength(0);
  });

  it("hides a leftover diametric seam and keeps the 90-degree rim", () => {
    // Two coplanar top triangles sharing (0,1,0)-(0,1,10), plus a vertical wall on (0,1,0)-(10,1,0).
    const mesh = [
      0, 1, 0, 10, 1, 0, 0, 1, 10,
      10, 1, 0, 10, 1, 10, 0, 1, 10,
      0, 1, 0, 0, 0, 0, 10, 1, 0,
    ];
    const kept = filterCoplanarDisplayEdges(
      [
        { points: [0, 1, 0, 0, 1, 10] },
        { points: [0, 1, 0, 10, 1, 0] },
      ],
      mesh,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].points).toEqual([0, 1, 0, 10, 1, 0]);
  });

  it("peels the last-selected group so Ungroup walks nested groups one at a time", () => {
    expect(pickGroupToUngroup(["outer", "other"], ["inner", "outer"])).toBe("outer");
    expect(pickGroupToUngroup(["inner", "leaf", "outer"], ["inner", "outer"])).toBe("outer");
    expect(pickGroupToUngroup(["inner", "leaf"], ["inner"])).toBe("inner");
    expect(pickGroupToUngroup(["leaf"], ["inner", "outer"])).toBe("outer");
    expect(pickGroupToUngroup([], [])).toBeNull();
  });
});
