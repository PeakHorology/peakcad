import type { SketchPlane } from "@/types/sketchforge";
import { worldToPlaneUV } from "@/lib/sketchPlane";
import { cloneSketchDoc, pruneDanglingReferences } from "./migrate";
import type { SketchDoc, SketchEntity, SketchPointEntity } from "./types";

function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export type ProjectableEdge = {
  /** Stable key for relinking (e.g. shapeId:edgeIndex). */
  sourceId: string;
  /** World-space polyline. */
  worldPoints: Array<{ x: number; y: number; z: number }>;
};

export type ProjectResult = {
  doc: SketchDoc;
  addedEntityIds: string[];
  lostSourceIds: string[];
};

/** Project host edges onto the sketch plane as locked construction/reference geometry. */
export function projectEdgesOntoSketch(doc: SketchDoc, edges: ProjectableEdge[]): ProjectResult {
  const next = cloneSketchDoc(doc);
  const addedEntityIds: string[] = [];
  const plane = next.plane;

  for (const edge of edges) {
    // Reuse the ids of the projection being replaced, in order. Refreshing used to mint new random
    // ids, so every constraint or dimension the user had attached to a projected corner was left
    // pointing at a dead id and silently stopped acting on the sketch.
    const previous = next.entities.filter((e) => e.projectSourceId === edge.sourceId);
    const reusablePointIds = previous.filter((e) => e.kind === "point").map((e) => e.id);
    const reusableLineIds = previous.filter((e) => e.kind === "line").map((e) => e.id);
    if (previous.length) {
      const staleIds = new Set(previous.map((e) => e.id));
      next.entities = next.entities.filter((e) => !staleIds.has(e.id));
    }

    if (edge.worldPoints.length < 2) continue;
    const uvPoints = edge.worldPoints.map((p) => worldToPlaneUV(plane, p));
    const pointIds: string[] = [];
    for (const [index, uv] of uvPoints.entries()) {
      const point: SketchPointEntity = {
        kind: "point",
        id: reusablePointIds[index] ?? newId("proj-point"),
        x: uv.u,
        z: uv.v,
        construction: true,
        projected: true,
        projectSourceId: edge.sourceId,
        fixed: true,
      };
      next.entities.push(point);
      pointIds.push(point.id);
      addedEntityIds.push(point.id);
    }
    for (let i = 0; i < pointIds.length - 1; i += 1) {
      const line: SketchEntity = {
        kind: "line",
        id: reusableLineIds[i] ?? newId("proj-line"),
        startId: pointIds[i],
        endId: pointIds[i + 1],
        construction: true,
        projected: true,
        projectSourceId: edge.sourceId,
        fixed: true,
      };
      next.entities.push(line);
      addedEntityIds.push(line.id);
    }
  }

  // A shorter polyline than last time leaves surplus ids unclaimed, so sweep whatever no longer
  // resolves rather than handing the solver references it cannot satisfy.
  return { doc: pruneDanglingReferences(next), addedEntityIds, lostSourceIds: [] };
}

/** Refresh projected entities; mark sources missing from the provided edge list as lost. */
export function updateProjectedGeometry(doc: SketchDoc, edges: ProjectableEdge[]): ProjectResult {
  const next = cloneSketchDoc(doc);
  const bySource = new Map(edges.map((e) => [e.sourceId, e]));
  const existingSources = new Set(
    next.entities.filter((e) => e.projected && e.projectSourceId).map((e) => e.projectSourceId!),
  );
  const lostSourceIds: string[] = [];
  for (const sourceId of existingSources) {
    if (!bySource.has(sourceId)) lostSourceIds.push(sourceId);
  }

  // Drop lost projections (keep geometry but clear projected lock so user can delete)
  if (lostSourceIds.length) {
    const lost = new Set(lostSourceIds);
    next.entities = next.entities.map((e) => {
      if (e.projectSourceId && lost.has(e.projectSourceId)) {
        return { ...e, projected: false, fixed: false, projectSourceId: undefined };
      }
      return e;
    });
  }

  const toRefresh = edges.filter((e) => existingSources.has(e.sourceId));
  if (toRefresh.length) {
    return projectEdgesOntoSketch(next, toRefresh);
  }
  return { doc: next, addedEntityIds: [], lostSourceIds };
}

/** Build simple box edges from a world AABB for projection helpers / tests. */
export function boxEdgesForProjection(
  shapeId: string,
  center: { x: number; y: number; z: number },
  size: { width: number; height: number; depth: number },
  plane: SketchPlane,
): ProjectableEdge[] {
  void plane;
  const hx = size.width / 2;
  const hy = size.height / 2;
  const hz = size.depth / 2;
  const c = center;
  const corners = [
    { x: c.x - hx, y: c.y - hy, z: c.z - hz },
    { x: c.x + hx, y: c.y - hy, z: c.z - hz },
    { x: c.x + hx, y: c.y - hy, z: c.z + hz },
    { x: c.x - hx, y: c.y - hy, z: c.z + hz },
    { x: c.x - hx, y: c.y + hy, z: c.z - hz },
    { x: c.x + hx, y: c.y + hy, z: c.z - hz },
    { x: c.x + hx, y: c.y + hy, z: c.z + hz },
    { x: c.x - hx, y: c.y + hy, z: c.z + hz },
  ];
  const pairs: Array<[number, number]> = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.map(([i, j], index) => ({
    sourceId: `${shapeId}:edge:${index}`,
    worldPoints: [corners[i], corners[j]],
  }));
}
