import { describe, expect, it } from "vitest";
import { mergeProfileIntoDoc, sketchDocToProfile } from "@/lib/sketch/migrate";
import { createEmptySketchDoc } from "@/lib/sketch/types";
import type { SketchDoc } from "@/lib/sketch/types";

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  uAxis: { x: 1, y: 0, z: 0 },
};

/** Model geometry, a construction line, a locked projected edge and an analytic circle. */
function richDoc(): SketchDoc {
  const doc = createEmptySketchDoc(PLANE, "sketch-1");
  doc.entities.push(
    { kind: "point", id: "a", x: 0, z: 0 },
    { kind: "point", id: "b", x: 40, z: 0 },
    { kind: "line", id: "wall", startId: "a", endId: "b" },

    { kind: "point", id: "cx1", x: 0, z: 30, construction: true },
    { kind: "point", id: "cx2", x: 40, z: 30, construction: true },
    { kind: "line", id: "centreline", startId: "cx1", endId: "cx2", construction: true },

    { kind: "point", id: "pj1", x: 5, z: 50, construction: true, projected: true, fixed: true, projectSourceId: "shape-1:edge:0" },
    { kind: "point", id: "pj2", x: 35, z: 50, construction: true, projected: true, fixed: true, projectSourceId: "shape-1:edge:0" },
    { kind: "line", id: "pjline", startId: "pj1", endId: "pj2", construction: true, projected: true, fixed: true, projectSourceId: "shape-1:edge:0" },

    { kind: "point", id: "cc", x: 20, z: 80 },
    { kind: "circle", id: "hole", centerId: "cc", radius: 6 },
  );
  doc.dimensions.push({ id: "d1", kind: "linear", entityIds: ["wall"], value: 40, driving: true });
  doc.constraints.push({ id: "c1", kind: "horizontal", entityIds: ["centreline"] });
  return doc;
}

describe("mergeProfileIntoDoc", () => {
  it("survives a doc -> profile -> doc round trip with everything intact", () => {
    // This is the path a dimension edit takes. Rebuilding from the profile deleted the construction
    // line, the projected edge and the analytic circle, permanently.
    const doc = richDoc();
    const merged = mergeProfileIntoDoc(doc, sketchDocToProfile(doc));

    const byId = new Map(merged.entities.map((entity) => [entity.id, entity]));
    expect(byId.get("centreline")).toMatchObject({ kind: "line", construction: true });
    expect(byId.get("pjline")).toMatchObject({ projected: true, fixed: true, projectSourceId: "shape-1:edge:0" });
    expect(byId.get("pj1")).toMatchObject({ projected: true, fixed: true });
    expect(byId.get("hole")).toMatchObject({ kind: "circle", radius: 6, centerId: "cc" });
    expect(byId.get("cc")).toBeDefined();
    expect(byId.get("wall")).toBeDefined();
    expect(merged.constraints.map((c) => c.id)).toEqual(["c1"]);
    expect(merged.dimensions.map((d) => d.id)).toEqual(["d1"]);
  });

  it("does not accumulate the circle's tessellation as real geometry", () => {
    const doc = richDoc();
    let merged = mergeProfileIntoDoc(doc, sketchDocToProfile(doc));
    for (let i = 0; i < 3; i += 1) {
      merged = mergeProfileIntoDoc(merged, sketchDocToProfile(merged));
    }
    expect(merged.entities).toHaveLength(doc.entities.length);
    expect(merged.entities.filter((entity) => entity.id.startsWith("hole-"))).toHaveLength(0);
  });

  it("applies a moved point back to the doc", () => {
    const doc = richDoc();
    const profile = sketchDocToProfile(doc);
    profile.points = profile.points.map((point) => (point.id === "b" ? { ...point, x: 55, z: 3 } : point));

    const merged = mergeProfileIntoDoc(doc, profile);
    expect(merged.entities.find((entity) => entity.id === "b")).toMatchObject({ x: 55, z: 3 });
  });

  it("moves a construction point without demoting it", () => {
    const doc = richDoc();
    const profile = sketchDocToProfile(doc);
    profile.points = profile.points.map((point) => (point.id === "cx1" ? { ...point, z: 12 } : point));

    const merged = mergeProfileIntoDoc(doc, profile);
    expect(merged.entities.find((entity) => entity.id === "cx1")).toMatchObject({ z: 12, construction: true });
  });

  it("still deletes ordinary geometry the profile dropped", () => {
    const doc = richDoc();
    const profile = sketchDocToProfile(doc);
    profile.segments = profile.segments.filter((segment) => segment.id !== "wall");
    profile.points = profile.points.filter((point) => point.id !== "b");

    const merged = mergeProfileIntoDoc(doc, profile);
    expect(merged.entities.some((entity) => entity.id === "wall")).toBe(false);
    expect(merged.entities.some((entity) => entity.id === "b")).toBe(false);
    // And the dimension that measured it goes with it.
    expect(merged.dimensions).toHaveLength(0);
  });

  it("deletes a circle once its polyline is gone from the profile", () => {
    const doc = richDoc();
    const profile = sketchDocToProfile(doc);
    profile.points = profile.points.filter((point) => !point.id.startsWith("hole-"));
    profile.segments = profile.segments.filter((segment) => !segment.id.startsWith("hole-"));

    const merged = mergeProfileIntoDoc(doc, profile);
    expect(merged.entities.some((entity) => entity.id === "hole")).toBe(false);
  });

  it("adds newly drawn geometry", () => {
    const doc = richDoc();
    const profile = sketchDocToProfile(doc);
    profile.points.push({ id: "n1", x: 90, z: 90 });
    profile.segments.push({ id: "n2", startId: "a", endId: "n1", kind: "line" });

    const merged = mergeProfileIntoDoc(doc, profile);
    expect(merged.entities.find((entity) => entity.id === "n1")).toMatchObject({ kind: "point", x: 90 });
    expect(merged.entities.find((entity) => entity.id === "n2")).toMatchObject({ kind: "line", startId: "a", endId: "n1" });
  });

  it("keeps a construction circle that is never expanded into the profile", () => {
    const doc = createEmptySketchDoc(PLANE, "sketch-2");
    doc.entities.push(
      { kind: "point", id: "cc", x: 0, z: 0, construction: true },
      { kind: "circle", id: "guide", centerId: "cc", radius: 10, construction: true },
    );
    const merged = mergeProfileIntoDoc(doc, sketchDocToProfile(doc));
    expect(merged.entities.some((entity) => entity.id === "guide")).toBe(true);
    expect(merged.entities.some((entity) => entity.id === "cc")).toBe(true);
  });

  it("takes images from the profile", () => {
    const doc = richDoc();
    const profile = sketchDocToProfile(doc);
    profile.images = [{
      id: "img",
      name: "ref",
      dataUrl: "data:image/png;base64,AA",
      mimeType: "image/png",
      pixelWidth: 10,
      pixelHeight: 10,
      x: 0,
      z: 0,
      width: 10,
      depth: 10,
    }];
    expect(mergeProfileIntoDoc(doc, profile).images).toHaveLength(1);
  });
});
