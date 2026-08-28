import { metricThreadDepth, type ResolvedThreadParams } from "@/lib/metricThreads";

export const DEFAULT_THREAD_SIDES = 96;
export const MIN_THREAD_SIDES = 8;
export const MAX_THREAD_SIDES = 256;
export const DEFAULT_THREAD_CLEARANCE = 0.2;
export const MIN_THREAD_CLEARANCE = 0;
export const MAX_THREAD_CLEARANCE = 2;

export type MetricThreadSolidMesh = {
  /** Non-indexed triangle soup (9 floats per triangle), editor Y-up, base at y = 0. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  brep: string;
  step?: string;
  width: number;
  depth: number;
  height: number;
};

export type ThreadMeshPart = "screw" | "shaft" | "threads";

export type ThreadMeshOptions = {
  /** Radial segments around the shaft / helix (higher = rounder). */
  sides?: number;
  /** Extra radial clearance (mm) for hole cutters / loose fit. */
  clearance?: number;
  /** Which solid to build. */
  part?: ThreadMeshPart;
};

type Vec3 = [number, number, number];

function pushTriangle(positions: number[], normals: number[], a: Vec3, b: Vec3, c: Vec3) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
}

function pushQuad(positions: number[], normals: number[], a: Vec3, b: Vec3, c: Vec3, d: Vec3) {
  pushTriangle(positions, normals, a, b, c);
  pushTriangle(positions, normals, a, c, d);
}

function pushCylinder(positions: number[], normals: number[], radius: number, height: number, radialSegs: number) {
  for (let i = 0; i < radialSegs; i += 1) {
    const a0 = (i / radialSegs) * Math.PI * 2;
    const a1 = ((i + 1) / radialSegs) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const b0: Vec3 = [c0 * radius, 0, s0 * radius];
    const b1: Vec3 = [c1 * radius, 0, s1 * radius];
    const t0: Vec3 = [c0 * radius, height, s0 * radius];
    const t1: Vec3 = [c1 * radius, height, s1 * radius];
    pushQuad(positions, normals, b0, b1, t1, t0);
    pushTriangle(positions, normals, [0, 0, 0], b1, b0);
    pushTriangle(positions, normals, [0, height, 0], t0, t1);
  }
}

/** Smooth 0→1 ease used for thread runout at each end of the blank. */
function smoothstep01(t: number) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Tooth height scale along the blank: full in the middle, gently folds to 0
 * over roughly one pitch at each end so the helix runs out into the shaft.
 */
function threadRunoutScale(y: number, height: number, pitch: number) {
  const runout = Math.min(pitch * 1.15, height * 0.4);
  if (runout <= 1e-6) return 1;
  return Math.min(smoothstep01(y / runout), smoothstep01((height - y) / runout));
}

function pushHelicalThreads(
  positions: number[],
  normals: number[],
  options: {
    majorR: number;
    toothRootR: number;
    pitch: number;
    height: number;
    halfWidth: number;
    lefthand: number;
    helixSegs: number;
  },
) {
  const { majorR, toothRootR, pitch, height: h, halfWidth, lefthand, helixSegs } = options;
  const sections: Array<{ rootA: Vec3; crest: Vec3; rootB: Vec3; scale: number }> = [];
  for (let i = 0; i <= helixSegs; i += 1) {
    const t = i / helixSegs;
    const y = t * h;
    const scale = threadRunoutScale(y, h, pitch);
    const angle = lefthand * (y / pitch) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const crestR = toothRootR + (majorR - toothRootR) * scale;
    const sectionHalf = halfWidth * (0.35 + 0.65 * scale);
    const crest: Vec3 = [cos * crestR, y, sin * crestR];
    const rootA: Vec3 = [cos * toothRootR, y - sectionHalf, sin * toothRootR];
    const rootB: Vec3 = [cos * toothRootR, y + sectionHalf, sin * toothRootR];
    rootA[1] = Math.max(0, Math.min(h, rootA[1]));
    rootB[1] = Math.max(0, Math.min(h, rootB[1]));
    crest[1] = Math.max(0, Math.min(h, crest[1]));
    sections.push({ rootA, crest, rootB, scale });
  }

  for (let i = 1; i < sections.length; i += 1) {
    const prev = sections[i - 1];
    const curr = sections[i];
    if (prev.scale < 1e-3 && curr.scale < 1e-3) continue;
    pushQuad(positions, normals, prev.rootA, prev.crest, curr.crest, curr.rootA);
    pushQuad(positions, normals, prev.crest, prev.rootB, curr.rootB, curr.crest);
    pushQuad(positions, normals, prev.rootA, curr.rootA, curr.rootB, prev.rootB);
  }
}

/**
 * Fast procedural metric screw / shaft / thread-cutter mesh.
 * Pure JS — no OCCT/WASM — so inserting/updating stays interactive.
 */
export function buildMetricThreadedCylinder(
  params: ResolvedThreadParams,
  height: number,
  options: ThreadMeshOptions = {},
): MetricThreadSolidMesh {
  const clearance = Math.max(MIN_THREAD_CLEARANCE, Math.min(MAX_THREAD_CLEARANCE, options.clearance ?? 0));
  const part: ThreadMeshPart = options.part ?? "screw";
  const majorR = Math.max(0.35, params.majorDiameter / 2) + clearance;
  const pitch = Math.max(0.15, params.pitch);
  const depth = Math.min(params.depth || metricThreadDepth(pitch), Math.max(0.08, majorR * 0.45));
  const rootR = Math.max(0.2, majorR - depth);
  const shaftR = rootR;
  const h = Math.max(pitch * 1.05, height);
  const lefthand = params.handedness === "left" ? -1 : 1;

  const radialSegs = Math.max(
    MIN_THREAD_SIDES,
    Math.min(MAX_THREAD_SIDES, Math.round(options.sides ?? DEFAULT_THREAD_SIDES)),
  );
  const segsPerTurn = Math.max(8, Math.round(radialSegs * 0.45));
  const turns = h / pitch;
  const helixSegs = Math.max(8, Math.ceil(turns * segsPerTurn));
  const halfWidth = Math.min(pitch * 0.38, h * 0.45);
  const embed = Math.min(depth * 0.35, shaftR * 0.2);
  const toothRootR = Math.max(0.12, shaftR - embed);

  const positions: number[] = [];
  const normals: number[] = [];

  if (part === "screw" || part === "shaft") {
    pushCylinder(positions, normals, shaftR, h, radialSegs);
  }

  // Hole cutter / separated threads: include a clearance core so the screw body fits,
  // plus the helical tooth. Shaft-only skips the helix.
  if (part === "threads") {
    // Core clears the screw shank (root + clearance already in shaftR).
    pushCylinder(positions, normals, shaftR, h, radialSegs);
  }

  if (part === "screw" || part === "threads") {
    pushHelicalThreads(positions, normals, {
      majorR,
      toothRootR,
      pitch,
      height: h,
      halfWidth,
      lefthand,
      helixSegs,
    });
  }

  const pos = new Float32Array(positions);
  const nor = new Float32Array(normals);
  const triangleCount = Math.floor(pos.length / 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i;

  const outerR = part === "shaft" ? shaftR : majorR;

  return {
    positions: pos,
    normals: nor,
    indices,
    triangleCount,
    brep: "",
    width: outerR * 2,
    depth: outerR * 2,
    height: h,
  };
}
