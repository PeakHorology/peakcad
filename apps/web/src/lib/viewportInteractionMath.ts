import * as THREE from "three";
import type { GridSize, WorkplaneShape } from "@/types/sketchforge";
import type { RotationAxis, RotationReadout, RotationWheelView, TransformHandleKind } from "@/components/workplane/TransformOverlay";
import { hardwareProfile } from "@/lib/desktopHardware";
import { cleanRotationDegrees } from "@/lib/workplaneShapes";
import type { DragState, SelectionFrame, ThreeState } from "@/components/WorkplaneViewport";

const MIN_SHAPE_SIZE = 0.01;

export function isVerticalMeasureHandleKind(kind: TransformHandleKind) {
  return kind === "height" || kind === "lift";
}

/** Pose-free fingerprint so a drag that only moves X/Z does not remesh Three.js objects. */
export function shapesInteractionFingerprint(shapes: WorkplaneShape[]) {
  return shapes.map((shape) => [
    shape.id,
    shape.csg?.version ?? 0,
    shape.importedMesh?.triangleCount ?? 0,
    shape.importedMesh?.positions.length ?? 0,
    shape.width,
    shape.depth,
    shape.height,
    shape.rotation,
    shape.rotationX ?? 0,
    shape.rotationZ ?? 0,
    shape.kind,
  ].join(":")).join("|");
}

export function previewShapesForDrag(shapes: WorkplaneShape[], drag: DragState | null) {
  if (!drag) {
    return shapes;
  }
  const previewById = new Map(drag.items.map((item) => [item.id, item]));
  return shapes.map((shape) => {
    const preview = previewById.get(shape.id);
    return preview ? { ...shape, x: preview.nextX, z: preview.nextZ } : shape;
  });
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function snapStep(size: GridSize) {
  if (size === "Off") {
    return 0;
  }
  if (size === "Brick") {
    return 8;
  }
  return Number.parseFloat(size) || 1;
}

export function snapValue(value: number, step: number) {
  return step > 0 ? Math.round(value / step) * step : value;
}

export function snapDimension(value: number, step: number, min = MIN_SHAPE_SIZE, max = 220) {
  const snapped = step > 0 ? snapValue(value, step) : value;
  const effectiveMin = step > 0 ? Math.max(min, Math.min(step, max)) : min;
  return clamp(snapped, effectiveMin, max);
}

export function snapPositionValue(value: number, step: number, min: number, max: number) {
  return clamp(step > 0 ? snapValue(value, step) : value, min, max);
}

export function projectedScreenY(state: ThreeState, shape: WorkplaneShape, y: number) {
  return projectedScreenYAt(state, shape.x, shape.z, y);
}

export function projectedScreenYAt(state: ThreeState, x: number, z: number, y: number) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.camera.updateMatrixWorld();
  const projected = new THREE.Vector3(x, y, z).project(state.camera);
  return ((1 - projected.y) / 2) * rect.height;
}

export function projectedScreenYPerWorldUnit(state: ThreeState, shape: WorkplaneShape, y: number) {
  return projectedScreenYPerWorldUnitAt(state, shape.x, shape.z, y);
}

export function projectedScreenYPerWorldUnitAt(state: ThreeState, x: number, z: number, y: number) {
  const sample = 8;
  const start = projectedScreenYAt(state, x, z, y);
  const end = projectedScreenYAt(state, x, z, y + sample);
  const slope = (end - start) / sample;
  return Math.abs(slope) > 0.01 ? slope : -3.2;
}

export function screenAngle(clientX: number, clientY: number, center: { x: number; y: number }) {
  return Math.atan2(clientY - center.y, clientX - center.x);
}

export function unwrapRadians(value: number) {
  if (value > Math.PI) {
    return value - Math.PI * 2;
  }
  if (value < -Math.PI) {
    return value + Math.PI * 2;
  }
  return value;
}

export function rotationAxisForHandle(handleKey: string): RotationAxis {
  if (handleKey === "rotate-tilt") {
    return "x";
  }
  if (handleKey.endsWith("-x") || handleKey === "rotate-left" || handleKey === "rotate-x") {
    return "x";
  }
  if (handleKey.endsWith("-z") || handleKey === "rotate-right" || handleKey === "rotate-z") {
    return "z";
  }
  return "y";
}

export function axisScreenHorizontality(state: ThreeState, origin: THREE.Vector3, axis: THREE.Vector3) {
  const direction = axis.clone();
  if (direction.lengthSq() < 0.0001) {
    return 0;
  }
  direction.normalize().multiplyScalar(8);
  const a = projectToScreen(origin, state);
  const b = projectToScreen(origin.clone().add(direction), state);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) {
    return 0;
  }
  return Math.abs(dx) / length;
}

export function cameraFacingTiltAxis(state: ThreeState, frame: SelectionFrame): RotationAxis {
  const origin = frame.center;
  const xHorizontality = axisScreenHorizontality(state, origin, frame.xAxis);
  const zHorizontality = axisScreenHorizontality(state, origin, frame.zAxis);
  // Prefer the axis that is less screen-horizontal so X/Z tilt appear when
  // viewing from the opposite side compared with the previous mapping.
  if (Math.abs(xHorizontality - zHorizontality) < 0.04) {
    const cameraRight = new THREE.Vector3();
    state.camera.updateMatrixWorld();
    cameraRight.setFromMatrixColumn(state.camera.matrixWorld, 0).normalize();
    const xAxis = frame.xAxis.clone().normalize();
    const zAxis = frame.zAxis.clone().normalize();
    return Math.abs(xAxis.dot(cameraRight)) >= Math.abs(zAxis.dot(cameraRight)) ? "z" : "x";
  }
  return xHorizontality >= zHorizontality ? "z" : "x";
}

export function resolveRotationAxis(handleKey: string, state: ThreeState | null, frame: SelectionFrame | null): RotationAxis {
  if (handleKey === "rotate-tilt") {
    return state && frame ? cameraFacingTiltAxis(state, frame) : "x";
  }
  return rotationAxisForHandle(handleKey);
}

export function rotationValueForAxis(shape: WorkplaneShape, axis: RotationAxis) {
  if (axis === "x") {
    return shape.rotationX ?? 0;
  }
  if (axis === "z") {
    return shape.rotationZ ?? 0;
  }
  return shape.rotation;
}

export function rotationSnapModeAtPointer(wheel: RotationWheelView | undefined, localX: number, localY: number): "stepped" | "free" {
  if (!wheel) {
    return "free";
  }
  const distance = Math.hypot(localX - wheel.x, localY - wheel.y);
  // Inner circle = indexed/snappy steps; outside that circle = free rotation.
  return distance <= wheel.innerRadius ? "stepped" : "free";
}

/** Screen atan2 → protractor degrees (0 = up, clockwise positive). */
export function protractorAngleFromPointer(localX: number, localY: number, center: { x: number; y: number }) {
  return THREE.MathUtils.radToDeg(screenAngle(localX, localY, center)) + 90;
}

export function rotationReadoutAtPointer(
  wheel: RotationWheelView | undefined,
  localX: number,
  localY: number,
  delta: number,
  startPointerAngle?: number,
): RotationReadout {
  const snapMode = rotationSnapModeAtPointer(wheel, localX, localY);
  const readoutText = delta % 1 === 0 ? `${delta}°` : `${Number(delta.toFixed(1))}°`;
  const pointerCenter = wheel ?? { x: localX, y: localY };
  const pointerAngle = protractorAngleFromPointer(localX, localY, pointerCenter);
  return {
    x: snapMode === "stepped" && wheel ? wheel.x : localX + 14,
    y: snapMode === "stepped" && wheel ? wheel.y - 80 : localY - 14,
    text: readoutText,
    angle: delta,
    pointerAngle,
    startPointerAngle: startPointerAngle ?? pointerAngle,
    snapMode,
  };
}

export function rotationPatchForAxis(axis: RotationAxis, value: number): Partial<WorkplaneShape> {
  const normalized = cleanRotationDegrees(value);
  if (axis === "x") {
    return { rotationX: normalized };
  }
  if (axis === "z") {
    return { rotationZ: normalized };
  }
  return { rotation: normalized };
}

export function quaternionForShape(shape: WorkplaneShape) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(shape.rotationX ?? 0),
      THREE.MathUtils.degToRad(shape.rotation),
      THREE.MathUtils.degToRad(shape.rotationZ ?? 0),
      "XYZ",
    ),
  );
}

export function rotationPatchFromQuaternion(quaternion: THREE.Quaternion): Partial<WorkplaneShape> {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return {
    rotationX: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.x)),
    rotation: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.y)),
    rotationZ: cleanRotationDegrees(THREE.MathUtils.radToDeg(euler.z)),
  };
}

export function shouldPreserveDrawingBufferForLocalAutomation() {
  // Capture paths render immediately before toDataURL, so the buffer does not
  // need to be preserved every frame (expensive on discrete GPUs).
  return hardwareProfile().preserveDrawingBuffer;
}

export function rotationScreenSign(axisVector: THREE.Vector3, camera: THREE.Camera) {
  const cameraForward = camera.getWorldDirection(new THREE.Vector3());
  return axisVector.dot(cameraForward) >= 0 ? 1 : -1;
}

export function projectToScreen(point: THREE.Vector3, state: ThreeState) {
  const rect = state.renderer.domElement.getBoundingClientRect();
  state.camera.updateMatrixWorld();
  const projected = point.clone().project(state.camera);
  return {
    x: ((projected.x + 1) / 2) * rect.width,
    y: ((1 - projected.y) / 2) * rect.height,
  };
}

export function rulerShapeDimensions(object: THREE.Object3D) {
  const dimensions = object.userData.rulerDimensions as [number, number, number] | undefined;
  return dimensions ?? [1, 1, 1];
}

export function rulerShapeTopologyKey(shape: WorkplaneShape): string {
  const positions = shape.importedMesh?.positions ?? [];
  const positionSample = positions.length > 0
    ? Array.from({ length: Math.min(12, positions.length) }, (_, index) => positions[Math.floor(index * (positions.length - 1) / Math.max(1, Math.min(12, positions.length) - 1))]?.toFixed(4) ?? "0").join(",")
    : "";
  const brep = shape.cadBrep ?? "";
  const brepSample = brep.length > 0
    ? Array.from({ length: Math.min(8, brep.length) }, (_, index) => brep.charCodeAt(Math.floor(index * (brep.length - 1) / Math.max(1, Math.min(8, brep.length) - 1)))).join(",")
    : "";
  return JSON.stringify({
    kind: shape.kind,
    radius: shape.radius,
    steps: shape.steps,
    sides: shape.sides,
    bevel: shape.bevel,
    segments: shape.segments,
    topRadius: shape.topRadius,
    baseRadius: shape.baseRadius,
    leftAngle: shape.leftAngle,
    rightAngle: shape.rightAngle,
    text: shape.text,
    font: shape.font,
    mesh: [positions.length, positionSample],
    brep: [brep.length, brepSample],
    treatments: shape.edgeTreatments,
    children: shape.groupedShapes?.map((child) => [child.id, rulerShapeTopologyKey(child)]),
  });
}
