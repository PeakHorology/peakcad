import { jsPDF } from "jspdf";
import { hardwareProfile } from "@/lib/desktopHardware";
import { renderMeshViewPng, collectHiddenLineRemovedEdges, projectMeshView } from "@/lib/blueprintIsoRender";
import { formatMeasurementNumber, lengthDisplayUnit, millimetersToDisplay } from "@/lib/measurementUnits";
import type { MeasurementAccuracy, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

export type BlueprintVec3 = [number, number, number];

export type BlueprintMeshPart = {
  name: string;
  kind: string;
  vertices: BlueprintVec3[];
  faces: [number, number, number][];
  width: number;
  depth: number;
  height: number;
  elevation: number;
  x: number;
  z: number;
  /** Regular polygon / pyramid side count when known. */
  sides?: number;
  /** Triangle/roof base angles (degrees from horizontal). */
  leftAngle?: number;
  rightAngle?: number;
  /** Cone ring radii (mm) when known from the solid definition. */
  topRadius?: number;
  baseRadius?: number;
  /** Workplane solid color (CSS hex/rgb) for shaded isometric. */
  color?: string;
};

export type BlueprintPartFrame = Pick<BlueprintMeshPart, "width" | "depth" | "height" | "elevation" | "x" | "z">;

export type BlueprintExportInput = {
  projectName: string;
  parts: BlueprintMeshPart[];
  workspace: Pick<WorkplaneWorkspaceSettings, "units" | "scale" | "accuracy">;
};

export type BlueprintExportFormat = "pdf" | "dxf" | "svg";

export const BLUEPRINT_FORMAT_OPTIONS: ReadonlyArray<{
  id: BlueprintExportFormat;
  label: string;
  description: string;
}> = [
  { id: "pdf", label: "PDF", description: "Printable multi-view sheet drawing" },
  { id: "dxf", label: "DXF", description: "2D vector for CAM, laser, and waterjet" },
  { id: "svg", label: "SVG", description: "Vector preview and easy handoff" },
];

export const BLUEPRINT_FORMATS_STORAGE_KEY = "peakcad:blueprintFormats";
export const DEFAULT_BLUEPRINT_FORMATS: BlueprintExportFormat[] = ["pdf"];

export function loadBlueprintFormats(): BlueprintExportFormat[] {
  if (typeof window === "undefined") {
    return [...DEFAULT_BLUEPRINT_FORMATS];
  }
  try {
    const raw = window.localStorage.getItem(BLUEPRINT_FORMATS_STORAGE_KEY);
    if (!raw) {
      return [...DEFAULT_BLUEPRINT_FORMATS];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_BLUEPRINT_FORMATS];
    }
    const allowed = new Set(BLUEPRINT_FORMAT_OPTIONS.map((option) => option.id));
    const formats = parsed.filter((value): value is BlueprintExportFormat => typeof value === "string" && allowed.has(value as BlueprintExportFormat));
    return formats.length > 0 ? formats : [...DEFAULT_BLUEPRINT_FORMATS];
  } catch {
    return [...DEFAULT_BLUEPRINT_FORMATS];
  }
}

export function saveBlueprintFormats(formats: BlueprintExportFormat[]) {
  if (typeof window === "undefined") {
    return;
  }
  const allowed = new Set(BLUEPRINT_FORMAT_OPTIONS.map((option) => option.id));
  const next = formats.filter((format) => allowed.has(format));
  try {
    window.localStorage.setItem(BLUEPRINT_FORMATS_STORAGE_KEY, JSON.stringify(next.length > 0 ? next : DEFAULT_BLUEPRINT_FORMATS));
  } catch {
    // Preference is best-effort.
  }
}

type ViewKind = "top" | "front" | "right" | "left" | "bottom" | "iso";

type Point2 = { x: number; y: number };

type Bounds2 = { minX: number; maxX: number; minY: number; maxY: number };

type Bounds3 = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type BlueprintLayer =
  | "BORDER"
  | "HEADER"
  | "TOP"
  | "FRONT"
  | "RIGHT"
  | "LEFT"
  | "BOTTOM"
  | "ISO"
  | "DIMS"
  | "TITLE"
  | "TABLE";

type BlueprintColorRole = "ink" | "accent" | "grid" | "panel";

export type BlueprintLine = {
  kind: "line";
  layer: BlueprintLayer;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  strokeWidth: number;
  color: BlueprintColorRole;
  /** When true, PDF/SVG skip this segment (used for DXF iso outlines under a shaded image). */
  dxfOnly?: boolean;
};

export type BlueprintRect = {
  kind: "rect";
  layer: BlueprintLayer;
  x: number;
  y: number;
  w: number;
  h: number;
  strokeWidth: number;
  color: BlueprintColorRole;
  fill?: BlueprintColorRole | "white";
  radius?: number;
};

export type BlueprintText = {
  kind: "text";
  layer: BlueprintLayer;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  baseline?: "alphabetic" | "middle";
  color: BlueprintColorRole;
};

export type BlueprintImage = {
  kind: "image";
  layer: BlueprintLayer;
  x: number;
  y: number;
  w: number;
  h: number;
  /** PNG data URL for PDF/SVG embedding. */
  dataUrl: string;
};

export type BlueprintPrimitive = BlueprintLine | BlueprintRect | BlueprintText | BlueprintImage;

export type BlueprintDrawing = {
  pageW: number;
  pageH: number;
  primitives: BlueprintPrimitive[];
};

const MAX_EDGES_PER_PART = hardwareProfile().maxEdgesPerPart;
/** Keep edges where adjacent face normals differ by at least this many degrees. */
const SHARP_EDGE_DEGREES = 28;
const SHARP_EDGE_DOT = Math.cos((SHARP_EDGE_DEGREES * Math.PI) / 180);
const POSITION_QUANT = 1e4;
const INK = { r: 18, g: 58, b: 86 };
const ACCENT = { r: 7, g: 155, b: 198 };
const GRID = { r: 210, g: 222, b: 230 };
const PANEL_FILL = { r: 248, g: 251, b: 252 };
const A3_LANDSCAPE = { w: 420, h: 297 };

const COLOR_RGB: Record<BlueprintColorRole | "white", { r: number; g: number; b: number }> = {
  ink: INK,
  accent: ACCENT,
  grid: GRID,
  panel: PANEL_FILL,
  white: { r: 255, g: 255, b: 255 },
};

function viewLayer(view: ViewKind): BlueprintLayer {
  switch (view) {
    case "top":
      return "TOP";
    case "front":
      return "FRONT";
    case "right":
      return "RIGHT";
    case "left":
      return "LEFT";
    case "bottom":
      return "BOTTOM";
    case "iso":
      return "ISO";
  }
}

export function blueprintPartFrame(vertices: BlueprintVec3[], fallback: BlueprintPartFrame): BlueprintPartFrame {
  if (vertices.length === 0) {
    return fallback;
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const [x, y, z] of vertices) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) {
    return fallback;
  }
  return {
    width: maxX - minX,
    depth: maxZ - minZ,
    height: maxY - minY,
    elevation: minY,
    x: (minX + maxX) / 2,
    z: (minZ + maxZ) / 2,
  };
}

function projectPoint(view: ViewKind, [x, y, z]: BlueprintVec3): Point2 {
  switch (view) {
    case "top":
      return { x, y: -z };
    case "bottom":
      return { x, y: z };
    case "front":
      return { x, y };
    case "right":
      return { x: z, y };
    case "left":
      return { x: -z, y };
    case "iso": {
      const angle = Math.PI / 6;
      return {
        x: (x - z) * Math.cos(angle),
        y: y + (x + z) * Math.sin(angle),
      };
    }
  }
}

/** Camera look direction into the scene for silhouette tests. */
function viewDirection(view: ViewKind): BlueprintVec3 {
  switch (view) {
    case "top":
      return [0, -1, 0];
    case "bottom":
      return [0, 1, 0];
    case "front":
      return [0, 0, -1];
    case "right":
      return [-1, 0, 0];
    case "left":
      return [1, 0, 0];
    case "iso": {
      const s = 1 / Math.sqrt(3);
      return [-s, -s, -s];
    }
  }
}

function quantizePosition([x, y, z]: BlueprintVec3) {
  return `${Math.round(x * POSITION_QUANT)}|${Math.round(y * POSITION_QUANT)}|${Math.round(z * POSITION_QUANT)}`;
}

function subtract(a: BlueprintVec3, b: BlueprintVec3): BlueprintVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: BlueprintVec3, b: BlueprintVec3): BlueprintVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: BlueprintVec3, b: BlueprintVec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: BlueprintVec3): BlueprintVec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) {
    return null;
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

function faceNormal(a: BlueprintVec3, b: BlueprintVec3, c: BlueprintVec3): BlueprintVec3 | null {
  return normalize(cross(subtract(b, a), subtract(c, a)));
}

function aabbWireframe(part: BlueprintMeshPart): Array<[BlueprintVec3, BlueprintVec3]> {
  const halfW = part.width / 2;
  const halfD = part.depth / 2;
  const y0 = part.elevation;
  const y1 = part.elevation + part.height;
  const corners: BlueprintVec3[] = [
    [part.x - halfW, y0, part.z - halfD],
    [part.x + halfW, y0, part.z - halfD],
    [part.x + halfW, y0, part.z + halfD],
    [part.x - halfW, y0, part.z + halfD],
    [part.x - halfW, y1, part.z - halfD],
    [part.x + halfW, y1, part.z - halfD],
    [part.x + halfW, y1, part.z + halfD],
    [part.x - halfW, y1, part.z + halfD],
  ];
  const pairs: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.map(([a, b]) => [corners[a], corners[b]]);
}

function emptyBounds2(): Bounds2 {
  return {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
}

function expandBounds2(bounds: Bounds2, point: Point2) {
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.maxY = Math.max(bounds.maxY, point.y);
}

function bounds3FromParts(parts: BlueprintMeshPart[]): Bounds3 {
  const bounds: Bounds3 = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };

  for (const part of parts) {
    if (part.vertices.length === 0) {
      bounds.minX = Math.min(bounds.minX, part.x - part.width / 2);
      bounds.maxX = Math.max(bounds.maxX, part.x + part.width / 2);
      bounds.minY = Math.min(bounds.minY, part.elevation);
      bounds.maxY = Math.max(bounds.maxY, part.elevation + part.height);
      bounds.minZ = Math.min(bounds.minZ, part.z - part.depth / 2);
      bounds.maxZ = Math.max(bounds.maxZ, part.z + part.depth / 2);
      continue;
    }
    for (const [x, y, z] of part.vertices) {
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.minZ = Math.min(bounds.minZ, z);
      bounds.maxZ = Math.max(bounds.maxZ, z);
    }
  }

  if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY, bounds.minZ, bounds.maxZ].every(Number.isFinite)) {
    return { minX: -10, maxX: 10, minY: 0, maxY: 20, minZ: -10, maxZ: 10 };
  }
  return bounds;
}

type WeldedMesh = {
  vertices: BlueprintVec3[];
  faces: Array<[number, number, number]>;
};

function weldMesh(part: BlueprintMeshPart): WeldedMesh | null {
  if (part.faces.length === 0 || part.vertices.length < 2) {
    return null;
  }
  const indexByKey = new Map<string, number>();
  const vertices: BlueprintVec3[] = [];
  const remap = (vertex: BlueprintVec3) => {
    const key = quantizePosition(vertex);
    const existing = indexByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const next = vertices.length;
    indexByKey.set(key, next);
    vertices.push(vertex);
    return next;
  };

  const faces: Array<[number, number, number]> = [];
  for (const [ia, ib, ic] of part.faces) {
    const va = part.vertices[ia];
    const vb = part.vertices[ib];
    const vc = part.vertices[ic];
    if (!va || !vb || !vc) {
      continue;
    }
    const a = remap(va);
    const b = remap(vb);
    const c = remap(vc);
    if (a === b || b === c || c === a) {
      continue;
    }
    faces.push([a, b, c]);
  }
  if (faces.length === 0 || vertices.length < 2) {
    return null;
  }
  return { vertices, faces };
}

type EdgeRecord = {
  a: number;
  b: number;
  normals: BlueprintVec3[];
  /** Faces incident on this edge (for projected silhouette tests). */
  tris: Array<[number, number, number]>;
};

function meshCentroid(vertices: BlueprintVec3[]): BlueprintVec3 {
  if (vertices.length === 0) {
    return [0, 0, 0];
  }
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const [x, y, z] of vertices) {
    sx += x;
    sy += y;
    sz += z;
  }
  const n = vertices.length;
  return [sx / n, sy / n, sz / n];
}

/** Prefer geometric outward normals so CSG winding flips do not hide silhouettes. */
function outwardFaceNormal(a: BlueprintVec3, b: BlueprintVec3, c: BlueprintVec3, center: BlueprintVec3): BlueprintVec3 | null {
  const normal = faceNormal(a, b, c);
  if (!normal) {
    return null;
  }
  const faceCenter: BlueprintVec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  if (dot(normal, subtract(faceCenter, center)) < 0) {
    return [-normal[0], -normal[1], -normal[2]];
  }
  return normal;
}

function projectedSignedArea(view: ViewKind, a: BlueprintVec3, b: BlueprintVec3, c: BlueprintVec3) {
  const pa = projectPoint(view, a);
  const pb = projectPoint(view, b);
  const pc = projectPoint(view, c);
  return (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
}

/**
 * Explicit taper for elevation profiles. Mesh-inferred tapers are ignored — embossed
 * discs and incomplete remeshes invent fake chamfers when radii are sampled from vertices.
 */
function elevationTaperRadii(part: BlueprintMeshPart): { top: number; bottom: number } | null {
  if (typeof part.topRadius === "number" && typeof part.baseRadius === "number") {
    const top = Math.max(0, part.topRadius);
    const bottom = Math.max(0, part.baseRadius);
    if (Math.abs(top - bottom) > 0.05) {
      return { top, bottom };
    }
    return null;
  }
  if (part.kind === "cone") {
    const profile = inferRevolutionProfile(part);
    if (profile && Math.abs(profile.topRadius - profile.bottomRadius) > 0.05) {
      return { top: profile.topRadius, bottom: profile.bottomRadius };
    }
  }
  return null;
}

/**
 * Front/right outline from the nominal part frame (W×D×H), not mesh vertices.
 * Tessellated/CSG meshes often miss a rim corner; tracing those vertices draws a
 * diagonal where the solid still has a right angle on the workplane.
 */
function elevationOutlineEdges(part: BlueprintMeshPart, view: ViewKind): Array<[BlueprintVec3, BlueprintVec3]> {
  const y0 = part.elevation;
  const y1 = part.elevation + Math.max(0.001, part.height);
  const taper = elevationTaperRadii(part);

  if (view === "front") {
    if (taper) {
      const z = part.z;
      return [
        [[part.x - taper.bottom, y0, z], [part.x + taper.bottom, y0, z]],
        [[part.x + taper.bottom, y0, z], [part.x + taper.top, y1, z]],
        [[part.x + taper.top, y1, z], [part.x - taper.top, y1, z]],
        [[part.x - taper.top, y1, z], [part.x - taper.bottom, y0, z]],
      ];
    }
    const halfW = Math.max(0.001, part.width) / 2;
    const x0 = part.x - halfW;
    const x1 = part.x + halfW;
    const z = part.z;
    return [
      [[x0, y0, z], [x1, y0, z]],
      [[x1, y0, z], [x1, y1, z]],
      [[x1, y1, z], [x0, y1, z]],
      [[x0, y1, z], [x0, y0, z]],
    ];
  }

  if (view === "right" || view === "left") {
    // Same side profile in 3D; left/right projection mirrors the depth axis.
    if (taper) {
      const x = part.x;
      return [
        [[x, y0, part.z - taper.bottom], [x, y0, part.z + taper.bottom]],
        [[x, y0, part.z + taper.bottom], [x, y1, part.z + taper.top]],
        [[x, y1, part.z + taper.top], [x, y1, part.z - taper.top]],
        [[x, y1, part.z - taper.top], [x, y0, part.z - taper.bottom]],
      ];
    }
    const halfD = Math.max(0.001, part.depth) / 2;
    const z0 = part.z - halfD;
    const z1 = part.z + halfD;
    const x = part.x;
    return [
      [[x, y0, z0], [x, y0, z1]],
      [[x, y0, z1], [x, y1, z1]],
      [[x, y1, z1], [x, y1, z0]],
      [[x, y1, z0], [x, y0, z0]],
    ];
  }

  return aabbWireframe(part);
}

function hasCircularOuterRing(part: BlueprintMeshPart): boolean {
  const radius = Math.max(part.width, part.depth) / 2;
  if (!(radius > 1e-6) || part.vertices.length < 16) {
    return false;
  }
  const band = radius * 0.92;
  let rimCount = 0;
  let maxR = 0;
  for (const [x, , z] of part.vertices) {
    const r = Math.hypot(x - part.x, z - part.z);
    maxR = Math.max(maxR, r);
    if (r >= band) {
      rimCount += 1;
    }
  }
  if (rimCount < 12 || maxR < 1e-6) {
    return false;
  }
  // Boxes put corners near √2·halfWidth; discs stay near the declared radius.
  return Math.abs(maxR - radius) / radius < 0.08;
}

function isCircularFootprint(part: BlueprintMeshPart): boolean {
  if (Math.abs(part.width - part.depth) > 0.15) {
    return false;
  }
  if (
    part.kind === "cylinder"
    || part.kind === "tube"
    || part.kind === "cone"
    || part.kind === "ring"
    || part.kind === "sphere"
  ) {
    return true;
  }
  if (typeof part.topRadius === "number" || typeof part.baseRadius === "number") {
    return true;
  }
  if (inferRevolutionProfile(part)) {
    return true;
  }
  return hasCircularOuterRing(part);
}

/** Closed outer circle for plan views — independent of mesh rim gaps. */
function circularPlanOutline(part: BlueprintMeshPart, atTop: boolean): Array<[BlueprintVec3, BlueprintVec3]> {
  const radius = Math.max(part.width, part.depth) / 2;
  if (!(radius > 1e-6)) {
    return [];
  }
  const y = atTop ? part.elevation + Math.max(0, part.height) : part.elevation;
  const segments = 72;
  const edges: Array<[BlueprintVec3, BlueprintVec3]> = [];
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    edges.push([
      [part.x + Math.cos(a0) * radius, y, part.z + Math.sin(a0) * radius],
      [part.x + Math.cos(a1) * radius, y, part.z + Math.sin(a1) * radius],
    ]);
  }
  return edges;
}

function circularTopOutline(part: BlueprintMeshPart): Array<[BlueprintVec3, BlueprintVec3]> {
  return circularPlanOutline(part, true);
}

function keepInteriorTopEdges(
  part: BlueprintMeshPart,
  edges: Array<[BlueprintVec3, BlueprintVec3]>,
): Array<[BlueprintVec3, BlueprintVec3]> {
  const radius = Math.max(part.width, part.depth) / 2;
  if (!(radius > 1e-6)) {
    return edges;
  }
  const rim = radius * 0.97;
  return edges.filter(([a, b]) => {
    const ra = Math.hypot(a[0] - part.x, a[2] - part.z);
    const rb = Math.hypot(b[0] - part.x, b[2] - part.z);
    return ra < rim && rb < rim;
  });
}

/**
 * Extract readable drawing edges: open boundaries, sharp creases, and view silhouettes.
 * Hidden back-facing creases (e.g. bottom rim under a larger top face) are omitted.
 *
 * Front/right elevations use the nominal part frame so incomplete tessellation cannot
 * invent chamfers or drop a side of the profile.
 */
function collectDrawingEdges(part: BlueprintMeshPart, view: ViewKind): Array<[BlueprintVec3, BlueprintVec3]> {
  if (view === "front" || view === "right" || view === "left") {
    return elevationOutlineEdges(part, view);
  }

  const planCircular = () => (
    isCircularFootprint(part) ? circularPlanOutline(part, view !== "bottom") : aabbWireframe(part)
  );

  const welded = weldMesh(part);
  if (!welded) {
    return planCircular();
  }

  const center = meshCentroid(welded.vertices);
  const edges = new Map<string, EdgeRecord>();
  for (const [ia, ib, ic] of welded.faces) {
    const va = welded.vertices[ia];
    const vb = welded.vertices[ib];
    const vc = welded.vertices[ic];
    const normal = outwardFaceNormal(va, vb, vc, center);
    if (!normal) {
      continue;
    }
    const tri: [number, number, number] = [ia, ib, ic];
    for (const [a, b] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const existing = edges.get(key);
      if (existing) {
        if (existing.normals.length < 2) {
          existing.normals.push(normal);
        }
        if (existing.tris.length < 2) {
          existing.tris.push(tri);
        }
      } else {
        edges.set(key, { a, b, normals: [normal], tris: [tri] });
      }
    }
  }

  if (edges.size === 0) {
    return (view === "top" || view === "bottom") && isCircularFootprint(part)
      ? circularPlanOutline(part, view === "top")
      : aabbWireframe(part);
  }

  const look = viewDirection(view);
  // Tiny threshold: fine tessellation (CSG remesh) places limb faces nearly edge-on.
  const facingEps = 1e-4;
  type RankedEdge = { segment: [BlueprintVec3, BlueprintVec3]; priority: number };
  const ranked: RankedEdge[] = [];
  for (const edge of edges.values()) {
    const [n1, n2] = edge.normals;
    const segment: [BlueprintVec3, BlueprintVec3] = [welded.vertices[edge.a], welded.vertices[edge.b]];
    if (!n2) {
      ranked.push({ segment, priority: 3 });
      continue;
    }
    const crease = dot(n1, n2) < SHARP_EDGE_DOT;
    const facingA = dot(n1, look);
    const facingB = dot(n2, look);
    const frontA = facingA < -facingEps;
    const frontB = facingB < -facingEps;
    const silhouette3d =
      (facingA < -facingEps && facingB > facingEps) || (facingA > facingEps && facingB < -facingEps);

    let silhouette2d = false;
    if (edge.tris.length >= 2) {
      const [t1, t2] = edge.tris;
      const area1 = projectedSignedArea(view, welded.vertices[t1[0]], welded.vertices[t1[1]], welded.vertices[t1[2]]);
      const area2 = projectedSignedArea(view, welded.vertices[t2[0]], welded.vertices[t2[1]], welded.vertices[t2[2]]);
      silhouette2d = area1 * area2 < 0;
    }

    if (silhouette3d || silhouette2d) {
      ranked.push({ segment, priority: 2 });
      continue;
    }
    // Visible surface creases only — drop fully-hidden back edges (bottom rim under a larger lid).
    if (crease && (frontA || frontB)) {
      ranked.push({ segment, priority: 1 });
    }
  }

  if (ranked.length === 0) {
    return (view === "top" || view === "bottom") && isCircularFootprint(part)
      ? circularPlanOutline(part, view === "top")
      : aabbWireframe(part);
  }

  ranked.sort((a, b) => b.priority - a.priority);
  let meshEdges: Array<[BlueprintVec3, BlueprintVec3]>;
  if (ranked.length <= MAX_EDGES_PER_PART) {
    meshEdges = ranked.map((entry) => entry.segment);
  } else {
    meshEdges = [];
    for (const entry of ranked) {
      if (meshEdges.length >= MAX_EDGES_PER_PART) {
        break;
      }
      meshEdges.push(entry.segment);
    }
  }

  if ((view === "top" || view === "bottom") && isCircularFootprint(part)) {
    return [...circularPlanOutline(part, view === "top"), ...keepInteriorTopEdges(part, meshEdges)];
  }
  return meshEdges;
}

function formatLength(mm: number, workspace: BlueprintExportInput["workspace"]) {
  const display = millimetersToDisplay(mm, workspace);
  const unit = lengthDisplayUnit(workspace).label;
  return `${formatMeasurementNumber(display, workspace.accuracy as MeasurementAccuracy)} ${unit}`;
}

function viewTitle(view: ViewKind) {
  switch (view) {
    case "top":
      return "TOP";
    case "front":
      return "FRONT";
    case "right":
      return "RIGHT SIDE";
    case "left":
      return "LEFT SIDE";
    case "bottom":
      return "BOTTOM";
    case "iso":
      return "ISOMETRIC";
  }
}

function fitTransform(bounds: Bounds2, panel: { x: number; y: number; w: number; h: number }, padding = 10) {
  const width = Math.max(1e-6, bounds.maxX - bounds.minX);
  const height = Math.max(1e-6, bounds.maxY - bounds.minY);
  const scale = Math.min((panel.w - padding * 2) / width, (panel.h - padding * 2) / height);
  const drawnW = width * scale;
  const drawnH = height * scale;
  const offsetX = panel.x + (panel.w - drawnW) / 2;
  const offsetY = panel.y + (panel.h - drawnH) / 2;
  return {
    map(point: Point2): Point2 {
      return {
        x: offsetX + (point.x - bounds.minX) * scale,
        // Sheet Y grows downward; flip model Y so up stays up on the sheet.
        y: offsetY + (bounds.maxY - point.y) * scale,
      };
    },
    scale,
  };
}

type DrawingBuilder = {
  primitives: BlueprintPrimitive[];
  line: (layer: BlueprintLayer, x1: number, y1: number, x2: number, y2: number, strokeWidth: number, color: BlueprintColorRole, dxfOnly?: boolean) => void;
  rect: (layer: BlueprintLayer, x: number, y: number, w: number, h: number, strokeWidth: number, color: BlueprintColorRole, fill?: BlueprintColorRole | "white", radius?: number) => void;
  text: (layer: BlueprintLayer, x: number, y: number, text: string, fontSize: number, color: BlueprintColorRole, opts?: { bold?: boolean; align?: "left" | "center" | "right"; baseline?: "alphabetic" | "middle" }) => void;
  image: (layer: BlueprintLayer, x: number, y: number, w: number, h: number, dataUrl: string) => void;
};

function createDrawingBuilder(): DrawingBuilder {
  const primitives: BlueprintPrimitive[] = [];
  return {
    primitives,
    line(layer, x1, y1, x2, y2, strokeWidth, color, dxfOnly) {
      primitives.push({ kind: "line", layer, x1, y1, x2, y2, strokeWidth, color, dxfOnly });
    },
    rect(layer, x, y, w, h, strokeWidth, color, fill, radius) {
      primitives.push({ kind: "rect", layer, x, y, w, h, strokeWidth, color, fill, radius });
    },
    text(layer, x, y, text, fontSize, color, opts) {
      primitives.push({
        kind: "text",
        layer,
        x,
        y,
        text,
        fontSize,
        color,
        bold: opts?.bold,
        align: opts?.align,
        baseline: opts?.baseline,
      });
    },
    image(layer, x, y, w, h, dataUrl) {
      primitives.push({ kind: "image", layer, x, y, w, h, dataUrl });
    },
  };
}

function addPanelFrame(builder: DrawingBuilder, layer: BlueprintLayer, panel: { x: number; y: number; w: number; h: number }, title: string) {
  builder.rect(layer, panel.x, panel.y, panel.w, panel.h, 0.35, "grid", "panel", 2);
  builder.text(layer, panel.x + 3.5, panel.y + 6, title, FONT.panelTitle, "accent", { bold: true });
}

/** Gutters reserved for dimension labels inside each view panel (mm). */
const VIEW_DIM_PAD = { top: 14, right: 34, bottom: 18, left: 8 };

/** Sheet typography (mm). Kept as named sizes so PDF/SVG/DXF stay in sync. */
const FONT = {
  header: 18,
  headerSub: 10,
  panelTitle: 10.5,
  dim: 8.5,
  dimNote: 7.5,
  isoOverall: 9.5,
  titleBrand: 12,
  titleName: 9.5,
  titleMeta: 8.5,
  table: 8.5,
  tableMore: 8,
} as const;

function formatAngleDegrees(degrees: number) {
  const rounded = Math.round(degrees * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}°` : `${rounded.toFixed(1)}°`;
}

function formatDiameter(mm: number, workspace: BlueprintExportInput["workspace"]) {
  return `Ø ${formatLength(mm, workspace)}`;
}

function regularPolygonInteriorAngle(sides: number) {
  return ((sides - 2) * 180) / sides;
}

function regularPolygonExteriorAngle(sides: number) {
  return 360 / sides;
}

export type RevolutionProfile = {
  topRadius: number;
  bottomRadius: number;
  height: number;
  /** Side wall angle from vertical (0° = cylinder). */
  taperFromVerticalDeg: number;
  /** Side wall angle from horizontal. */
  wallFromHorizontalDeg: number;
};

function ringRadiiAtY(vertices: BlueprintVec3[], y: number, eps: number, cx: number, cz: number) {
  const radii: number[] = [];
  for (const [x, vy, z] of vertices) {
    if (Math.abs(vy - y) > eps) {
      continue;
    }
    radii.push(Math.hypot(x - cx, z - cz));
  }
  return radii;
}

function radiusStats(radii: number[]) {
  if (radii.length === 0) {
    return null;
  }
  const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  if (mean < 1e-6) {
    return { mean: 0, max: 0, cv: 0, count: radii.length };
  }
  let variance = 0;
  let max = 0;
  for (const value of radii) {
    variance += (value - mean) ** 2;
    max = Math.max(max, value);
  }
  variance /= radii.length;
  return { mean, max, cv: Math.sqrt(variance) / mean, count: radii.length };
}

/**
 * Detect circular top/bottom rings (cones, cylinders, tubes, CSG groups of same).
 * Returns null for boxes / irregular footprints.
 */
function inferRevolutionProfile(part: BlueprintMeshPart): RevolutionProfile | null {
  const height = Math.max(0.001, part.height);
  if (typeof part.topRadius === "number" && typeof part.baseRadius === "number") {
    const topRadius = Math.max(0, part.topRadius);
    const bottomRadius = Math.max(0, part.baseRadius);
    const delta = Math.abs(bottomRadius - topRadius);
    const taperFromVerticalDeg = (Math.atan2(delta, height) * 180) / Math.PI;
    return {
      topRadius,
      bottomRadius,
      height,
      taperFromVerticalDeg,
      wallFromHorizontalDeg: 90 - taperFromVerticalDeg,
    };
  }

  if (part.kind === "cylinder" || part.kind === "tube") {
    const radius = Math.max(part.width, part.depth) / 2;
    return {
      topRadius: radius,
      bottomRadius: radius,
      height,
      taperFromVerticalDeg: 0,
      wallFromHorizontalDeg: 90,
    };
  }

  if (part.vertices.length < 8) {
    return null;
  }

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [, y] of part.vertices) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (![minY, maxY].every(Number.isFinite) || maxY - minY < 1e-4) {
    return null;
  }

  const eps = Math.max(0.05, (maxY - minY) * 0.03);
  const cx = part.x;
  const cz = part.z;
  const top = radiusStats(ringRadiiAtY(part.vertices, maxY, eps, cx, cz));
  const bottom = radiusStats(ringRadiiAtY(part.vertices, minY, eps, cx, cz));
  if (!top || !bottom || top.count < 6 || bottom.count < 6) {
    return null;
  }
  // Corners of a box have high radial variance; circular rings stay tight.
  if (top.cv > 0.08 || bottom.cv > 0.08) {
    return null;
  }

  const topRadius = top.max;
  const bottomRadius = bottom.max;
  const delta = Math.abs(bottomRadius - topRadius);
  const taperFromVerticalDeg = (Math.atan2(delta, maxY - minY) * 180) / Math.PI;
  return {
    topRadius,
    bottomRadius,
    height: maxY - minY,
    taperFromVerticalDeg,
    wallFromHorizontalDeg: 90 - taperFromVerticalDeg,
  };
}

function addArcSegments(
  builder: DrawingBuilder,
  cx: number,
  cy: number,
  radius: number,
  startRad: number,
  endRad: number,
) {
  let sweep = endRad - startRad;
  while (sweep <= -Math.PI) sweep += Math.PI * 2;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  const steps = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  let prevX = cx + Math.cos(startRad) * radius;
  let prevY = cy - Math.sin(startRad) * radius;
  for (let i = 1; i <= steps; i += 1) {
    const t = startRad + (sweep * i) / steps;
    const x = cx + Math.cos(t) * radius;
    const y = cy - Math.sin(t) * radius;
    builder.line("DIMS", prevX, prevY, x, y, 0.25, "accent");
    prevX = x;
    prevY = y;
  }
}

function addDimensionHorizontal(
  builder: DrawingBuilder,
  x1: number,
  x2: number,
  yDim: number,
  yAttach: number,
  label: string,
) {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  builder.line("DIMS", left, yAttach, left, yDim, 0.16, "accent");
  builder.line("DIMS", right, yAttach, right, yDim, 0.16, "accent");
  builder.line("DIMS", left, yDim - 1.4, left, yDim + 1.4, 0.28, "accent");
  builder.line("DIMS", right, yDim - 1.4, right, yDim + 1.4, 0.28, "accent");
  builder.line("DIMS", left, yDim, right, yDim, 0.28, "accent");
  builder.text("DIMS", (left + right) / 2, yDim - 1.8, label, FONT.dim, "accent", { align: "center" });
}

function addDimensionVertical(
  builder: DrawingBuilder,
  xDim: number,
  y1: number,
  y2: number,
  xAttach: number,
  label: string,
) {
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  builder.line("DIMS", xAttach, top, xDim, top, 0.16, "accent");
  builder.line("DIMS", xAttach, bottom, xDim, bottom, 0.16, "accent");
  builder.line("DIMS", xDim - 1.4, top, xDim + 1.4, top, 0.28, "accent");
  builder.line("DIMS", xDim - 1.4, bottom, xDim + 1.4, bottom, 0.28, "accent");
  builder.line("DIMS", xDim, top, xDim, bottom, 0.28, "accent");
  // Label outside the part, to the right of the dimension line.
  builder.text("DIMS", xDim + 2.4, (top + bottom) / 2, label, FONT.dim, "accent", { align: "left", baseline: "middle" });
}

/** Top-face outline in top-view model coordinates (x, -z), ordered CCW. */
function orderedTopRing(part: BlueprintMeshPart): Point2[] {
  if (part.vertices.length === 0) {
    return [];
  }
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [, y] of part.vertices) {
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(maxY)) {
    return [];
  }
  const eps = Math.max(0.05, Math.abs(part.height || 1) * 0.02);
  const pts: Point2[] = [];
  const seen = new Set<string>();
  for (const [x, y, z] of part.vertices) {
    if (y < maxY - eps) {
      continue;
    }
    const key = `${Math.round(x * 200)}|${Math.round(z * 200)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    pts.push({ x, y: -z });
  }
  if (pts.length < 3) {
    return [];
  }
  const cx = pts.reduce((sum, point) => sum + point.x, 0) / pts.length;
  const cy = pts.reduce((sum, point) => sum + point.y, 0) / pts.length;
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  return pts;
}

function polygonAngleNotes(part: BlueprintMeshPart): { interior: number; exterior: number; sides: number } | null {
  const sides = Math.round(part.sides ?? 0);
  if (sides >= 3 && (part.kind === "polygon" || part.kind === "pyramid")) {
    return {
      sides,
      interior: regularPolygonInteriorAngle(sides),
      exterior: regularPolygonExteriorAngle(sides),
    };
  }
  const ring = orderedTopRing(part);
  if (ring.length < 3) {
    return null;
  }
  const prev = ring[ring.length - 1];
  const curr = ring[0];
  const next = ring[1];
  const inAngle = Math.atan2(curr.y - prev.y, curr.x - prev.x);
  const outAngle = Math.atan2(next.y - curr.y, next.x - curr.x);
  let turn = outAngle - inAngle;
  while (turn <= -Math.PI) turn += Math.PI * 2;
  while (turn > Math.PI) turn -= Math.PI * 2;
  const interior = ((Math.PI - turn) * 180) / Math.PI;
  if (!(interior > 1 && interior < 179)) {
    return null;
  }
  return {
    sides: ring.length,
    interior,
    exterior: 360 / ring.length,
  };
}

function addPolygonAngleCallout(
  builder: DrawingBuilder,
  part: BlueprintMeshPart,
  transform: { map: (point: Point2) => Point2 },
  panel: { x: number; y: number; w: number; h: number },
) {
  const notes = polygonAngleNotes(part);
  if (!notes) {
    return;
  }
  const ring = orderedTopRing(part);
  if (ring.length >= 3) {
    let best = 0;
    for (let i = 1; i < ring.length; i += 1) {
      if (ring[i].x > ring[best].x) {
        best = i;
      }
    }
    const prev = ring[(best - 1 + ring.length) % ring.length];
    const curr = ring[best];
    const next = ring[(best + 1) % ring.length];
    const sheet = transform.map(curr);
    const a0 = Math.atan2(-(transform.map(prev).y - sheet.y), transform.map(prev).x - sheet.x);
    const a1 = Math.atan2(-(transform.map(next).y - sheet.y), transform.map(next).x - sheet.x);
    let start = a0;
    let end = a1;
    let sweep = end - start;
    while (sweep <= -Math.PI) sweep += Math.PI * 2;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    if (Math.abs(sweep) > Math.PI) {
      const tmp = start;
      start = end;
      end = tmp;
    }
    const radius = 7;
    addArcSegments(builder, sheet.x, sheet.y, radius, start, end);
    const mid = start + (end - start) / 2;
    const labelX = sheet.x + Math.cos(mid) * (radius + 4);
    const labelY = sheet.y - Math.sin(mid) * (radius + 4);
    const clampedX = Math.min(panel.x + panel.w - 4, Math.max(panel.x + 4, labelX));
    const clampedY = Math.min(panel.y + panel.h - 4, Math.max(panel.y + 10, labelY));
    builder.text("DIMS", clampedX, clampedY, formatAngleDegrees(notes.interior), FONT.dim, "accent", {
      align: "center",
      baseline: "middle",
      bold: true,
    });
  }

  builder.text(
    "DIMS",
    panel.x + 30,
    panel.y + 6,
    `${notes.sides} sides · Int ${formatAngleDegrees(notes.interior)} · Ext ${formatAngleDegrees(notes.exterior)}`,
    FONT.dimNote,
    "accent",
    { align: "left" },
  );
}

function addRoofAngleCallouts(
  builder: DrawingBuilder,
  parts: BlueprintMeshPart[],
  transform: { map: (point: Point2) => Point2 },
  projectedBounds: Bounds2,
  panel: { x: number; y: number; w: number; h: number },
) {
  const roof = parts.find((part) => part.kind === "roof" && part.leftAngle != null && part.rightAngle != null);
  if (!roof || roof.leftAngle == null || roof.rightAngle == null) {
    return;
  }
  const left = transform.map({ x: projectedBounds.minX, y: projectedBounds.minY });
  const right = transform.map({ x: projectedBounds.maxX, y: projectedBounds.minY });
  const apex = transform.map({
    x: (projectedBounds.minX + projectedBounds.maxX) / 2,
    y: projectedBounds.maxY,
  });
  const apexInterior = Math.max(1, 180 - roof.leftAngle - roof.rightAngle);
  builder.text("DIMS", left.x + 2, left.y - 3, formatAngleDegrees(roof.leftAngle), FONT.dim, "accent", { align: "left" });
  builder.text("DIMS", right.x - 2, right.y - 3, formatAngleDegrees(roof.rightAngle), FONT.dim, "accent", { align: "right" });
  builder.text("DIMS", apex.x, Math.max(panel.y + 14, apex.y + 5), `Apex ${formatAngleDegrees(apexInterior)}`, FONT.dim, "accent", {
    align: "center",
  });
}

function addTaperAngleCallout(
  builder: DrawingBuilder,
  geom: { left: number; right: number; top: number; bottom: number },
  panel: { x: number; y: number; w: number; h: number },
  profile: RevolutionProfile,
) {
  const note = profile.taperFromVerticalDeg < 0.05
    ? `Wall ${formatAngleDegrees(90)} from horiz · Draft ${formatAngleDegrees(0)}`
    : `Draft ${formatAngleDegrees(profile.taperFromVerticalDeg)} from vert · Wall ${formatAngleDegrees(profile.wallFromHorizontalDeg)} from horiz`;
  builder.text("DIMS", panel.x + 28, panel.y + 6, note, FONT.dimNote, "accent", { align: "left" });

  if (profile.taperFromVerticalDeg < 0.05) {
    return;
  }

  // Arc at the lower-right corner: vertical reference → slanted wall.
  const cornerX = geom.right;
  const cornerY = geom.bottom;
  const radius = Math.min(11, Math.max(6, (geom.bottom - geom.top) * 0.35));
  const wallRad = (profile.taperFromVerticalDeg * Math.PI) / 180;
  // Sheet Y grows downward: vertical up is +π/2 in math angles used by addArcSegments (y flipped in drawing).
  const start = Math.PI / 2;
  const end = Math.PI / 2 - wallRad;
  addArcSegments(builder, cornerX, cornerY, radius, start, end);
  builder.line("DIMS", cornerX, cornerY, cornerX, cornerY - radius - 1.5, 0.18, "accent");
  const labelX = Math.min(panel.x + panel.w - 3, cornerX + radius + 2);
  const labelY = cornerY - radius * 0.55;
  builder.text("DIMS", labelX, labelY, formatAngleDegrees(profile.taperFromVerticalDeg), FONT.dim, "accent", {
    align: "left",
    baseline: "middle",
    bold: true,
  });
}

function addRevolutionDimensionCallouts(
  builder: DrawingBuilder,
  view: ViewKind,
  parts: BlueprintMeshPart[],
  transform: { map: (point: Point2) => Point2 },
  projectedBounds: Bounds2,
  panel: { x: number; y: number; w: number; h: number },
  workspace: BlueprintExportInput["workspace"],
) {
  const matched = parts
    .map((part) => {
      const profile = inferRevolutionProfile(part);
      return profile ? { part, profile } : null;
    })
    .filter((entry): entry is { part: BlueprintMeshPart; profile: RevolutionProfile } => Boolean(entry));
  if (matched.length === 0) {
    return null;
  }
  // Multi-part: use the largest outer ring for sheet callouts.
  const { part, profile } = matched.reduce((best, entry) => (
    Math.max(entry.profile.topRadius, entry.profile.bottomRadius)
      > Math.max(best.profile.topRadius, best.profile.bottomRadius)
      ? entry
      : best
  ));

  const yTop = part.elevation + part.height;
  const yBot = part.elevation;
  /** Sheet-space span of a horizontal diameter at world Y for this orthographic view. */
  const ringSpan = (radius: number, y: number) => {
    const ends: Point2[] = view === "right" || view === "left"
      ? [
          projectPoint(view, [part.x, y, part.z - radius]),
          projectPoint(view, [part.x, y, part.z + radius]),
        ]
      : view === "front"
        ? [
            projectPoint(view, [part.x - radius, y, part.z]),
            projectPoint(view, [part.x + radius, y, part.z]),
          ]
        : [
            // Top / bottom: diameter along +X through the ring center.
            projectPoint(view, [part.x - radius, y, part.z]),
            projectPoint(view, [part.x + radius, y, part.z]),
          ];
    const sheet = ends.map((point) => transform.map(point));
    return {
      left: Math.min(sheet[0].x, sheet[1].x),
      right: Math.max(sheet[0].x, sheet[1].x),
      y: (sheet[0].y + sheet[1].y) / 2,
    };
  };

  const geom = sheetBoundsFromProjected(transform, projectedBounds);

  if (view === "top" || view === "bottom") {
    // Plan views: outer silhouette diameter; plus the inner rim when an annulus is visible.
    const outerR = Math.max(profile.topRadius, profile.bottomRadius);
    const outerY = profile.topRadius >= profile.bottomRadius ? yTop : yBot;
    const outer = ringSpan(outerR, outerY);
    const yOuter = Math.min(panel.y + panel.h - 5, Math.max(outer.y + 7, panel.y + panel.h - 8));
    addDimensionHorizontal(builder, outer.left, outer.right, yOuter, outer.y, formatDiameter(outerR * 2, workspace));

    if (view === "top" && profile.topRadius + 0.05 < profile.bottomRadius) {
      // Classic frustum from above: top face is the visible inner circle.
      const inner = ringSpan(profile.topRadius, yTop);
      const yInner = Math.max(panel.y + 14, inner.y - 7);
      addDimensionHorizontal(
        builder,
        inner.left,
        inner.right,
        yInner,
        inner.y,
        formatDiameter(profile.topRadius * 2, workspace),
      );
    } else if (view === "bottom" && profile.bottomRadius + 0.05 < profile.topRadius) {
      // Looking up into a larger top: bottom face is the visible inner circle.
      const inner = ringSpan(profile.bottomRadius, yBot);
      const yInner = Math.max(panel.y + 14, inner.y - 7);
      addDimensionHorizontal(
        builder,
        inner.left,
        inner.right,
        yInner,
        inner.y,
        formatDiameter(profile.bottomRadius * 2, workspace),
      );
    }
    return profile;
  }

  // Front / right / left: extension lines land on the actual ring ends being measured.
  const topRing = ringSpan(profile.topRadius, yTop);
  const botRing = ringSpan(profile.bottomRadius, yBot);
  const yTopDim = Math.max(panel.y + 12, topRing.y - 6);
  const yBotDim = Math.min(panel.y + panel.h - 5, botRing.y + 7);

  if (Math.abs(profile.topRadius - profile.bottomRadius) < 0.05) {
    addDimensionHorizontal(
      builder,
      botRing.left,
      botRing.right,
      yBotDim,
      botRing.y,
      formatDiameter(profile.bottomRadius * 2, workspace),
    );
  } else {
    addDimensionHorizontal(
      builder,
      topRing.left,
      topRing.right,
      yTopDim,
      topRing.y,
      formatDiameter(profile.topRadius * 2, workspace),
    );
    addDimensionHorizontal(
      builder,
      botRing.left,
      botRing.right,
      yBotDim,
      botRing.y,
      formatDiameter(profile.bottomRadius * 2, workspace),
    );
  }
  const xDim = Math.min(panel.x + panel.w - 24, Math.max(geom.right + 12, panel.x + panel.w - 28));
  addDimensionVertical(builder, xDim, topRing.y, botRing.y, geom.right, `H ${formatLength(profile.height, workspace)}`);
  addTaperAngleCallout(builder, {
    left: Math.min(topRing.left, botRing.left),
    right: Math.max(topRing.right, botRing.right),
    top: Math.min(topRing.y, botRing.y),
    bottom: Math.max(topRing.y, botRing.y),
  }, panel, profile);
  return profile;
}

function sheetBoundsFromProjected(transform: { map: (point: Point2) => Point2 }, bounds: Bounds2) {
  const corners = [
    transform.map({ x: bounds.minX, y: bounds.minY }),
    transform.map({ x: bounds.maxX, y: bounds.minY }),
    transform.map({ x: bounds.maxX, y: bounds.maxY }),
    transform.map({ x: bounds.minX, y: bounds.maxY }),
  ];
  return {
    left: Math.min(...corners.map((point) => point.x)),
    right: Math.max(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
}

function addView(
  builder: DrawingBuilder,
  view: ViewKind,
  parts: BlueprintMeshPart[],
  world: Bounds3,
  panel: { x: number; y: number; w: number; h: number },
  workspace: BlueprintExportInput["workspace"],
) {
  const layer = viewLayer(view);
  addPanelFrame(builder, layer, panel, viewTitle(view));

  const content = {
    x: panel.x + VIEW_DIM_PAD.left,
    y: panel.y + VIEW_DIM_PAD.top,
    w: panel.w - VIEW_DIM_PAD.left - VIEW_DIM_PAD.right,
    h: panel.h - VIEW_DIM_PAD.top - VIEW_DIM_PAD.bottom,
  };

  // Fit from the full mesh projection so the shaded preview matches the true solid extent.
  const projectedBounds = emptyBounds2();
  for (const part of parts) {
    for (const vertex of part.vertices) {
      expandBounds2(projectedBounds, projectMeshView(view, vertex));
    }
  }
  const worldCorners: BlueprintVec3[] = [
    [world.minX, world.minY, world.minZ],
    [world.maxX, world.minY, world.minZ],
    [world.maxX, world.maxY, world.minZ],
    [world.minX, world.maxY, world.minZ],
    [world.minX, world.minY, world.maxZ],
    [world.maxX, world.minY, world.maxZ],
    [world.maxX, world.maxY, world.maxZ],
    [world.minX, world.maxY, world.maxZ],
  ];
  for (const corner of worldCorners) {
    expandBounds2(projectedBounds, projectMeshView(view, corner));
  }
  // Fallback when a part has no tessellation yet.
  if (!Number.isFinite(projectedBounds.minX)) {
    for (const part of parts) {
      for (const [a, b] of collectDrawingEdges(part, view)) {
        expandBounds2(projectedBounds, projectPoint(view, a));
        expandBounds2(projectedBounds, projectPoint(view, b));
      }
    }
  }

  if (!Number.isFinite(projectedBounds.minX)) {
    return;
  }

  const transform = fitTransform(projectedBounds, content, 4);
  const widthMm = world.maxX - world.minX;
  const heightMm = world.maxY - world.minY;
  const depthMm = world.maxZ - world.minZ;

  // Screenshot-style shaded preview for every viewport (PDF/SVG). Complexity doesn't matter —
  // we rasterize the mesh with a z-buffer instead of tracing fragile crease edges.
  const shaded = renderMeshViewPng(view, parts, content.w, content.h, projectedBounds, 6, 4);
  if (shaded) {
    builder.image(layer, content.x, content.y, content.w, content.h, shaded.dataUrl);
  }

  // Vector edges on top of the shaded preview so steps/emboss read clearly in PDF/SVG/DXF.
  // These are hidden-line removed: only spans lying on the visible surface survive, so a
  // feature on a face pointing away from this view can never print as a stray line.
  const visibleEdges = shaded?.visibleEdges ?? collectHiddenLineRemovedEdges(view, parts, projectedBounds);
  if (visibleEdges.length > 0) {
    for (const [a, b] of visibleEdges) {
      const pa = transform.map(projectMeshView(view, a));
      const pb = transform.map(projectMeshView(view, b));
      builder.line(layer, pa.x, pa.y, pb.x, pb.y, 0.32, "ink", false);
    }
  } else {
    for (const part of parts) {
      for (const [a, b] of collectDrawingEdges(part, view)) {
        const pa = transform.map(projectPoint(view, a));
        const pb = transform.map(projectPoint(view, b));
        builder.line(layer, pa.x, pa.y, pb.x, pb.y, shaded ? 0.28 : 0.22, "ink", Boolean(shaded));
      }
    }
  }

  if (view === "iso") {
    builder.text(
      "DIMS",
      panel.x + panel.w / 2,
      panel.y + panel.h - 5.5,
      `${formatLength(widthMm, workspace)} × ${formatLength(depthMm, workspace)} × ${formatLength(heightMm, workspace)}`,
      FONT.isoOverall,
      "accent",
      { bold: true, align: "center" },
    );
    return;
  }

  const geom = sheetBoundsFromProjected(transform, projectedBounds);
  const yDim = Math.min(panel.y + panel.h - 5, Math.max(geom.bottom + 7, content.y + content.h + 5));
  const xDim = Math.min(panel.x + panel.w - 24, Math.max(geom.right + 12, content.x + content.w + 8));

  const revolution = addRevolutionDimensionCallouts(builder, view, parts, transform, projectedBounds, panel, workspace);

  if (view === "top" || view === "bottom") {
    if (!revolution) {
      addDimensionHorizontal(builder, geom.left, geom.right, yDim, geom.bottom, `W ${formatLength(widthMm, workspace)}`);
      addDimensionVertical(builder, xDim, geom.top, geom.bottom, geom.right, `D ${formatLength(depthMm, workspace)}`);
    } else if (Math.abs(widthMm - depthMm) > 0.15) {
      // Non-circular envelope (elliptical cone footprint) — keep W/D beside Ø callouts.
      addDimensionHorizontal(builder, geom.left, geom.right, yDim, geom.bottom, `W ${formatLength(widthMm, workspace)}`);
      addDimensionVertical(builder, xDim, geom.top, geom.bottom, geom.right, `D ${formatLength(depthMm, workspace)}`);
    }
    if (view === "top") {
      for (const part of parts) {
        if (part.kind === "polygon" || part.kind === "pyramid" || (part.sides ?? 0) >= 3) {
          addPolygonAngleCallout(builder, part, transform, panel);
          break;
        }
      }
    }
  } else if (view === "front") {
    if (!revolution) {
      addDimensionHorizontal(builder, geom.left, geom.right, yDim, geom.bottom, `W ${formatLength(widthMm, workspace)}`);
      addDimensionVertical(builder, xDim, geom.top, geom.bottom, geom.right, `H ${formatLength(heightMm, workspace)}`);
    }
    addRoofAngleCallouts(builder, parts, transform, projectedBounds, panel);
  } else if ((view === "right" || view === "left") && !revolution) {
    addDimensionHorizontal(builder, geom.left, geom.right, yDim, geom.bottom, `D ${formatLength(depthMm, workspace)}`);
    addDimensionVertical(builder, xDim, geom.top, geom.bottom, geom.right, `H ${formatLength(heightMm, workspace)}`);
  }
}

function addTitleBlock(builder: DrawingBuilder, pageW: number, pageH: number, input: BlueprintExportInput, world: Bounds3) {
  const unit = lengthDisplayUnit(input.workspace).label;
  const boxW = 120;
  const boxH = 38;
  const x = pageW - 12 - boxW;
  const y = pageH - 12 - boxH;
  const overall =
    `${formatLength(world.maxX - world.minX, input.workspace)} × ${formatLength(world.maxZ - world.minZ, input.workspace)} × ${formatLength(world.maxY - world.minY, input.workspace)}`;

  builder.rect("TITLE", x, y, boxW, boxH, 0.4, "ink", "white");
  builder.line("TITLE", x, y + 11, x + boxW, y + 11, 0.4, "ink");
  builder.line("TITLE", x, y + 22, x + boxW, y + 22, 0.4, "ink");
  builder.line("TITLE", x + 38, y + 11, x + 38, y + 22, 0.4, "ink");
  builder.line("TITLE", x + 78, y + 11, x + 78, y + 22, 0.4, "ink");

  builder.text("TITLE", x + 2.5, y + 7.5, "PeakCAD", FONT.titleBrand, "ink", { bold: true });
  builder.text("TITLE", x + 32, y + 7.5, (input.projectName || "Untitled design").slice(0, 36), FONT.titleName, "ink");
  builder.text("TITLE", x + 2.5, y + 18.5, `Units: ${unit}`, FONT.titleMeta, "ink");
  builder.text("TITLE", x + 40, y + 18.5, `Parts: ${input.parts.length}`, FONT.titleMeta, "ink");
  builder.text("TITLE", x + 80, y + 18.5, new Date().toLocaleDateString(), FONT.titleMeta, "ink");
  builder.text("TITLE", x + 2.5, y + 31, `Overall: ${overall}`, FONT.titleMeta, "ink");
}

function addPartsTable(builder: DrawingBuilder, input: BlueprintExportInput, origin: { x: number; y: number; w: number; h: number }) {
  addPanelFrame(builder, "TABLE", origin, "PART DIMENSIONS");
  const unit = lengthDisplayUnit(input.workspace).label;
  const rowH = 6.2;
  const headerY = origin.y + 11;
  const cols = [
    { label: "#", x: origin.x + 3 },
    { label: "Name", x: origin.x + 11 },
    { label: "Kind", x: origin.x + 60 },
    { label: `W (${unit})`, x: origin.x + 84 },
    { label: `D (${unit})`, x: origin.x + 108 },
    { label: `H (${unit})`, x: origin.x + 132 },
    { label: `Elev (${unit})`, x: origin.x + 156 },
    { label: `X (${unit})`, x: origin.x + 182 },
    { label: `Z (${unit})`, x: origin.x + 206 },
  ];

  for (const col of cols) {
    builder.text("TABLE", col.x, headerY, col.label, FONT.table, "accent", { bold: true });
  }
  builder.line("TABLE", origin.x + 2, headerY + 1.8, origin.x + origin.w - 2, headerY + 1.8, 0.25, "grid");

  const maxRows = Math.max(1, Math.floor((origin.h - 16) / rowH));
  const rows = input.parts.slice(0, maxRows);
  rows.forEach((part, index) => {
    const y = headerY + 6 + index * rowH;
    const values = [
      String(index + 1),
      part.name.slice(0, 28),
      part.kind,
      formatMeasurementNumber(millimetersToDisplay(part.width, input.workspace), input.workspace.accuracy),
      formatMeasurementNumber(millimetersToDisplay(part.depth, input.workspace), input.workspace.accuracy),
      formatMeasurementNumber(millimetersToDisplay(part.height, input.workspace), input.workspace.accuracy),
      formatMeasurementNumber(millimetersToDisplay(part.elevation, input.workspace), input.workspace.accuracy),
      formatMeasurementNumber(millimetersToDisplay(part.x, input.workspace), input.workspace.accuracy),
      formatMeasurementNumber(millimetersToDisplay(part.z, input.workspace), input.workspace.accuracy),
    ];
    values.forEach((value, colIndex) => {
      builder.text("TABLE", cols[colIndex].x, y, value, FONT.table, "ink");
    });
  });

  if (input.parts.length > maxRows) {
    builder.text(
      "TABLE",
      origin.x + 3,
      origin.y + origin.h - 3.5,
      `+ ${input.parts.length - maxRows} more part${input.parts.length - maxRows === 1 ? "" : "s"}…`,
      FONT.tableMore,
      "accent",
    );
  }
}

/** Build a format-agnostic sheet drawing (PDF coordinate system: Y down, mm). */
export function buildBlueprintDrawing(input: BlueprintExportInput): BlueprintDrawing {
  if (input.parts.length === 0) {
    throw new Error("Add a solid shape before exporting a blueprint");
  }

  const pageW = A3_LANDSCAPE.w;
  const pageH = A3_LANDSCAPE.h;
  const margin = 12;
  const world = bounds3FromParts(input.parts);
  const builder = createDrawingBuilder();

  builder.rect("BORDER", margin - 3, margin - 3, pageW - (margin - 3) * 2, pageH - (margin - 3) * 2, 0.55, "ink");

  builder.text("HEADER", margin, margin + 5, "TECHNICAL DRAWING", FONT.header, "ink", { bold: true });
  builder.text(
    "HEADER",
    margin,
    margin + 11.5,
    "Third-angle projection  ·  Six orthographic views + true isometric (30°)  ·  Shaded mesh previews",
    FONT.headerSub,
    "accent",
  );

  const gap = 3.5;
  const headerH = 18;
  const tableH = 52;
  const viewsTop = margin + headerH;
  const viewsBottom = pageH - margin - tableH - gap - 2;
  const viewsH = viewsBottom - viewsTop;
  const viewsW = pageW - margin * 2;
  // 3×2: TOP | ISO | LEFT / FRONT | RIGHT | BOTTOM
  const cellW = (viewsW - gap * 2) / 3;
  const cellH = (viewsH - gap) / 2;
  const col = (index: number) => margin + index * (cellW + gap);
  const row = (index: number) => viewsTop + index * (cellH + gap);

  const panels: Record<ViewKind, { x: number; y: number; w: number; h: number }> = {
    top: { x: col(0), y: row(0), w: cellW, h: cellH },
    iso: { x: col(1), y: row(0), w: cellW, h: cellH },
    left: { x: col(2), y: row(0), w: cellW, h: cellH },
    front: { x: col(0), y: row(1), w: cellW, h: cellH },
    right: { x: col(1), y: row(1), w: cellW, h: cellH },
    bottom: { x: col(2), y: row(1), w: cellW, h: cellH },
  };

  (["top", "front", "right", "left", "bottom", "iso"] as ViewKind[]).forEach((view) => {
    addView(builder, view, input.parts, world, panels[view], input.workspace);
  });

  const tableWidth = pageW - margin * 2 - 120 - gap;
  addPartsTable(builder, input, {
    x: margin,
    y: pageH - margin - tableH,
    w: Math.max(180, tableWidth),
    h: tableH,
  });
  addTitleBlock(builder, pageW, pageH, input, world);

  return { pageW, pageH, primitives: builder.primitives };
}

function rgbCss(color: BlueprintColorRole | "white") {
  const { r, g, b } = COLOR_RGB[color];
  return `rgb(${r},${g},${b})`;
}

function setPdfColor(doc: jsPDF, color: BlueprintColorRole | "white", stroke = true) {
  const { r, g, b } = COLOR_RGB[color];
  if (stroke) {
    doc.setDrawColor(r, g, b);
  } else {
    doc.setFillColor(r, g, b);
  }
  doc.setTextColor(r, g, b);
}

export function writeBlueprintPdf(drawing: BlueprintDrawing): Uint8Array {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a3" });
  for (const primitive of drawing.primitives) {
    if (primitive.kind === "line") {
      if (primitive.dxfOnly) {
        continue;
      }
      setPdfColor(doc, primitive.color, true);
      doc.setLineWidth(primitive.strokeWidth);
      doc.line(primitive.x1, primitive.y1, primitive.x2, primitive.y2);
      continue;
    }
    if (primitive.kind === "rect") {
      setPdfColor(doc, primitive.color, true);
      doc.setLineWidth(primitive.strokeWidth);
      if (primitive.fill) {
        setPdfColor(doc, primitive.fill, false);
        if (primitive.radius && primitive.radius > 0) {
          doc.roundedRect(primitive.x, primitive.y, primitive.w, primitive.h, primitive.radius, primitive.radius, "FD");
        } else {
          doc.rect(primitive.x, primitive.y, primitive.w, primitive.h, "FD");
        }
      } else if (primitive.radius && primitive.radius > 0) {
        doc.roundedRect(primitive.x, primitive.y, primitive.w, primitive.h, primitive.radius, primitive.radius, "S");
      } else {
        doc.rect(primitive.x, primitive.y, primitive.w, primitive.h, "S");
      }
      continue;
    }
    if (primitive.kind === "image") {
      try {
        doc.addImage(primitive.dataUrl, "PNG", primitive.x, primitive.y, primitive.w, primitive.h);
      } catch {
        // Skip broken/empty preview rather than failing the whole sheet.
      }
      continue;
    }
    setPdfColor(doc, primitive.color, true);
    doc.setFont("helvetica", primitive.bold ? "bold" : "normal");
    doc.setFontSize(primitive.fontSize);
    const options: { align?: "left" | "center" | "right"; baseline?: "alphabetic" | "middle" } = {};
    if (primitive.align) {
      options.align = primitive.align;
    }
    if (primitive.baseline) {
      options.baseline = primitive.baseline;
    }
    doc.text(primitive.text, primitive.x, primitive.y, options);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

export function buildBlueprintPdf(input: BlueprintExportInput): Uint8Array {
  return writeBlueprintPdf(buildBlueprintDrawing(input));
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function writeBlueprintSvg(drawing: BlueprintDrawing): string {
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.pageW}mm" height="${drawing.pageH}mm" viewBox="0 0 ${drawing.pageW} ${drawing.pageH}">`,
    `<title>PeakCAD technical drawing</title>`,
  ];

  for (const primitive of drawing.primitives) {
    if (primitive.kind === "line") {
      if (primitive.dxfOnly) {
        continue;
      }
      parts.push(
        `<line data-layer="${primitive.layer}" x1="${primitive.x1}" y1="${primitive.y1}" x2="${primitive.x2}" y2="${primitive.y2}" stroke="${rgbCss(primitive.color)}" stroke-width="${primitive.strokeWidth}" />`,
      );
      continue;
    }
    if (primitive.kind === "rect") {
      const fill = primitive.fill ? rgbCss(primitive.fill) : "none";
      const radius = primitive.radius ?? 0;
      parts.push(
        `<rect data-layer="${primitive.layer}" x="${primitive.x}" y="${primitive.y}" width="${primitive.w}" height="${primitive.h}" rx="${radius}" ry="${radius}" fill="${fill}" stroke="${rgbCss(primitive.color)}" stroke-width="${primitive.strokeWidth}" />`,
      );
      continue;
    }
    if (primitive.kind === "image") {
      parts.push(
        `<image data-layer="${primitive.layer}" x="${primitive.x}" y="${primitive.y}" width="${primitive.w}" height="${primitive.h}" href="${primitive.dataUrl}" preserveAspectRatio="xMidYMid meet" />`,
      );
      continue;
    }
    const anchor = primitive.align === "center" ? "middle" : primitive.align === "right" ? "end" : "start";
    const baseline = primitive.baseline === "middle" ? "central" : "alphabetic";
    const weight = primitive.bold ? "700" : "400";
    parts.push(
      `<text data-layer="${primitive.layer}" x="${primitive.x}" y="${primitive.y}" fill="${rgbCss(primitive.color)}" font-family="Helvetica, Arial, sans-serif" font-size="${primitive.fontSize}" font-weight="${weight}" text-anchor="${anchor}" dominant-baseline="${baseline}">${escapeXml(primitive.text)}</text>`,
    );
  }

  parts.push(`</svg>`);
  return `${parts.join("\n")}\n`;
}

export function buildBlueprintSvg(input: BlueprintExportInput): string {
  return writeBlueprintSvg(buildBlueprintDrawing(input));
}

function dxfPair(code: number, value: string | number) {
  return `${code}\n${value}\n`;
}

function dxfLayerTable(layers: BlueprintLayer[]) {
  let out = "";
  out += dxfPair(0, "TABLE");
  out += dxfPair(2, "LAYER");
  out += dxfPair(70, layers.length);
  for (const layer of layers) {
    out += dxfPair(0, "LAYER");
    out += dxfPair(2, layer);
    out += dxfPair(70, 0);
    out += dxfPair(62, 7);
    out += dxfPair(6, "CONTINUOUS");
  }
  out += dxfPair(0, "ENDTAB");
  return out;
}

/** DXF uses Y-up; drawing model is Y-down like PDF. */
function dxfY(pageH: number, y: number) {
  return pageH - y;
}

export function writeBlueprintDxf(drawing: BlueprintDrawing): string {
  const layers: BlueprintLayer[] = [
    "BORDER",
    "HEADER",
    "TOP",
    "FRONT",
    "RIGHT",
    "LEFT",
    "BOTTOM",
    "ISO",
    "DIMS",
    "TITLE",
    "TABLE",
  ];
  let out = "";
  out += dxfPair(0, "SECTION");
  out += dxfPair(2, "HEADER");
  out += dxfPair(9, "$ACADVER");
  out += dxfPair(1, "AC1009");
  out += dxfPair(9, "$INSUNITS");
  out += dxfPair(70, 4); // millimeters
  out += dxfPair(0, "ENDSEC");

  out += dxfPair(0, "SECTION");
  out += dxfPair(2, "TABLES");
  out += dxfLayerTable(layers);
  out += dxfPair(0, "ENDSEC");

  out += dxfPair(0, "SECTION");
  out += dxfPair(2, "ENTITIES");

  for (const primitive of drawing.primitives) {
    if (primitive.kind === "image") {
      continue;
    }
    if (primitive.kind === "line") {
      out += dxfPair(0, "LINE");
      out += dxfPair(8, primitive.layer);
      out += dxfPair(10, primitive.x1);
      out += dxfPair(20, dxfY(drawing.pageH, primitive.y1));
      out += dxfPair(30, 0);
      out += dxfPair(11, primitive.x2);
      out += dxfPair(21, dxfY(drawing.pageH, primitive.y2));
      out += dxfPair(31, 0);
      continue;
    }
    if (primitive.kind === "rect") {
      const x1 = primitive.x;
      const y1 = primitive.y;
      const x2 = primitive.x + primitive.w;
      const y2 = primitive.y + primitive.h;
      const corners: Array<[number, number]> = [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2],
      ];
      for (let i = 0; i < 4; i += 1) {
        const [ax, ay] = corners[i];
        const [bx, by] = corners[(i + 1) % 4];
        out += dxfPair(0, "LINE");
        out += dxfPair(8, primitive.layer);
        out += dxfPair(10, ax);
        out += dxfPair(20, dxfY(drawing.pageH, ay));
        out += dxfPair(30, 0);
        out += dxfPair(11, bx);
        out += dxfPair(21, dxfY(drawing.pageH, by));
        out += dxfPair(31, 0);
      }
      continue;
    }
    out += dxfPair(0, "TEXT");
    out += dxfPair(8, primitive.layer);
    out += dxfPair(10, primitive.x);
    out += dxfPair(20, dxfY(drawing.pageH, primitive.y));
    out += dxfPair(30, 0);
    out += dxfPair(40, Math.max(1, primitive.fontSize * 0.35));
    out += dxfPair(1, primitive.text);
    if (primitive.align === "center") {
      out += dxfPair(72, 1);
    } else if (primitive.align === "right") {
      out += dxfPair(72, 2);
    }
  }

  out += dxfPair(0, "ENDSEC");
  out += dxfPair(0, "EOF");
  return out;
}

export function buildBlueprintDxf(input: BlueprintExportInput): string {
  return writeBlueprintDxf(buildBlueprintDrawing(input));
}

/** Test helpers */
export const __blueprintTestUtils = {
  projectPoint,
  collectDrawingEdges,
  bounds3FromParts,
  formatLength,
  polygonAngleNotes,
  regularPolygonInteriorAngle,
  regularPolygonExteriorAngle,
  inferRevolutionProfile,
  VIEW_DIM_PAD,
};
