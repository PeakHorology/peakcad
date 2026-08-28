import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  MAX_SVG_GEOMETRY_ELEMENTS,
  analyzeTriangleSoup,
  buildSvgExtrusionFromPaths,
  describeSvgImportFailure,
  isLocalSvgUseHref,
  normalizeSvgUseReferences,
  simplifySvgProfile,
  stripExternalSvgUseElements,
  svgContainsEmbeddedRaster,
  validateClosedSolidTriangleSoup,
  validateSvgSourcePreflight,
  type SvgProfile,
} from "@/lib/svgImport";

function shapePath(
  points: Array<[number, number]>,
  options: {
    closed?: boolean;
    fill?: string;
    fillOpacity?: number;
    opacity?: number;
    stroke?: string;
    strokeWidth?: number;
  } = {},
) {
  const path = new THREE.ShapePath();
  path.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) path.lineTo(x, y);
  if (options.closed !== false) path.currentPath!.autoClose = true;
  (path as THREE.ShapePath & { userData: unknown }).userData = {
    style: {
      fill: options.fill ?? (options.stroke ? "none" : "#000"),
      fillOpacity: options.fillOpacity ?? 1,
      opacity: options.opacity ?? 1,
      visibility: "visible",
      stroke: options.stroke,
      strokeWidth: options.strokeWidth,
      strokeOpacity: 1,
    },
  };
  return path;
}

function rectangle(x: number, y: number, width: number, height: number, options?: Parameters<typeof shapePath>[1]) {
  return shapePath(
    [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ],
    options,
  );
}

function geometryPositions(geometry: THREE.BufferGeometry) {
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const attribute = nonIndexed.getAttribute("position");
  const positions: number[] = [];
  for (let index = 0; index < attribute.count; index += 1) {
    positions.push(attribute.getX(index), attribute.getY(index), attribute.getZ(index));
  }
  if (nonIndexed !== geometry) nonIndexed.dispose();
  geometry.dispose();
  return positions;
}

describe("SVG source preflight", () => {
  it("rejects XML entities and SVGs that only reference external artwork", () => {
    expect(() => validateSvgSourcePreflight('<!DOCTYPE svg [<!ENTITY x "bad">]><svg/>')).toThrow(/document types and entities/i);
    expect(() => validateSvgSourcePreflight('<svg><use href="https://example.com/art.svg#part"/></svg>')).toThrow(/external references/i);
  });

  it("allows common design-tool hrefs that are not external <use> geometry", () => {
    expect(() => validateSvgSourcePreflight(
      '<svg><a href="https://example.com"><path d="M0 0H10V10H0Z"/></a><image href="logo.png"/></svg>',
    )).not.toThrow();
    expect(() => validateSvgSourcePreflight(
      '<svg><defs><path id="p" d="M0 0H1V1H0Z"/></defs><use href="#p"/><use href="https://example.com/x.svg#p"/></svg>',
    )).not.toThrow();
  });

  it("classifies local vs external use hrefs", () => {
    expect(isLocalSvgUseHref("#icon")).toBe(true);
    expect(isLocalSvgUseHref("https://example.com/a.svg#x")).toBe(false);
    expect(isLocalSvgUseHref("other.svg#x")).toBe(false);
  });

  it("strips external use tags while keeping local ones", () => {
    const stripped = stripExternalSvgUseElements(
      '<svg><use href="#local"/><use xlink:href="https://example.com/a.svg#x"/></svg>',
    );
    expect(stripped).toContain('href="#local"');
    expect(stripped).not.toContain("example.com");
  });

  it("rejects excessive geometry before SVGLoader runs", () => {
    const source = `<svg>${"<rect width='1' height='1'/>".repeat(MAX_SVG_GEOMETRY_ELEMENTS + 1)}</svg>`;
    expect(() => validateSvgSourcePreflight(source)).toThrow(/too many geometry elements/i);
  });

  it("normalizes modern local use href attributes for SVGLoader", () => {
    const normalized = normalizeSvgUseReferences('<svg><defs><path id="p" d="M0 0L1 0L1 1Z"/></defs><use href="#p"/></svg>');
    expect(normalized).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(normalized).toContain('xlink:href="#p"');
  });

  it("detects Canva-style SVG image wrappers", () => {
    const canvaSvg = '<svg xmlns="http://www.w3.org/2000/svg"><!-- Generator: Canva --><image href="data:image/png;base64,iVBORw0KGgo="/></svg>';
    expect(svgContainsEmbeddedRaster(canvaSvg)).toBe(true);
    expect(describeSvgImportFailure(canvaSvg, [])).toMatch(/Canva SVG is an image wrapper/i);
    expect(describeSvgImportFailure(canvaSvg, [])).toMatch(/Recommended action: Use Inkscape/i);
  });
});

describe("SVG path extrusion", () => {
  it("creates a watertight solid with real, unclamped dimensions", () => {
    const result = buildSvgExtrusionFromPaths([rectangle(0, 0, 0.25, 0.5)]);
    expect(result.analysis.width).toBeCloseTo(0.25);
    expect(result.analysis.height).toBeCloseTo(4);
    expect(result.analysis.depth).toBeCloseTo(0.5);
    expect(result.analysis.volume).toBeCloseTo(0.5);
    expect(result.analysis.boundaryEdges).toBe(0);
    expect(result.analysis.nonManifoldEdges).toBe(0);
    expect(result.svgProfile.shapes.length).toBeGreaterThan(0);
    expect(result.svgProfile.width).toBeCloseTo(0.25);
    expect(result.svgProfile.height).toBeCloseTo(0.5);
  });

  it("treats a separately defined contained contour as a hole", () => {
    const result = buildSvgExtrusionFromPaths([rectangle(0, 0, 10, 10), rectangle(3, 3, 4, 4)]);
    expect(result.analysis.volume).toBeCloseTo((100 - 16) * 4, 5);
    expect(result.analysis.boundaryEdges).toBe(0);
  });

  it("ignores non-filled and fully transparent paths without strokes", () => {
    expect(() => buildSvgExtrusionFromPaths([rectangle(0, 0, 10, 10, { fill: "none" })])).toThrow(/no readable visible filled or stroked paths/i);
    expect(() => buildSvgExtrusionFromPaths([rectangle(0, 0, 10, 10, { opacity: 0 })])).toThrow(/no readable visible filled or stroked paths/i);
    expect(() => buildSvgExtrusionFromPaths([rectangle(0, 0, 10, 10, { fillOpacity: 0 })])).toThrow(/no readable visible filled or stroked paths/i);
    expect(() => buildSvgExtrusionFromPaths([rectangle(0, 0, 10, 10, { fill: "#00000000" })])).toThrow(/no readable visible filled or stroked paths/i);
  });

  it("imports stroke-only black logos (transparent background)", () => {
    const result = buildSvgExtrusionFromPaths([
      shapePath(
        [
          [0, 0],
          [20, 0],
          [20, 8],
          [0, 8],
        ],
        { fill: "none", stroke: "#000000", strokeWidth: 2 },
      ),
    ]);
    expect(result.analysis.triangleCount).toBeGreaterThan(0);
    expect(result.analysis.volume).toBeGreaterThan(0);
    expect(result.svgProfile.shapes.length).toBeGreaterThan(0);
  });

  it("imports open filled contours when they enclose usable area and skips lines", () => {
    const result = buildSvgExtrusionFromPaths([shapePath([[0, 0], [10, 0], [5, 5]], { closed: false })]);
    expect(result.analysis.volume).toBeCloseTo(100);
    expect(() => buildSvgExtrusionFromPaths([shapePath([[0, 0], [10, 0]], { closed: false })])).toThrow(/no (?:readable )?filled (?:paths|contours)/i);
  });

  it("skips closed collinear paths", () => {
    expect(() => buildSvgExtrusionFromPaths([shapePath([[0, 0], [5, 0], [10, 0]])])).toThrow(/no readable filled paths/i);
  });

  it("imports overlapping contours as separate valid components", () => {
    const result = buildSvgExtrusionFromPaths([rectangle(0, 0, 10, 10), rectangle(5, 5, 10, 10)]);
    expect(result.analysis.volume).toBeCloseTo(800);
  });

  it("simplifies the stored profile after import (drops micro-features, caps points)", () => {
    const noisyOuter: Array<[number, number]> = [];
    for (let index = 0; index <= 400; index += 1) {
      const t = index / 400;
      const angle = t * Math.PI * 2;
      const wobble = 0.02 * Math.sin(angle * 40);
      noisyOuter.push([50 + (40 + wobble) * Math.cos(angle), 50 + (40 + wobble) * Math.sin(angle)]);
    }
    const result = buildSvgExtrusionFromPaths([
      shapePath(noisyOuter),
      rectangle(49.9, 49.9, 0.05, 0.05),
    ]);
    expect(result.svgProfile.shapes.length).toBe(1);
    expect(result.svgProfile.shapes[0].outer.length).toBeLessThan(200);
    expect(result.svgProfile.width).toBeGreaterThan(70);
  });
});

describe("simplifySvgProfile", () => {
  it("removes tiny shapes and decimates dense rings", () => {
    const dense: SvgProfile = {
      width: 100,
      height: 100,
      shapes: [
        {
          outer: Array.from({ length: 360 }, (_, index) => {
            const angle = (index / 360) * Math.PI * 2;
            return { x: 50 + 40 * Math.cos(angle), y: 50 + 40 * Math.sin(angle) };
          }),
          holes: [],
        },
        {
          outer: [
            { x: 0, y: 0 },
            { x: 0.1, y: 0 },
            { x: 0.1, y: 0.1 },
            { x: 0, y: 0.1 },
          ],
          holes: [],
        },
      ],
    };
    const cleaned = simplifySvgProfile(dense);
    expect(cleaned.shapes.length).toBe(1);
    expect(cleaned.shapes[0].outer.length).toBeLessThan(dense.shapes[0].outer.length);
    expect(cleaned.shapes[0].outer.length).toBeLessThanOrEqual(181);
  });
});

describe("triangle-soup solid validation", () => {
  it("accepts a closed box", () => {
    const positions = geometryPositions(new THREE.BoxGeometry(2, 3, 4));
    const analysis = validateClosedSolidTriangleSoup(positions);
    expect(analysis.volume).toBeCloseTo(24);
    expect(analysis.boundaryEdges).toBe(0);
    expect(analysis.nonManifoldEdges).toBe(0);
  });

  it("rejects an open box shell", () => {
    const positions = geometryPositions(new THREE.BoxGeometry(2, 3, 4)).slice(9);
    expect(analyzeTriangleSoup(positions).boundaryEdges).toBeGreaterThan(0);
    expect(() => validateClosedSolidTriangleSoup(positions)).toThrow(/not a watertight manifold/i);
  });

  it("rejects a topologically closed zero-volume shell", () => {
    const positions = [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 1, 0, 1, 0, 0,
    ];
    const analysis = analyzeTriangleSoup(positions);
    expect(analysis.boundaryEdges).toBe(0);
    expect(analysis.volume).toBe(0);
    expect(() => validateClosedSolidTriangleSoup(positions)).toThrow(/non-zero volume/i);
  });
});
