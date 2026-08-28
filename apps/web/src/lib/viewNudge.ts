import * as THREE from "three";

export type ViewNudgeAxes = {
  rightX: number;
  rightZ: number;
  upX: number;
  upZ: number;
};

export const DEFAULT_VIEW_NUDGE_AXES: ViewNudgeAxes = {
  rightX: 1,
  rightZ: 0,
  upX: 0,
  upZ: -1,
};

function projectToGroundAxis(vector: THREE.Vector3, fallback: THREE.Vector3) {
  const projected = vector.clone();
  projected.y = 0;
  if (projected.lengthSq() < 0.0001) {
    return fallback.clone();
  }
  return projected.normalize();
}

/**
 * Screen-aligned move axes on the workplane (XZ).
 * - Right = camera right flattened onto the ground
 * - Up = toward the top of the screen along the ground (camera forward),
 *   not camera-up (which collapses when looking down)
 */
export function computeViewNudgeAxes(camera: THREE.Camera): ViewNudgeAxes {
  camera.updateMatrixWorld();

  const cameraRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const cameraForward = new THREE.Vector3();
  camera.getWorldDirection(cameraForward);

  const groundRight = projectToGroundAxis(cameraRight, new THREE.Vector3(1, 0, 0));
  // Top of the view on the workplane = further along the look direction.
  let groundUp = projectToGroundAxis(cameraForward, new THREE.Vector3(0, 0, -1));

  // Keep Up perpendicular to Right so Left/Right and Up/Down never shear into each other.
  groundUp.sub(groundRight.clone().multiplyScalar(groundUp.dot(groundRight)));
  if (groundUp.lengthSq() < 0.0001) {
    groundUp = projectToGroundAxis(new THREE.Vector3(-groundRight.z, 0, groundRight.x), new THREE.Vector3(0, 0, -1));
  } else {
    groundUp.normalize();
  }

  return {
    rightX: groundRight.x,
    rightZ: groundRight.z,
    upX: groundUp.x,
    upZ: groundUp.z,
  };
}

/**
 * Map a screen nudge onto a single world-grid cardinal (±X or ±Z).
 * Camera orientation chooses *which* axis feels like left/right/up/down,
 * but movement never drifts diagonally across the workplane grid.
 */
export function viewNudgeDelta(axes: ViewNudgeAxes, screenRight: number, screenUp: number, step: number) {
  const dx = screenRight * axes.rightX + screenUp * axes.upX;
  const dz = screenRight * axes.rightZ + screenUp * axes.upZ;
  if (Math.abs(dx) < 1e-8 && Math.abs(dz) < 1e-8) {
    return { deltaX: 0, deltaZ: 0 };
  }

  // Nearest workplane cardinal: prefer the stronger component (ties → X).
  if (Math.abs(dx) >= Math.abs(dz)) {
    return { deltaX: Math.sign(dx) * step, deltaZ: 0 };
  }
  return { deltaX: 0, deltaZ: Math.sign(dz) * step };
}
