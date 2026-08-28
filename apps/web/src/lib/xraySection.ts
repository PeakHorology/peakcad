import type { WorkplaneShape } from "@/types/sketchforge";

const SECTION_PADDING = 4;

export function xrayHeightBounds(shapes: WorkplaneShape[]) {
  let minBottom = 0;
  let maxTop = 20;
  for (const shape of shapes) {
    if (shape.hidden) {
      continue;
    }
    const bottom = shape.elevation ?? 0;
    minBottom = Math.min(minBottom, bottom);
    maxTop = Math.max(maxTop, bottom + shape.height);
  }
  return {
    min: Math.min(0, Math.floor(minBottom - SECTION_PADDING)),
    max: Math.max(24, Math.ceil(maxTop + SECTION_PADDING)),
  };
}
