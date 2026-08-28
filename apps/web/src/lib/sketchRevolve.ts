import * as THREE from "three";
import { createLocalId } from "@/lib/localIds";
import { sketchProfileToDoc } from "@/lib/sketch/migrate";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import type { SketchPoint, SketchProfile, SketchSegment, WorkplaneShape } from "@/types/sketchforge";

export type SketchRevolveAxis = {
  start: { x: number; z: number };
  end: { x: number; z: number };
};

type OrderedStep = { segment: SketchSegment; from: SketchPoint; to: SketchPoint };
type OrderedPath = { points: SketchPoint[]; steps: OrderedStep[]; closed: boolean };

function cloneSketchProfile(profile: SketchProfile): SketchProfile {
  return {
    points: profile.points.map((point) => ({
      ...point,
      handleIn: point.handleIn ? { ...point.handleIn } : undefined,
      handleOut: point.handleOut ? { ...point.handleOut } : undefined,
    })),
    segments: profile.segments.map((segment) => ({ ...segment })),
    images: (profile.images ?? []).map((image) => ({ ...image })),
  };
}

function orderedSketchPaths(profile: SketchProfile): OrderedPath[] {
  const pointById = new Map(profile.points.map((point) => [point.id, point]));
  const adjacency = new Map<string, Array<{ pointId: string; segment: SketchSegment }>>();
  profile.points.forEach((point) => adjacency.set(point.id, []));
  const validSegments = profile.segments.filter((segment) => {
    if (!pointById.has(segment.startId) || !pointById.has(segment.endId) || segment.startId === segment.endId) return false;
    adjacency.get(segment.startId)?.push({ pointId: segment.endId, segment });
    adjacency.get(segment.endId)?.push({ pointId: segment.startId, segment });
    return true;
  });
  const unvisited = new Set(validSegments.map((segment) => segment.id));
  const paths: OrderedPath[] = [];
  while (unvisited.size > 0) {
    const seedId = unvisited.values().next().value as string | undefined;
    const seed = validSegments.find((segment) => segment.id === seedId);
    if (!seed) break;
    const componentIds = new Set<string>();
    const queue = [seed.startId, seed.endId];
    while (queue.length > 0) {
      const id = queue.pop();
      if (!id || componentIds.has(id)) continue;
      componentIds.add(id);
      adjacency.get(id)?.forEach((entry) => queue.push(entry.pointId));
    }
    const startId = [...componentIds].find((id) => (adjacency.get(id)?.filter((entry) => unvisited.has(entry.segment.id)).length ?? 0) === 1) ?? seed.startId;
    const first = pointById.get(startId);
    if (!first) {
      unvisited.delete(seed.id);
      continue;
    }
    const points = [first];
    const steps: OrderedStep[] = [];
    let currentId = startId;
    for (let guard = 0; guard <= validSegments.length; guard += 1) {
      const edge = adjacency.get(currentId)?.find((entry) => unvisited.has(entry.segment.id));
      if (!edge) break;
      const from = pointById.get(currentId);
      const to = pointById.get(edge.pointId);
      if (!from || !to) break;
      unvisited.delete(edge.segment.id);
      steps.push({ segment: edge.segment, from, to });
      currentId = to.id;
      if (currentId === startId) break;
      points.push(to);
    }
    paths.push({ points, steps, closed: currentId === startId && steps.length >= 3 });
  }
  return paths;
}

function cubicPoint(
  start: SketchPoint,
  first: { x: number; z: number },
  second: { x: number; z: number },
  end: SketchPoint,
  amount: number,
) {
  const inverse = 1 - amount;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * amount * first.x + 3 * inverse * amount ** 2 * second.x + amount ** 3 * end.x,
    z: inverse ** 3 * start.z + 3 * inverse ** 2 * amount * first.z + 3 * inverse * amount ** 2 * second.z + amount ** 3 * end.z,
  };
}

/** Dense polyline samples of a closed sketch path in the XZ plane. */
function sampleClosedPath(path: OrderedPath): Array<{ x: number; z: number }> {
  const samples: Array<{ x: number; z: number }> = [];
  path.steps.forEach(({ segment, from, to }, stepIndex) => {
    if (stepIndex === 0) samples.push({ x: from.x, z: from.z });
    const forward = segment.startId === from.id;
    const control1 = forward ? from.handleOut : from.handleIn;
    const control2 = forward ? to.handleIn : to.handleOut;
    const curved = segment.kind !== "line" && control1 && control2;
    if (curved) {
      const steps = 12;
      for (let index = 1; index <= steps; index += 1) {
        samples.push(cubicPoint(from, control1, control2, to, index / steps));
      }
    } else {
      samples.push({ x: to.x, z: to.z });
    }
  });
  if (samples.length > 1) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) > 1e-6) {
      samples.push({ ...first });
    }
  }
  return samples;
}

function pathArea(samples: Array<{ x: number; z: number }>) {
  let area = 0;
  for (let index = 0, previous = samples.length - 1; index < samples.length; previous = index, index += 1) {
    area += samples[previous].x * samples[index].z - samples[index].x * samples[previous].z;
  }
  return Math.abs(area) * 0.5;
}

export function resolveSketchRevolveAxis(
  profile: SketchProfile,
  selection: { kind: string; id?: string } | null,
): SketchRevolveAxis | null {
  if (!selection || selection.kind !== "segment" || !selection.id) return null;
  const segment = profile.segments.find((entry) => entry.id === selection.id);
  if (!segment || segment.kind === "bezier" || segment.kind === "smooth") return null;
  const start = profile.points.find((point) => point.id === segment.startId);
  const end = profile.points.find((point) => point.id === segment.endId);
  if (!start || !end) return null;
  if (Math.hypot(end.x - start.x, end.z - start.z) < 0.25) return null;
  return { start: { x: start.x, z: start.z }, end: { x: end.x, z: end.z } };
}

/**
 * Revolve the largest closed sketch profile around a straight axis in the sketch plane.
 * Profiles that stay away from the axis become solids with a hole (e.g. tubes, rings).
 */
export function shapeFromSketchRevolve(
  profile: SketchProfile,
  axis: SketchRevolveAxis,
  existing?: WorkplaneShape | null,
  radialSegments = 72,
): WorkplaneShape | null {
  const closedPaths = orderedSketchPaths(profile).filter((path) => path.closed);
  if (closedPaths.length === 0) return null;

  const axisDx = axis.end.x - axis.start.x;
  const axisDz = axis.end.z - axis.start.z;
  const axisLength = Math.hypot(axisDx, axisDz);
  if (axisLength < 0.25) return null;
  const ux = axisDx / axisLength;
  const uz = axisDz / axisLength;

  const sampledPaths = closedPaths.map((path) => sampleClosedPath(path)).filter((samples) => samples.length >= 4);
  if (sampledPaths.length === 0) return null;
  sampledPaths.sort((a, b) => pathArea(b) - pathArea(a));
  const samples = sampledPaths[0];

  type LatheSample = { radius: number; along: number; sign: number };
  const latheSamples: LatheSample[] = samples.map((point) => {
    const vx = point.x - axis.start.x;
    const vz = point.z - axis.start.z;
    const along = vx * ux + vz * uz;
    const rx = vx - along * ux;
    const rz = vz - along * uz;
    const radius = Math.hypot(rx, rz);
    const sign = Math.sign(ux * vz - uz * vx) || 1;
    return { radius, along, sign };
  });

  const sideVotes = latheSamples.reduce((sum, sample) => sum + (sample.radius < 1e-4 ? 0 : sample.sign), 0);
  const side = Math.sign(sideVotes) || 1;
  const crossed = latheSamples.some((sample) => sample.radius > 0.2 && sample.sign !== 0 && sample.sign !== side);
  if (crossed) return null;

  const points2 = latheSamples.map((sample) => new THREE.Vector2(Math.max(0, sample.radius), sample.along));
  // Remove consecutive duplicates that collapse to the axis or same point.
  const cleaned: THREE.Vector2[] = [];
  for (const point of points2) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 1e-4) continue;
    cleaned.push(point);
  }
  if (cleaned.length < 3) return null;
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-4) {
    cleaned.push(first.clone());
  }

  const maxRadius = cleaned.reduce((max, point) => Math.max(max, point.x), 0);
  if (maxRadius < 0.25) return null;

  const geometry = new THREE.LatheGeometry(cleaned, Math.max(16, Math.min(128, radialSegments)));
  const radial = new THREE.Vector3(-uz * side, 0, ux * side).normalize();
  const axisVec = new THREE.Vector3(ux, 0, uz);
  const binormal = new THREE.Vector3().crossVectors(radial, axisVec).normalize();
  const matrix = new THREE.Matrix4().makeBasis(radial, axisVec, binormal);
  matrix.setPosition(axis.start.x, 0, axis.start.z);
  geometry.applyMatrix4(matrix);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const box = geometry.boundingBox;
  if (!box) {
    geometry.dispose();
    return null;
  }
  const meshCenterX = (box.min.x + box.max.x) / 2;
  const meshCenterZ = (box.min.z + box.max.z) / 2;

  // Center on the footprint and seat the solid on the plate (y = 0).
  geometry.translate(-meshCenterX, -box.min.y, -meshCenterZ);
  geometry.computeVertexNormals();

  const meshGeometry = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = meshGeometry.getAttribute("position");
  const normal = meshGeometry.getAttribute("normal");
  const positions = Array.from(position.array as ArrayLike<number>);
  const normals = normal ? Array.from(normal.array as ArrayLike<number>) : undefined;
  if (meshGeometry !== geometry) meshGeometry.dispose();
  geometry.dispose();

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index]);
    maxX = Math.max(maxX, positions[index]);
    minY = Math.min(minY, positions[index + 1]);
    maxY = Math.max(maxY, positions[index + 1]);
    minZ = Math.min(minZ, positions[index + 2]);
    maxZ = Math.max(maxZ, positions[index + 2]);
  }
  const width = Math.max(0.01, maxX - minX);
  const height = Math.max(0.01, maxY - minY);
  const depth = Math.max(0.01, maxZ - minZ);

  return canonicalizeShape({
    id: existing?.id ?? createLocalId("sketch-revolve"),
    name: existing?.name ?? "Sketch revolve",
    kind: "mesh",
    color: existing?.color ?? "#d41721",
    hole: Boolean(existing?.hole),
    x: meshCenterX,
    z: meshCenterZ,
    elevation: 0,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions,
      normals,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: Math.floor(positions.length / 9),
      sourceFormat: "json",
    },
    sketchProfile: cloneSketchProfile(profile),
    sketchDoc: (() => {
      const doc = sketchProfileToDoc(profile, existing?.sketchId);
      if (existing?.sketchDoc?.constraints?.length) doc.constraints = existing.sketchDoc.constraints;
      if (existing?.sketchDoc?.dimensions?.length) doc.dimensions = existing.sketchDoc.dimensions;
      return doc;
    })(),
    sketchId: existing?.sketchId ?? existing?.sketchDoc?.id,
    sketchFinish: "revolve",
    sketchRevolveAxis: {
      x1: axis.start.x,
      z1: axis.start.z,
      x2: axis.end.x,
      z2: axis.end.z,
    },
  } satisfies WorkplaneShape);
}
