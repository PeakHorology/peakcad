import type { SketchPlane, SketchPoint, SketchProfile, SketchSegment } from "@/types/sketchforge";
import { cloneSketchPlane, defaultSketchPlane, mergeSketchPlanes, resolveSketchPlane } from "@/lib/sketchPlane";
import { createEmptySketchDoc, type SketchDoc, type SketchEntity } from "./types";

function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert legacy SketchProfile → SketchDoc (source of truth going forward). */
export function sketchProfileToDoc(
  profile: SketchProfile,
  existingId?: string,
  planeFallback?: SketchPlane | null,
): SketchDoc {
  const plane = mergeSketchPlanes(profile.sketchPlane, planeFallback ?? defaultSketchPlane());
  const doc = createEmptySketchDoc(plane, existingId ?? newId("sketch"));
  doc.images = (profile.images ?? []).map((image) => ({ ...image }));
  doc.faceReferenceLoops = profile.faceReferenceLoops?.map((loop) => loop.map((p) => ({ ...p })));

  const entities: SketchEntity[] = [];
  for (const point of profile.points) {
    entities.push({
      kind: "point",
      id: point.id,
      x: point.x,
      z: point.z,
      handleIn: point.handleIn ? { ...point.handleIn } : undefined,
      handleOut: point.handleOut ? { ...point.handleOut } : undefined,
      mode: point.mode,
    });
  }
  for (const segment of profile.segments) {
    const kind = segment.kind === "bezier" || segment.kind === "smooth" ? segment.kind : "line";
    entities.push({
      kind,
      id: segment.id,
      startId: segment.startId,
      endId: segment.endId,
    });
  }
  doc.entities = entities;
  return doc;
}

/** Convert SketchDoc → legacy SketchProfile for extrude/revolve mesh pipeline. */
/**
 * Chord tolerance for tessellating sketch circles and arcs. The previous fixed counts (32 per
 * circle, 15° per arc step) made the error scale with radius: a 100mm circle sat 0.48mm inside
 * its true radius, and these polylines are what the STEP bake extrudes, so that error shipped in
 * a body badged "exact". Holding the sagitta to a fixed tolerance makes it size-independent.
 */
const CURVE_CHORD_TOLERANCE_MM = 0.01;
const MIN_CIRCLE_SEGMENTS = 32;
const MIN_ARC_SEGMENTS = 4;
const MAX_CURVE_SEGMENTS = 512;

export function curveSegmentCount(radius: number, sweepRadians: number = Math.PI * 2) {
  const sweep = Math.abs(sweepRadians);
  const fullTurn = sweep >= Math.PI * 2 - 1e-9;
  const floor = fullTurn ? MIN_CIRCLE_SEGMENTS : MIN_ARC_SEGMENTS;
  if (!Number.isFinite(radius) || radius <= 0 || sweep < 1e-9) return floor;
  // Sagitta of a chord spanning angle t is r(1 - cos(t/2)); solve that for the tolerance.
  const cosHalf = 1 - CURVE_CHORD_TOLERANCE_MM / radius;
  if (cosHalf <= -1) return floor;
  const maxStep = 2 * Math.acos(Math.min(1, cosHalf));
  if (!Number.isFinite(maxStep) || maxStep <= 1e-9) return MAX_CURVE_SEGMENTS;
  return Math.min(MAX_CURVE_SEGMENTS, Math.max(floor, Math.ceil(sweep / maxStep)));
}

export function sketchDocToProfile(doc: SketchDoc): SketchProfile {
  const points: SketchPoint[] = doc.entities
    .filter((e) => e.kind === "point")
    .map((e) => {
      if (e.kind !== "point") throw new Error("unreachable");
      return {
        id: e.id,
        x: e.x,
        z: e.z,
        handleIn: e.handleIn ? { ...e.handleIn } : undefined,
        handleOut: e.handleOut ? { ...e.handleOut } : undefined,
        mode: e.mode,
      };
    });

  const segments: SketchSegment[] = doc.entities
    .filter((e) => e.kind === "line" || e.kind === "bezier" || e.kind === "smooth")
    .filter((e) => !e.construction)
    .map((e) => {
      if (e.kind !== "line" && e.kind !== "bezier" && e.kind !== "smooth") throw new Error("unreachable");
      return {
        id: e.id,
        startId: e.startId,
        endId: e.endId,
        kind: e.kind === "line" ? ("line" as const) : e.kind,
      };
    });

  // Expand circles into polyline approximations for the mesh extrude path
  for (const entity of doc.entities) {
    if (entity.kind !== "circle" || entity.construction) continue;
    const center = doc.entities.find((e) => e.kind === "point" && e.id === entity.centerId);
    if (!center || center.kind !== "point") continue;
    const segmentsCount = curveSegmentCount(entity.radius);
    const circlePointIds: string[] = [];
    for (let i = 0; i < segmentsCount; i += 1) {
      const angle = (i / segmentsCount) * Math.PI * 2;
      const id = `${entity.id}-p${i}`;
      points.push({
        id,
        x: center.x + Math.cos(angle) * entity.radius,
        z: center.z + Math.sin(angle) * entity.radius,
      });
      circlePointIds.push(id);
    }
    for (let i = 0; i < segmentsCount; i += 1) {
      segments.push({
        id: `${entity.id}-s${i}`,
        startId: circlePointIds[i],
        endId: circlePointIds[(i + 1) % segmentsCount],
        kind: "line",
      });
    }
  }

  // Expand arcs into polylines
  for (const entity of doc.entities) {
    if (entity.kind !== "arc" || entity.construction) continue;
    const center = doc.entities.find((e) => e.kind === "point" && e.id === entity.centerId);
    const start = doc.entities.find((e) => e.kind === "point" && e.id === entity.startId);
    const end = doc.entities.find((e) => e.kind === "point" && e.id === entity.endId);
    if (!center || center.kind !== "point" || !start || start.kind !== "point" || !end || end.kind !== "point") continue;
    const r = Math.hypot(start.x - center.x, start.z - center.z);
    let a0 = Math.atan2(start.z - center.z, start.x - center.x);
    let a1 = Math.atan2(end.z - center.z, end.x - center.x);
    const ccw = entity.ccw !== false;
    if (ccw && a1 <= a0) a1 += Math.PI * 2;
    if (!ccw && a0 <= a1) a0 += Math.PI * 2;
    const span = a1 - a0;
    const steps = curveSegmentCount(r, span);
    const arcIds = [entity.startId];
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const angle = a0 + span * t;
      const id = `${entity.id}-p${i}`;
      points.push({
        id,
        x: center.x + Math.cos(angle) * r,
        z: center.z + Math.sin(angle) * r,
      });
      arcIds.push(id);
    }
    arcIds.push(entity.endId);
    for (let i = 0; i < arcIds.length - 1; i += 1) {
      segments.push({
        id: `${entity.id}-s${i}`,
        startId: arcIds[i],
        endId: arcIds[i + 1],
        kind: "line",
      });
    }
  }

  return {
    points,
    segments,
    images: doc.images.map((image) => ({ ...image })),
    sketchPlane: cloneSketchPlane(doc.plane),
    faceReferenceLoops: doc.faceReferenceLoops?.map((loop) => loop.map((p) => ({ ...p }))),
  };
}

/**
 * Drop constraints and dimensions that reference entities the document no longer contains.
 *
 * Deleting geometry used to leave these behind pointing at dead ids. The solver then carried
 * constraints it could never satisfy and the palette counted dimensions with nothing to measure,
 * so a sketch could sit permanently over-constrained or "unsolved" with no visible cause.
 * Mutates `doc` in place; callers already hold a fresh clone.
 */
export function pruneDanglingReferences(doc: SketchDoc): SketchDoc {
  const liveIds = new Set(doc.entities.map((entity) => entity.id));
  const referencesLiveIds = (entityIds: string[], pointIds?: string[]) =>
    entityIds.every((id) => liveIds.has(id)) && (pointIds ?? []).every((id) => liveIds.has(id));
  doc.constraints = doc.constraints.filter((constraint) =>
    referencesLiveIds(constraint.entityIds, constraint.pointIds));
  doc.dimensions = doc.dimensions.filter((dimension) =>
    referencesLiveIds(dimension.entityIds, dimension.pointIds));
  return doc;
}

/** Matches the `<curveId>-p3` / `<curveId>-s3` ids that curve expansion generates. */
const TESSELLATION_ID = /^(.*)-[ps]\d+$/;

/**
 * Fold a legacy profile's edits back into the document it came from.
 *
 * Rebuilding the doc from the profile instead discarded everything a profile cannot express:
 * construction geometry, projected references along with their locks and source links, and analytic
 * circles and arcs. Because a dimension edit round-trips through the profile, one edit destroyed all
 * of it permanently. The profile stays authoritative for the plain geometry it does carry, so
 * ordinary moves and deletions still apply; the doc's plane, constraints, dimensions and settings
 * are its own and are left alone.
 */
export function mergeProfileIntoDoc(doc: SketchDoc, profile: SketchProfile): SketchDoc {
  const next = cloneSketchDoc(doc);
  next.images = (profile.images ?? []).map((image) => ({ ...image }));
  if (profile.faceReferenceLoops?.length) {
    next.faceReferenceLoops = profile.faceReferenceLoops.map((loop) => loop.map((point) => ({ ...point })));
  }

  const profilePoints = new Map(profile.points.map((point) => [point.id, point]));
  const profileSegments = new Map(profile.segments.map((segment) => [segment.id, segment]));

  // A curve survives while the profile still carries the polyline it was expanded into. Construction
  // curves are never expanded, so their absence from the profile says nothing about the user's intent.
  const curves = next.entities.filter(
    (entity): entity is Extract<SketchEntity, { kind: "circle" | "arc" }> =>
      entity.kind === "circle" || entity.kind === "arc",
  );
  const keptCurveIds = new Set(
    curves
      .filter((curve) =>
        curve.construction
        || profile.points.some((point) => point.id.startsWith(`${curve.id}-p`))
        || profile.segments.some((segment) => segment.id.startsWith(`${curve.id}-s`)))
      .map((curve) => curve.id),
  );
  // A kept curve's defining points must outlive the polyline that stands in for it.
  const curveAnchorIds = new Set<string>();
  for (const curve of curves) {
    if (!keptCurveIds.has(curve.id)) continue;
    curveAnchorIds.add(curve.centerId);
    if (curve.kind === "arc") {
      curveAnchorIds.add(curve.startId);
      curveAnchorIds.add(curve.endId);
    }
  }

  const entities: SketchEntity[] = [];
  for (const entity of next.entities) {
    if (entity.kind === "circle" || entity.kind === "arc") {
      if (keptCurveIds.has(entity.id)) entities.push(entity);
      continue;
    }
    if (entity.kind === "point") {
      const updated = profilePoints.get(entity.id);
      if (updated) {
        // Position comes from the profile; construction, projected and fixed flags stay put.
        entities.push({
          ...entity,
          x: updated.x,
          z: updated.z,
          handleIn: updated.handleIn ? { ...updated.handleIn } : undefined,
          handleOut: updated.handleOut ? { ...updated.handleOut } : undefined,
          mode: updated.mode,
        });
      } else if (curveAnchorIds.has(entity.id)) {
        entities.push(entity);
      }
      continue;
    }
    const updated = profileSegments.get(entity.id);
    if (updated) {
      entities.push({
        ...entity,
        kind: updated.kind === "bezier" || updated.kind === "smooth" ? updated.kind : "line",
        startId: updated.startId,
        endId: updated.endId,
      });
    } else if (entity.construction) {
      // Construction segments are never emitted to the profile, so absence is not a deletion.
      entities.push(entity);
    }
  }

  const known = new Set(entities.map((entity) => entity.id));
  const standsInForKeptCurve = (id: string) => {
    const match = TESSELLATION_ID.exec(id);
    return match !== null && keptCurveIds.has(match[1]);
  };

  for (const point of profile.points) {
    if (known.has(point.id) || standsInForKeptCurve(point.id)) continue;
    entities.push({
      kind: "point",
      id: point.id,
      x: point.x,
      z: point.z,
      handleIn: point.handleIn ? { ...point.handleIn } : undefined,
      handleOut: point.handleOut ? { ...point.handleOut } : undefined,
      mode: point.mode,
    });
  }
  for (const segment of profile.segments) {
    if (known.has(segment.id) || standsInForKeptCurve(segment.id)) continue;
    entities.push({
      kind: segment.kind === "bezier" || segment.kind === "smooth" ? segment.kind : "line",
      id: segment.id,
      startId: segment.startId,
      endId: segment.endId,
    });
  }

  next.entities = entities;
  return pruneDanglingReferences(next);
}

export function cloneSketchDoc(doc: SketchDoc): SketchDoc {
  return {
    id: doc.id,
    plane: cloneSketchPlane(doc.plane),
    entities: doc.entities.map((entity) => ({ ...entity }) as SketchEntity),
    constraints: doc.constraints.map((c) => ({ ...c, entityIds: [...c.entityIds], pointIds: c.pointIds ? [...c.pointIds] : undefined })),
    dimensions: doc.dimensions.map((d) => ({
      ...d,
      entityIds: [...d.entityIds],
      pointIds: d.pointIds ? [...d.pointIds] : undefined,
      labelOffset: d.labelOffset ? { ...d.labelOffset } : undefined,
    })),
    images: doc.images.map((image) => ({ ...image })),
    faceReferenceLoops: doc.faceReferenceLoops?.map((loop) => loop.map((p) => ({ ...p }))),
    settings: { ...doc.settings },
    selectedProfileIds: [...doc.selectedProfileIds],
  };
}

export function ensureSketchDocOnShape(args: {
  sketchDoc?: SketchDoc | null;
  sketchProfile?: SketchProfile | null;
  sketchPlane?: SketchPlane | null;
  sketchId?: string | null;
}): SketchDoc | null {
  if (args.sketchDoc) return cloneSketchDoc(args.sketchDoc);
  if (args.sketchProfile) {
    return sketchProfileToDoc(args.sketchProfile, args.sketchId ?? undefined);
  }
  return null;
}
