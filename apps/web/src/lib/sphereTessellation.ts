import { defaultStepsForKind, getActiveDisplayQuality } from "@/lib/displayTessellation";

export const DEFAULT_SPHERE_STEPS = defaultStepsForKind("sphere", "smooth") ?? 64;

export function sphereTessellation(steps?: number) {
  const normalizedSteps = Math.max(6, Math.round(steps ?? defaultStepsForKind("sphere", getActiveDisplayQuality()) ?? DEFAULT_SPHERE_STEPS));

  return {
    widthSegments: Math.max(8, normalizedSteps * 2),
    heightSegments: Math.max(6, normalizedSteps),
  };
}
