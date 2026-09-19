import { describe, expect, it } from "vitest";
import {
  __blueprintTestUtils,
  blueprintPartFrame,
  buildBlueprintDrawing,
  buildBlueprintDxf,
  buildBlueprintPdf,
  buildBlueprintSvg,
  writeBlueprintSvg,
  type BlueprintMeshPart,
} from "../../apps/web/src/lib/blueprintExport";

const boxPart = (): BlueprintMeshPart => ({
  name: "Block",
  kind: "box",
  width: 40,
  depth: 20,
  height: 10,
  elevation: 0,
  x: 0,
  z: 0,
  vertices: [
    [-20, 0, -10],
    [20, 0, -10],
    [20, 0, 10],
    [-20, 0, 10],
    [-20, 10, -10],
    [20, 10, -10],
    [20, 10, 10],
    [-20, 10, 10],
  ],
  faces: [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [0, 4, 5],
    [0, 5, 1],
    [1, 5, 6],
    [1, 6, 2],
    [2, 6, 7],
    [2, 7, 3],
    [3, 7, 4],
    [3, 4, 0],
  ],
});

function cylinderPart(sides = 48): BlueprintMeshPart {
  const radius = 32;
  const height = 12;
  const vertices: Array<[number, number, number]> = [[0, height, 0], [0, 0, 0]];
  const faces: Array<[number, number, number]> = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (i / sides) * Math.PI * 2;
    vertices.push([Math.cos(angle) * radius, height, Math.sin(angle) * radius]);
    vertices.push([Math.cos(angle) * radius, 0, Math.sin(angle) * radius]);
  }
  for (let i = 0; i < sides; i += 1) {
    const next = (i + 1) % sides;
    const topA = 2 + i * 2;
    const botA = topA + 1;
    const topB = 2 + next * 2;
    const botB = topB + 1;
    faces.push([0, topA, topB]);
    faces.push([1, botB, botA]);
    faces.push([topA, botA, botB]);
    faces.push([topA, botB, topB]);
  }
  return {
    name: "Cup",
    kind: "cylinder",
    width: radius * 2,
    depth: radius * 2,
    height,
    elevation: 0,
    x: 0,
    z: 0,
    vertices,
    faces,
  };
}

/** Axis-aligned box triangles with outward winding, appended to an existing mesh. */
function pushBox(
  vertices: Array<[number, number, number]>,
  faces: Array<[number, number, number]>,
  min: [number, number, number],
  max: [number, number, number],
) {
  const base = vertices.length;
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  vertices.push(
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  );
  const quads: Array<[number, number, number]> = [
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1],
    [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3],
    [3, 7, 4], [3, 4, 0],
  ];
  for (const [a, b, c] of quads) {
    faces.push([base + a, base + b, base + c]);
  }
}

function boxMeshPart(min: [number, number, number], max: [number, number, number]): BlueprintMeshPart {
  const vertices: Array<[number, number, number]> = [];
  const faces: Array<[number, number, number]> = [];
  pushBox(vertices, faces, min, max);
  return {
    name: "Block",
    kind: "mesh",
    width: max[0] - min[0],
    depth: max[2] - min[2],
    height: max[1] - min[1],
    elevation: min[1],
    x: (min[0] + max[0]) / 2,
    z: (min[2] + max[2]) / 2,
    color: "#3b82f6",
    vertices,
    faces,
  };
}

/** 40x20x10 plate with a 10x1x10 pad raised on the top face (a feature only visible from above). */
function plateWithRaisedPad(): BlueprintMeshPart {
  const vertices: Array<[number, number, number]> = [];
  const faces: Array<[number, number, number]> = [];
  pushBox(vertices, faces, [-20, 0, -10], [20, 10, 10]);
  pushBox(vertices, faces, [-5, 10, -5], [5, 11, 5]);
  return {
    name: "Plate",
    kind: "mesh",
    width: 40,
    depth: 20,
    height: 11,
    elevation: 0,
    x: 0,
    z: 0,
    color: "#3b82f6",
    vertices,
    faces,
  };
}

const sampleInput = () => ({
  projectName: "Test Assembly",
  parts: [boxPart()],
  workspace: { units: "Metric (Default)" as const, scale: "1:1 (millimeters)" as const, accuracy: 2 as const },
});

describe("blueprintExport", () => {
  it("projects orthographic and isometric points", () => {
    const point: [number, number, number] = [10, 5, 2];
    expect(__blueprintTestUtils.projectPoint("top", point)).toEqual({ x: 10, y: -2 });
    expect(__blueprintTestUtils.projectPoint("bottom", point)).toEqual({ x: 10, y: 2 });
    expect(__blueprintTestUtils.projectPoint("front", point)).toEqual({ x: 10, y: 5 });
    expect(__blueprintTestUtils.projectPoint("right", point)).toEqual({ x: 2, y: 5 });
    expect(__blueprintTestUtils.projectPoint("left", point)).toEqual({ x: -2, y: 5 });
    const iso = __blueprintTestUtils.projectPoint("iso", point);
    expect(iso.x).toBeCloseTo((10 - 2) * Math.cos(Math.PI / 6), 5);
    expect(iso.y).toBeCloseTo(5 + (10 + 2) * Math.sin(Math.PI / 6), 5);
  });

  it("keeps cylinder top views as outlines instead of tessellation spaghetti", () => {
    const part = cylinderPart(64);
    const totalTriangleEdges = part.faces.length * 3;
    const topEdges = __blueprintTestUtils.collectDrawingEdges(part, "top");
    // Top/bottom rims only (~2 * sides), not every radial fan spoke.
    expect(topEdges.length).toBeLessThan(part.faces.length);
    expect(topEdges.length).toBeLessThan(totalTriangleEdges / 4);
    expect(topEdges.length).toBeGreaterThanOrEqual(32);
  });

  it("keeps front-view silhouette generators on finely tessellated cylinders", () => {
    const part = cylinderPart(192);
    const frontEdges = __blueprintTestUtils.collectDrawingEdges(part, "front");
    // Elevations use the nominal W×H frame — a cylinder becomes a closed rectangle.
    expect(frontEdges).toHaveLength(4);
    const verticalish = frontEdges.filter(([a, b]) => {
      const dx = Math.abs(a[0] - b[0]);
      const dy = Math.abs(a[1] - b[1]);
      return dy > 1 && dx / dy < 0.35;
    });
    expect(verticalish.length).toBe(2);
    const horizontalish = frontEdges.filter(([a, b]) => {
      const dx = Math.abs(a[0] - b[0]);
      const dy = Math.abs(a[1] - b[1]);
      return dx > 1 && dy / dx < 0.35;
    });
    expect(horizontalish.length).toBe(2);
  });

  it("draws embossed discs as closed elevation rectangles, not crease crumbs", () => {
    const part = cylinderPart(96);
    part.kind = "mesh";
    // Mimic raised lettering + a missing rim corner (broken CSG tessellation).
    for (let i = 0; i < 40; i += 1) {
      const t = i / 40;
      const x = (t - 0.5) * 40;
      const z = Math.sin(t * Math.PI * 6) * 8;
      part.vertices.push([x, part.height + 0.4, z], [x + 0.3, part.height + 0.4, z + 0.3], [x, part.height, z + 0.2]);
      const n = part.vertices.length;
      part.faces.push([n - 3, n - 2, n - 1]);
    }
    // Drop the leftmost bottom/top rim vertices so a mesh hull would invent a chamfer.
    part.vertices = part.vertices.filter(([x, , z]) => !(x < -30 && Math.abs(z) < 8));
    for (const view of ["front", "right", "left"] as const) {
      const edges = __blueprintTestUtils.collectDrawingEdges(part, view);
      expect(edges).toHaveLength(4);
      const pts = edges.flatMap(([a, b]) => [
        __blueprintTestUtils.projectPoint(view, a),
        __blueprintTestUtils.projectPoint(view, b),
      ]);
      const spanX = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
      const spanY = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
      expect(spanX).toBeCloseTo(64, 5);
      expect(spanY).toBeCloseTo(12, 5);
      // No diagonal chamfers — every edge is axis-aligned.
      for (const [a, b] of edges) {
        const pa = __blueprintTestUtils.projectPoint(view, a);
        const pb = __blueprintTestUtils.projectPoint(view, b);
        const axisAligned = Math.abs(pa.x - pb.x) < 1e-6 || Math.abs(pa.y - pb.y) < 1e-6;
        expect(axisAligned).toBe(true);
      }
    }
  });

  it("closes circular top outlines even when the mesh rim is gapped", () => {
    const part = cylinderPart(64);
    part.kind = "mesh";
    // Remove a wedge of rim vertices so crease extraction leaves a gap.
    part.vertices = part.vertices.filter(([x, , z]) => !(x < -20 && z > 0));
    const topEdges = __blueprintTestUtils.collectDrawingEdges(part, "top");
    const projected = topEdges.map(([a, b]) => [
      __blueprintTestUtils.projectPoint("top", a),
      __blueprintTestUtils.projectPoint("top", b),
    ]);
    const xs = projected.flatMap(([a, b]) => [a.x, b.x]);
    const ys = projected.flatMap(([a, b]) => [a.y, b.y]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(60);
    expect(topEdges.length).toBeGreaterThanOrEqual(72);
  });

  it("omits hidden bottom rims from top view when the top face is larger", () => {
    const height = 12;
    const topRadius = 32;
    const baseRadius = 20;
    const sides = 48;
    const vertices: Array<[number, number, number]> = [[0, height, 0], [0, 0, 0]];
    const faces: Array<[number, number, number]> = [];
    for (let i = 0; i < sides; i += 1) {
      const angle = (i / sides) * Math.PI * 2;
      vertices.push([Math.cos(angle) * topRadius, height, Math.sin(angle) * topRadius]);
      vertices.push([Math.cos(angle) * baseRadius, 0, Math.sin(angle) * baseRadius]);
    }
    for (let i = 0; i < sides; i += 1) {
      const next = (i + 1) % sides;
      const topA = 2 + i * 2;
      const botA = topA + 1;
      const topB = 2 + next * 2;
      const botB = topB + 1;
      faces.push([0, topA, topB], [1, botB, botA], [topA, botA, botB], [topA, botB, topB]);
    }
    const part: BlueprintMeshPart = {
      name: "Lid",
      kind: "cone",
      width: topRadius * 2,
      depth: topRadius * 2,
      height,
      elevation: 0,
      x: 0,
      z: 0,
      topRadius,
      baseRadius,
      vertices,
      faces,
    };
    const topEdges = __blueprintTestUtils.collectDrawingEdges(part, "top");
    const bottomRim = topEdges.filter(([a, b]) => (a[1] + b[1]) / 2 < height * 0.25);
    const topRim = topEdges.filter(([a, b]) => (a[1] + b[1]) / 2 > height * 0.75);
    expect(topRim.length).toBeGreaterThanOrEqual(sides / 2);
    expect(bottomRim.length).toBe(0);
  });

  it("anchors front diameter extension lines to each ring width", () => {
    const height = 12;
    const topRadius = 32.25;
    const baseRadius = 20;
    const sides = 32;
    const vertices: Array<[number, number, number]> = [[0, height, 0], [0, 0, 0]];
    const faces: Array<[number, number, number]> = [];
    for (let i = 0; i < sides; i += 1) {
      const angle = (i / sides) * Math.PI * 2;
      vertices.push([Math.cos(angle) * topRadius, height, Math.sin(angle) * topRadius]);
      vertices.push([Math.cos(angle) * baseRadius, 0, Math.sin(angle) * baseRadius]);
    }
    for (let i = 0; i < sides; i += 1) {
      const next = (i + 1) % sides;
      const topA = 2 + i * 2;
      const botA = topA + 1;
      const topB = 2 + next * 2;
      const botB = topB + 1;
      faces.push([0, topA, topB], [1, botB, botA], [topA, botA, botB], [topA, botB, topB]);
    }
    const drawing = buildBlueprintDrawing({
      projectName: "Taper",
      parts: [{
        name: "Cone",
        kind: "cone",
        width: topRadius * 2,
        depth: topRadius * 2,
        height,
        elevation: 0,
        x: 0,
        z: 0,
        topRadius,
        baseRadius,
        vertices,
        faces,
      }],
      workspace: { units: "Metric (Default)", scale: "1:1 (millimeters)", accuracy: 2 },
    });

    const frontPanel = drawing.primitives.find(
      (primitive) => primitive.kind === "rect" && primitive.layer === "FRONT",
    );
    expect(frontPanel?.kind).toBe("rect");
    if (frontPanel?.kind !== "rect") return;

    const inFront = (x: number, y: number) => (
      x >= frontPanel.x - 1
      && x <= frontPanel.x + frontPanel.w + 1
      && y >= frontPanel.y - 1
      && y <= frontPanel.y + frontPanel.h + 1
    );

    const topLabel = drawing.primitives.find(
      (primitive) =>
        primitive.kind === "text"
        && primitive.layer === "DIMS"
        && /^Ø .*64\.50/.test(primitive.text)
        && inFront(primitive.x, primitive.y),
    );
    const botLabel = drawing.primitives.find(
      (primitive) =>
        primitive.kind === "text"
        && primitive.layer === "DIMS"
        && /^Ø .*40\.00/.test(primitive.text)
        && inFront(primitive.x, primitive.y),
    );
    expect(topLabel?.kind).toBe("text");
    expect(botLabel?.kind).toBe("text");
    if (topLabel?.kind !== "text" || botLabel?.kind !== "text") return;

    const witnessWidthNear = (labelY: number) => {
      const lines = drawing.primitives.filter(
        (primitive) =>
          primitive.kind === "line"
          && primitive.layer === "DIMS"
          && Math.abs(primitive.y1 - primitive.y2) < 0.01
          && Math.abs(primitive.y1 - labelY) < 4
          && Math.abs(primitive.x2 - primitive.x1) > 8
          && inFront((primitive.x1 + primitive.x2) / 2, primitive.y1),
      );
      expect(lines.length).toBeGreaterThan(0);
      return Math.max(...lines.map((primitive) => (primitive.kind === "line" ? Math.abs(primitive.x2 - primitive.x1) : 0)));
    };

    const topWidth = witnessWidthNear(topLabel.y + 1.8);
    const botWidth = witnessWidthNear(botLabel.y + 1.8);
    expect(topWidth).toBeGreaterThan(botWidth * 1.2);
  });

  it("calls out cone diameters and draft angle", () => {
    const height = 12;
    const topRadius = 10;
    const baseRadius = 32.25;
    const part: BlueprintMeshPart = {
      ...cylinderPart(48),
      name: "Cone",
      kind: "cone",
      width: baseRadius * 2,
      depth: baseRadius * 2,
      height,
      topRadius,
      baseRadius,
    };
    // Rebuild as truncated cone mesh
    const sides = 48;
    const vertices: Array<[number, number, number]> = [[0, height, 0], [0, 0, 0]];
    const faces: Array<[number, number, number]> = [];
    for (let i = 0; i < sides; i += 1) {
      const angle = (i / sides) * Math.PI * 2;
      vertices.push([Math.cos(angle) * topRadius, height, Math.sin(angle) * topRadius]);
      vertices.push([Math.cos(angle) * baseRadius, 0, Math.sin(angle) * baseRadius]);
    }
    for (let i = 0; i < sides; i += 1) {
      const next = (i + 1) % sides;
      const topA = 2 + i * 2;
      const botA = topA + 1;
      const topB = 2 + next * 2;
      const botB = topB + 1;
      faces.push([0, topA, topB], [1, botB, botA], [topA, botA, botB], [topA, botB, topB]);
    }
    part.vertices = vertices;
    part.faces = faces;

    const profile = __blueprintTestUtils.inferRevolutionProfile(part);
    expect(profile?.topRadius).toBeCloseTo(topRadius, 5);
    expect(profile?.bottomRadius).toBeCloseTo(baseRadius, 5);
    expect(profile?.taperFromVerticalDeg).toBeGreaterThan(1);

    const drawing = buildBlueprintDrawing({
      projectName: "Cone Sheet",
      parts: [part],
      workspace: { units: "Metric (Default)", scale: "1:1 (millimeters)", accuracy: 2 },
    });
    const dimTexts = drawing.primitives
      .filter((primitive): primitive is Extract<typeof primitive, { kind: "text" }> => primitive.kind === "text" && primitive.layer === "DIMS")
      .map((primitive) => primitive.text);
    expect(dimTexts.some((text) => text.includes("Ø") && text.includes("64.50"))).toBe(true);
    expect(dimTexts.some((text) => text.includes("Ø") && text.includes("20.00"))).toBe(true);
    expect(dimTexts.some((text) => text.includes("Draft") && text.includes("°"))).toBe(true);
  });

  it("keeps title-block overall and date from overlapping", () => {
    const drawing = buildBlueprintDrawing(sampleInput());
    const titleTexts = drawing.primitives.filter(
      (primitive) => primitive.kind === "text" && primitive.layer === "TITLE",
    );
    const overall = titleTexts.find((primitive) => primitive.kind === "text" && primitive.text.startsWith("Overall:"));
    const dateLike = titleTexts.find((primitive) => primitive.kind === "text" && /^\d/.test(primitive.text));
    expect(overall).toBeTruthy();
    expect(dateLike).toBeTruthy();
    if (overall?.kind === "text" && dateLike?.kind === "text") {
      expect(Math.abs(overall.y - dateLike.y)).toBeGreaterThan(4);
    }
  });

  it("derives table dimensions from transformed mesh bounds", () => {
    const frame = blueprintPartFrame(
      [
        [5, -3, 10],
        [25, 7, 40],
        [15, 2, 20],
      ],
      { width: 1, depth: 1, height: 1, elevation: 0, x: 0, z: 0 },
    );
    expect(frame).toEqual({
      width: 20,
      depth: 30,
      height: 10,
      elevation: -3,
      x: 15,
      z: 25,
    });
  });

  it("builds a shared drawing model with view layers", () => {
    const drawing = buildBlueprintDrawing(sampleInput());
    expect(drawing.pageW).toBe(420);
    expect(drawing.pageH).toBe(297);
    expect(drawing.primitives.length).toBeGreaterThan(20);
    const layers = new Set(drawing.primitives.map((primitive) => primitive.layer));
    expect(layers.has("TOP")).toBe(true);
    expect(layers.has("FRONT")).toBe(true);
    expect(layers.has("RIGHT")).toBe(true);
    expect(layers.has("LEFT")).toBe(true);
    expect(layers.has("BOTTOM")).toBe(true);
    expect(layers.has("ISO")).toBe(true);
    expect(layers.has("DIMS")).toBe(true);
    expect(layers.has("TITLE")).toBe(true);
  });

  it("keeps dimension labels inside view panels", () => {
    const drawing = buildBlueprintDrawing(sampleInput());
    const panelRects = drawing.primitives.filter(
      (primitive) =>
        primitive.kind === "rect"
        && (primitive.layer === "TOP"
          || primitive.layer === "FRONT"
          || primitive.layer === "RIGHT"
          || primitive.layer === "LEFT"
          || primitive.layer === "BOTTOM"),
    );
    expect(panelRects.length).toBe(5);
    const dimTexts = drawing.primitives.filter(
      (primitive) => primitive.kind === "text" && primitive.layer === "DIMS" && /^(W|D|H) /.test(primitive.text),
    );
    expect(dimTexts.length).toBeGreaterThanOrEqual(10);
    for (const text of dimTexts) {
      if (text.kind !== "text") continue;
      const panel = panelRects.find((rect) => {
        if (rect.kind !== "rect") return false;
        // Rough association: text near this panel's vertical dim is in right gutter of a panel
        return text.x >= rect.x - 1 && text.x <= rect.x + rect.w + 1 && text.y >= rect.y - 1 && text.y <= rect.y + rect.h + 1;
      });
      expect(panel).toBeTruthy();
      if (panel && panel.kind === "rect") {
        expect(text.x).toBeGreaterThanOrEqual(panel.x);
        expect(text.x).toBeLessThanOrEqual(panel.x + panel.w);
        expect(text.y).toBeGreaterThanOrEqual(panel.y);
        expect(text.y).toBeLessThanOrEqual(panel.y + panel.h);
      }
    }
  });

  it("calls out regular polygon interior and exterior angles", () => {
    const notes = __blueprintTestUtils.polygonAngleNotes({
      ...boxPart(),
      kind: "polygon",
      sides: 10,
    });
    expect(notes).toEqual({
      sides: 10,
      interior: __blueprintTestUtils.regularPolygonInteriorAngle(10),
      exterior: __blueprintTestUtils.regularPolygonExteriorAngle(10),
    });
    expect(notes?.interior).toBe(144);
    expect(notes?.exterior).toBe(36);

    const drawing = buildBlueprintDrawing({
      projectName: "Decagon",
      parts: [
        {
          ...boxPart(),
          name: "Polygon",
          kind: "polygon",
          sides: 10,
        },
      ],
      workspace: { units: "Metric (Default)", scale: "1:1 (millimeters)", accuracy: 2 },
    });
    const angleTexts = drawing.primitives.filter(
      (primitive) => primitive.kind === "text" && primitive.layer === "DIMS" && (primitive.text.includes("°") || primitive.text.includes("sides")),
    );
    expect(angleTexts.length).toBeGreaterThanOrEqual(2);
    expect(angleTexts.some((primitive) => primitive.kind === "text" && primitive.text.includes("144°"))).toBe(true);
    expect(angleTexts.some((primitive) => primitive.kind === "text" && primitive.text.includes("10 sides"))).toBe(true);
  });

  it("builds a non-empty PDF for solid parts", () => {
    const bytes = buildBlueprintPdf(sampleInput());
    expect(bytes.byteLength).toBeGreaterThan(1_000);
    const head = String.fromCharCode(...bytes.slice(0, 5));
    expect(head).toBe("%PDF-");
  });

  it("builds DXF with expected layers and entities", () => {
    const dxf = buildBlueprintDxf(sampleInput());
    expect(dxf.length).toBeGreaterThan(500);
    expect(dxf).toContain("SECTION");
    expect(dxf).toContain("ENTITIES");
    expect(dxf).toContain("TOP");
    expect(dxf).toContain("FRONT");
    expect(dxf).toContain("RIGHT");
    expect(dxf).toContain("LEFT");
    expect(dxf).toContain("BOTTOM");
    expect(dxf).toContain("ISO");
    expect(dxf).toContain("DIMS");
    expect(dxf).toContain("EOF");
  });

  it("embeds shaded screenshot PNGs for every viewport", () => {
    const drawing = buildBlueprintDrawing({
      projectName: "Colored Box",
      parts: [{ ...boxPart(), color: "#d41721" }],
      workspace: { units: "Metric (Default)", scale: "1:1 (millimeters)", accuracy: 2 },
    });
    const images = drawing.primitives.filter((primitive) => primitive.kind === "image");
    const layers = new Set(images.map((primitive) => primitive.layer));
    expect(layers.has("TOP")).toBe(true);
    expect(layers.has("FRONT")).toBe(true);
    expect(layers.has("RIGHT")).toBe(true);
    expect(layers.has("LEFT")).toBe(true);
    expect(layers.has("BOTTOM")).toBe(true);
    expect(layers.has("ISO")).toBe(true);
    expect(images.length).toBe(6);
    for (const image of images) {
      expect(image.kind).toBe("image");
      if (image.kind !== "image") continue;
      expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
      expect(image.dataUrl.length).toBeGreaterThan(200);
      expect(image.w).toBeGreaterThan(10);
      expect(image.h).toBeGreaterThan(10);
    }

    const svg = writeBlueprintSvg(drawing);
    expect(svg).toContain("<image");
    expect(svg).toContain("data:image/png;base64,");
  });

  it("removes hidden lines: a raised pad never prints in the bottom view", async () => {
    const { renderMeshViewPng } = await import("../../apps/web/src/lib/blueprintIsoRender");
    const part = plateWithRaisedPad();
    const padFloor = 10.05;

    const bottom = renderMeshViewPng("bottom", [part], 90, 70, null, 6, 4);
    expect(bottom).not.toBeNull();
    if (!bottom) return;
    // The pad sits on the top face; from below the plate fully occludes it.
    for (const [a, b] of bottom.visibleEdges) {
      expect(Math.max(a[1], b[1])).toBeLessThanOrEqual(padFloor);
    }

    // Sanity: the same pad must still be drawn when the view can actually see it.
    const top = renderMeshViewPng("top", [part], 90, 70, null, 6, 4);
    expect(top).not.toBeNull();
    if (!top) return;
    const padEdges = top.visibleEdges.filter(([a, b]) => Math.min(a[1], b[1]) > padFloor);
    expect(padEdges.length).toBeGreaterThan(0);
  });

  it("removes hidden lines: top-face emboss never prints in the bottom view", async () => {
    const { renderMeshViewPng } = await import("../../apps/web/src/lib/blueprintIsoRender");
    const part = cylinderPart(96);
    for (let i = 0; i < 40; i += 1) {
      const t = i / 40;
      const x = (t - 0.5) * 40;
      const z = Math.sin(t * Math.PI * 6) * 8;
      part.vertices.push([x, part.height + 0.4, z], [x + 0.3, part.height + 0.4, z + 0.3], [x, part.height, z + 0.2]);
      const n = part.vertices.length;
      part.faces.push([n - 3, n - 2, n - 1]);
    }

    const bottom = renderMeshViewPng("bottom", [{ ...part, color: "#3b82f6" }], 90, 70, null, 6, 4);
    expect(bottom).not.toBeNull();
    if (!bottom) return;
    for (const [a, b] of bottom.visibleEdges) {
      expect(Math.max(a[1], b[1])).toBeLessThanOrEqual(part.height + 0.05);
    }
  });

  it("removes edges of a part standing behind another part", async () => {
    const { collectVisibleViewEdges, collectHiddenLineRemovedEdges, renderMeshViewPng } = await import(
      "../../apps/web/src/lib/blueprintIsoRender"
    );
    // A tall plate up front, a small block parked directly behind it.
    const plate = boxMeshPart([-30, 0, 20], [30, 30, 25]);
    const hidden = boxMeshPart([-5, 5, -20], [5, 15, -15]);
    const parts = [plate, hidden];
    const behind = ([a, b]: [number[], number[]]) => Math.max(a[2], b[2]) < 0;

    // Face-orientation tests are per-part, so the hidden block is still a candidate.
    expect(collectVisibleViewEdges("front", parts).filter(behind).length).toBeGreaterThan(0);

    // Depth-buffer clipping drops it from both the vector and raster paths.
    const vector = collectHiddenLineRemovedEdges("front", parts);
    expect(vector.length).toBeGreaterThan(0);
    expect(vector.filter(behind)).toHaveLength(0);

    const raster = renderMeshViewPng("front", parts, 90, 70, null, 6, 4);
    expect(raster).not.toBeNull();
    expect(raster?.visibleEdges.filter(behind)).toHaveLength(0);
  });

  it("renders orthographic mesh views as solid screenshots", async () => {
    const { renderMeshViewPng } = await import("../../apps/web/src/lib/blueprintIsoRender");
    const part = { ...boxPart(), color: "#3b82f6" };
    for (const view of ["top", "front", "right", "left", "bottom"] as const) {
      const png = renderMeshViewPng(view, [part], 80, 60, null, 3, 4);
      expect(png).not.toBeNull();
      if (!png) continue;
      const binary = Buffer.from(png.dataUrl.split(",")[1] ?? "", "base64");
      expect(binary[0]).toBe(0x89);
      expect(binary.length).toBeGreaterThan(400);
    }
  });

  it("keeps isometric depth aligned with the drafting projection", async () => {
    const { projectIso, isoDepth } = await import("../../apps/web/src/lib/blueprintIsoRender");
    const origin: [number, number, number] = [4, 7, -2];
    const alongView: [number, number, number] = [origin[0] + 3, origin[1] - 3, origin[2] + 3];
    const a = projectIso(origin);
    const b = projectIso(alongView);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(isoDepth(alongView)).toBeGreaterThan(isoDepth(origin));
  });

  it("fills a solid isometric silhouette for opaque shaded parts", async () => {
    const { renderIsoShadedPng } = await import("../../apps/web/src/lib/blueprintIsoRender");
    const part = { ...boxPart(), color: "#3b82f6" };
    const png = renderIsoShadedPng([part], 80, 60, null, 3, 4);
    expect(png).not.toBeNull();
    if (!png) return;
    const binary = Buffer.from(png.dataUrl.split(",")[1] ?? "", "base64");
    // PNG signature + IHDR prove a real image; length scales with a filled solid (not a thin lid).
    expect(binary[0]).toBe(0x89);
    expect(binary.length).toBeGreaterThan(800);
  });

  it("omits fully-back edges from isometric outlines", async () => {
    const { collectVisibleIsoEdges } = await import("../../apps/web/src/lib/blueprintIsoRender");
    const part = { ...boxPart(), color: "#3b82f6" };
    const edges = collectVisibleIsoEdges([part]);
    expect(edges.length).toBeGreaterThan(0);
    // A unit box has 12 edges; hidden-line iso should keep fewer than all 12.
    expect(edges.length).toBeLessThan(12);
  });

  it("builds SVG with view markers", () => {
    const svg = buildBlueprintSvg(sampleInput());
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("<svg");
    expect(svg).toContain('data-layer="TOP"');
    expect(svg).toContain('data-layer="FRONT"');
    expect(svg).toContain('data-layer="RIGHT"');
    expect(svg).toContain('data-layer="LEFT"');
    expect(svg).toContain('data-layer="BOTTOM"');
    expect(svg).toContain('data-layer="ISO"');
    expect(svg).toContain("TECHNICAL DRAWING");
  });

  it("rejects empty part lists", () => {
    expect(() =>
      buildBlueprintPdf({
        projectName: "Empty",
        parts: [],
        workspace: { units: "Metric (Default)", scale: "1:1 (millimeters)", accuracy: 2 },
      }),
    ).toThrow(/solid shape/i);
  });
});
