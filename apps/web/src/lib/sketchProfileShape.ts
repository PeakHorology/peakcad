import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SketchProfile, SketchPoint, WorkplaneShape } from "@/types/sketchforge";
import type { SketchSelection } from "@/components/SketchWorkspace";
import { createLocalId } from "@/lib/localIds";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import { faceHoleOvershootMm } from "@/lib/csgTree";
import { cloneSketchPlane, isFaceHostedSketch, resolveSketchPlane, sketchBasisMatrix } from "@/lib/sketchPlane";
import { isCylinderSketchPlane, wrapCircleRadialCylinder, wrapUvLoopRadialPrism } from "@/lib/sketchCylinder";
import { densifyClosedPathUv } from "@/lib/sketchBrep";
import { promoteWorkplaneSketchToPrimitive } from "@/lib/sketchPrimitivePromote";
import { closedProfilesFromLegacy, sketchProfileToDoc } from "@/lib/sketch";

export function emptySketchProfile(): SketchProfile {
  return { points: [], segments: [], images: [] };
}

export function cloneSketchProfile(profile: SketchProfile): SketchProfile {
  return {
    points: profile.points.map((point) => ({
      ...point,
      handleIn: point.handleIn ? { ...point.handleIn } : undefined,
      handleOut: point.handleOut ? { ...point.handleOut } : undefined,
    })),
    segments: profile.segments.map((segment) => ({ ...segment })),
    images: (profile.images ?? []).map((image) => ({ ...image })),
    sketchPlane: profile.sketchPlane ? cloneSketchPlane(profile.sketchPlane) : undefined,
    faceReferenceLoops: profile.faceReferenceLoops?.map((loop) => loop.map((point) => ({ ...point }))),
  };
}

export type SketchClipboard = {
  points: SketchPoint[];
  segments: SketchProfile["segments"];
  images: NonNullable<SketchProfile["images"]>;
};

const SKETCH_PASTE_OFFSET = 4;

export function sketchClipboardFromSelection(profile: SketchProfile, selection: SketchSelection): SketchClipboard | null {
  if (!selection) return null;
  const pointIds = new Set<string>();
  const segmentIds = new Set<string>();
  const imageIds = new Set<string>();
  if (selection.kind === "point") pointIds.add(selection.id);
  else if (selection.kind === "segment") segmentIds.add(selection.id);
  else if (selection.kind === "image") imageIds.add(selection.id);
  else {
    selection.pointIds.forEach((id) => pointIds.add(id));
    selection.segmentIds.forEach((id) => segmentIds.add(id));
    (selection.imageIds ?? []).forEach((id) => imageIds.add(id));
  }
  for (const segment of profile.segments) {
    if (!segmentIds.has(segment.id)) continue;
    pointIds.add(segment.startId);
    pointIds.add(segment.endId);
  }
  const points = profile.points
    .filter((point) => pointIds.has(point.id))
    .map((point) => ({
      ...point,
      handleIn: point.handleIn ? { ...point.handleIn } : undefined,
      handleOut: point.handleOut ? { ...point.handleOut } : undefined,
    }));
  const segments = profile.segments
    .filter((segment) => segmentIds.has(segment.id) && pointIds.has(segment.startId) && pointIds.has(segment.endId))
    .map((segment) => ({ ...segment }));
  const images = (profile.images ?? []).filter((image) => imageIds.has(image.id)).map((image) => ({ ...image }));
  if (points.length === 0 && images.length === 0) return null;
  return { points, segments, images };
}

export function pasteSketchClipboardIntoProfile(profile: SketchProfile, clipboard: SketchClipboard, offset = SKETCH_PASTE_OFFSET) {
  const idMap = new Map<string, string>();
  clipboard.points.forEach((point) => idMap.set(point.id, createLocalId("sketch-point")));
  const points = clipboard.points.map((point) => ({
    ...point,
    id: idMap.get(point.id)!,
    x: point.x + offset,
    z: point.z + offset,
    handleIn: point.handleIn ? { x: point.handleIn.x + offset, z: point.handleIn.z + offset } : undefined,
    handleOut: point.handleOut ? { x: point.handleOut.x + offset, z: point.handleOut.z + offset } : undefined,
  }));
  const segments = clipboard.segments.map((segment) => ({
    ...segment,
    id: createLocalId("sketch-segment"),
    startId: idMap.get(segment.startId)!,
    endId: idMap.get(segment.endId)!,
  }));
  const images = clipboard.images.map((image) => ({
    ...image,
    id: createLocalId("sketch-image"),
    x: image.x + offset,
    z: image.z + offset,
  }));
  const next: SketchProfile = {
    ...profile,
    points: [...profile.points, ...points],
    segments: [...profile.segments, ...segments],
    images: [...(profile.images ?? []), ...images],
  };
  const selection: SketchSelection =
    points.length === 1 && segments.length === 0 && images.length === 0
      ? { kind: "point", id: points[0].id }
      : segments.length === 1 && points.length <= 2 && images.length === 0
        ? { kind: "segment", id: segments[0].id }
        : images.length === 1 && points.length === 0 && segments.length === 0
          ? { kind: "image", id: images[0].id }
          : {
              kind: "multiple",
              pointIds: points.map((point) => point.id),
              segmentIds: segments.map((segment) => segment.id),
              imageIds: images.map((image) => image.id),
            };
  return { profile: next, selection };
}

export type OrderedSketchStep = { segment: SketchProfile["segments"][number]; from: SketchPoint; to: SketchPoint };
export type OrderedSketchPath = { points: SketchPoint[]; steps: OrderedSketchStep[]; closed: boolean };

export function orderedSketchPaths(profile: SketchProfile): OrderedSketchPath[] {
  const pointById = new Map(profile.points.map((point) => [point.id, point]));
  const adjacency = new Map<string, Array<{ pointId: string; segment: SketchProfile["segments"][number] }>>();
  profile.points.forEach((point) => adjacency.set(point.id, []));
  const validSegments = profile.segments.filter((segment) => {
    if (!pointById.has(segment.startId) || !pointById.has(segment.endId) || segment.startId === segment.endId) return;
    adjacency.get(segment.startId)?.push({ pointId: segment.endId, segment });
    adjacency.get(segment.endId)?.push({ pointId: segment.startId, segment });
    return true;
  });
  const unvisited = new Set(validSegments.map((segment) => segment.id));
  const paths: OrderedSketchPath[] = [];
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
    const steps: OrderedSketchStep[] = [];
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

export function withSmoothSketchHandles(profile: SketchProfile) {
  const next = cloneSketchProfile(profile);
  const points = new Map(next.points.map((point) => [point.id, point]));
  orderedSketchPaths(next).forEach((path) => {
    path.points.forEach((sourcePoint, index) => {
      const point = points.get(sourcePoint.id);
      if (!point) return;
      const previous = path.closed ? path.points[(index - 1 + path.points.length) % path.points.length] : path.points[Math.max(0, index - 1)];
      const following = path.closed ? path.points[(index + 1) % path.points.length] : path.points[Math.min(path.points.length - 1, index + 1)];
      const tangentX = (following.x - previous.x) / 6;
      const tangentZ = (following.z - previous.z) / 6;
      point.handleIn = { x: point.x - tangentX, z: point.z - tangentZ };
      point.handleOut = { x: point.x + tangentX, z: point.z + tangentZ };
      point.mode = "smooth";
    });
  });
  return next;
}

/** True when a single closed path is an axis-aligned rectangle of line segments in UV. */
export function axisAlignedRectFromClosedPath(path: OrderedSketchPath): { width: number; depth: number; centerX: number; centerZ: number } | null {
  if (!path.closed || path.points.length !== 4 || path.steps.length !== 4) {
    return null;
  }
  if (path.steps.some((step) => step.segment.kind !== "line")) {
    return null;
  }
  const xs = path.points.map((point) => point.x);
  const zs = path.points.map((point) => point.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const width = maxX - minX;
  const depth = maxZ - minZ;
  if (width < 0.01 || depth < 0.01) {
    return null;
  }
  const onCorner = (point: { x: number; z: number }) => (
    (Math.abs(point.x - minX) < 1e-4 || Math.abs(point.x - maxX) < 1e-4)
    && (Math.abs(point.z - minZ) < 1e-4 || Math.abs(point.z - maxZ) < 1e-4)
  );
  if (!path.points.every(onCorner)) {
    return null;
  }
  // Must occupy all four corners (no collapsed/degenerate diamond).
  const cornerKeys = new Set(path.points.map((point) => `${Math.abs(point.x - minX) < 1e-4 ? "0" : "1"},${Math.abs(point.z - minZ) < 1e-4 ? "0" : "1"}`));
  if (cornerKeys.size !== 4) {
    return null;
  }
  return {
    width,
    depth,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}

/** True when a closed path is a circle (4-bezier sketch circle or regular polygon on a circle). */
export function circleFromClosedPath(path: OrderedSketchPath): { radius: number; centerX: number; centerZ: number } | null {
  if (!path.closed || path.points.length < 4) {
    return null;
  }
  const centerX = path.points.reduce((sum, point) => sum + point.x, 0) / path.points.length;
  const centerZ = path.points.reduce((sum, point) => sum + point.z, 0) / path.points.length;
  const radii = path.points.map((point) => Math.hypot(point.x - centerX, point.z - centerZ));
  const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  if (radius < 0.01) {
    return null;
  }
  const radialSpread = Math.max(...radii) - Math.min(...radii);
  if (radialSpread > Math.max(0.05, radius * 0.02)) {
    return null;
  }
  // Sketch circles are four cubics; polygons/line rings need enough sides to stay round.
  const curved = path.steps.every((step) => step.segment.kind === "bezier" || step.segment.kind === "smooth");
  if (curved && path.points.length === 4) {
    return { radius, centerX, centerZ };
  }
  if (!curved && path.steps.every((step) => step.segment.kind === "line") && path.points.length >= 12) {
    return { radius, centerX, centerZ };
  }
  return null;
}

export function bakeSketchExtrusionGeometry(geometry: THREE.BufferGeometry) {
  // Weld ExtrudeGeometry triangle soups so Manifold/CSG get shared edges instead of open shells.
  const merged = mergeVertices(geometry, 1e-4);
  if (merged !== geometry) {
    geometry.dispose();
  }
  // Keep indexed form when possible — duplicated soups break Manifold and inflate CSG cost.
  if (!merged.index) {
    merged.computeVertexNormals();
    return merged;
  }
  merged.computeVertexNormals();
  return merged;
}

/** Reverse triangle winding so FrontSide materials show the exterior after a reflection. */
export function flipGeometryWinding(geometry: THREE.BufferGeometry) {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);
      index.setX(i + 1, c);
      index.setX(i + 2, b);
    }
    index.needsUpdate = true;
    return;
  }
  const position = geometry.getAttribute("position");
  if (!position || position.count < 3) return;
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const az = new THREE.Vector3();
  for (let i = 0; i + 2 < position.count; i += 3) {
    ax.fromBufferAttribute(position, i);
    ay.fromBufferAttribute(position, i + 1);
    az.fromBufferAttribute(position, i + 2);
    position.setXYZ(i + 1, az.x, az.y, az.z);
    position.setXYZ(i + 2, ay.x, ay.y, ay.z);
  }
  position.needsUpdate = true;
}

export function importedMeshPayloadFromGeometry(geometry: THREE.BufferGeometry, width: number, depth: number, height: number) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const positions = Array.from(position.array as ArrayLike<number>);
  const normals = normal ? Array.from(normal.array as ArrayLike<number>) : undefined;
  const index = geometry.getIndex();
  const indices = index ? Array.from(index.array as ArrayLike<number>) : undefined;
  const triangleCount = indices
    ? Math.floor(indices.length / 3)
    : Math.floor(positions.length / 9);
  return {
    positions,
    ...(indices && indices.length >= 3 ? { indices } : {}),
    normals,
    baseWidth: width,
    baseDepth: depth,
    baseHeight: height,
    triangleCount,
    sourceFormat: "json" as const,
  };
}

export function pointInSketchPolygon(point: THREE.Vector2, polygon: THREE.Vector2[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = currentPoint.y > point.y !== previousPoint.y > point.y;
    if (crosses && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function shapeFromSketchProfile(
  profile: SketchProfile,
  height: number,
  existing?: WorkplaneShape | null,
  options?: { cutIntoFace?: boolean },
) {
  const closedPaths = orderedSketchPaths(profile).filter((path) => path.closed);
  if (closedPaths.length === 0) return null;
  const plane = resolveSketchPlane(profile.sketchPlane ?? existing?.sketchPlane);
  const profilePoints = closedPaths.flatMap((path) => path.points);
  const minX = Math.min(...profilePoints.map((point) => point.x));
  const maxX = Math.max(...profilePoints.map((point) => point.x));
  const minZ = Math.min(...profilePoints.map((point) => point.z));
  const maxZ = Math.max(...profilePoints.map((point) => point.z));
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const width = Math.max(0.01, maxX - minX);
  const depth = Math.max(0.01, maxZ - minZ);
  const safeHeight = Math.max(0.01, height);
  // Tinkercad-like: bake at exact sketch dimensions. Cut-axis overshoot for face holes
  // is applied below via faceHoleOvershootMm — never grow the profile in-plane.
  const cutIntoFace = options?.cutIntoFace ?? (
    isFaceHostedSketch(plane, profile.faceReferenceLoops ?? existing?.sketchProfile?.faceReferenceLoops)
    && Boolean(existing?.hole)
  );

  // Barrel sketches: wrap UV into a radial prism / cylinder instead of planar extrude.
  if (isCylinderSketchPlane(plane)) {
    const surface = plane.surface;
    const pathByKey = new Map(
      closedPaths.map((path) => [path.points.map((point) => point.id).join("|"), path]),
    );
    const findPathByPointIds = (pointIds: string[]) => {
      const key = pointIds.join("|");
      if (pathByKey.has(key)) return pathByKey.get(key)!;
      // Point order may differ — match by set equality.
      const wanted = new Set(pointIds);
      return closedPaths.find((path) => (
        path.points.length === wanted.size && path.points.every((point) => wanted.has(point.id))
      )) ?? null;
    };
    const nestedProfiles = closedProfilesFromLegacy({
      points: profile.points,
      segments: profile.segments,
      sketchPlane: plane,
    });
    const geometries: THREE.BufferGeometry[] = [];
    for (const nested of nestedProfiles) {
      const outerPath = findPathByPointIds(nested.pointIds);
      if (!outerPath) continue;
      const holePaths = nested.holePointIdLoops
        .map((ids) => findPathByPointIds(ids))
        .filter((path): path is OrderedSketchPath => Boolean(path));
      const simpleCircle = holePaths.length === 0 ? circleFromClosedPath(outerPath) : null;
      let part: THREE.BufferGeometry | null = null;
      if (simpleCircle) {
        part = wrapCircleRadialCylinder(
          simpleCircle.centerX,
          simpleCircle.centerZ,
          simpleCircle.radius,
          surface,
          safeHeight,
          cutIntoFace,
        );
      } else {
        const outerSamples = densifyClosedPathUv(outerPath, 20);
        const holeSamples = holePaths.map((path) => densifyClosedPathUv(path, 20));
        part = wrapUvLoopRadialPrism(outerSamples, surface, safeHeight, cutIntoFace, holeSamples);
      }
      if (part) geometries.push(part);
    }
    let geometry: THREE.BufferGeometry | null = null;
    if (geometries.length === 1) {
      geometry = geometries[0];
    } else if (geometries.length > 1) {
      // Separate UV islands (e.g. two barrel holes) — concatenate triangle soups.
      const positions: number[] = [];
      const indices: number[] = [];
      for (const part of geometries) {
        const pos = part.getAttribute("position");
        const index = part.getIndex();
        const base = positions.length / 3;
        for (let i = 0; i < pos.count; i += 1) {
          positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        }
        if (index) {
          for (let i = 0; i < index.count; i += 1) indices.push(base + index.getX(i));
        } else {
          for (let i = 0; i < pos.count; i += 1) indices.push(base + i);
        }
        part.dispose();
      }
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
    }
    if (!geometry) return null;

    geometry.computeBoundingBox();
    const geometryBox = geometry.boundingBox;
    const worldMinX = geometryBox?.min.x ?? 0;
    const worldMaxX = geometryBox?.max.x ?? 0;
    const worldMinY = geometryBox?.min.y ?? 0;
    const worldMaxY = geometryBox?.max.y ?? safeHeight;
    const worldMinZ = geometryBox?.min.z ?? 0;
    const worldMaxZ = geometryBox?.max.z ?? 0;
    const meshCenterX = (worldMinX + worldMaxX) / 2;
    const meshCenterZ = (worldMinZ + worldMaxZ) / 2;
    const meshElevation = worldMinY;
    const meshWidth = Math.max(0.01, worldMaxX - worldMinX);
    const meshDepth = Math.max(0.01, worldMaxZ - worldMinZ);
    const meshHeight = Math.max(0.01, worldMaxY - worldMinY);
    geometry.translate(-meshCenterX, -meshElevation, -meshCenterZ);
    const meshGeometry = bakeSketchExtrusionGeometry(geometry);
    const importedMesh = importedMeshPayloadFromGeometry(meshGeometry, meshWidth, meshDepth, meshHeight);
    meshGeometry.dispose();

    const nextProfile = cloneSketchProfile(profile);
    nextProfile.sketchPlane = cloneSketchPlane(plane);
    const sketchId = existing?.sketchId ?? createLocalId("sketch");
    const sketchDoc = sketchProfileToDoc(nextProfile, sketchId);
    if (existing?.sketchDoc?.constraints?.length) {
      sketchDoc.constraints = existing.sketchDoc.constraints.map((c) => ({
        ...c,
        entityIds: [...c.entityIds],
        pointIds: c.pointIds ? [...c.pointIds] : undefined,
      }));
    }
    if (existing?.sketchDoc?.dimensions?.length) {
      sketchDoc.dimensions = existing.sketchDoc.dimensions.map((d) => ({
        ...d,
        entityIds: [...d.entityIds],
        pointIds: d.pointIds ? [...d.pointIds] : undefined,
      }));
    }
    const profiles = closedProfilesFromLegacy(nextProfile);
    return canonicalizeShape({
      id: existing?.id ?? createLocalId("sketch-extrusion"),
      name: existing?.name ?? "Sketch extrusion",
      kind: "mesh",
      color: existing?.color ?? "#d41721",
      hole: Boolean(existing?.hole),
      x: meshCenterX,
      z: meshCenterZ,
      elevation: meshElevation,
      size: Math.max(meshWidth, meshDepth),
      width: meshWidth,
      depth: meshDepth,
      height: meshHeight,
      rotation: 0,
      rotationX: 0,
      rotationZ: 0,
      importedMesh,
      sketchProfile: nextProfile,
      sketchDoc,
      sketchId,
      sketchProfileIds: existing?.sketchProfileIds?.length ? existing.sketchProfileIds : profiles.map((p) => p.id),
      sketchPlane: cloneSketchPlane(plane),
      sketchFinish: "extrude",
      sketchRevolveAxis: undefined,
    } satisfies WorkplaneShape);
  }

  let geometry: THREE.BufferGeometry;
  const simpleRect = closedPaths.length === 1 ? axisAlignedRectFromClosedPath(closedPaths[0]) : null;
  const simpleCircle = !simpleRect && closedPaths.length === 1 ? circleFromClosedPath(closedPaths[0]) : null;
  if (simpleRect) {
    // BoxGeometry is manifold (indexed, shared verts) — much cleaner hole cutters than ExtrudeGeometry soups.
    geometry = new THREE.BoxGeometry(simpleRect.width, safeHeight, simpleRect.depth);
    geometry.translate(simpleRect.centerX, safeHeight / 2, simpleRect.centerZ);
  } else if (simpleCircle) {
    // CylinderGeometry stays manifold under face transforms; ExtrudeGeometry circles often fail Manifold.
    const radius = simpleCircle.radius;
    const radialSegments = Math.min(96, Math.max(32, Math.ceil(radius * 4)));
    geometry = new THREE.CylinderGeometry(radius, radius, safeHeight, radialSegments, 1, false);
    geometry.translate(simpleCircle.centerX, safeHeight / 2, simpleCircle.centerZ);
  } else {
    const outlineRecords = closedPaths.map((path) => {
      const outline = new THREE.Shape();
      const toLocal = (x: number, z: number) => ({ x: x - centerX, y: -(z - centerZ) });
      const first = toLocal(path.points[0].x, path.points[0].z);
      outline.moveTo(first.x, first.y);
      path.steps.forEach(({ segment, from, to }) => {
        const forward = segment.startId === from.id;
        const control1 = forward ? from.handleOut : from.handleIn;
        const control2 = forward ? to.handleIn : to.handleOut;
        const end = toLocal(to.x, to.z);
        if (segment.kind !== "line" && control1 && control2) {
          const c1 = toLocal(control1.x, control1.z);
          const c2 = toLocal(control2.x, control2.z);
          outline.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
        } else {
          outline.lineTo(end.x, end.y);
        }
      });
      outline.closePath();
      const polygon = outline.extractPoints(16).shape;
      return { outline, polygon, area: Math.abs(THREE.ShapeUtils.area(polygon)) };
    });
    const sortedOutlines = [...outlineRecords].sort((a, b) => b.area - a.area);
    const outlines: THREE.Shape[] = [];
    sortedOutlines.forEach((record) => {
      const sample = record.polygon[0];
      const parent = sample
        ? sortedOutlines
            .filter((candidate) => candidate !== record && candidate.area > record.area && pointInSketchPolygon(sample, candidate.polygon))
            .sort((a, b) => a.area - b.area)[0]
        : undefined;
      if (parent) parent.outline.holes.push(record.outline);
      else outlines.push(record.outline);
    });
    const hasCurves = profile.segments.some((segment) => segment.kind === "bezier" || segment.kind === "smooth");
    const longestHandle = profile.points.reduce((longest, point) => Math.max(
      longest,
      point.handleIn ? Math.hypot(point.handleIn.x - point.x, point.handleIn.z - point.z) : 0,
      point.handleOut ? Math.hypot(point.handleOut.x - point.x, point.handleOut.z - point.z) : 0,
    ), 0);
    const curveScale = Math.max(width, depth, longestHandle * 2);
    // Even line-only profiles need a few segments so ExtrudeGeometry caps stay clean under transform.
    const curveSegments = hasCurves ? Math.min(256, Math.max(32, Math.ceil(curveScale * 1.25))) : 8;
    geometry = new THREE.ExtrudeGeometry(outlines, { depth: safeHeight, bevelEnabled: false, steps: 1, curveSegments });
    geometry.rotateX(-Math.PI / 2);
    // Local frame after rotateX: +X=U, +Y=extrusion, +Z=V.
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(centerX, 0, centerZ));
  }

  const basis = sketchBasisMatrix(plane);
  geometry.applyMatrix4(basis);
  // sketchBasisMatrix maps U/N/(N×U) which is left-handed (det < 0), so transforms flip
  // winding. Standalone sketches hid this with DoubleSide; after Join the body uses
  // FrontSide and walls vanish. Restore outward winding so bosses stay solid opaque.
  if (basis.determinant() < 0) {
    flipGeometryWinding(geometry);
  }

  // Face holes: extrude along +normal first, then pull so the cutter spans the
  // host with overshoot past BOTH skins (entrance + exit). Old pull (height+os)
  // parked the cutter entirely inside and short of the sketch face, which left
  // coplanar entrance skins and "offset" blind holes when height ≈ host length.
  if (cutIntoFace) {
    const n = plane.normal;
    const os = faceHoleOvershootMm(safeHeight);
    // Geometry currently occupies [origin, origin + height*n].
    // Target: [origin - (height - os)*n, origin + os*n] so os sticks out past the
    // sketch face and the far end reaches height - os past the face (through-all
    // when height = thickness + 2*os).
    const pull = Math.max(0, safeHeight - os);
    geometry.translate(-n.x * pull, -n.y * pull, -n.z * pull);
  }

  geometry.computeBoundingBox();
  const geometryBox = geometry.boundingBox;
  const worldMinX = geometryBox?.min.x ?? 0;
  const worldMaxX = geometryBox?.max.x ?? 0;
  const worldMinY = geometryBox?.min.y ?? 0;
  const worldMaxY = geometryBox?.max.y ?? safeHeight;
  const worldMinZ = geometryBox?.min.z ?? 0;
  const worldMaxZ = geometryBox?.max.z ?? 0;
  const meshCenterX = (worldMinX + worldMaxX) / 2;
  const meshCenterZ = (worldMinZ + worldMaxZ) / 2;
  const meshElevation = worldMinY;
  const meshWidth = Math.max(0.01, worldMaxX - worldMinX);
  const meshDepth = Math.max(0.01, worldMaxZ - worldMinZ);
  const meshHeight = Math.max(0.01, worldMaxY - worldMinY);

  // Bake into local mesh frame: XZ centered at 0, minY at 0 (matches putGeometryOnBase).
  geometry.translate(-meshCenterX, -meshElevation, -meshCenterZ);

  const meshGeometry = bakeSketchExtrusionGeometry(geometry);
  const importedMesh = importedMeshPayloadFromGeometry(meshGeometry, meshWidth, meshDepth, meshHeight);
  meshGeometry.dispose();

  const nextProfile = cloneSketchProfile(profile);
  nextProfile.sketchPlane = cloneSketchPlane(plane);
  const sketchId = existing?.sketchId ?? createLocalId("sketch");
  const sketchDoc = sketchProfileToDoc(nextProfile, sketchId);
  if (existing?.sketchDoc?.constraints?.length) {
    sketchDoc.constraints = existing.sketchDoc.constraints.map((c) => ({
      ...c,
      entityIds: [...c.entityIds],
      pointIds: c.pointIds ? [...c.pointIds] : undefined,
    }));
  }
  if (existing?.sketchDoc?.dimensions?.length) {
    sketchDoc.dimensions = existing.sketchDoc.dimensions.map((d) => ({
      ...d,
      entityIds: [...d.entityIds],
      pointIds: d.pointIds ? [...d.pointIds] : undefined,
    }));
  }
  const profiles = closedProfilesFromLegacy(nextProfile);

  const meshShape = canonicalizeShape({
    id: existing?.id ?? createLocalId("sketch-extrusion"),
    name: existing?.name ?? "Sketch extrusion",
    kind: "mesh",
    color: existing?.color ?? "#d41721",
    hole: Boolean(existing?.hole),
    x: meshCenterX,
    z: meshCenterZ,
    elevation: meshElevation,
    size: Math.max(meshWidth, meshDepth),
    width: meshWidth,
    depth: meshDepth,
    height: meshHeight,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh,
    sketchProfile: nextProfile,
    sketchDoc,
    sketchId,
    sketchProfileIds: existing?.sketchProfileIds?.length ? existing.sketchProfileIds : profiles.map((p) => p.id),
    sketchPlane: cloneSketchPlane(plane),
    sketchFinish: "extrude",
    sketchRevolveAxis: undefined,
  } satisfies WorkplaneShape);
  // Workplane rect/circle → analytic box/cylinder for exact STEP (face-hosted stays mesh).
  return promoteWorkplaneSketchToPrimitive(
    meshShape,
    closedPaths.map((path) => ({ closed: path.closed, points: path.points })),
  );
}
