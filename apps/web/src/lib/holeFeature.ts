import type { WorkplaneShape } from "@/types/sketchforge";

export function isConstructionShape(shape: Pick<WorkplaneShape, "construction"> | null | undefined) {
  return Boolean(shape?.construction);
}
