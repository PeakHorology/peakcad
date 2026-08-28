import { createLocalId } from "@/lib/localIds";
import {
  findMetricThread,
  resolveThreadParams,
  type MetricThreadDesignation,
} from "@/lib/metricThreads";
import {
  buildMetricThreadedCylinder,
  DEFAULT_THREAD_CLEARANCE,
  DEFAULT_THREAD_SIDES,
  MAX_THREAD_CLEARANCE,
  MAX_THREAD_SIDES,
  MIN_THREAD_CLEARANCE,
  MIN_THREAD_SIDES,
  type ThreadMeshPart,
} from "@/lib/metricThreadSolid";
import { canonicalizeShape, withHoleMode } from "@/lib/workplaneShapes";
import type { WorkplaneShape } from "@/types/sketchforge";

export const DEFAULT_THREAD_DESIGNATION: MetricThreadDesignation = "M6";
export const DEFAULT_THREAD_HEIGHT = 20;

export type ThreadStyle = "screw" | "hole";

export type ThreadShapeSpec = {
  designation: MetricThreadDesignation;
  majorDiameter: number;
  pitch: number;
  /** screw = solid fastener; hole = clearance cutter for tapping a receiving hole. */
  style?: ThreadStyle;
  /** Radial clearance in mm (applied to hole cutters / loose fit). */
  clearance?: number;
  /** After Separate: shaft-only or threads-only piece. */
  part?: ThreadMeshPart;
};

function clampThreadSides(sides?: number) {
  const value = Math.round(sides ?? DEFAULT_THREAD_SIDES);
  return Math.max(MIN_THREAD_SIDES, Math.min(MAX_THREAD_SIDES, value));
}

function clampThreadClearance(clearance?: number) {
  const value = Number.isFinite(clearance) ? Number(clearance) : 0;
  return Math.max(MIN_THREAD_CLEARANCE, Math.min(MAX_THREAD_CLEARANCE, value));
}

export function threadSpecForDesignation(designation: MetricThreadDesignation): ThreadShapeSpec {
  const preset = findMetricThread(designation) ?? findMetricThread(DEFAULT_THREAD_DESIGNATION)!;
  return {
    designation: preset.designation,
    majorDiameter: preset.majorDiameter,
    pitch: preset.pitch,
    style: "screw",
    clearance: 0,
    part: "screw",
  };
}

function normalizeThreadSpec(input?: Partial<ThreadShapeSpec> | WorkplaneShape["threadSpec"] | null): ThreadShapeSpec {
  const designation = (findMetricThread(input?.designation ?? DEFAULT_THREAD_DESIGNATION)?.designation
    ?? DEFAULT_THREAD_DESIGNATION) as MetricThreadDesignation;
  const base = threadSpecForDesignation(designation);
  const style: ThreadStyle = input?.style === "hole" ? "hole" : "screw";
  const part: ThreadMeshPart =
    input?.part === "shaft" || input?.part === "threads" || input?.part === "screw"
      ? input.part
      : style === "hole"
        ? "threads"
        : "screw";
  const clearance = clampThreadClearance(
    input?.clearance ?? (style === "hole" || part === "threads" ? DEFAULT_THREAD_CLEARANCE : 0),
  );
  return {
    // The designation is authoritative: diameter and pitch always come from its preset.
    // Honouring carried-forward values here let a size-driven re-designation relabel an
    // M6 as M8 while keeping 6mm/1.0mm geometry, so the label described a different screw
    // than the solid.
    designation: base.designation,
    majorDiameter: base.majorDiameter,
    pitch: base.pitch,
    style,
    clearance,
    part,
  };
}

function meshPartForSpec(spec: ThreadShapeSpec): ThreadMeshPart {
  if (spec.part === "shaft" || spec.part === "threads") return spec.part;
  return spec.style === "hole" ? "threads" : "screw";
}

function shapeNameForSpec(spec: ThreadShapeSpec, fallback?: string) {
  if (fallback && !fallback.startsWith("Threads") && !fallback.startsWith("Shaft") && !fallback.startsWith("Thread cutter")) {
    return fallback;
  }
  if (spec.part === "shaft") return `Shaft ${spec.designation}`;
  if (spec.style === "hole" || spec.part === "threads") return `Thread cutter ${spec.designation}`;
  return `Threads ${spec.designation}`;
}

/** Instant procedural metric screw / shaft / hole-cutter (no WASM). */
export function createThreadShape(options: {
  designation?: MetricThreadDesignation;
  height?: number;
  point?: { x: number; z: number; elevation?: number };
  base?: Partial<WorkplaneShape> & Pick<WorkplaneShape, "id" | "name" | "color">;
}): WorkplaneShape {
  const height = Math.max(0.5, options.height ?? options.base?.height ?? DEFAULT_THREAD_HEIGHT);
  const sides = clampThreadSides(options.base?.sides);
  const prior = options.base?.threadSpec;
  const spec = normalizeThreadSpec({
    designation: options.designation
      ?? (prior?.designation as MetricThreadDesignation | undefined),
    majorDiameter: prior?.majorDiameter,
    pitch: prior?.pitch,
    style: prior?.style,
    clearance: prior?.clearance,
    part: prior?.part,
  });
  const part = meshPartForSpec(spec);
  const params = resolveThreadParams({
    designation: spec.designation,
    majorDiameter: spec.majorDiameter,
    pitch: spec.pitch,
    length: height,
    side: "external",
    handedness: "right",
  });
  const useClearance = part === "threads" || spec.style === "hole";
  const clearance = useClearance ? clampThreadClearance(spec.clearance) : 0;
  const mesh = buildMetricThreadedCylinder(params, height, {
    sides,
    clearance,
    part,
  });
  const x = options.point?.x ?? options.base?.x ?? 0;
  const z = options.point?.z ?? options.base?.z ?? 0;
  const elevation = options.point?.elevation ?? options.base?.elevation ?? 0;
  const id = options.base?.id ?? createLocalId("thread");
  const asHole = useClearance || Boolean(options.base?.hole && useClearance);
  const color = asHole ? "#b8c2cc" : (options.base?.color ?? "#d97813");
  const name = shapeNameForSpec({ ...spec, clearance, style: useClearance ? "hole" : "screw", part }, options.base?.name);

  const shape = canonicalizeShape({
    id,
    name,
    kind: "thread",
    color,
    hole: asHole || undefined,
    x,
    z,
    elevation,
    size: Math.max(mesh.width, mesh.depth),
    width: mesh.width,
    depth: mesh.depth,
    height: mesh.height,
    sides,
    rotation: options.base?.rotation ?? 0,
    rotationX: options.base?.rotationX ?? 0,
    rotationZ: options.base?.rotationZ ?? 0,
    mirrorX: options.base?.mirrorX,
    mirrorY: options.base?.mirrorY,
    mirrorZ: options.base?.mirrorZ,
    locked: options.base?.locked ?? false,
    hidden: options.base?.hidden ?? false,
    threadSpec: {
      designation: spec.designation,
      majorDiameter: spec.majorDiameter,
      pitch: spec.pitch,
      style: useClearance ? "hole" : "screw",
      clearance,
      part: useClearance ? "threads" : part === "shaft" ? "shaft" : "screw",
    },
    importedMesh: {
      positions: Array.from(mesh.positions),
      normals: Array.from(mesh.normals),
      baseWidth: mesh.width,
      baseDepth: mesh.depth,
      baseHeight: mesh.height,
      triangleCount: mesh.triangleCount,
      sourceFormat: "json",
    },
    cadBrep: undefined,
    cadBrepFrame: undefined,
    cadPrimitiveFrame: undefined,
    cadDisplayEdges: undefined,
    cadDisplayEdgesVersion: undefined,
  });

  return asHole ? withHoleMode(shape, true) : shape;
}

/** True when a Threads screw can be split into shaft + thread cutter. */
export function canSeparateThreadScrew(shape: WorkplaneShape) {
  if (shape.kind !== "thread" || shape.locked || shape.hole) return false;
  const part = shape.threadSpec?.part ?? "screw";
  const style = shape.threadSpec?.style ?? "screw";
  return part === "screw" && style === "screw";
}

/**
 * Split a screw into a solid shaft and a hole-ready thread cutter (with clearance).
 */
export function separateThreadScrewParts(shape: WorkplaneShape): WorkplaneShape[] {
  if (!canSeparateThreadScrew(shape)) return [];
  const designation = (findMetricThread(shape.threadSpec?.designation ?? DEFAULT_THREAD_DESIGNATION)?.designation
    ?? DEFAULT_THREAD_DESIGNATION) as MetricThreadDesignation;
  const clearance = clampThreadClearance(shape.threadSpec?.clearance || DEFAULT_THREAD_CLEARANCE);
  const shared = {
    height: shape.height,
    point: { x: shape.x, z: shape.z, elevation: shape.elevation },
  };

  const shaft = createThreadShape({
    ...shared,
    designation,
    base: {
      id: createLocalId("thread-shaft"),
      name: `Shaft ${designation}`,
      color: shape.color,
      sides: shape.sides,
      rotation: shape.rotation,
      rotationX: shape.rotationX,
      rotationZ: shape.rotationZ,
      mirrorX: shape.mirrorX,
      mirrorY: shape.mirrorY,
      mirrorZ: shape.mirrorZ,
      threadSpec: {
        designation,
        majorDiameter: shape.threadSpec?.majorDiameter ?? 6,
        pitch: shape.threadSpec?.pitch ?? 1,
        style: "screw",
        clearance: 0,
        part: "shaft",
      },
      hole: false,
    },
  });

  const cutter = createThreadShape({
    ...shared,
    designation,
    base: {
      id: createLocalId("thread-cutter"),
      name: `Thread cutter ${designation}`,
      color: "#b8c2cc",
      sides: shape.sides,
      rotation: shape.rotation,
      rotationX: shape.rotationX,
      rotationZ: shape.rotationZ,
      mirrorX: shape.mirrorX,
      mirrorY: shape.mirrorY,
      mirrorZ: shape.mirrorZ,
      threadSpec: {
        designation,
        majorDiameter: shape.threadSpec?.majorDiameter ?? 6,
        pitch: shape.threadSpec?.pitch ?? 1,
        style: "hole",
        clearance,
        part: "threads",
      },
      hole: true,
    },
  });

  // Nudge the cutter slightly so both remain selectable after split.
  return [
    shaft,
    canonicalizeShape({ ...cutter, x: cutter.x + 0.01 }),
  ];
}
