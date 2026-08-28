/** Triangle/roof cross-section helpers. Angles are interior base angles (degrees). */

const MIN_ANGLE = 1;
const MAX_ANGLE = 179;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function interiorAngleDegrees(
  origin: { x: number; y: number },
  pointA: { x: number; y: number },
  pointB: { x: number; y: number },
) {
  const ux = pointA.x - origin.x;
  const uy = pointA.y - origin.y;
  const vx = pointB.x - origin.x;
  const vy = pointB.y - origin.y;
  const du = Math.hypot(ux, uy);
  const dv = Math.hypot(vx, vy);
  if (du < 1e-9 || dv < 1e-9) {
    return 90;
  }
  const cos = clamp((ux * vx + uy * vy) / (du * dv), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Peak X from a left base interior angle, keeping width/height fixed. */
export function roofRidgeXFromLeftAngle(width: number, height: number, leftAngleDeg: number) {
  const safeWidth = Math.max(0.01, width);
  const safeHeight = Math.max(0.01, height);
  const left = -safeWidth / 2;
  const angle = clamp(leftAngleDeg, MIN_ANGLE, MAX_ANGLE);
  if (Math.abs(angle - 90) < 1e-6) {
    return left;
  }
  const radians = (angle * Math.PI) / 180;
  const tan = Math.tan(radians);
  if (!Number.isFinite(tan) || Math.abs(tan) < 1e-9) {
    return left;
  }
  // Ray from left base at interior angle `angle` from the base; peak sits at y=height.
  return left + safeHeight / tan;
}

export function roofRidgeXFromRightAngle(width: number, height: number, rightAngleDeg: number) {
  const safeWidth = Math.max(0.01, width);
  const safeHeight = Math.max(0.01, height);
  const right = safeWidth / 2;
  const angle = clamp(rightAngleDeg, MIN_ANGLE, MAX_ANGLE);
  if (Math.abs(angle - 90) < 1e-6) {
    return right;
  }
  const radians = (angle * Math.PI) / 180;
  const tan = Math.tan(radians);
  if (!Number.isFinite(tan) || Math.abs(tan) < 1e-9) {
    return right;
  }
  return right - safeHeight / tan;
}

export function roofAnglesFromRidge(width: number, height: number, ridgeX: number) {
  const safeWidth = Math.max(0.01, width);
  const safeHeight = Math.max(0.01, height);
  const left = { x: -safeWidth / 2, y: 0 };
  const right = { x: safeWidth / 2, y: 0 };
  const peak = { x: ridgeX, y: safeHeight };
  return {
    leftAngle: interiorAngleDegrees(left, right, peak),
    rightAngle: interiorAngleDegrees(right, left, peak),
    apexAngle: interiorAngleDegrees(peak, left, right),
    ridgeX,
  };
}

/** Clamp ridge so both base angles stay within (1°, 179°). */
export function clampRoofRidgeX(width: number, height: number, ridgeX: number) {
  // Both bounds used to come from the left angle, so the allowed span was centred on the left
  // base corner rather than on the shape and the right angle was never constrained — a symmetric
  // 66 x 0.5mm triangle was shoved 4.6mm off centre. Intersect the two intervals instead.
  const leftBounds = [
    roofRidgeXFromLeftAngle(width, height, MAX_ANGLE - 0.01),
    roofRidgeXFromLeftAngle(width, height, MIN_ANGLE + 0.01),
  ];
  const rightBounds = [
    roofRidgeXFromRightAngle(width, height, MAX_ANGLE - 0.01),
    roofRidgeXFromRightAngle(width, height, MIN_ANGLE + 0.01),
  ];
  const lo = Math.max(Math.min(...leftBounds), Math.min(...rightBounds));
  const hi = Math.min(Math.max(...leftBounds), Math.max(...rightBounds));
  if (lo > hi) {
    // Very wide and very flat: no apex keeps both base angles above 1°, so honour the symmetry
    // the user drew rather than skewing the roof to satisfy one side.
    return 0;
  }
  return clamp(ridgeX, lo, hi);
}

/**
 * Resolve the triangle peak from stored angles + current size.
 * Height/width stay as given; angles only slide the peak horizontally.
 */
export function roofAnglesFromProfile(width: number, height: number, leftAngle?: number, rightAngle?: number) {
  const safeWidth = Math.max(0.01, width);
  const safeHeight = Math.max(0.01, height);
  let ridgeX = 0;
  if (typeof leftAngle === "number") {
    ridgeX = roofRidgeXFromLeftAngle(safeWidth, safeHeight, leftAngle);
  } else if (typeof rightAngle === "number") {
    ridgeX = roofRidgeXFromRightAngle(safeWidth, safeHeight, rightAngle);
  } else {
    ridgeX = 0;
  }
  ridgeX = clampRoofRidgeX(safeWidth, safeHeight, ridgeX);
  const angles = roofAnglesFromRidge(safeWidth, safeHeight, ridgeX);
  return {
    leftAngle: angles.leftAngle,
    rightAngle: angles.rightAngle,
    apexAngle: angles.apexAngle,
    ridgeX: angles.ridgeX,
    leftRun: angles.ridgeX + safeWidth / 2,
    rightRun: safeWidth / 2 - angles.ridgeX,
  };
}
