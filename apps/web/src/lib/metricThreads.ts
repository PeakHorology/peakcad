export type MetricThreadDesignation =
  | "M2"
  | "M2.5"
  | "M3"
  | "M4"
  | "M5"
  | "M6"
  | "M8"
  | "M10"
  | "M12"
  | "M14"
  | "M16"
  | "M18"
  | "M20";

export type MetricThreadSpec = {
  designation: MetricThreadDesignation;
  /** Major diameter in mm. */
  majorDiameter: number;
  /** Coarse pitch in mm. */
  pitch: number;
};

/** ISO metric coarse series used by the Threads shape presets. */
export const METRIC_COARSE_THREADS: readonly MetricThreadSpec[] = [
  { designation: "M2", majorDiameter: 2, pitch: 0.4 },
  { designation: "M2.5", majorDiameter: 2.5, pitch: 0.45 },
  { designation: "M3", majorDiameter: 3, pitch: 0.5 },
  { designation: "M4", majorDiameter: 4, pitch: 0.7 },
  { designation: "M5", majorDiameter: 5, pitch: 0.8 },
  { designation: "M6", majorDiameter: 6, pitch: 1 },
  { designation: "M8", majorDiameter: 8, pitch: 1.25 },
  { designation: "M10", majorDiameter: 10, pitch: 1.5 },
  { designation: "M12", majorDiameter: 12, pitch: 1.75 },
  { designation: "M14", majorDiameter: 14, pitch: 2 },
  { designation: "M16", majorDiameter: 16, pitch: 2 },
  { designation: "M18", majorDiameter: 18, pitch: 2.5 },
  { designation: "M20", majorDiameter: 20, pitch: 2.5 },
] as const;

export type ThreadSide = "external" | "internal";
export type ThreadHandedness = "right" | "left";

export type ResolvedThreadParams = {
  designation?: MetricThreadDesignation;
  majorDiameter: number;
  pitch: number;
  length: number;
  /** Radial tooth depth (crest to root). */
  depth: number;
  side: ThreadSide;
  handedness: ThreadHandedness;
};

/** ISO 60° basic triangle height H = (√3/2)·P; engagement depth ≈ (5/8)·H. */
export function metricThreadDepth(pitch: number) {
  return 0.541266 * pitch;
}

export function metricThreadMinorDiameter(majorDiameter: number, pitch: number) {
  return Math.max(0.1, majorDiameter - 1.082532 * pitch);
}

export function findMetricThread(designation: string): MetricThreadSpec | undefined {
  return METRIC_COARSE_THREADS.find((entry) => entry.designation === designation);
}

export function nearestMetricThreadForDiameter(diameter: number): MetricThreadSpec {
  let best = METRIC_COARSE_THREADS[0];
  let bestError = Math.abs(best.majorDiameter - diameter);
  for (const entry of METRIC_COARSE_THREADS) {
    const error = Math.abs(entry.majorDiameter - diameter);
    if (error < bestError) {
      best = entry;
      bestError = error;
    }
  }
  return best;
}

export function resolveThreadParams(input: {
  designation?: string | null;
  majorDiameter?: number;
  pitch?: number;
  length: number;
  depth?: number;
  side: ThreadSide;
  handedness?: ThreadHandedness;
}): ResolvedThreadParams {
  const preset = input.designation ? findMetricThread(input.designation) : undefined;
  const majorDiameter = Math.max(0.5, input.majorDiameter ?? preset?.majorDiameter ?? 3);
  const pitch = Math.max(0.1, input.pitch ?? preset?.pitch ?? 0.5);
  const length = Math.max(pitch, input.length);
  const depth = Math.max(0.05, input.depth ?? metricThreadDepth(pitch));
  return {
    designation: preset?.designation,
    majorDiameter,
    pitch,
    length,
    depth,
    side: input.side,
    handedness: input.handedness === "left" ? "left" : "right",
  };
}

/**
 * Infer external vs internal from a cylindrical face normal vs solid interior.
 * If the face normal points toward the solid center of mass, the face is a hole wall.
 */
export function inferThreadSideFromFace(options: {
  faceCenter: { x: number; y: number; z: number };
  outwardNormal: { x: number; y: number; z: number };
  solidCenter: { x: number; y: number; z: number };
}): ThreadSide {
  const toSolid = {
    x: options.solidCenter.x - options.faceCenter.x,
    y: options.solidCenter.y - options.faceCenter.y,
    z: options.solidCenter.z - options.faceCenter.z,
  };
  const dot =
    options.outwardNormal.x * toSolid.x +
    options.outwardNormal.y * toSolid.y +
    options.outwardNormal.z * toSolid.z;
  return dot > 0 ? "internal" : "external";
}
