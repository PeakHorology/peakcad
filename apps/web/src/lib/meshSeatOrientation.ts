import * as THREE from "three";

/** Minimum share of total surface area for a planar region to count as a dominant seat. */
const MIN_DOMINANT_AREA_RATIO = 0.06;
/** Triangles whose normals agree within ~8° can belong to the same plane cluster. */
const NORMAL_DOT_THRESHOLD = 0.99;
const EPSILON = 1e-10;
/**
 * Bounds for the clustering pass, which costs O(triangles x clusters) and runs on the main
 * thread during file drop. A curved or scanned mesh gives almost every triangle its own
 * cluster, so an uncapped run took ~0.9s at 40k triangles and grew quadratically from there —
 * minutes of frozen UI near the app's own 400k-triangle import limit. Both limits sit well
 * above any real machined part's plane count, so ordinary imports cluster exactly as before.
 */
const SEAT_TRIANGLE_BUDGET = 20000;
const MAX_PLANE_CLUSTERS = 512;

export type SeatedTriangleSoup = {
  positions: number[];
  normals: number[] | undefined;
  /** Rigid rotation applied about the origin before recentering (identity when skipped). */
  rotation: THREE.Quaternion;
};

type PlaneCluster = {
  normal: THREE.Vector3;
  offset: number;
  area: number;
  samplePoint: THREE.Vector3;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Convert a unit quaternion to an axis-angle suitable for brep.rotate (degrees).
 * Returns angle 0 when the rotation is negligible.
 */
export function quaternionToAxisAngleDegrees(quaternion: THREE.Quaternion): {
  axis: [number, number, number];
  angle: number;
} {
  const q = quaternion.clone().normalize();
  const angleRad = 2 * Math.acos(clamp(q.w, -1, 1));
  const sinHalf = Math.sqrt(Math.max(0, 1 - q.w * q.w));
  if (sinHalf < 1e-8 || angleRad < 1e-8) {
    return { axis: [1, 0, 0], angle: 0 };
  }
  return {
    axis: [q.x / sinHalf, q.y / sinHalf, q.z / sinHalf],
    angle: (angleRad * 180) / Math.PI,
  };
}

function meshBoundsExtent(positions: number[]) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

function findLargestFlatPlane(positions: number[]): PlaneCluster | null {
  const triangleCount = Math.floor(positions.length / 9);
  if (triangleCount < 1) {
    return null;
  }

  const extent = meshBoundsExtent(positions);
  const offsetTolerance = Math.max(extent * 1e-4, 1e-5);
  const clusters: PlaneCluster[] = [];
  let totalArea = 0;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  // Sampling scales both cluster areas and totalArea alike, so the dominant-area ratio below
  // stays meaningful.
  const stride = Math.max(1, Math.ceil(triangleCount / SEAT_TRIANGLE_BUDGET));

  for (let t = 0; t < triangleCount; t += stride) {
    const base = t * 9;
    a.set(positions[base], positions[base + 1], positions[base + 2]);
    b.set(positions[base + 3], positions[base + 4], positions[base + 5]);
    c.set(positions[base + 6], positions[base + 7], positions[base + 8]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac);
    const area = normal.length() * 0.5;
    if (area < EPSILON) {
      continue;
    }
    normal.multiplyScalar(1 / (area * 2));
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const offset = normal.dot(centroid);
    totalArea += area;

    let matched: PlaneCluster | null = null;
    for (const cluster of clusters) {
      if (cluster.normal.dot(normal) < NORMAL_DOT_THRESHOLD) {
        continue;
      }
      if (Math.abs(cluster.offset - offset) > offsetTolerance) {
        continue;
      }
      matched = cluster;
      break;
    }

    if (!matched) {
      // Once the cap is reached, area still accrues to totalArea, which correctly makes the
      // dominant-plane test harder to satisfy on a mesh with no real flat face.
      if (clusters.length < MAX_PLANE_CLUSTERS) {
        clusters.push({
          normal: normal.clone(),
          offset,
          area,
          samplePoint: centroid.clone(),
        });
      }
      continue;
    }

    const weight = matched.area + area;
    matched.normal.multiplyScalar(matched.area).addScaledVector(normal, area).normalize();
    matched.offset = (matched.offset * matched.area + offset * area) / weight;
    matched.samplePoint
      .multiplyScalar(matched.area)
      .addScaledVector(centroid, area)
      .multiplyScalar(1 / weight);
    matched.area = weight;
  }

  if (!clusters.length || totalArea < EPSILON) {
    return null;
  }

  clusters.sort((left, right) => right.area - left.area);
  const best = clusters[0];
  if (best.area / totalArea < MIN_DOMINANT_AREA_RATIO) {
    return null;
  }
  return best;
}

function applyQuaternionToTriangleSoup(
  positions: number[],
  normals: number[] | undefined,
  rotation: THREE.Quaternion,
): { positions: number[]; normals: number[] | undefined } {
  if (Math.abs(quaternionToAxisAngleDegrees(rotation).angle) < 1e-6) {
    return { positions: positions.slice(), normals: normals ? normals.slice() : undefined };
  }

  const nextPositions = new Array<number>(positions.length);
  const point = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    point.set(positions[i], positions[i + 1], positions[i + 2]).applyQuaternion(rotation);
    nextPositions[i] = point.x;
    nextPositions[i + 1] = point.y;
    nextPositions[i + 2] = point.z;
  }

  let nextNormals: number[] | undefined;
  if (normals && normals.length === positions.length) {
    nextNormals = new Array<number>(normals.length);
    const n = new THREE.Vector3();
    for (let i = 0; i < normals.length; i += 3) {
      n.set(normals[i], normals[i + 1], normals[i + 2]).applyQuaternion(rotation).normalize();
      nextNormals[i] = n.x;
      nextNormals[i + 1] = n.y;
      nextNormals[i + 2] = n.z;
    }
  }

  return { positions: nextPositions, normals: nextNormals };
}

/**
 * Rotate a triangle soup so its largest planar region becomes the bottom
 * (-Y) face. Skips reorientation when no dominant flat surface is found.
 */
export function seatTriangleSoupOnLargestFlatSurface(
  positions: number[],
  normals?: number[],
): SeatedTriangleSoup {
  const identity = new THREE.Quaternion();
  const plane = findLargestFlatPlane(positions);
  if (!plane) {
    return {
      positions: positions.slice(),
      normals: normals ? normals.slice() : undefined,
      rotation: identity,
    };
  }

  const down = new THREE.Vector3(0, -1, 0);
  let rotation = new THREE.Quaternion().setFromUnitVectors(plane.normal.clone().normalize(), down);

  // Ensure the solid lies above the chosen face (not hanging below a "ceiling").
  const trial = applyQuaternionToTriangleSoup(positions, undefined, rotation);
  let sumY = 0;
  let count = 0;
  for (let i = 1; i < trial.positions.length; i += 3) {
    sumY += trial.positions[i];
    count += 1;
  }
  const sample = plane.samplePoint.clone().applyQuaternion(rotation);
  const centroidY = count ? sumY / count : sample.y;
  if (centroidY < sample.y - EPSILON) {
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    rotation = flip.multiply(rotation);
  }

  const seated = applyQuaternionToTriangleSoup(positions, normals, rotation);
  return {
    positions: seated.positions,
    normals: seated.normals,
    rotation,
  };
}
