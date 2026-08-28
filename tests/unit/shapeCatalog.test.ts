import { describe, expect, it } from "vitest";
import type { ShapeAsset } from "@/types/sketchforge";
import { makeShapeFromAsset, sceneShape, toolbarShapeAssets } from "@/lib/shapeCatalog";

describe("shape catalog", () => {
  it("exposes the current primitive kinds in the toolbar catalog", () => {
    const kinds = toolbarShapeAssets.map((asset) => asset.kind);

    expect(kinds).toContain("thread");
    expect(kinds).toContain("roof");
    expect(kinds).toContain("roundRoof");
    expect(kinds).toContain("tube");
    expect(kinds).toContain("polygon");
    expect(kinds).not.toContain("ring");
    expect(kinds).not.toContain("icosahedron");
  });

  it("does not expose removed decorative shapes in the toolbar catalog", () => {
    const kinds = toolbarShapeAssets.map((asset) => asset.kind);

    expect(kinds).not.toContain("star");
    expect(kinds).not.toContain("heart");
  });

  it("creates placed shapes from toolbar assets", () => {
    const asset: ShapeAsset = { id: "box", name: "Box", src: "box.png", kind: "box", color: "#d41721" };
    const placed = makeShapeFromAsset(asset, { x: 12, z: -8, elevation: 4 });

    expect(placed.id).toMatch(/^box-/);
    expect(placed).toMatchObject({
      name: "Box",
      kind: "box",
      color: "#d41721",
      x: 12,
      z: -8,
      elevation: 4,
      size: 20,
      width: 20,
      depth: 20,
      height: 20,
      radius: 0,
      steps: 10,
      locked: false,
      hidden: false,
    });
  });

  it("uses shape-specific defaults for text and round profiles", () => {
    const text = makeShapeFromAsset({ id: "text", name: "Text", src: "text.png", kind: "text", color: "#cf101b" });
    const torus = makeShapeFromAsset({ id: "torus", name: "Torus", src: "torus.png", kind: "torus", color: "#0098c7" });
    const polygon = makeShapeFromAsset({ id: "polygon", name: "Polygon", src: "polygon.png", kind: "polygon", color: "#3b82f6" });
    const ring = makeShapeFromAsset({ id: "ring", name: "Ring", src: "ring.png", kind: "ring", color: "#b98254" });

    expect(text).toMatchObject({ width: 86, depth: 28, height: 10, text: "TEXT", font: "Multilanguage" });
    expect(torus).toMatchObject({ size: 22, width: 22, depth: 22, height: 5 });
    expect(polygon).toMatchObject({ sides: 6, width: 20, depth: 20, height: 20 });
    expect(ring).toMatchObject({ size: 22, width: 22, depth: 22, height: 5, bevel: 4 });
  });

  it("creates canonical scene shapes with stable defaults", () => {
    const created = sceneShape({
      name: "Part",
      kind: "box",
      color: "#d41721",
      width: 12,
      depth: 18,
      rotation: 359.9,
      mirrorX: false,
    });

    expect(created.id).toMatch(/^shape-/);
    expect(created).toMatchObject({
      name: "Part",
      kind: "box",
      color: "#d41721",
      x: 0,
      z: 0,
      elevation: 0,
      width: 12,
      depth: 18,
      height: 20,
      size: 18,
      rotation: 0,
      locked: false,
      hidden: false,
    });
    expect(created.mirrorX).toBeUndefined();
  });
});
