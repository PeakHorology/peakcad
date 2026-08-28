import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { createLocalId } from "@/lib/localIds";
import type { WorkplaneShape } from "@/types/sketchforge";

import { hardwareProfile } from "@/lib/desktopHardware";

const profile = hardwareProfile();
export const MAX_SVG_BYTES = profile.maxSvgBytes;
export const MAX_SVG_XML_ELEMENTS = profile.highEnd ? 50_000 : 10_000;
export const MAX_SVG_GEOMETRY_ELEMENTS = profile.highEnd ? 10_000 : 2_000;
export const MAX_SVG_PATH_COMMANDS = profile.highEnd ? 250_000 : 50_000;
export const MAX_SVG_TRIANGLES = profile.maxSvgTriangles;

const SVG_EXTRUSION_DEPTH = 4;
const SVG_CURVE_SEGMENTS = 12;
/** Profile sampling before simplifySvgProfile decimation. */
const SVG_PROFILE_CURVE_SEGMENTS = 20;
/** Longest on-canvas footprint edge after import (mm). */
const SVG_IMPORT_MAX_FOOTPRINT_MM = 48;

/** Millimetres per CSS absolute length unit. */
const MM_PER_SVG_UNIT: Record<string, number> = {
  mm: 1,
  cm: 10,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
};

function parsePhysicalSvgLength(value: string | null): number | null {
  if (!value) return null;
  const match = /^\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z]+)\s*$/i.exec(value);
  if (!match) return null;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return null;
  const perUnit = MM_PER_SVG_UNIT[match[2].toLowerCase()];
  return perUnit === undefined ? null : magnitude * perUnit;
}

/**
 * Millimetres per SVG user unit, from the root width/height measured against the viewBox.
 *
 * SVGLoader hands back raw user-unit coordinates, and those were used directly as millimetres. A
 * drawing saved as 100mm wide by Illustrator or Inkscape carries a px-based viewBox (about 283
 * units), so it imported ~2.8x oversized with nothing on screen indicating the scale was invented.
 *
 * Only an explicit physical width/height alongside a viewBox is treated as authoritative — that
 * pairing is the author stating "this viewBox is this many millimetres". Unitless or px sizes stay
 * at 1 unit = 1mm so files that already import at the intended size are unaffected.
 */
export function svgUserUnitToMm(root: Element): number {
  const viewBox = root.getAttribute("viewBox");
  if (!viewBox) return 1;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isFinite(part))) return 1;
  const [, , viewBoxWidth, viewBoxHeight] = parts;

  const physicalWidth = parsePhysicalSvgLength(root.getAttribute("width"));
  if (physicalWidth !== null && viewBoxWidth > 0) return physicalWidth / viewBoxWidth;
  const physicalHeight = parsePhysicalSvgLength(root.getAttribute("height"));
  if (physicalHeight !== null && viewBoxHeight > 0) return physicalHeight / viewBoxHeight;
  return 1;
}
const MIN_VISIBLE_ALPHA = 1e-6;
const svgLoader = new SVGLoader();

const SIMPLIFY_MIN_AREA_FRACTION = 0.0005;
const SIMPLIFY_RDP_TOLERANCE_FRACTION = 0.0015;
const SIMPLIFY_MAX_OUTER_POINTS = 180;
const SIMPLIFY_MAX_HOLE_POINTS = 120;

export type SvgProfilePoint = { x: number; y: number };

export type SvgProfileShape = {
  outer: SvgProfilePoint[];
  holes: SvgProfilePoint[][];
};

export type SvgProfile = {
  width: number;
  height: number;
  shapes: SvgProfileShape[];
};

type SvgPathStyle = {
  fill?: string;
  fillOpacity?: number;
  opacity?: number;
  visibility?: string;
  stroke?: string;
  strokeWidth?: number | string;
  strokeOpacity?: number;
};

type ShapePathWithUserData = THREE.ShapePath & {
  userData?: { style?: SvgPathStyle; node?: Element };
  subPaths?: Array<{ getPoints: (divisions?: number) => THREE.Vector2[] }>;
};

export type TriangleSoupAnalysis = {
  triangleCount: number;
  vertexCount: number;
  surfaceArea: number;
  volume: number;
  degenerateTriangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  width: number;
  height: number;
  depth: number;
  volumeTolerance: number;
};

type SvgRing = {
  points: THREE.Vector2[];
  area: number;
  parent: number | null;
  depth: number;
};

function sourceByteLength(source: string) {
  return new TextEncoder().encode(source).byteLength;
}

function attributeValues(source: string, name: string) {
  const values: string[] = [];
  const expression = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "gis");
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source))) values.push(match[2]);
  return values;
}

/** True when a `<use>` href can be resolved inside this file (fragment or empty). */
export function isLocalSvgUseHref(href: string) {
  const trimmed = href.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#")) return true;
  // Bare ids (no "#") from some exporters are still same-document references.
  return /^[a-zA-Z_][a-zA-Z0-9._-]*$/.test(trimmed);
}

function useElementHrefs(source: string) {
  const hrefs: string[] = [];
  const expression = /<use\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(source))) {
    const tag = match[0];
    const href = tag.match(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (href !== undefined) hrefs.push(href);
  }
  return hrefs;
}

export function validateSvgSourcePreflight(source: string) {
  if (!source.trim()) throw new Error("SVG file is empty");
  if (sourceByteLength(source) > MAX_SVG_BYTES) {
    throw new Error(`SVG is too large. The maximum supported size is ${MAX_SVG_BYTES / 1024 / 1024} MB`);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new Error("SVG document types and entities are not supported");
  }

  const xmlElementCount = source.match(/<[a-z][^!?/\s>]*/gi)?.length ?? 0;
  if (xmlElementCount > MAX_SVG_XML_ELEMENTS) {
    throw new Error(`SVG is too complex (${xmlElementCount} elements; maximum ${MAX_SVG_XML_ELEMENTS})`);
  }

  const geometryElementCount = source.match(/<(?:path|rect|polygon|polyline|circle|ellipse|line|use)\b/gi)?.length ?? 0;
  if (geometryElementCount > MAX_SVG_GEOMETRY_ELEMENTS) {
    throw new Error(`SVG has too many geometry elements (${geometryElementCount}; maximum ${MAX_SVG_GEOMETRY_ELEMENTS})`);
  }

  let pathCommandCount = 0;
  for (const pathData of attributeValues(source, "d")) {
    pathCommandCount += pathData.match(/[MmZzLlHhVvCcSsQqTtAa]/g)?.length ?? 0;
    if (pathCommandCount > MAX_SVG_PATH_COMMANDS) {
      throw new Error(`SVG has too many path commands (maximum ${MAX_SVG_PATH_COMMANDS})`);
    }
  }

  // Only `<use>` can pull external geometry. Ignore `<a href>`, `<image href>`, metadata, etc.
  // External `<use>` tags are stripped later so filled paths in the file can still import.
  const externalUseCount = useElementHrefs(source).filter((href) => !isLocalSvgUseHref(href)).length;
  if (externalUseCount > 0 && geometryElementCount <= externalUseCount) {
    throw new Error("SVG external references are not supported; embed referenced artwork in the file");
  }
}

/** Drop `<use>` tags that point outside this document so local paths can still import. */
export function stripExternalSvgUseElements(source: string) {
  return source.replace(/<use\b[^>]*\/?>/gi, (tag) => {
    const href = tag.match(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "";
    return isLocalSvgUseHref(href) ? tag : "";
  });
}

export function normalizeSvgUseReferences(source: string) {
  let normalized = stripExternalSvgUseElements(source);
  if (!/<use\b/i.test(normalized)) return normalized;

  normalized = normalized.replace(/<use\b[^>]*>/gi, (tag) => {
    if (/\bxlink:href\s*=/i.test(tag)) return tag;
    return tag.replace(/\bhref(\s*=)/i, "xlink:href$1");
  });

  if (/\bxlink:href\s*=/i.test(normalized) && !/\bxmlns:xlink\s*=/i.test(normalized)) {
    normalized = normalized.replace(/<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return normalized;
}

/** Inkscape "Inkscape SVG" often keeps helpers that confuse CAD import; Plain SVG is cleaner. */
export function normalizeInkscapeSvgSource(source: string) {
  let normalized = source;
  // Drop leftover bitmaps after Trace Bitmap so vector paths are what we import.
  if (/<(?:path|rect|polygon|polyline|circle|ellipse)\b/i.test(normalized) && /<image\b/i.test(normalized)) {
    normalized = normalized.replace(/<image\b[^>]*\/?>/gi, "");
  }
  if (/inkscape/i.test(normalized)) {
    // Unhide Inkscape layers that SVGLoader would otherwise skip.
    normalized = normalized.replace(/\bdisplay\s*:\s*none\b/gi, "display:inline");
    normalized = normalized.replace(/\bvisibility\s*:\s*hidden\b/gi, "visibility:visible");
  }
  return normalized;
}

function numericStyleValue(value: unknown, fallback = 1) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fillAlpha(fill: string | undefined) {
  const normalized = fill?.trim().toLowerCase();
  if (!normalized || normalized === "none" || normalized === "transparent") return normalized ? 0 : 1;

  const shortHexAlpha = normalized.match(/^#[0-9a-f]{3}([0-9a-f])$/i)?.[1];
  if (shortHexAlpha) return Number.parseInt(shortHexAlpha + shortHexAlpha, 16) / 255;
  const longHexAlpha = normalized.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i)?.[1];
  if (longHexAlpha) return Number.parseInt(longHexAlpha, 16) / 255;

  const functional = normalized.match(/^(?:rgba|hsla)\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/i)?.[1];
  if (!functional) return 1;
  if (functional.trim().endsWith("%")) return Number.parseFloat(functional) / 100;
  return Number.parseFloat(functional);
}

function elementStyleValue(element: Element, property: string) {
  const style = (element as Element & { style?: CSSStyleDeclaration }).style;
  const fromStyle = style?.getPropertyValue(property);
  if (fromStyle) return fromStyle;
  const camelCase = property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const direct = style?.[camelCase as keyof CSSStyleDeclaration];
  return typeof direct === "string" ? direct : element.getAttribute(property);
}

function elementOrAncestorSuppressesRendering(element: Element | null | undefined) {
  let current = element;
  while (current) {
    const display = elementStyleValue(current, "display")?.trim().toLowerCase();
    if (display === "none" || current.hasAttribute("hidden")) return true;
    const opacity = elementStyleValue(current, "opacity");
    if (opacity !== null && opacity !== undefined && numericStyleValue(opacity) <= MIN_VISIBLE_ALPHA) return true;
    current = current.parentElement;
  }
  return false;
}

function pathStyle(path: THREE.ShapePath): SvgPathStyle {
  return (path as ShapePathWithUserData).userData?.style ?? {};
}

function pathIsVisible(path: THREE.ShapePath) {
  const userData = (path as ShapePathWithUserData).userData;
  const style = userData?.style ?? {};
  const visibility = style.visibility?.trim().toLowerCase();
  if (visibility === "hidden" || visibility === "collapse") return false;
  if (numericStyleValue(style.opacity) <= MIN_VISIBLE_ALPHA) return false;
  return !elementOrAncestorSuppressesRendering(userData?.node);
}

function pathHasVisibleFill(path: THREE.ShapePath) {
  if (!pathIsVisible(path)) return false;
  const style = pathStyle(path);
  if (numericStyleValue(style.fillOpacity) <= MIN_VISIBLE_ALPHA) return false;
  return fillAlpha(style.fill) > MIN_VISIBLE_ALPHA;
}

function pathHasVisibleStroke(path: THREE.ShapePath) {
  if (!pathIsVisible(path)) return false;
  const style = pathStyle(path);
  const stroke = style.stroke?.trim().toLowerCase();
  // Unlike fill, SVG default is no stroke when the attribute is omitted.
  if (!stroke || stroke === "none" || stroke === "transparent") return false;
  if (fillAlpha(stroke) <= MIN_VISIBLE_ALPHA) return false;
  if (numericStyleValue(style.strokeOpacity) <= MIN_VISIBLE_ALPHA) return false;
  return numericStyleValue(style.strokeWidth, 1) > MIN_VISIBLE_ALPHA;
}

/** Filled logos, or stroke-only logos (common Illustrator/Figma export). */
function pathIsImportable(path: THREE.ShapePath) {
  return pathHasVisibleFill(path) || pathHasVisibleStroke(path);
}

function strokeStyleForPoints(style: SvgPathStyle) {
  return SVGLoader.getStrokeStyle(
    Math.max(0.05, numericStyleValue(style.strokeWidth, 1)),
    style.stroke?.trim() || "#000000",
  );
}

function geometryPositionsFlat(geometry: THREE.BufferGeometry) {
  const mesh = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = mesh.getAttribute("position");
  const positions: number[] = [];
  for (let index = 0; index < position.count; index += 1) {
    positions.push(position.getX(index), position.getY(index), position.getZ(index));
  }
  if (mesh !== geometry) mesh.dispose();
  return positions;
}

/** Extrude a planar (XY) triangle soup along +Z into a closed solid (caps + boundary walls only). */
function extrudePlanarTriangleSoup(positions: readonly number[], depth: number) {
  const extruded: number[] = [];
  const safeDepth = Math.max(1e-3, depth);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    maxX = Math.max(maxX, positions[index]);
    maxY = Math.max(maxY, positions[index + 1]);
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const quantum = Math.max(extent * 1e-7, 1e-9);
  const edgeCounts = new Map<string, { ax: number; ay: number; bx: number; by: number; count: number }>();
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const aKey = quantizePlanarKey(ax, ay, quantum);
    const bKey = quantizePlanarKey(bx, by, quantum);
    if (aKey === bKey) return;
    const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
    const existing = edgeCounts.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    edgeCounts.set(key, { ax, ay, bx, by, count: 1 });
  };

  for (let index = 0; index + 8 < positions.length; index += 9) {
    const ax = positions[index];
    const ay = positions[index + 1];
    const bx = positions[index + 3];
    const by = positions[index + 4];
    const cx = positions[index + 6];
    const cy = positions[index + 7];
    const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area2) <= 1e-20) continue;

    if (area2 > 0) {
      extruded.push(ax, ay, 0, cx, cy, 0, bx, by, 0);
      extruded.push(ax, ay, safeDepth, bx, by, safeDepth, cx, cy, safeDepth);
      addEdge(ax, ay, cx, cy);
      addEdge(cx, cy, bx, by);
      addEdge(bx, by, ax, ay);
    } else {
      extruded.push(ax, ay, 0, bx, by, 0, cx, cy, 0);
      extruded.push(ax, ay, safeDepth, cx, cy, safeDepth, bx, by, safeDepth);
      addEdge(ax, ay, bx, by);
      addEdge(bx, by, cx, cy);
      addEdge(cx, cy, ax, ay);
    }
  }

  for (const edge of edgeCounts.values()) {
    if (edge.count !== 1) continue;
    const { ax, ay, bx, by } = edge;
    extruded.push(ax, ay, 0, bx, by, 0, bx, by, safeDepth);
    extruded.push(ax, ay, 0, bx, by, safeDepth, ax, ay, safeDepth);
  }
  return extruded;
}

function quantizePlanarKey(x: number, y: number, quantum: number) {
  return `${Math.round(x / quantum)},${Math.round(y / quantum)}`;
}

function profileShapesFromPlanarPositions(positions: readonly number[]): SvgProfileShape[] {
  if (positions.length < 9) return [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    maxX = Math.max(maxX, positions[index]);
    maxY = Math.max(maxY, positions[index + 1]);
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const quantum = Math.max(extent * 1e-7, 1e-9);
  const edgeCounts = new Map<string, { ax: number; ay: number; bx: number; by: number; count: number }>();
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const aKey = quantizePlanarKey(ax, ay, quantum);
    const bKey = quantizePlanarKey(bx, by, quantum);
    if (aKey === bKey) return;
    const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
    const existing = edgeCounts.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    edgeCounts.set(key, { ax, ay, bx, by, count: 1 });
  };

  for (let index = 0; index + 8 < positions.length; index += 9) {
    const ax = positions[index];
    const ay = positions[index + 1];
    const bx = positions[index + 3];
    const by = positions[index + 4];
    const cx = positions[index + 6];
    const cy = positions[index + 7];
    addEdge(ax, ay, bx, by);
    addEdge(bx, by, cx, cy);
    addEdge(cx, cy, ax, ay);
  }

  const adjacency = new Map<string, Array<{ x: number; y: number; key: string }>>();
  const pointByKey = new Map<string, { x: number; y: number }>();
  for (const edge of edgeCounts.values()) {
    if (edge.count !== 1) continue;
    const aKey = quantizePlanarKey(edge.ax, edge.ay, quantum);
    const bKey = quantizePlanarKey(edge.bx, edge.by, quantum);
    if (!pointByKey.has(aKey)) pointByKey.set(aKey, { x: edge.ax, y: edge.ay });
    if (!pointByKey.has(bKey)) pointByKey.set(bKey, { x: edge.bx, y: edge.by });
    const aList = adjacency.get(aKey) ?? [];
    aList.push({ x: edge.bx, y: edge.by, key: bKey });
    adjacency.set(aKey, aList);
    const bList = adjacency.get(bKey) ?? [];
    bList.push({ x: edge.ax, y: edge.ay, key: aKey });
    adjacency.set(bKey, bList);
  }

  const used = new Set<string>();
  const rings: THREE.Vector2[][] = [];
  for (const startKey of adjacency.keys()) {
    if (used.has(startKey)) continue;
    const ring: THREE.Vector2[] = [];
    let currentKey = startKey;
    let guard = 0;
    while (guard < adjacency.size + 2) {
      const currentPoint = pointByKey.get(currentKey);
      if (!currentPoint) break;
      ring.push(new THREE.Vector2(currentPoint.x, currentPoint.y));
      used.add(currentKey);
      const neighbors = adjacency.get(currentKey);
      if (!neighbors?.length) break;
      const next = neighbors.find((candidate) => !used.has(candidate.key)) ?? neighbors[0];
      currentKey = next.key;
      guard += 1;
      if (currentKey === startKey) break;
    }
    const cleaned = cleanRingPoints(ring);
    if (cleaned.length >= 3) rings.push(cleaned);
  }

  if (!rings.length) {
    // Fallback: keep a bounding rectangle so the stroke still extrudes.
    return [{
      outer: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ],
      holes: [],
    }];
  }

  rings.sort((a, b) => Math.abs(THREE.ShapeUtils.area(b)) - Math.abs(THREE.ShapeUtils.area(a)));
  const shapes: SvgProfileShape[] = [];
  const assigned = new Set<number>();
  for (let index = 0; index < rings.length; index += 1) {
    if (assigned.has(index)) continue;
    const outer = rings[index];
    const holes: Array<Array<{ x: number; y: number }>> = [];
    for (let candidate = index + 1; candidate < rings.length; candidate += 1) {
      if (assigned.has(candidate)) continue;
      const sample = ringSamplePoint(rings[candidate]);
      if (!pointInRing(sample, outer)) continue;
      holes.push(rings[candidate].map((point) => ({ x: point.x, y: point.y })));
      assigned.add(candidate);
    }
    assigned.add(index);
    shapes.push({
      outer: outer.map((point) => ({ x: point.x, y: point.y })),
      holes,
    });
  }
  return shapes;
}

function strokePlanarGeometriesFromPath(path: THREE.ShapePath) {
  const style = strokeStyleForPoints(pathStyle(path));
  const geometries: THREE.BufferGeometry[] = [];
  const subPaths = (path as ShapePathWithUserData).subPaths ?? [];
  for (const subPath of subPaths) {
    const points = subPath.getPoints(SVG_CURVE_SEGMENTS);
    if (points.length < 2) continue;
    const geometry = SVGLoader.pointsToStroke(points, style);
    if (geometry) geometries.push(geometry);
  }
  // ShapePath created outside SVGLoader may only expose currentPath.
  if (!geometries.length && path.currentPath) {
    const points = path.currentPath.getPoints(SVG_CURVE_SEGMENTS);
    if (points.length >= 2) {
      const geometry = SVGLoader.pointsToStroke(points, style);
      if (geometry) geometries.push(geometry);
    }
  }
  return geometries;
}

function cleanRingPoints(points: THREE.Vector2[]) {
  const cleaned: THREE.Vector2[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (!cleaned.length || cleaned[cleaned.length - 1].distanceToSquared(point) > 1e-20) cleaned.push(point.clone());
  }
  if (cleaned.length > 1 && cleaned[0].distanceToSquared(cleaned[cleaned.length - 1]) <= 1e-20) cleaned.pop();
  return cleaned;
}

function ringSamplePoint(points: THREE.Vector2[]) {
  const triangles = THREE.ShapeUtils.triangulateShape(points, []);
  const triangle = triangles[0];
  if (!triangle) return points[0].clone();
  return points[triangle[0]].clone().add(points[triangle[1]]).add(points[triangle[2]]).multiplyScalar(1 / 3);
}

function pointOnSegment(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2, tolerance: number) {
  const ab = b.clone().sub(a);
  const ap = point.clone().sub(a);
  const cross = Math.abs(ab.x * ap.y - ab.y * ap.x);
  if (cross > tolerance * Math.max(1, ab.length())) return false;
  const dot = ap.dot(ab);
  return dot >= -tolerance && dot <= ab.lengthSq() + tolerance;
}

function pointInRing(point: THREE.Vector2, ring: THREE.Vector2[]) {
  let inside = false;
  const extent = ring.reduce((largest, entry) => Math.max(largest, Math.abs(entry.x), Math.abs(entry.y)), 1);
  const tolerance = extent * 1e-9;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j];
    const b = ring[i];
    if (pointOnSegment(point, a, b, tolerance)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function orientation(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function ringsIntersect(a: THREE.Vector2[], b: THREE.Vector2[]) {
  const scale = [...a, ...b].reduce((largest, point) => Math.max(largest, Math.abs(point.x), Math.abs(point.y)), 1);
  const tolerance = scale * 1e-9;
  for (let ai = 0; ai < a.length; ai += 1) {
    const a0 = a[ai];
    const a1 = a[(ai + 1) % a.length];
    for (let bi = 0; bi < b.length; bi += 1) {
      const b0 = b[bi];
      const b1 = b[(bi + 1) % b.length];
      const o1 = orientation(a0, a1, b0);
      const o2 = orientation(a0, a1, b1);
      const o3 = orientation(b0, b1, a0);
      const o4 = orientation(b0, b1, a1);
      if (((o1 > tolerance && o2 < -tolerance) || (o1 < -tolerance && o2 > tolerance)) &&
          ((o3 > tolerance && o4 < -tolerance) || (o3 < -tolerance && o4 > tolerance))) return true;
      if (Math.abs(o1) <= tolerance && pointOnSegment(b0, a0, a1, tolerance)) return true;
      if (Math.abs(o2) <= tolerance && pointOnSegment(b1, a0, a1, tolerance)) return true;
      if (Math.abs(o3) <= tolerance && pointOnSegment(a0, b0, b1, tolerance)) return true;
      if (Math.abs(o4) <= tolerance && pointOnSegment(a1, b0, b1, tolerance)) return true;
    }
  }
  return false;
}

function vectorRingToProfile(points: THREE.Vector2[]) {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function profileRingArea(ring: readonly SvgProfilePoint[]) {
  if (ring.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) * 0.5;
}

function profilePointDistanceToSegment(
  point: SvgProfilePoint,
  a: SvgProfilePoint,
  b: SvgProfilePoint,
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-18) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Ramer–Douglas–Peucker decimation for open polylines (first/last kept). */
function rdpDecimateRing(points: SvgProfilePoint[], tolerance: number): SvgProfilePoint[] {
  if (points.length <= 3 || !(tolerance > 0)) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let maxIndex = -1;
    const a = points[start];
    const b = points[end];
    for (let index = start + 1; index < end; index += 1) {
      const distance = profilePointDistanceToSegment(points[index], a, b);
      if (distance > maxDist) {
        maxDist = distance;
        maxIndex = index;
      }
    }
    if (maxIndex >= 0 && maxDist > tolerance) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function ensureClosedRing(ring: SvgProfilePoint[]) {
  if (ring.length < 3) return ring.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first.x === last.x && first.y === last.y) return ring.slice();
  return [...ring, { x: first.x, y: first.y }];
}

function openRing(ring: SvgProfilePoint[]) {
  if (ring.length < 2) return ring.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first.x === last.x && first.y === last.y) return ring.slice(0, -1);
  return ring.slice();
}

function capRingPointCount(ring: SvgProfilePoint[], maxPoints: number) {
  const open = openRing(ring);
  if (open.length <= maxPoints) return ensureClosedRing(open);
  const step = open.length / maxPoints;
  const capped: SvgProfilePoint[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    capped.push(open[Math.min(open.length - 1, Math.floor(index * step))]);
  }
  // Always keep the true last open point so the close edge stays accurate.
  capped[capped.length - 1] = open[open.length - 1];
  return ensureClosedRing(capped);
}

function simplifyProfileRing(ring: SvgProfilePoint[], tolerance: number, maxPoints: number) {
  const open = openRing(ring);
  if (open.length < 3) return null;
  const closedForSimplify = [...open, { x: open[0].x, y: open[0].y }];
  const decimated = openRing(rdpDecimateRing(closedForSimplify, tolerance));
  if (decimated.length < 3) return null;
  return capRingPointCount(decimated, maxPoints);
}

function profileBounds(shapes: readonly SvgProfileShape[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const shape of shapes) {
    for (const point of shape.outer) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Drop micro-features and decimate outlines so import meshes stay clean.
 * Safe to call repeatedly; returns a new profile object.
 */
export function simplifySvgProfile(profile: SvgProfile): SvgProfile {
  if (!profile.shapes.length) return profile;
  const bounds = profileBounds(profile.shapes);
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)) {
    return profile;
  }
  const width = Math.max(1e-6, bounds.maxX - bounds.minX);
  const height = Math.max(1e-6, bounds.maxY - bounds.minY);
  const diagonal = Math.hypot(width, height);
  const minArea = width * height * SIMPLIFY_MIN_AREA_FRACTION;
  const tolerance = Math.max(1e-6, diagonal * SIMPLIFY_RDP_TOLERANCE_FRACTION);

  const shapes: SvgProfileShape[] = [];
  for (const shape of profile.shapes) {
    if (profileRingArea(shape.outer) < minArea) continue;
    const outer = simplifyProfileRing(shape.outer, tolerance, SIMPLIFY_MAX_OUTER_POINTS);
    if (!outer || profileRingArea(outer) < minArea) continue;
    const holes = shape.holes
      .filter((hole) => profileRingArea(hole) >= minArea)
      .map((hole) => simplifyProfileRing(hole, tolerance, SIMPLIFY_MAX_HOLE_POINTS))
      .filter((hole): hole is SvgProfilePoint[] => hole !== null && profileRingArea(hole) >= minArea * 0.25);
    shapes.push({ outer, holes });
  }

  if (!shapes.length) {
    // Fall back to the original profile if cleanup removed everything.
    return {
      width,
      height,
      shapes: profile.shapes.map((shape) => ({
        outer: shape.outer.map((point) => ({ ...point })),
        holes: shape.holes.map((hole) => hole.map((point) => ({ ...point }))),
      })),
    };
  }

  const nextBounds = profileBounds(shapes);
  return {
    width: Math.max(1e-6, nextBounds.maxX - nextBounds.minX),
    height: Math.max(1e-6, nextBounds.maxY - nextBounds.minY),
    shapes,
  };
}

function profileShapeToThreeShape(shape: SvgProfileShape) {
  const outer = openRing(shape.outer).map((point) => new THREE.Vector2(point.x, point.y));
  if (outer.length < 3) return null;
  const threeShape = new THREE.Shape(outer);
  threeShape.autoClose = true;
  for (const hole of shape.holes) {
    const holePoints = openRing(hole).map((point) => new THREE.Vector2(point.x, point.y));
    if (holePoints.length < 3) continue;
    const path = new THREE.Path(holePoints);
    path.autoClose = true;
    threeShape.holes.push(path);
  }
  return threeShape;
}

function shapeToSvgProfileShape(shape: THREE.Shape, curveSegments: number): SvgProfileShape | null {
  const extracted = shape.extractPoints(curveSegments);
  const outer = cleanRingPoints(extracted.shape);
  if (outer.length < 3) return null;
  const holes = extracted.holes
    .map((hole) => cleanRingPoints(hole))
    .filter((hole) => hole.length >= 3)
    .map(vectorRingToProfile);
  return { outer: vectorRingToProfile(outer), holes };
}

function svgProfileFromShapes(shapes: readonly THREE.Shape[], curveSegments = SVG_PROFILE_CURVE_SEGMENTS): SvgProfile {
  const profileShapes: SvgProfileShape[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const shape of shapes) {
    const profileShape = shapeToSvgProfileShape(shape, curveSegments);
    if (!profileShape) continue;
    profileShapes.push(profileShape);
    for (const point of profileShape.outer) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!profileShapes.length || ![minX, minY, maxX, maxY].every(Number.isFinite)) {
    throw new Error("SVG has no readable filled paths");
  }
  return {
    width: Math.max(1e-6, maxX - minX),
    height: Math.max(1e-6, maxY - minY),
    shapes: profileShapes,
  };
}

function composeNestedRings(shapes: THREE.Shape[]) {
  const rings: SvgRing[] = [];
  for (const shape of shapes) {
    const extracted = shape.extractPoints(SVG_CURVE_SEGMENTS);
    for (const rawPoints of [extracted.shape, ...extracted.holes]) {
      const points = cleanRingPoints(rawPoints);
      if (points.length < 3) continue;
      const area = Math.abs(THREE.ShapeUtils.area(points));
      const extent = points.reduce((largest, point) => Math.max(largest, Math.abs(point.x), Math.abs(point.y)), 1);
      if (!Number.isFinite(area) || area <= (extent * 1e-9) ** 2) {
        continue;
      }
      rings.push({ points, area, parent: null, depth: 0 });
    }
  }

  if (!rings.length) throw new Error("SVG has no readable filled paths");
  rings.sort((a, b) => b.area - a.area);

  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    const sample = ringSamplePoint(ring.points);
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      const possibleParent = rings[candidate];
      if (possibleParent.area <= ring.area || !pointInRing(sample, possibleParent.points)) continue;
      if (ringsIntersect(ring.points, possibleParent.points)) continue;
      if (ring.parent === null || possibleParent.area < rings[ring.parent].area) ring.parent = candidate;
    }
    ring.depth = ring.parent === null ? 0 : rings[ring.parent].depth + 1;
  }

  const composed: THREE.Shape[] = [];
  const shapeByRing = new Map<number, THREE.Shape>();
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    if (ring.depth % 2 !== 0) continue;
    const shape = new THREE.Shape(ring.points);
    shape.autoClose = true;
    composed.push(shape);
    shapeByRing.set(index, shape);
  }
  for (let index = 0; index < rings.length; index += 1) {
    const ring = rings[index];
    if (ring.depth % 2 === 0 || ring.parent === null) continue;
    let solidParent: number | null = ring.parent;
    while (solidParent !== null && rings[solidParent].depth % 2 !== 0) solidParent = rings[solidParent].parent;
    const shape = solidParent === null ? undefined : shapeByRing.get(solidParent);
    if (!shape) continue;
    const hole = new THREE.Path(ring.points);
    hole.autoClose = true;
    shape.holes.push(hole);
  }
  return composed;
}

function edgeKey(a: number, b: number) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function analyzeTriangleSoup(positions: readonly number[]): TriangleSoupAnalysis {
  if (positions.length < 9 || positions.length % 9 !== 0) {
    throw new Error("Mesh does not contain complete triangles");
  }
  if (positions.some((value) => !Number.isFinite(value))) throw new Error("Mesh contains non-finite coordinates");

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    minZ = Math.min(minZ, positions[index + 2]);
    maxX = Math.max(maxX, positions[index]);
    maxY = Math.max(maxY, positions[index + 1]);
    maxZ = Math.max(maxZ, positions[index + 2]);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const depth = maxZ - minZ;
  const largestDimension = Math.max(width, height, depth);
  const quantization = Math.max(largestDimension * 1e-7, 1e-9);
  const areaTolerance = quantization * quantization;
  const volumeTolerance = Math.max(width * height * depth * 1e-9, quantization ** 3);

  const vertexIds = new Map<string, number>();
  const parent: number[] = [];
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const idForVertex = (x: number, y: number, z: number) => {
    const key = `${Math.round(x / quantization)},${Math.round(y / quantization)},${Math.round(z / quantization)}`;
    const existing = vertexIds.get(key);
    if (existing !== undefined) return existing;
    const id = vertexIds.size;
    vertexIds.set(key, id);
    parent.push(id);
    return id;
  };

  const edges = new Map<string, number>();
  const triangleComponents: Array<{ vertex: number; signedVolume: number }> = [];
  let surfaceArea = 0;
  let degenerateTriangles = 0;

  for (let index = 0; index < positions.length; index += 9) {
    const ax = positions[index];
    const ay = positions[index + 1];
    const az = positions[index + 2];
    const bx = positions[index + 3];
    const by = positions[index + 4];
    const bz = positions[index + 5];
    const cx = positions[index + 6];
    const cy = positions[index + 7];
    const cz = positions[index + 8];
    const a = idForVertex(ax, ay, az);
    const b = idForVertex(bx, by, bz);
    const c = idForVertex(cx, cy, cz);
    union(a, b);
    union(b, c);

    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    const crossX = aby * acz - abz * acy;
    const crossY = abz * acx - abx * acz;
    const crossZ = abx * acy - aby * acx;
    const area = Math.hypot(crossX, crossY, crossZ) / 2;
    if (a === b || b === c || c === a || area <= areaTolerance) degenerateTriangles += 1;
    surfaceArea += area;

    edges.set(edgeKey(a, b), (edges.get(edgeKey(a, b)) ?? 0) + 1);
    edges.set(edgeKey(b, c), (edges.get(edgeKey(b, c)) ?? 0) + 1);
    edges.set(edgeKey(c, a), (edges.get(edgeKey(c, a)) ?? 0) + 1);
    const signedVolume = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    triangleComponents.push({ vertex: a, signedVolume });
  }

  const componentVolumes = new Map<number, number>();
  for (const triangle of triangleComponents) {
    const root = find(triangle.vertex);
    componentVolumes.set(root, (componentVolumes.get(root) ?? 0) + triangle.signedVolume);
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edges.values()) {
    if (count === 1) boundaryEdges += 1;
    else if (count !== 2) nonManifoldEdges += 1;
  }

  return {
    triangleCount: positions.length / 9,
    vertexCount: vertexIds.size,
    surfaceArea,
    volume: [...componentVolumes.values()].reduce((total, value) => total + Math.abs(value), 0),
    degenerateTriangles,
    boundaryEdges,
    nonManifoldEdges,
    width,
    height,
    depth,
    volumeTolerance,
  };
}

export function validateClosedSolidTriangleSoup(positions: readonly number[], label = "SVG") {
  const analysis = analyzeTriangleSoup(positions);
  if (analysis.triangleCount > MAX_SVG_TRIANGLES) {
    throw new Error(`${label} is too complex (${analysis.triangleCount} triangles; maximum ${MAX_SVG_TRIANGLES})`);
  }
  if (analysis.degenerateTriangles > 0) {
    throw new Error(`${label} contains ${analysis.degenerateTriangles} zero-area triangle${analysis.degenerateTriangles === 1 ? "" : "s"}`);
  }
  if (analysis.boundaryEdges > 0 || analysis.nonManifoldEdges > 0) {
    throw new Error(`${label} is not a watertight manifold (${analysis.boundaryEdges} open edge${analysis.boundaryEdges === 1 ? "" : "s"}, ${analysis.nonManifoldEdges} non-manifold edge${analysis.nonManifoldEdges === 1 ? "" : "s"})`);
  }
  if (analysis.width <= 0 || analysis.height <= 0 || analysis.depth <= 0 || analysis.surfaceArea <= 0 || analysis.volume <= analysis.volumeTolerance) {
    throw new Error(`${label} does not enclose a non-zero volume`);
  }
  return analysis;
}

function appendValidatedSolid(
  candidatePositions: number[],
  rawPositions: number[],
  acceptedAnalyses: TriangleSoupAnalysis[],
) {
  let candidateAnalysis: TriangleSoupAnalysis | null = null;
  try {
    candidateAnalysis = validateClosedSolidTriangleSoup(candidatePositions);
  } catch {
    candidateAnalysis = null;
  }
  if (candidateAnalysis && rawPositions.length / 9 + candidateAnalysis.triangleCount > MAX_SVG_TRIANGLES) {
    throw new Error(`SVG is too complex (maximum ${MAX_SVG_TRIANGLES} triangles)`);
  }
  if (candidateAnalysis) {
    rawPositions.push(...candidatePositions);
    acceptedAnalyses.push(candidateAnalysis);
    return true;
  }
  return false;
}

export function svgContainsEmbeddedRaster(source: string) {
  if (!/<image\b/i.test(source)) return false;
  return (
    /(?:xlink:)?href\s*=\s*["']data:image\//i.test(source)
    || /(?:xlink:)?href\s*=\s*["'][^"']+\.(?:png|jpe?g|webp|gif)(?:\?[^"']*)?["']/i.test(source)
  );
}

/** Explain why a Canva / design-tool SVG couldn't become CAD geometry. */
export function describeSvgImportFailure(source: string, paths: readonly THREE.ShapePath[]) {
  const hasEmbeddedRaster = svgContainsEmbeddedRaster(source) || /<image\b/i.test(source);
  const looksLikeCanva = /canva/i.test(source);
  const vectorTagCount = source.match(/<(?:path|rect|polygon|polyline|circle|ellipse)\b/gi)?.length ?? 0;
  const textCount = source.match(/<text\b/gi)?.length ?? 0;
  const importableCount = paths.filter(pathIsImportable).length;

  if (hasEmbeddedRaster && (vectorTagCount === 0 || importableCount === 0)) {
    const inkscapeTip = " Recommended action: Use Inkscape to convert your PNG into a usable SVG.";
    return looksLikeCanva
      ? `This Canva SVG is an image wrapper, not real vector paths. Canva often embeds a PNG/JPG inside the .svg file.${inkscapeTip}`
      : `This SVG embeds a raster image (PNG/JPG) instead of vector paths. PeakCAD needs real fills/strokes.${inkscapeTip}`;
  }
  if (textCount > 0 && vectorTagCount === 0 && importableCount === 0) {
    return "This SVG only contains text objects. Convert text to outlines/paths in your design tool, then export SVG again.";
  }
  if (paths.length === 0 && vectorTagCount === 0) {
    return "This SVG has no vector shapes to extrude. Files from Canva frequently look like SVG but only contain a flat image.";
  }
  if (paths.length === 0 && vectorTagCount > 0) {
    return "SVG path data was found but could not be read. In Inkscape use File → Save As → Plain SVG (not Inkscape SVG), then import again.";
  }
  if (/inkscape/i.test(source) && importableCount === 0) {
    return "Inkscape SVG had no usable filled/stroked paths. Save as Plain SVG (File → Save As → Plain SVG), ensure the logo has a solid fill, and try again.";
  }
  return "SVG has no readable visible filled or stroked paths. Use a vector logo with fills or strokes (not an embedded image), and convert text to outlines.";
}

export function buildSvgExtrusionFromPaths(paths: readonly THREE.ShapePath[], sourceForDiagnostics?: string) {
  const importablePaths = paths.filter(pathIsImportable);
  if (!importablePaths.length) {
    throw new Error(describeSvgImportFailure(sourceForDiagnostics ?? "", paths));
  }

  const filledPaths = importablePaths.filter(pathHasVisibleFill);
  const strokeOnlyPaths = importablePaths.filter((path) => !pathHasVisibleFill(path) && pathHasVisibleStroke(path));

  const sourceShapes = filledPaths.flatMap((path) => SVGLoader.createShapes(path));
  const shapes = sourceShapes.length ? composeNestedRings(sourceShapes) : [];
  let profileShapes: SvgProfileShape[] = shapes.length ? svgProfileFromShapes(shapes).shapes : [];

  for (const path of strokeOnlyPaths) {
    const strokeGeometries = strokePlanarGeometriesFromPath(path);
    for (const strokeGeometry of strokeGeometries) {
      const planar = geometryPositionsFlat(strokeGeometry);
      strokeGeometry.dispose();
      profileShapes.push(...profileShapesFromPlanarPositions(planar));
    }
  }

  if (!profileShapes.length) {
    throw new Error(describeSvgImportFailure(sourceForDiagnostics ?? "", paths));
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const shape of profileShapes) {
    for (const point of shape.outer) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  const svgProfile = simplifySvgProfile({
    width: Math.max(1e-6, maxX - minX),
    height: Math.max(1e-6, maxY - minY),
    shapes: profileShapes,
  });

  const extrudeShapes = svgProfile.shapes
    .map(profileShapeToThreeShape)
    .filter((shape): shape is THREE.Shape => Boolean(shape));
  if (!extrudeShapes.length) {
    throw new Error("SVG has no readable filled or stroked contours that can be converted into a solid");
  }

  const rawPositions: number[] = [];
  const acceptedAnalyses: TriangleSoupAnalysis[] = [];
  let droppedContours = 0;

  for (const shape of extrudeShapes) {
    const rawGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: SVG_EXTRUSION_DEPTH,
      bevelEnabled: false,
      curveSegments: SVG_CURVE_SEGMENTS,
      steps: 1,
    });
    rawGeometry.rotateX(-Math.PI / 2);
    const geometry = rawGeometry.index ? rawGeometry.toNonIndexed() : rawGeometry;
    const candidatePositions = geometryPositionsFlat(geometry);
    try {
      if (!appendValidatedSolid(candidatePositions, rawPositions, acceptedAnalyses)) droppedContours += 1;
    } finally {
      if (geometry !== rawGeometry) geometry.dispose();
      rawGeometry.dispose();
    }
  }

  if (!rawPositions.length) {
    throw new Error("SVG has no filled or stroked contours that can be converted into a solid");
  }

  const combinedAnalysis = analyzeTriangleSoup(rawPositions);
  const analysis: TriangleSoupAnalysis = {
    ...combinedAnalysis,
    surfaceArea: acceptedAnalyses.reduce((total, entry) => total + entry.surfaceArea, 0),
    volume: acceptedAnalyses.reduce((total, entry) => total + entry.volume, 0),
    degenerateTriangles: 0,
    boundaryEdges: 0,
    nonManifoldEdges: 0,
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(rawPositions, 3));
  geometry.computeVertexNormals();
  const normal = geometry.getAttribute("normal");
  const rawNormals: number[] = [];
  for (let index = 0; index < normal.count; index += 1) rawNormals.push(normal.getX(index), normal.getY(index), normal.getZ(index));
  geometry.dispose();
  return {
    rawPositions,
    rawNormals,
    analysis,
    svgProfile,
    droppedContours,
    contourCount: extrudeShapes.length,
  };
}

/**
 * Import an SVG as an extruded solid.
 *
 * `onWarning` reports contours that were parsed but could not be closed into a watertight solid.
 * Those were dropped silently, so a logo could come in missing letters with nothing to say so.
 */
export function importedShapeFromSvg(
  fileName: string,
  source: string,
  onWarning?: (message: string) => void,
): WorkplaneShape {
  validateSvgSourcePreflight(source);
  const normalizedSource = normalizeSvgUseReferences(normalizeInkscapeSvgSource(source));
  // Fail fast with a clear Canva/raster message before asking the path extruder to guess.
  if (svgContainsEmbeddedRaster(normalizedSource)) {
    const vectorTagCount = normalizedSource.match(/<(?:path|rect|polygon|polyline|circle|ellipse)\b/gi)?.length ?? 0;
    if (vectorTagCount === 0) {
      throw new Error(describeSvgImportFailure(normalizedSource, []));
    }
  }
  let parsed: ReturnType<SVGLoader["parse"]>;
  try {
    parsed = svgLoader.parse(normalizedSource);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not parse SVG: ${error.message}. If this is from Inkscape, save as Plain SVG and try again.`
        : "Could not parse SVG. If this is from Inkscape, save as Plain SVG and try again.",
    );
  }
  const parsedXml = parsed.xml as unknown as XMLDocument | Element;
  const root = "documentElement" in parsedXml ? parsedXml.documentElement : parsedXml;
  if (root.localName !== "svg" || root.querySelector("parsererror")) {
    throw new Error("SVG is not valid XML");
  }
  const { rawPositions, rawNormals, analysis, droppedContours, contourCount } = buildSvgExtrusionFromPaths(
    parsed.paths,
    normalizedSource,
  );
  if (droppedContours > 0) {
    onWarning?.(
      `${droppedContours} of ${contourCount} contour${contourCount === 1 ? "" : "s"} could not be closed into a solid and were left out of the import — check the result against your artwork`,
    );
  }
  const unitScale = svgUserUnitToMm(root);
  const footprint = Math.max(analysis.width, analysis.depth) * unitScale;
  // Folded into fitScale so every downstream coordinate and dimension picks it up at once.
  const fitScale = (footprint > SVG_IMPORT_MAX_FOOTPRINT_MM ? SVG_IMPORT_MAX_FOOTPRINT_MM / footprint : 1) * unitScale;
  const fittedWidth = analysis.width * fitScale;
  const fittedDepth = analysis.depth * fitScale;
  const fittedHeight = analysis.height; // extrusion depth stays in mm as authored
  const centerX = fittedWidth / 2;
  const centerZ = fittedDepth / 2;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  for (let index = 0; index < rawPositions.length; index += 3) {
    minX = Math.min(minX, rawPositions[index] * fitScale);
    minY = Math.min(minY, rawPositions[index + 1]);
    minZ = Math.min(minZ, rawPositions[index + 2] * fitScale);
  }

  const positions: number[] = [];
  for (let index = 0; index < rawPositions.length; index += 3) {
    positions.push(
      rawPositions[index] * fitScale - minX - centerX,
      rawPositions[index + 1] - minY,
      rawPositions[index + 2] * fitScale - minZ - centerZ,
    );
  }

  return {
    id: createLocalId("uploaded-svg"),
    name: fileName.replace(/\.[^.]+$/, "") || "Imported SVG",
    kind: "mesh",
    color: "#0098c7",
    x: 10,
    z: -10,
    size: Math.max(fittedWidth, fittedDepth),
    width: fittedWidth,
    depth: fittedDepth,
    height: fittedHeight,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions,
      normals: rawNormals,
      baseWidth: fittedWidth,
      baseDepth: fittedDepth,
      baseHeight: fittedHeight,
      triangleCount: analysis.triangleCount,
      sourceFormat: "svg",
    },
    locked: false,
    hidden: false,
  };
}

export function invalidSvgMeshReason(shape: WorkplaneShape) {
  if (shape.importedMesh?.sourceFormat !== "svg") return null;
  try {
    validateClosedSolidTriangleSoup(shape.importedMesh.positions, `SVG mesh "${shape.name}"`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `SVG mesh "${shape.name}" is invalid`;
  }
}
