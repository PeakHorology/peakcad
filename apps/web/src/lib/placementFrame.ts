import type { WorkplaneShape } from "@/types/sketchforge";

export type PlacementBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

function clean(value: number) {
  const rounded = Number(value.toFixed(4));
  return Math.abs(rounded) < 0.0005 ? 0 : rounded;
}

/** Translate a shape so its mesh bottom sits on the base workplane (Y = 0). */
export function dropPatchOntoFrame(
  shape: Pick<WorkplaneShape, "x" | "z" | "elevation">,
  bounds: PlacementBounds,
): Partial<WorkplaneShape> {
  return {
    elevation: clean((shape.elevation ?? 0) - bounds.minY),
  };
}
