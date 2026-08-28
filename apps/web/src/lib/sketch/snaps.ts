import type { SketchProfile } from "@/types/sketchforge";
import type { SketchDoc, SketchSnapResult, SketchVec2 } from "./types";

const DEFAULT_PIXEL_TOL = 10;

function dist(a: SketchVec2, b: SketchVec2) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function projectPointOnSegment(p: SketchVec2, a: SketchVec2, b: SketchVec2) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return { ...a, t: 0 };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  return { x: a.x + dx * t, z: a.z + dz * t, t };
}

function segmentIntersection(a1: SketchVec2, a2: SketchVec2, b1: SketchVec2, b2: SketchVec2): SketchVec2 | null {
  const dax = a2.x - a1.x;
  const daz = a2.z - a1.z;
  const dbx = b2.x - b1.x;
  const dbz = b2.z - b1.z;
  const denom = dax * dbz - daz * dbx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((b1.x - a1.x) * dbz - (b1.z - a1.z) * dbx) / denom;
  const u = ((b1.x - a1.x) * daz - (b1.z - a1.z) * dax) / denom;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: a1.x + dax * t, z: a1.z + daz * t };
}

export type SnapQuery = {
  cursor: SketchVec2;
  /** Previous point for horiz/vert inference (e.g. line start). */
  from?: SketchVec2 | null;
  /** World units per screen pixel (approx). */
  screenUnit: number;
  gridStep?: number;
  /** Prefer entity snaps over grid when within this many pixels. */
  pixelTolerance?: number;
  /** Point ids to ignore (e.g. the point currently being dragged). */
  excludePointIds?: readonly string[];
};

/** Entity + inference snaps for a legacy profile (used by SketchWorkspace). */
export function snapSketchPoint(profile: SketchProfile, query: SnapQuery): SketchSnapResult {
  const tol = (query.pixelTolerance ?? DEFAULT_PIXEL_TOL) * Math.max(query.screenUnit, 1e-6);
  const cursor = query.cursor;
  const candidates: SketchSnapResult[] = [];

  const excluded = query.excludePointIds?.length ? new Set(query.excludePointIds) : null;
  for (const point of profile.points) {
    if (excluded?.has(point.id)) continue;
    const d = dist(cursor, point);
    if (d <= tol) {
      candidates.push({
        x: point.x,
        z: point.z,
        kind: "endpoint",
        pointId: point.id,
        inferredConstraints: [{ kind: "coincident", entityIds: [], pointIds: [point.id] }],
      });
    }
  }

  const pointById = new Map(profile.points.map((p) => [p.id, p]));
  for (const segment of profile.segments) {
    const a = pointById.get(segment.startId);
    const b = pointById.get(segment.endId);
    if (!a || !b) continue;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    if (dist(cursor, mid) <= tol) {
      candidates.push({
        x: mid.x,
        z: mid.z,
        kind: "midpoint",
        entityId: segment.id,
        inferredConstraints: [{ kind: "midpoint", entityIds: [segment.id] }],
      });
    }
    const proj = projectPointOnSegment(cursor, a, b);
    if (proj.t > 0.05 && proj.t < 0.95 && dist(cursor, proj) <= tol) {
      candidates.push({
        x: proj.x,
        z: proj.z,
        kind: "nearest",
        entityId: segment.id,
        inferredConstraints: [],
      });
    }
  }

  // Intersections
  for (let i = 0; i < profile.segments.length; i += 1) {
    const s1 = profile.segments[i];
    const a1 = pointById.get(s1.startId);
    const a2 = pointById.get(s1.endId);
    if (!a1 || !a2) continue;
    for (let j = i + 1; j < profile.segments.length; j += 1) {
      const s2 = profile.segments[j];
      if (s1.startId === s2.startId || s1.startId === s2.endId || s1.endId === s2.startId || s1.endId === s2.endId) continue;
      const b1 = pointById.get(s2.startId);
      const b2 = pointById.get(s2.endId);
      if (!b1 || !b2) continue;
      const hit = segmentIntersection(a1, a2, b1, b2);
      if (hit && dist(cursor, hit) <= tol) {
        candidates.push({
          x: hit.x,
          z: hit.z,
          kind: "intersection",
          entityId: s1.id,
          inferredConstraints: [],
        });
      }
    }
  }

  // Circle-like closed quads: use centroid as center snap when 4+ points near equal radius
  // (lightweight; full circle entities handled via SketchDoc snap below)

  if (query.from) {
    const dx = Math.abs(cursor.x - query.from.x);
    const dz = Math.abs(cursor.z - query.from.z);
    if (dz <= tol && dx > tol) {
      candidates.push({
        x: cursor.x,
        z: query.from.z,
        kind: "horizontal",
        inferredConstraints: [{ kind: "horizontal", entityIds: [] }],
      });
    }
    if (dx <= tol && dz > tol) {
      candidates.push({
        x: query.from.x,
        z: cursor.z,
        kind: "vertical",
        inferredConstraints: [{ kind: "vertical", entityIds: [] }],
      });
    }
  }

  const priority: Record<SketchSnapResult["kind"], number> = {
    endpoint: 0,
    intersection: 1,
    midpoint: 2,
    center: 3,
    quadrant: 4,
    nearest: 5,
    horizontal: 6,
    vertical: 7,
    grid: 8,
  };

  candidates.sort((a, b) => {
    const pa = priority[a.kind];
    const pb = priority[b.kind];
    if (pa !== pb) return pa - pb;
    return dist(cursor, a) - dist(cursor, b);
  });

  if (candidates.length > 0 && dist(cursor, candidates[0]) <= tol * 1.25) {
    return candidates[0];
  }

  if (query.gridStep && query.gridStep > 0) {
    const step = query.gridStep;
    const gx = Math.round(cursor.x / step) * step;
    const gz = Math.round(cursor.z / step) * step;
    return { x: gx, z: gz, kind: "grid", inferredConstraints: [] };
  }

  return { x: cursor.x, z: cursor.z, kind: "grid", inferredConstraints: [] };
}

/** Snaps against a SketchDoc including circle centers/quadrants. */
export function snapSketchDocPoint(doc: SketchDoc, query: SnapQuery): SketchSnapResult {
  const profile = {
    points: doc.entities
      .filter((e) => e.kind === "point")
      .map((e) => (e.kind === "point" ? { id: e.id, x: e.x, z: e.z } : { id: "", x: 0, z: 0 })),
    segments: doc.entities
      .filter((e) => e.kind === "line" || e.kind === "bezier" || e.kind === "smooth")
      .map((e) =>
        e.kind === "line" || e.kind === "bezier" || e.kind === "smooth"
          ? { id: e.id, startId: e.startId, endId: e.endId, kind: e.kind === "line" ? ("line" as const) : e.kind }
          : { id: "", startId: "", endId: "" },
      ),
  };
  const base = snapSketchPoint(profile, query);
  const tol = (query.pixelTolerance ?? DEFAULT_PIXEL_TOL) * Math.max(query.screenUnit, 1e-6);

  let bestCircle: SketchSnapResult | null = null;
  let bestCircleDist = Infinity;
  for (const entity of doc.entities) {
    if (entity.kind !== "circle") continue;
    const center = doc.entities.find((e) => e.kind === "point" && e.id === entity.centerId);
    if (!center || center.kind !== "point") continue;
    const centerDist = dist(query.cursor, center);
    if (centerDist <= tol && centerDist < bestCircleDist) {
      bestCircleDist = centerDist;
      bestCircle = {
        x: center.x,
        z: center.z,
        kind: "center",
        entityId: entity.id,
        pointId: center.id,
        inferredConstraints: [{ kind: "concentric", entityIds: [entity.id] }],
      };
    }
    const quads: SketchVec2[] = [
      { x: center.x + entity.radius, z: center.z },
      { x: center.x - entity.radius, z: center.z },
      { x: center.x, z: center.z + entity.radius },
      { x: center.x, z: center.z - entity.radius },
    ];
    for (const q of quads) {
      const qDist = dist(query.cursor, q);
      if (qDist <= tol && qDist < bestCircleDist) {
        bestCircleDist = qDist;
        bestCircle = {
          x: q.x,
          z: q.z,
          kind: "quadrant",
          entityId: entity.id,
          inferredConstraints: [],
        };
      }
    }
  }

  if (!bestCircle) return base;

  // Never let center/quadrant win over a closer endpoint/intersection/etc.
  const baseDist = dist(query.cursor, base);
  if (base.kind !== "grid" && baseDist <= bestCircleDist + 1e-9) {
    return base;
  }
  return bestCircle;
}
