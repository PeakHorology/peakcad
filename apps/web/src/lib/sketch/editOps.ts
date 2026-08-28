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
