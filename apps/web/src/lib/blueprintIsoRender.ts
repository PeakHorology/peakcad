import { zlibSync } from "fflate";

type Vec3 = [number, number, number];

export type IsoRenderPart = {
  color?: string;
  vertices: Vec3[];
  faces: Array<[number, number, number]>;
};

export type MeshViewKind = "top" | "front" | "right" | "left" | "bottom" | "iso";

type Point2 = { x: number; y: number };

type ShadedTri = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
  r: number;
  g: number;
  b: number;
};

/** True isometric: equal foreshortening; drafting axes at 30° to the base. */
const ISO_ANGLE = Math.PI / 6;
/**
 * Direction into the scene for `projectIso`.
 * Screen x'=(x-z)·cosθ and y'=y+(x+z)·sinθ are constant along (1,-1,1),
 * not along (1,1,1) — using the wrong axis inverts near/far and culls the front.
 */
const ISO_LOOK: Vec3 = normalize([1, -1, 1])!;
/** Matches workplane key light bias (above-front-right) without crushing side faces. */
const LIGHT: Vec3 = normalize([0.45, 0.82, 0.35])!;
const FILL: Vec3 = normalize([-0.55, 0.35, -0.4])!;
const UP: Vec3 = [0, 1, 0];
const MAX_SHADED_FACES = 120_000;
const SHARP_EDGE_DOT = Math.cos((28 * Math.PI) / 180);
const POSITION_QUANT = 1e4;

function normalize(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-12) {
    return null;
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function projectIso([x, y, z]: Vec3): Point2 {
  return {
    x: (x - z) * Math.cos(ISO_ANGLE),
    y: y + (x + z) * Math.sin(ISO_ANGLE),
  };
}

/** Larger = farther along the isometric view ray (direction (1,-1,1)). */
export function isoDepth([x, y, z]: Vec3) {
  return x - y + z;
}

export function projectMeshView(view: MeshViewKind, point: Vec3): Point2 {
  const [x, y, z] = point;
  switch (view) {
    case "top":
      return { x, y: -z };
    case "bottom":
      // Looking up +Y: flip depth axis vs top so the underside reads correctly.
      return { x, y: z };
    case "front":
      return { x, y };
    case "right":
      return { x: z, y };
    case "left":
      // Looking from −X: mirror the right-side depth axis.
      return { x: -z, y };
    case "iso":
      return projectIso(point);
  }
}

/** Larger = farther from the camera (same convention as `isoDepth`). */
export function meshViewDepth(view: MeshViewKind, point: Vec3): number {
  const [x, y, z] = point;
  switch (view) {
    case "top":
      // Looking down −Y: farther points have smaller Y.
      return -y;
    case "bottom":
      // Looking up +Y: farther points have larger Y.
      return y;
    case "front":
      // Looking toward −Z: farther points have smaller Z.
      return -z;
    case "right":
      // Looking toward −X: farther points have smaller X.
      return -x;
    case "left":
      // Looking toward +X: farther points have larger X.
      return x;
    case "iso":
      return isoDepth(point);
  }
}

function viewLook(view: MeshViewKind): Vec3 {
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
    case "iso":
      return ISO_LOOK;
  }
}

export function parseCssColor(color: string | undefined): { r: number; g: number; b: number } {
  const fallback = { r: 180, g: 190, b: 200 };
  if (!color) {
    return fallback;
  }
  const hex = color.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(hex);
  if (short) {
    const [r, g, b] = short[1].split("").map((ch) => Number.parseInt(ch + ch, 16));
    return { r, g, b };
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (full) {
    return {
      r: Number.parseInt(full[1].slice(0, 2), 16),
      g: Number.parseInt(full[1].slice(2, 4), 16),
      b: Number.parseInt(full[1].slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(hex);
  if (rgb) {
    return {
      r: Math.round(Number(rgb[1])),
      g: Math.round(Number(rgb[2])),
      b: Math.round(Number(rgb[3])),
    };
  }
  return fallback;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return chunk;
}

export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  const compressed = zlibSync(raw, { level: 6 });
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array(0))];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function edge(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

function fillTriangle(
  pixels: Uint8ClampedArray | null,
  zbuf: Float32Array,
  width: number,
  height: number,
  tri: ShadedTri,
) {
  const minX = Math.max(0, Math.floor(Math.min(tri.ax, tri.bx, tri.cx)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(tri.ax, tri.bx, tri.cx)));
  const minY = Math.max(0, Math.floor(Math.min(tri.ay, tri.by, tri.cy)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(tri.ay, tri.by, tri.cy)));
  if (minX > maxX || minY > maxY) {
    return;
  }

  const area = edge(tri.ax, tri.ay, tri.bx, tri.by, tri.cx, tri.cy);
  if (Math.abs(area) < 1e-8) {
    return;
  }

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = edge(tri.bx, tri.by, tri.cx, tri.cy, px, py) / area;
      const w1 = edge(tri.cx, tri.cy, tri.ax, tri.ay, px, py) / area;
      const w2 = edge(tri.ax, tri.ay, tri.bx, tri.by, px, py) / area;
      if (w0 < 0 || w1 < 0 || w2 < 0) {
        continue;
      }
      const depth = w0 * tri.az + w1 * tri.bz + w2 * tri.cz;
      const index = y * width + x;
      if (depth >= zbuf[index]) {
        continue;
      }
      zbuf[index] = depth;
      if (!pixels) {
        continue;
      }
      const offset = index * 4;
      pixels[offset] = tri.r;
      pixels[offset + 1] = tri.g;
      pixels[offset + 2] = tri.b;
      pixels[offset + 3] = 255;
    }
  }
}

function outwardNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  return normalize(cross(subtract(b, a), subtract(c, a)));
}

/** Force a geometric outward normal using the part centroid (winding-safe). */
function outwardNormalFromCenter(a: Vec3, b: Vec3, c: Vec3, center: Vec3): Vec3 | null {
  const normal = outwardNormal(a, b, c);
  if (!normal) {
    return null;
  }
  const faceCenter: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  if (dot(normal, subtract(faceCenter, center)) < 0) {
    return [-normal[0], -normal[1], -normal[2]];
  }
  return normal;
}

function partCentroid(part: IsoRenderPart): Vec3 {
  if (part.vertices.length === 0) {
    return [0, 0, 0];
  }
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const [x, y, z] of part.vertices) {
    sx += x;
    sy += y;
    sz += z;
  }
  const n = part.vertices.length;
  return [sx / n, sy / n, sz / n];
}

function isFrontFacing(normal: Vec3, look: Vec3) {
  // Outward normal against look direction ⇒ faces the camera.
  return dot(normal, look) < -0.001;
}

function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}

/**
 * Two-sided shaded triangles. Emboss/engrave and inconsistent windings are common on
 * CSG meshes — culling by centroid leaves lettering and steps as holes/ghosts.
 */
function collectShadedTris(view: MeshViewKind, parts: IsoRenderPart[]): ShadedTri[] {
  const tris: ShadedTri[] = [];
  const look = viewLook(view);
  for (const part of parts) {
    const base = parseCssColor(part.color);
    const center = partCentroid(part);
    for (const [ia, ib, ic] of part.faces) {
      const a = part.vertices[ia];
      const b = part.vertices[ib];
      const c = part.vertices[ic];
      if (!a || !b || !c) {
        continue;
      }
      let normal = outwardNormalFromCenter(a, b, c, center) ?? outwardNormal(a, b, c);
      if (!normal) {
        continue;
      }
      // Face the camera for lighting; still rasterize (back faces lose on depth for solids).
      if (dot(normal, look) > 0) {
        normal = negate(normal);
      }
      const key = Math.max(0, dot(normal, LIGHT));
      const fill = Math.max(0, dot(normal, FILL));
      const hemi = 0.5 + 0.5 * Math.max(-0.2, Math.min(1, dot(normal, UP)));
      const shade = Math.min(1.02, 0.86 + 0.1 * key + 0.04 * fill + 0.04 * hemi);
      const pa = projectMeshView(view, a);
      const pb = projectMeshView(view, b);
      const pc = projectMeshView(view, c);
      // Skip knife-edge projections that only add z-fireflies.
      const area2 = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
      if (Math.abs(area2) < 1e-10) {
        continue;
      }
      tris.push({
        ax: pa.x,
        ay: pa.y,
        az: meshViewDepth(view, a),
        bx: pb.x,
        by: pb.y,
        bz: meshViewDepth(view, b),
        cx: pc.x,
        cy: pc.y,
        cz: meshViewDepth(view, c),
        r: Math.min(255, Math.round(base.r * shade)),
        g: Math.min(255, Math.round(base.g * shade)),
        b: Math.min(255, Math.round(base.b * shade)),
      });
      if (tris.length >= MAX_SHADED_FACES) {
        return tris;
      }
    }
  }
  return tris;
}

function quantizePosition([x, y, z]: Vec3) {
  return `${Math.round(x * POSITION_QUANT)}|${Math.round(y * POSITION_QUANT)}|${Math.round(z * POSITION_QUANT)}`;
}

/**
 * Visible outlines for a view: open boundaries, front creases, and true silhouettes.
 * Never emits edges that only touch back faces.
 */
export function collectVisibleViewEdges(view: MeshViewKind, parts: IsoRenderPart[]): Array<[Vec3, Vec3]> {
  const look = viewLook(view);
  const kept: Array<[Vec3, Vec3]> = [];
  for (const part of parts) {
    if (part.faces.length === 0 || part.vertices.length < 2) {
      continue;
    }
    const center = partCentroid(part);
    const indexByKey = new Map<string, number>();
    const vertices: Vec3[] = [];
    const remap = (vertex: Vec3) => {
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
    const faceFront: boolean[] = [];
    const faceNormals: Array<Vec3 | null> = [];
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
      const normal = outwardNormalFromCenter(vertices[a], vertices[b], vertices[c], center);
      faces.push([a, b, c]);
      faceNormals.push(normal);
      faceFront.push(Boolean(normal && isFrontFacing(normal, look)));
    }

    type EdgeRec = { a: number; b: number; faces: number[] };
    const edges = new Map<string, EdgeRec>();
    faces.forEach(([ia, ib, ic], faceIndex) => {
      for (const [a, b] of [
        [ia, ib],
        [ib, ic],
        [ic, ia],
      ] as const) {
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const existing = edges.get(key);
        if (existing) {
          if (existing.faces.length < 2) {
            existing.faces.push(faceIndex);
          }
        } else {
          edges.set(key, { a, b, faces: [faceIndex] });
        }
      }
    });

    for (const edge of edges.values()) {
      const [f0, f1] = edge.faces;
      const front0 = faceFront[f0];
      const front1 = f1 === undefined ? false : faceFront[f1];
      if (!front0 && !front1) {
        continue;
      }
      if (f1 === undefined) {
        if (front0) {
          kept.push([vertices[edge.a], vertices[edge.b]]);
        }
        continue;
      }
      const n0 = faceNormals[f0];
      const n1 = faceNormals[f1];
      if (!n0 || !n1) {
        continue;
      }
      const crease = dot(n0, n1) < SHARP_EDGE_DOT;
      const silhouette = front0 !== front1;
      if ((front0 && front1 && crease) || silhouette) {
        kept.push([vertices[edge.a], vertices[edge.b]]);
      }
    }
  }
  return kept;
}

export function collectVisibleIsoEdges(parts: IsoRenderPart[]): Array<[Vec3, Vec3]> {
  return collectVisibleViewEdges("iso", parts);
}

function strokeLine(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
  thickness: number,
) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2.5));
  const radius = Math.max(0.55, thickness / 2);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius) {
          continue;
        }
        const offset = (y * width + x) * 4;
        pixels[offset] = rgb[0];
        pixels[offset + 1] = rgb[1];
        pixels[offset + 2] = rgb[2];
        pixels[offset + 3] = 255;
      }
    }
  }
}

type ViewFit = {
  widthPx: number;
  heightPx: number;
  mapX: (x: number) => number;
  mapY: (y: number) => number;
};

function makeViewFit(bounds: IsoRenderBounds, widthPx: number, heightPx: number, paddingPx: number): ViewFit {
  const modelW = Math.max(1e-6, bounds.maxX - bounds.minX);
  const modelH = Math.max(1e-6, bounds.maxY - bounds.minY);
  const scale = Math.min((widthPx - paddingPx * 2) / modelW, (heightPx - paddingPx * 2) / modelH);
  const offsetX = (widthPx - modelW * scale) / 2;
  const offsetY = (heightPx - modelH * scale) / 2;
  return {
    widthPx,
    heightPx,
    mapX: (x: number) => offsetX + (x - bounds.minX) * scale,
    mapY: (y: number) => offsetY + (bounds.maxY - y) * scale,
  };
}

/**
 * Depth slack allowed when deciding an edge sits on the visible surface.
 * Scaled to the model so it absorbs interpolation error without letting far-side
 * geometry (a raised emboss seen from below, the back rim of a cylinder) leak through.
 */
function occlusionTolerance(view: MeshViewKind, parts: IsoRenderPart[]) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    for (const vertex of part.vertices) {
      const depth = meshViewDepth(view, vertex);
      min = Math.min(min, depth);
      max = Math.max(max, depth);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 1e-6;
  }
  const range = Math.max(0, max - min);
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  return Math.max(range * 0.005, magnitude * 1e-5, 1e-6);
}

/**
 * Is an edge sample on the visible surface, or behind it?
 *
 * Anchored on the sample's own pixel, then widened to the farthest surface among the
 * solid pixels touching it. The widening matters on curved bodies: at a silhouette limb
 * the depth gradient goes vertical, so a single-pixel comparison would reject the very
 * outline it should keep. Empty neighbors are ignored (they carry no depth), but an empty
 * center means the sample is off the solid entirely, where nothing can occlude it.
 */
function isEdgeSampleVisible(
  fit: ViewFit,
  zbuf: Float32Array,
  px: number,
  py: number,
  depth: number,
  tolerance: number,
) {
  const cx = Math.round(px - 0.5);
  const cy = Math.round(py - 0.5);
  if (cx < 0 || cy < 0 || cx >= fit.widthPx || cy >= fit.heightPx) {
    return true;
  }
  let farthest = zbuf[cy * fit.widthPx + cx];
  if (!(farthest < Number.POSITIVE_INFINITY)) {
    return true;
  }
  if (depth <= farthest + tolerance) {
    return true;
  }
  for (let dy = -1; dy <= 1; dy += 1) {
    const y = cy + dy;
    if (y < 0 || y >= fit.heightPx) {
      continue;
    }
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = cx + dx;
      if (x < 0 || x >= fit.widthPx) {
        continue;
      }
      const surface = zbuf[y * fit.widthPx + x];
      if (surface < Number.POSITIVE_INFINITY && surface > farthest) {
        farthest = surface;
        if (depth <= farthest + tolerance) {
          return true;
        }
      }
    }
  }
  return false;
}

function lerpPoint(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Hidden-line removal: clip candidate edges against the rasterized depth buffer and keep
 * only the sub-spans that lie on the visible surface. Orientation tests alone are not
 * enough — a face's "outward" normal is ambiguous on non-convex features (emboss, engrave,
 * steps), so far-side creases would otherwise survive as stray lines.
 */
function clipEdgesToVisible(
  view: MeshViewKind,
  parts: IsoRenderPart[],
  fit: ViewFit,
  zbuf: Float32Array,
  tolerance: number,
  maxSegments = 24_000,
): Array<[Vec3, Vec3]> {
  const visible: Array<[Vec3, Vec3]> = [];
  const isVisibleAt = (px: number, py: number, depth: number) =>
    isEdgeSampleVisible(fit, zbuf, px, py, depth, tolerance);

  for (const [a, b] of collectVisibleViewEdges(view, parts)) {
    const pa = projectMeshView(view, a);
    const pb = projectMeshView(view, b);
    const ax = fit.mapX(pa.x);
    const ay = fit.mapY(pa.y);
    const bx = fit.mapX(pb.x);
    const by = fit.mapY(pb.y);
    const depthA = meshViewDepth(view, a);
    const depthB = meshViewDepth(view, b);
    const pixelLength = Math.hypot(bx - ax, by - ay);

    if (pixelLength < 2) {
      if (isVisibleAt((ax + bx) / 2, (ay + by) / 2, (depthA + depthB) / 2)) {
        visible.push([a, b]);
      }
    } else {
      const steps = Math.min(512, Math.max(2, Math.ceil(pixelLength)));
      let runStart: number | null = null;
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const lit = isVisibleAt(
          ax + (bx - ax) * t,
          ay + (by - ay) * t,
          depthA + (depthB - depthA) * t,
        );
        if (lit) {
          if (runStart === null) {
            runStart = t;
          }
          if (i === steps) {
            visible.push([lerpPoint(a, b, runStart), b]);
          }
          continue;
        }
        if (runStart !== null) {
          const runEnd = (i - 1) / steps;
          // Require a span (not a single sample) so rasterization noise can't create dashes.
          if (runEnd > runStart) {
            visible.push([lerpPoint(a, b, runStart), lerpPoint(a, b, runEnd)]);
          }
          runStart = null;
        }
      }
    }

    if (visible.length >= maxSegments) {
      break;
    }
  }
  return visible;
}

/**
 * Screen-space silhouette from the depth buffer — clean outline without mesh-edge ghosts.
 */
function strokeDepthSilhouette(
  pixels: Uint8ClampedArray,
  zbuf: Float32Array,
  width: number,
  height: number,
  rgb: [number, number, number],
) {
  const empty = Number.POSITIVE_INFINITY;
  const isSolid = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return false;
    }
    return zbuf[y * width + x] < empty;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isSolid(x, y)) {
        continue;
      }
      if (isSolid(x - 1, y) && isSolid(x + 1, y) && isSolid(x, y - 1) && isSolid(x, y + 1)) {
        continue;
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }
}

export type IsoShadedPng = {
  dataUrl: string;
  widthPx: number;
  heightPx: number;
  /** Model-space edge spans that survived hidden-line removal for this view. */
  visibleEdges: Array<[Vec3, Vec3]>;
};

export type IsoRenderBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

/**
 * Opaque lit mesh preview for any blueprint view (orthographic or isometric).
 * Two-sided shaded fill + depth silhouette + depth-tested crease/silhouette edges.
 */
export function renderMeshViewPng(
  view: MeshViewKind,
  parts: IsoRenderPart[],
  panelWmm: number,
  panelHmm: number,
  bounds?: IsoRenderBounds | null,
  pixelsPerMm = 6,
  paddingMm = 4,
): IsoShadedPng | null {
  const tris = collectShadedTris(view, parts);
  if (tris.length === 0) {
    return null;
  }

  let minX = bounds?.minX ?? Number.POSITIVE_INFINITY;
  let maxX = bounds?.maxX ?? Number.NEGATIVE_INFINITY;
  let minY = bounds?.minY ?? Number.POSITIVE_INFINITY;
  let maxY = bounds?.maxY ?? Number.NEGATIVE_INFINITY;
  if (!bounds) {
    for (const part of parts) {
      for (const vertex of part.vertices) {
        const p = projectMeshView(view, vertex);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    return null;
  }

  const widthPx = Math.max(64, Math.min(1800, Math.round(panelWmm * pixelsPerMm)));
  const heightPx = Math.max(64, Math.min(1400, Math.round(panelHmm * pixelsPerMm)));
  const viewBounds: IsoRenderBounds = { minX, maxX, minY, maxY };
  const fit = makeViewFit(viewBounds, widthPx, heightPx, paddingMm * pixelsPerMm);

  for (const tri of tris) {
    tri.ax = fit.mapX(tri.ax);
    tri.ay = fit.mapY(tri.ay);
    tri.bx = fit.mapX(tri.bx);
    tri.by = fit.mapY(tri.by);
    tri.cx = fit.mapX(tri.cx);
    tri.cy = fit.mapY(tri.cy);
  }

  const pixels = new Uint8ClampedArray(widthPx * heightPx * 4);
  for (let i = 0; i < widthPx * heightPx; i += 1) {
    const o = i * 4;
    pixels[o] = 248;
    pixels[o + 1] = 251;
    pixels[o + 2] = 252;
    pixels[o + 3] = 255;
  }
  const zbuf = new Float32Array(widthPx * heightPx);
  zbuf.fill(Number.POSITIVE_INFINITY);
  for (const tri of tris) {
    fillTriangle(pixels, zbuf, widthPx, heightPx, tri);
  }

  // Dark ink edges for drafting clarity (silhouette + creases).
  const edgeRgb: [number, number, number] = [28, 36, 44];
  strokeDepthSilhouette(pixels, zbuf, widthPx, heightPx, edgeRgb);

  const visibleEdges = clipEdgesToVisible(view, parts, fit, zbuf, occlusionTolerance(view, parts));
  for (const [a, b] of visibleEdges) {
    const pa = projectMeshView(view, a);
    const pb = projectMeshView(view, b);
    strokeLine(pixels, widthPx, heightPx, fit.mapX(pa.x), fit.mapY(pa.y), fit.mapX(pb.x), fit.mapY(pb.y), edgeRgb, 1.35);
  }

  const png = encodePngRgba(widthPx, heightPx, new Uint8Array(pixels.buffer));
  return {
    dataUrl: `data:image/png;base64,${bytesToBase64(png)}`,
    widthPx,
    heightPx,
    visibleEdges,
  };
}

/**
 * Hidden-line-removed edges for a view, without rendering a raster preview.
 * Used for vector-only outputs (DXF) and as the fallback when shading is unavailable.
 */
export function collectHiddenLineRemovedEdges(
  view: MeshViewKind,
  parts: IsoRenderPart[],
  bounds?: IsoRenderBounds | null,
  resolutionPx = 900,
): Array<[Vec3, Vec3]> {
  const tris = collectShadedTris(view, parts);
  if (tris.length === 0) {
    return [];
  }

  let minX = bounds?.minX ?? Number.POSITIVE_INFINITY;
  let maxX = bounds?.maxX ?? Number.NEGATIVE_INFINITY;
  let minY = bounds?.minY ?? Number.POSITIVE_INFINITY;
  let maxY = bounds?.maxY ?? Number.NEGATIVE_INFINITY;
  if (!bounds) {
    for (const part of parts) {
      for (const vertex of part.vertices) {
        const p = projectMeshView(view, vertex);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    return [];
  }

  const modelW = Math.max(1e-6, maxX - minX);
  const modelH = Math.max(1e-6, maxY - minY);
  const longest = Math.max(modelW, modelH);
  const widthPx = Math.max(64, Math.round((modelW / longest) * resolutionPx));
  const heightPx = Math.max(64, Math.round((modelH / longest) * resolutionPx));
  const fit = makeViewFit({ minX, maxX, minY, maxY }, widthPx, heightPx, 2);

  for (const tri of tris) {
    tri.ax = fit.mapX(tri.ax);
    tri.ay = fit.mapY(tri.ay);
    tri.bx = fit.mapX(tri.bx);
    tri.by = fit.mapY(tri.by);
    tri.cx = fit.mapX(tri.cx);
    tri.cy = fit.mapY(tri.cy);
  }

  const zbuf = new Float32Array(widthPx * heightPx);
  zbuf.fill(Number.POSITIVE_INFINITY);
  for (const tri of tris) {
    fillTriangle(null, zbuf, widthPx, heightPx, tri);
  }

  return clipEdgesToVisible(view, parts, fit, zbuf, occlusionTolerance(view, parts));
}

/**
 * Opaque lit isometric preview with hidden-line removal.
 * Projection: +Y vertical; +X/+Z at ±30° (true drafting isometric).
 */
export function renderIsoShadedPng(
  parts: IsoRenderPart[],
  panelWmm: number,
  panelHmm: number,
  bounds?: IsoRenderBounds | null,
  pixelsPerMm = 6,
  paddingMm = 4,
): IsoShadedPng | null {
  return renderMeshViewPng("iso", parts, panelWmm, panelHmm, bounds, pixelsPerMm, paddingMm);
}
