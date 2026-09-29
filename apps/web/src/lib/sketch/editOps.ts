import type { SketchPoint, SketchProfile, SketchSegment } from "@/types/sketchforge";
import { cloneSketchDoc, pruneDanglingReferences } from "./migrate";
import type { SketchDoc, SketchEntity, SketchPointEntity, SketchVec2 } from "./types";

function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function pointById(doc: SketchDoc, id: string): SketchPointEntity | null {
  const e = doc.entities.find((ent) => ent.id === id && ent.kind === "point");
  return e && e.kind === "point" ? e : null;
}


/** Toggle construction flag on entities. */
export function setConstruction(doc: SketchDoc, entityIds: string[], construction: boolean): SketchDoc {
  const next = cloneSketchDoc(doc);
  next.entities = next.entities.map((e) => (entityIds.includes(e.id) ? { ...e, construction } : e));
  return next;
}

/** Split a line at a UV point (nearest projection). */
export function splitLineAtPoint(doc: SketchDoc, lineId: string, at: SketchVec2): SketchDoc {
  const next = cloneSketchDoc(doc);
  const line = next.entities.find((e) => e.id === lineId && e.kind === "line");
  if (!line || line.kind !== "line") return doc;
  const a = pointById(next, line.startId);
  const b = pointById(next, line.endId);
  if (!a || !b) return doc;
  const mid: SketchPointEntity = {
    kind: "point",
    id: newId("sketch-point"),
    x: at.x,
    z: at.z,
    construction: line.construction,
  };
  next.entities = next.entities.filter((e) => e.id !== lineId);
  next.entities.push(mid, {
    kind: "line",
    id: newId("sketch-segment"),
    startId: a.id,
    endId: mid.id,
    construction: line.construction,
  }, {
    kind: "line",
    id: newId("sketch-segment"),
    startId: mid.id,
    endId: b.id,
    construction: line.construction,
  });
  // The original line id is gone. Which half should inherit an equal/parallel/tangent constraint
  // is genuinely ambiguous, so drop them rather than guess or leave them pointing at a dead id.
  return pruneDanglingReferences(next);
}

const CURVE_SEGMENT_ID = /^(.*)-s\d+$/;
const TRIM_ENDPOINT_GAP = 0.02;

function lineCircleParameters(
  a: SketchVec2,
  b: SketchVec2,
  center: SketchVec2,
  radius: number,
): number[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const fx = a.x - center.x;
  const fz = a.z - center.z;
  const A = dx * dx + dz * dz;
  if (A < 1e-12) return [];
  const B = 2 * (fx * dx + fz * dz);
  const C = fx * fx + fz * fz - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-B - root) / (2 * A), (-B + root) / (2 * A)];
}

function projectParameter(at: SketchVec2, a: SketchVec2, b: SketchVec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return 0;
  return ((at.x - a.x) * dx + (at.z - a.z) * dz) / len2;
}

/** A drawn circle's tessellated chord (`circleId-s3`) or the circle entity itself. */
export function resolveSketchCircle(doc: SketchDoc, segmentId?: string | null, pointId?: string | null) {
  const ids = [segmentId, pointId].filter((id): id is string => Boolean(id));
  for (const id of ids) {
    const curveId = CURVE_SEGMENT_ID.exec(id)?.[1] ?? id;
    const byId = doc.entities.find((entity) => entity.id === curveId && entity.kind === "circle");
    if (byId && byId.kind === "circle") return byId;
  }
  if (pointId) {
    const byCenter = doc.entities.find((entity) => entity.kind === "circle" && entity.centerId === pointId);
    if (byCenter && byCenter.kind === "circle") return byCenter;
  }
  return null;
}

/**
 * Fusion-style trim: delete only the span that contains the click, cutting the curve at every
 * intersection. A curve with nothing to cut against is removed entirely.
 */
export function trimClickedSpan(doc: SketchDoc, entityId: string, at: SketchVec2): SketchDoc {
  const direct = doc.entities.find((entity) => entity.id === entityId);
  if (direct?.kind === "line") return trimLineAt(doc, direct, at);
  const curveId = CURVE_SEGMENT_ID.exec(entityId)?.[1];
  const curve = curveId ? doc.entities.find((entity) => entity.id === curveId) : null;
  if (curve?.kind === "circle") return trimCircleAt(doc, curve, at);
  return trimEntity(doc, entityId);
}

function trimLineAt(doc: SketchDoc, line: Extract<SketchEntity, { kind: "line" }>, at: SketchVec2): SketchDoc {
  const next = cloneSketchDoc(doc);
  const a = pointById(next, line.startId);
  const b = pointById(next, line.endId);
  if (!a || !b) return doc;
  const cuts: Array<{ t: number; x: number; z: number; pointId?: string }> = [];
  const consider = (t: number, x: number, z: number, pointId?: string) => {
    if (t <= TRIM_ENDPOINT_GAP || t >= 1 - TRIM_ENDPOINT_GAP) return;
    const near = cuts.find((cut) => Math.abs(cut.t - t) < 1e-3);
    if (near) {
      if (!near.pointId && pointId) near.pointId = pointId;
      return;
    }
    cuts.push({ t, x, z, pointId });
  };

  for (const entity of next.entities) {
    if (entity.id === line.id) continue;
    if (entity.kind === "line") {
      const c = pointById(next, entity.startId);
      const d = pointById(next, entity.endId);
      if (!c || !d) continue;
      const hit = segmentHit(a, b, c, d);
      if (hit) consider(hit.t, hit.x, hit.z, hit.pointId);
      for (const end of [c, d]) {
        const t = projectParameter(end, a, b);
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        if (Math.hypot(end.x - x, end.z - z) <= 0.05) consider(t, end.x, end.z, end.id);
      }
    } else if (entity.kind === "circle") {
      const center = pointById(next, entity.centerId);
      if (!center) continue;
      for (const t of lineCircleParameters(a, b, center, entity.radius)) {
        consider(t, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      }
    }
  }

  if (!cuts.length) return trimEntity(doc, line.id);
  cuts.sort((left, right) => left.t - right.t);
  const clickT = Math.min(1, Math.max(0, projectParameter(at, a, b)));
  const stations = [
    { t: 0, pointId: a.id },
    ...cuts.map((cut) => ({ t: cut.t, pointId: cut.pointId ?? placePoint(next, cut.x, cut.z) })),
    { t: 1, pointId: b.id },
  ];
  next.entities = next.entities.filter((entity) => entity.id !== line.id);
  for (let index = 0; index < stations.length - 1; index += 1) {
    const start = stations[index];
    const end = stations[index + 1];
    const containsClick = clickT >= start.t - 1e-6 && (index === stations.length - 2 ? clickT <= end.t + 1e-6 : clickT < end.t - 1e-9);
    if (containsClick || start.pointId === end.pointId) continue;
    next.entities.push({
      kind: "line",
      id: newId("sketch-segment"),
      startId: start.pointId,
      endId: end.pointId,
      construction: line.construction,
    });
  }
  return dropOrphanPoints(next);
}

function trimCircleAt(doc: SketchDoc, circle: Extract<SketchEntity, { kind: "circle" }>, at: SketchVec2): SketchDoc {
  const next = cloneSketchDoc(doc);
  const center = pointById(next, circle.centerId);
  if (!center) return trimEntity(doc, circle.id);
  const hits: Array<{ angle: number; pointId?: string }> = [];
  const consider = (angle: number, x: number, z: number, pointId?: string) => {
    const wrapped = (angle + Math.PI * 2) % (Math.PI * 2);
    const near = hits.find((hit) => Math.min(Math.abs(hit.angle - wrapped), Math.PI * 2 - Math.abs(hit.angle - wrapped)) < 0.02);
    if (near) {
      if (!near.pointId && pointId) near.pointId = pointId;
      return;
    }
    hits.push({ angle: wrapped, pointId });
  };
  for (const entity of next.entities) {
    if (entity.kind !== "line") continue;
    const a = pointById(next, entity.startId);
    const b = pointById(next, entity.endId);
    if (!a || !b) continue;
    for (const t of lineCircleParameters(a, b, center, circle.radius)) {
      if (t < -1e-4 || t > 1 + 1e-4) continue;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const reuse = [a, b].find((point) => Math.hypot(point.x - x, point.z - z) <= 0.05);
      consider(Math.atan2(z - center.z, x - center.x), x, z, reuse?.id);
    }
  }
  if (hits.length < 2) return trimEntity(doc, circle.id);
  hits.sort((left, right) => left.angle - right.angle);
  const clickAngle = (Math.atan2(at.z - center.z, at.x - center.x) + Math.PI * 2) % (Math.PI * 2);
  const ccw = (from: number, to: number) => {
    const span = (to - from + Math.PI * 2) % (Math.PI * 2);
    return span === 0 ? Math.PI * 2 : span;
  };
  let removeFrom = hits[hits.length - 1];
  let removeTo = hits[0];
  for (let index = 0; index < hits.length; index += 1) {
    const from = hits[index];
    const to = hits[(index + 1) % hits.length];
    if (ccw(from.angle, clickAngle) <= ccw(from.angle, to.angle) + 1e-6) {
      removeFrom = from;
      removeTo = to;
      break;
    }
  }
  const startId = removeTo.pointId ?? placePoint(next, center.x + Math.cos(removeTo.angle) * circle.radius, center.z + Math.sin(removeTo.angle) * circle.radius);
  const endId = removeFrom.pointId ?? placePoint(next, center.x + Math.cos(removeFrom.angle) * circle.radius, center.z + Math.sin(removeFrom.angle) * circle.radius);
  next.entities = next.entities.filter((entity) => entity.id !== circle.id);
  if (startId !== endId) {
    next.entities.push({
      kind: "arc",
      id: newId("sketch-arc"),
      centerId: center.id,
      startId,
      endId,
      ccw: true,
      construction: circle.construction,
    });
  }
  return dropOrphanPoints(next);
}

function dropOrphanPoints(doc: SketchDoc): SketchDoc {
  const used = new Set<string>();
  for (const entity of doc.entities) {
    if (entity.kind === "line" || entity.kind === "bezier" || entity.kind === "smooth") {
      used.add(entity.startId);
      used.add(entity.endId);
    } else if (entity.kind === "circle") {
      used.add(entity.centerId);
    } else if (entity.kind === "arc") {
      used.add(entity.centerId);
      used.add(entity.startId);
      used.add(entity.endId);
    }
  }
  doc.entities = doc.entities.filter((entity) => entity.kind !== "point" || used.has(entity.id) || entity.fixed || entity.projected);
  return pruneDanglingReferences(doc);
}

function placePoint(doc: SketchDoc, x: number, z: number): string {
  const existing = doc.entities.find((entity) => entity.kind === "point" && Math.hypot(entity.x - x, entity.z - z) <= 0.05);
  if (existing) return existing.id;
  const id = newId("sketch-point");
  doc.entities.push({ kind: "point", id, x, z });
  return id;
}

function segmentHit(
  a: SketchPointEntity,
  b: SketchPointEntity,
  c: SketchPointEntity,
  d: SketchPointEntity,
): { t: number; x: number; z: number; pointId?: string } | null {
  const dax = b.x - a.x;
  const daz = b.z - a.z;
  const dbx = d.x - c.x;
  const dbz = d.z - c.z;
  const denom = dax * dbz - daz * dbx;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((c.x - a.x) * dbz - (c.z - a.z) * dbx) / denom;
  const u = ((c.x - a.x) * daz - (c.z - a.z) * dax) / denom;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  const x = a.x + dax * t;
  const z = a.z + daz * t;
  const reuse = [a, b, c, d].find((point) => Math.hypot(point.x - x, point.z - z) <= 0.05);
  return { t, x, z, pointId: reuse?.id };
}

/** Trim: remove a line segment entity. */
export function trimEntity(doc: SketchDoc, entityId: string): SketchDoc {
  const next = cloneSketchDoc(doc);
  const entity = next.entities.find((e) => e.id === entityId);
  if (!entity || entity.kind === "point") return doc;
  next.entities = next.entities.filter((e) => e.id !== entityId);
  // Drop orphan non-shared points
  const used = new Set<string>();
  for (const e of next.entities) {
    if (e.kind === "line" || e.kind === "bezier" || e.kind === "smooth") {
      used.add(e.startId);
      used.add(e.endId);
    }
    if (e.kind === "circle" || e.kind === "arc") used.add(e.centerId);
    if (e.kind === "arc") {
      used.add(e.startId);
      used.add(e.endId);
    }
  }
  next.entities = next.entities.filter((e) => e.kind !== "point" || used.has(e.id) || e.fixed || e.projected);
  return pruneDanglingReferences(next);
}

/** Extend a line endpoint toward a target point (moves free endpoint). */
export function extendLineToPoint(doc: SketchDoc, lineId: string, toward: SketchVec2, end: "start" | "end" = "end"): SketchDoc {
  const next = cloneSketchDoc(doc);
  const line = next.entities.find((e) => e.id === lineId && e.kind === "line");
  if (!line || line.kind !== "line") return doc;
  const pointId = end === "start" ? line.startId : line.endId;
  next.entities = next.entities.map((e) => {
    if (e.kind === "point" && e.id === pointId && !e.fixed) {
      return { ...e, x: toward.x, z: toward.z };
    }
    return e;
  });
  return next;
}

/** Most of each leg a corner cut may consume, so the neighbouring geometry survives. */
const CORNER_TRIM_FRACTION = 0.45;

/** Unit leg directions and the interior angle at a two-segment corner. */
function cornerGeometry(profile: SketchProfile, vertexId: string) {
  const point = profile.points.find((p) => p.id === vertexId);
  if (!point) return null;
  const connected = profile.segments.filter((s) => s.startId === vertexId || s.endId === vertexId);
  if (connected.length !== 2) return null;
  const otherId = (s: SketchSegment) => (s.startId === vertexId ? s.endId : s.startId);
  const p1 = profile.points.find((p) => p.id === otherId(connected[0]));
  const p2 = profile.points.find((p) => p.id === otherId(connected[1]));
  if (!p1 || !p2) return null;

  const len1 = Math.hypot(p1.x - point.x, p1.z - point.z);
  const len2 = Math.hypot(p2.x - point.x, p2.z - point.z);
  if (len1 < 1e-9 || len2 < 1e-9) return null;
  const u1 = { x: (p1.x - point.x) / len1, z: (p1.z - point.z) / len1 };
  const u2 = { x: (p2.x - point.x) / len2, z: (p2.z - point.z) / len2 };
  const interiorAngle = Math.acos(Math.min(1, Math.max(-1, u1.x * u2.x + u1.z * u2.z)));
  // Legs that double back on each other or run straight through have no corner to cut.
  if (interiorAngle < 1e-3 || Math.PI - interiorAngle < 1e-3) return null;

  return {
    point,
    connected: [connected[0], connected[1]] as [SketchSegment, SketchSegment],
    u1,
    u2,
    interiorAngle,
    maxTangent: Math.min(len1, len2) * CORNER_TRIM_FRACTION,
  };
}

/**
 * Replace a corner with either an arc (`rounded`) or a straight cut, setting each leg back by
 * `requestedTangent`.
 */
function cutCorner(
  profile: SketchProfile,
  vertexId: string,
  requestedTangent: number,
  rounded: boolean,
): SketchProfile | null {
  if (!(requestedTangent > 0)) return null;
  const corner = cornerGeometry(profile, vertexId);
  if (!corner) return null;
  const { point, connected, u1, u2, interiorAngle, maxTangent } = corner;
  const tangent = Math.min(requestedTangent, maxTangent);
  if (!(tangent > 1e-9)) return null;

  const t1 = { x: point.x + u1.x * tangent, z: point.z + u1.z * tangent };
  const t2 = { x: point.x + u2.x * tangent, z: point.z + u2.z * tangent };
  const id1 = newId("sketch-point");
  const id2 = newId("sketch-point");

  // Cubic control offset for a circular arc of this sweep — the same 4/3·tan(sweep/4) rule the arc
  // drawing tools use. Parking the handles on the corner itself overshot the true arc by ~80%, so
  // the curve was nowhere near the radius the user asked for.
  const radius = tangent * Math.tan(interiorAngle / 2);
  const handleLength = rounded ? (4 / 3) * Math.tan((Math.PI - interiorAngle) / 4) * radius : 0;
  const handleAt = (t: { x: number; z: number }, u: { x: number; z: number }) => ({
    x: t.x - u.x * handleLength,
    z: t.z - u.z * handleLength,
  });

  const cutPoints: SketchPoint[] = rounded
    ? [
      { id: id1, x: t1.x, z: t1.z, mode: "smooth", handleIn: handleAt(t1, u1), handleOut: handleAt(t1, u1) },
      { id: id2, x: t2.x, z: t2.z, mode: "smooth", handleIn: handleAt(t2, u2), handleOut: handleAt(t2, u2) },
    ]
    : [
      { id: id1, x: t1.x, z: t1.z, mode: "corner" },
      { id: id2, x: t2.x, z: t2.z, mode: "corner" },
    ];

  // Each leg keeps its own kind and orientation. Rebuilding them as plain lines straightened
  // curved neighbours, and stripping handles profile-wide destroyed unrelated curves.
  const legWithoutVertex = (segment: SketchSegment, replacementId: string): SketchSegment => ({
    ...segment,
    id: newId("sketch-segment"),
    startId: segment.startId === vertexId ? replacementId : segment.startId,
    endId: segment.endId === vertexId ? replacementId : segment.endId,
  });

  return {
    ...profile,
    points: profile.points.filter((p) => p.id !== vertexId).concat(cutPoints),
    segments: profile.segments
      .filter((s) => s.id !== connected[0].id && s.id !== connected[1].id)
      .concat([
        legWithoutVertex(connected[0], id1),
        legWithoutVertex(connected[1], id2),
        { id: newId("sketch-segment"), startId: id1, endId: id2, kind: rounded ? "bezier" : "line" },
      ]),
  };
}

/** Corner fillet: replace a sharp corner with an arc of the requested radius. */
export function filletCorner(
  profile: SketchProfile,
  vertexId: string,
  radius: number,
): SketchProfile | null {
  if (!(radius > 0)) return null;
  const corner = cornerGeometry(profile, vertexId);
  if (!corner) return null;
  // Tangent length that yields this radius at this corner. Trimming by the radius itself only
  // produced the requested radius at exactly 90 degrees, and was wrong everywhere else.
  return cutCorner(profile, vertexId, radius / Math.tan(corner.interiorAngle / 2), true);
}

/** Chamfer corner: cut straight across, setting each leg back by `distance`. */
export function chamferCorner(profile: SketchProfile, vertexId: string, distance: number): SketchProfile | null {
  return cutCorner(profile, vertexId, distance, false);
}

/** Offset a straight segment parallel toward a side. */
export function offsetLineSegment(
  doc: SketchDoc,
  lineId: string,
  toward: SketchVec2,
): SketchDoc {
  const next = cloneSketchDoc(doc);
  const line = next.entities.find((e) => e.id === lineId && e.kind === "line");
  if (!line || line.kind !== "line") return doc;
  const a = pointById(next, line.startId);
  const b = pointById(next, line.endId);
  if (!a || !b) return doc;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const side = Math.sign((toward.x - mid.x) * nx + (toward.z - mid.z) * nz) || 1;
  // Distance = projection length from mid to toward along normal
  const dist = Math.abs((toward.x - mid.x) * nx + (toward.z - mid.z) * nz);
  const ox = nx * side * dist;
  const oz = nz * side * dist;
  const p1: SketchPointEntity = { kind: "point", id: newId("sketch-point"), x: a.x + ox, z: a.z + oz };
  const p2: SketchPointEntity = { kind: "point", id: newId("sketch-point"), x: b.x + ox, z: b.z + oz };
  next.entities.push(p1, p2, {
    kind: "line",
    id: newId("sketch-segment"),
    startId: p1.id,
    endId: p2.id,
    construction: next.settings.constructionMode,
  });
  return next;
}

/** Mirror selected entities across a line axis. */
export function mirrorEntities(doc: SketchDoc, entityIds: string[], axisLineId: string): SketchDoc {
  const next = cloneSketchDoc(doc);
  const axis = next.entities.find((e) => e.id === axisLineId && e.kind === "line");
  if (!axis || axis.kind !== "line") return doc;
  const a = pointById(next, axis.startId);
  const b = pointById(next, axis.endId);
  if (!a || !b) return doc;
  const ax = b.x - a.x;
  const az = b.z - a.z;
  const len2 = ax * ax + az * az || 1;

  const reflect = (x: number, z: number) => {
    const px = x - a.x;
    const pz = z - a.z;
    const t = (px * ax + pz * az) / len2;
    const projX = a.x + ax * t;
    const projZ = a.z + az * t;
    return { x: 2 * projX - x, z: 2 * projZ - z };
  };

  const idMap = new Map<string, string>();
  const selected = new Set(entityIds);
  // Include points referenced by selected curves
  for (const e of next.entities) {
    if (!selected.has(e.id)) continue;
    if (e.kind === "line" || e.kind === "bezier" || e.kind === "smooth") {
      selected.add(e.startId);
      selected.add(e.endId);
    }
  }

  const additions: SketchEntity[] = [];
  for (const e of next.entities) {
    if (!selected.has(e.id) || e.kind !== "point") continue;
    const id = newId("sketch-point");
    idMap.set(e.id, id);
    const r = reflect(e.x, e.z);
    additions.push({ kind: "point", id, x: r.x, z: r.z, construction: e.construction });
  }
  for (const e of next.entities) {
    if (!selected.has(e.id)) continue;
    if (e.kind === "line" || e.kind === "bezier" || e.kind === "smooth") {
      const startId = idMap.get(e.startId);
      const endId = idMap.get(e.endId);
      if (!startId || !endId) continue;
      additions.push({
        kind: e.kind,
        id: newId("sketch-segment"),
        startId,
        endId,
        construction: e.construction,
      });
    }
  }
  next.entities.push(...additions);
  return next;
}

/** Rectangular pattern of selected geometry. */
export function rectangularPattern(
  doc: SketchDoc,
  entityIds: string[],
  countX: number,
  countZ: number,
  spacingX: number,
  spacingZ: number,
): SketchDoc {
  const next = cloneSketchDoc(doc);
  const selected = new Set(entityIds);
  for (const e of next.entities) {
    if (!selected.has(e.id)) continue;
    if (e.kind === "line" || e.kind === "bezier" || e.kind === "smooth") {
      selected.add(e.startId);
      selected.add(e.endId);
    }
  }
  const basePoints = next.entities.filter((e) => e.kind === "point" && selected.has(e.id)) as SketchPointEntity[];
  const baseCurves = next.entities.filter(
    (e) => selected.has(e.id) && (e.kind === "line" || e.kind === "bezier" || e.kind === "smooth"),
  );

  for (let ix = 0; ix < countX; ix += 1) {
    for (let iz = 0; iz < countZ; iz += 1) {
      if (ix === 0 && iz === 0) continue;
      const ox = ix * spacingX;
      const oz = iz * spacingZ;
      const idMap = new Map<string, string>();
      for (const p of basePoints) {
        const id = newId("sketch-point");
        idMap.set(p.id, id);
        next.entities.push({ kind: "point", id, x: p.x + ox, z: p.z + oz, construction: p.construction });
      }
      for (const c of baseCurves) {
        if (c.kind !== "line" && c.kind !== "bezier" && c.kind !== "smooth") continue;
        const startId = idMap.get(c.startId);
        const endId = idMap.get(c.endId);
        if (!startId || !endId) continue;
        next.entities.push({
          kind: c.kind,
          id: newId("sketch-segment"),
          startId,
          endId,
          construction: c.construction,
        });
      }
    }
  }
  return next;
}

/** Circular pattern around a center point. */
export function circularPatternSketch(
  doc: SketchDoc,
  entityIds: string[],
  center: SketchVec2,
  count: number,
): SketchDoc {
  if (count < 2) return doc;
  const next = cloneSketchDoc(doc);
  const selected = new Set(entityIds);
  for (const e of next.entities) {
    if (!selected.has(e.id)) continue;
    if (e.kind === "line" || e.kind === "bezier" || e.kind === "smooth") {
      selected.add(e.startId);
      selected.add(e.endId);
    }
  }
  const basePoints = next.entities.filter((e) => e.kind === "point" && selected.has(e.id)) as SketchPointEntity[];
  const baseCurves = next.entities.filter(
    (e) => selected.has(e.id) && (e.kind === "line" || e.kind === "bezier" || e.kind === "smooth"),
  );
  for (let i = 1; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const idMap = new Map<string, string>();
    for (const p of basePoints) {
      const dx = p.x - center.x;
      const dz = p.z - center.z;
      const id = newId("sketch-point");
      idMap.set(p.id, id);
      next.entities.push({
        kind: "point",
        id,
        x: center.x + dx * cos - dz * sin,
        z: center.z + dx * sin + dz * cos,
        construction: p.construction,
      });
    }
    for (const c of baseCurves) {
      if (c.kind !== "line" && c.kind !== "bezier" && c.kind !== "smooth") continue;
      const startId = idMap.get(c.startId);
      const endId = idMap.get(c.endId);
      if (!startId || !endId) continue;
      next.entities.push({
        kind: c.kind,
        id: newId("sketch-segment"),
        startId,
        endId,
        construction: c.construction,
      });
    }
  }
  return next;
}
