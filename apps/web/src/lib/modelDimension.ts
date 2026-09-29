export const MIN_SHAPE_DIMENSION = 0.01;
export const MODEL_DIMENSION_PRECISION = 3;

export function cleanModelDimension(value: number) {
  return Math.max(MIN_SHAPE_DIMENSION, Number(value.toFixed(MODEL_DIMENSION_PRECISION)));
}
