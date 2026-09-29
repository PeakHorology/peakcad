import { closedProfilesFromDoc } from "./profiles";
import type {
  SketchDefinitionStatus,
  SketchDimension,
  SketchDoc,
  SketchPointEntity,
  SketchSolveResult,
} from "./types";
import { cloneSketchDoc } from "./migrate";

type PointVar = { id: string; x: number; z: number; fixed: boolean };

function getPoints(doc: SketchDoc): Map<string, PointVar> {
  const map = new Map<string, PointVar>();
  for (const entity of doc.entities) {
    if (entity.kind !== "point") continue;
    map.set(entity.id, {
      id: entity.id,
      x: entity.x,
      z: entity.z,
      fixed: Boolean(entity.fixed),
    });
  }
  return map;
}

function lineEndpoints(doc: SketchDoc, lineId: string, points: Map<string, PointVar>) {
  const line = doc.entities.find((e) => e.id === lineId && e.kind === "line");
  if (!line || line.kind !== "line") return null;
  const a = points.get(line.startId);
  const b = points.get(line.endId);
  if (!a || !b) return null;
  return { line, a, b };
}

/** Place a line on an exact direction and length. A fixed end stays put and the free end moves. */
function placeLine(a: PointVar, b: PointVar, dirX: number, dirZ: number, length: number) {
  if (a.fixed && !b.fixed) return applyExact(b, a.x + dirX * length, a.z + dirZ * length);
  if (!a.fixed && b.fixed) return applyExact(a, b.x - dirX * length, b.z - dirZ * length);
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const hx = (dirX * length) / 2;
  const hz = (dirZ * length) / 2;
  return applyExact(a, mx - hx, mz - hz) + applyExact(b, mx + hx, mz + hz);
}

/** Exact set for hard constraints — residual is the prior error that was removed. */
function applyExact(target: PointVar, goalX: number, goalZ: number) {
  if (target.fixed) return 0;
  const err = Math.hypot(goalX - target.x, goalZ - target.z);
  target.x = goalX;
  target.z = goalZ;
  return err;
}

function solveOnce(doc: SketchDoc, points: Map<string, PointVar>): number {
  let error = 0;
  const active = doc.constraints.filter((c) => !c.suppressed);

  for (const c of active) {
    switch (c.kind) {
      case "fix": {
        for (const id of c.entityIds) {
          const p = points.get(id);
          if (p) p.fixed = true;
        }
        break;
      }
      case "coincident": {
        const ids = [...(c.pointIds ?? []), ...c.entityIds.filter((id) => points.has(id))];
        if (ids.length < 2) break;
        const pts = ids.map((id) => points.get(id)).filter(Boolean) as PointVar[];
        const free = pts.filter((p) => !p.fixed);
        const anchors = pts.filter((p) => p.fixed);
        const ax = anchors.length ? anchors.reduce((s, p) => s + p.x, 0) / anchors.length : pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const az = anchors.length ? anchors.reduce((s, p) => s + p.z, 0) / anchors.length : pts.reduce((s, p) => s + p.z, 0) / pts.length;
        for (const p of free) error += applyExact(p, ax, az);
        break;
      }
      case "horizontal": {
        const line = c.entityIds[0] ? lineEndpoints(doc, c.entityIds[0], points) : null;
        if (line) {
          const midZ = (line.a.fixed && !line.b.fixed)
            ? line.a.z
            : (!line.a.fixed && line.b.fixed)
              ? line.b.z
              : (line.a.z + line.b.z) / 2;
          error += applyExact(line.a, line.a.x, midZ);
          error += applyExact(line.b, line.b.x, midZ);
        } else if (c.pointIds && c.pointIds.length >= 2) {
          const a = points.get(c.pointIds[0]);
          const b = points.get(c.pointIds[1]);
          if (a && b) {
            const midZ = (a.fixed && !b.fixed) ? a.z : (!a.fixed && b.fixed) ? b.z : (a.z + b.z) / 2;
            error += applyExact(a, a.x, midZ);
            error += applyExact(b, b.x, midZ);
          }
        }
        break;
      }
      case "vertical": {
        const line = c.entityIds[0] ? lineEndpoints(doc, c.entityIds[0], points) : null;
        if (line) {
          const midX = (line.a.fixed && !line.b.fixed)
            ? line.a.x
            : (!line.a.fixed && line.b.fixed)
              ? line.b.x
              : (line.a.x + line.b.x) / 2;
          error += applyExact(line.a, midX, line.a.z);
          error += applyExact(line.b, midX, line.b.z);
        } else if (c.pointIds && c.pointIds.length >= 2) {
          const a = points.get(c.pointIds[0]);
          const b = points.get(c.pointIds[1]);
          if (a && b) {
            const midX = (a.fixed && !b.fixed) ? a.x : (!a.fixed && b.fixed) ? b.x : (a.x + b.x) / 2;
            error += applyExact(a, midX, a.z);
            error += applyExact(b, midX, b.z);
          }
        }
        break;
      }
      case "parallel":
      case "perpendicular": {
        if (c.entityIds.length < 2) break;
        const l1 = lineEndpoints(doc, c.entityIds[0], points);
        const l2 = lineEndpoints(doc, c.entityIds[1], points);
        if (!l1 || !l2) break;
        const v1x = l1.b.x - l1.a.x;
        const v1z = l1.b.z - l1.a.z;
        const len1 = Math.hypot(v1x, v1z) || 1;
        let tx = v1x / len1;
        let tz = v1z / len1;
        if (c.kind === "perpendicular") {
          tx = -tz;
          tz = v1x / len1;
        }
        const v2x = l2.b.x - l2.a.x;
        const v2z = l2.b.z - l2.a.z;
        if (v2x * tx + v2z * tz < 0) {
          tx = -tx;
          tz = -tz;
        }
        const len2 = Math.hypot(v2x, v2z) || 1;
        error += placeLine(l2.a, l2.b, tx, tz, len2);
        break;
      }
      case "equal": {
        if (c.entityIds.length < 2) break;
        const l1 = lineEndpoints(doc, c.entityIds[0], points);
        const l2 = lineEndpoints(doc, c.entityIds[1], points);
        if (!l1 || !l2) break;
        const len1 = Math.hypot(l1.b.x - l1.a.x, l1.b.z - l1.a.z);
        const v2x = l2.b.x - l2.a.x;
        const v2z = l2.b.z - l2.a.z;
        const len2 = Math.hypot(v2x, v2z);
        if (len2 < 1e-9) break;
        error += placeLine(l2.a, l2.b, v2x / len2, v2z / len2, len1);
        break;
      }
      case "midpoint": {
        const line = c.entityIds[0] ? lineEndpoints(doc, c.entityIds[0], points) : null;
        const midPoint = c.pointIds?.[0] ? points.get(c.pointIds[0]) : null;
        if (!line || !midPoint) break;
        error += applyExact(midPoint, (line.a.x + line.b.x) / 2, (line.a.z + line.b.z) / 2);
        break;
      }
      case "concentric": {
        const ids = c.entityIds
          .map((id) => {
            const circle = doc.entities.find((e) => e.id === id && e.kind === "circle");
            return circle && circle.kind === "circle" ? circle.centerId : id;
          })
          .filter((id) => points.has(id));
        if (ids.length >= 2) {
          const a = points.get(ids[0])!;
          const b = points.get(ids[1])!;
          const anchors = [a, b].filter((p) => p.fixed);
          const mx = anchors.length ? anchors.reduce((s, p) => s + p.x, 0) / anchors.length : (a.x + b.x) / 2;
          const mz = anchors.length ? anchors.reduce((s, p) => s + p.z, 0) / anchors.length : (a.z + b.z) / 2;
          error += applyExact(a, mx, mz);
          error += applyExact(b, mx, mz);
        }
        break;
      }
      case "tangent": {
        error += applyTangent(doc, c.entityIds, points);
        break;
      }
      case "symmetry": {
        error += applySymmetry(doc, c, points);
        break;
      }
      default:
        break;
    }
  }

  // Driving dimensions
  for (const dim of doc.dimensions) {
    if (!dim.driving) continue;
    error += applyDimension(doc, dim, points);
  }

  return error;
}

function applyDimension(doc: SketchDoc, dim: SketchDimension, points: Map<string, PointVar>): number {
  let error = 0;
  if (dim.kind === "linear") {
    let a: PointVar | undefined;
    let b: PointVar | undefined;
    if (dim.pointIds && dim.pointIds.length >= 2) {
      a = points.get(dim.pointIds[0]);
      b = points.get(dim.pointIds[1]);
    } else if (dim.entityIds[0]) {
      const line = lineEndpoints(doc, dim.entityIds[0], points);
      if (line) {
        a = line.a;
        b = line.b;
      }
    }
    if (!a || !b) return 0;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const rawLen = Math.hypot(dx, dz);
    // A collapsed line has no direction to scale along, so the old `dx * (value / len)`
    // stayed 0: the dimension reported zero error while the line sat at length 0 forever.
    // Grow it along the sketch U axis instead so the driving length is reachable.
    const degenerate = rawLen < 1e-9;
    const ux = degenerate ? 1 : dx / rawLen;
    const uz = degenerate ? 0 : dz / rawLen;
    if (a.fixed && !b.fixed) {
      error += applyExact(b, a.x + ux * dim.value, a.z + uz * dim.value);
    } else if (!a.fixed && b.fixed) {
      error += applyExact(a, b.x - ux * dim.value, b.z - uz * dim.value);
    } else {
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const hx = (ux * dim.value) / 2;
      const hz = (uz * dim.value) / 2;
      error += applyExact(a, mx - hx, mz - hz);
      error += applyExact(b, mx + hx, mz + hz);
    }
  } else if (dim.kind === "radius" || dim.kind === "diameter") {
    const circle = doc.entities.find((e) => e.id === dim.entityIds[0] && e.kind === "circle");
    if (!circle || circle.kind !== "circle") return 0;
    const targetR = dim.kind === "diameter" ? dim.value / 2 : dim.value;
    circle.radius = targetR;
  } else if (dim.kind === "angular" && dim.entityIds.length >= 2) {
    // Soft-align second line angle relative to first
    const l1 = lineEndpoints(doc, dim.entityIds[0], points);
    const l2 = lineEndpoints(doc, dim.entityIds[1], points);
    if (!l1 || !l2) return 0;
    const a1 = Math.atan2(l1.b.z - l1.a.z, l1.b.x - l1.a.x);
    const target = a1 + (dim.value * Math.PI) / 180;
    const len2 = Math.hypot(l2.b.x - l2.a.x, l2.b.z - l2.a.z) || 1;
    error += placeLine(l2.a, l2.b, Math.cos(target), Math.sin(target), len2);
  }
  return error;
}

function applyTangent(doc: SketchDoc, entityIds: string[], points: Map<string, PointVar>): number {
  if (entityIds.length < 2) return 0;
  const a = doc.entities.find((e) => e.id === entityIds[0]);
  const b = doc.entities.find((e) => e.id === entityIds[1]);
  if (!a || !b) return 0;

  const asCircle = (e: typeof a) => (e.kind === "circle" ? e : null);
  const asLine = (e: typeof a) => (e.kind === "line" ? e : null);
  const circleA = asCircle(a);
  const circleB = asCircle(b);
  const lineA = asLine(a);
  const lineB = asLine(b);

  // Line–circle: distance(center, line) ≈ radius
  const line = lineA ?? lineB;
  const circle = circleA ?? circleB;
  if (line && circle && circle.kind === "circle") {
    const ends = lineEndpoints(doc, line.id, points);
    const center = points.get(circle.centerId);
    if (!ends || !center) return 0;
    const dx = ends.b.x - ends.a.x;
    const dz = ends.b.z - ends.a.z;
    const len = Math.hypot(dx, dz) || 1e-9;
    const nx = -dz / len;
    const nz = dx / len;
    const dist = (center.x - ends.a.x) * nx + (center.z - ends.a.z) * nz;
    const target = circle.radius * Math.sign(dist || 1);
    const delta = target - dist;
    if (!center.fixed) return applyExact(center, center.x + nx * delta, center.z + nz * delta);
    return applyExact(ends.a, ends.a.x - nx * delta, ends.a.z - nz * delta)
      + applyExact(ends.b, ends.b.x - nx * delta, ends.b.z - nz * delta);
  }

  // Circle–circle: external tangent |d − (r1+r2)| → 0
  if (circleA && circleB && circleA.kind === "circle" && circleB.kind === "circle") {
    const c1 = points.get(circleA.centerId);
    const c2 = points.get(circleB.centerId);
    if (!c1 || !c2) return 0;
    const dx = c2.x - c1.x;
    const dz = c2.z - c1.z;
    const dist = Math.hypot(dx, dz) || 1e-9;
    const target = circleA.radius + circleB.radius;
    const scale = target / dist;
    const mx = (c1.x + c2.x) / 2;
    const mz = (c1.z + c2.z) / 2;
    const hx = (dx * scale) / 2;
    const hz = (dz * scale) / 2;
    return applyExact(c1, mx - hx, mz - hz) + applyExact(c2, mx + hx, mz + hz);
  }

  return 0;
}

function applySymmetry(
  doc: SketchDoc,
  constraint: { entityIds: string[]; pointIds?: string[] },
  points: Map<string, PointVar>,
): number {
  const axisLineId = constraint.entityIds[constraint.entityIds.length - 1];
  const axis = lineEndpoints(doc, axisLineId, points);
  if (!axis) return 0;
  const ax = axis.b.x - axis.a.x;
  const az = axis.b.z - axis.a.z;
  const len2 = ax * ax + az * az || 1;
  const reflect = (x: number, z: number) => {
    const px = x - axis.a.x;
    const pz = z - axis.a.z;
    const t = (px * ax + pz * az) / len2;
    const projX = axis.a.x + ax * t;
    const projZ = axis.a.z + az * t;
    return { x: 2 * projX - x, z: 2 * projZ - z };
  };

  const pairIds = (constraint.pointIds && constraint.pointIds.length >= 2)
    ? constraint.pointIds.slice(0, 2)
    : constraint.entityIds.slice(0, 2);
  if (pairIds.length < 2) return 0;

  const resolvePoint = (id: string): PointVar | null => {
    if (points.has(id)) return points.get(id)!;
    const circle = doc.entities.find((e) => e.id === id && e.kind === "circle");
    if (circle && circle.kind === "circle") return points.get(circle.centerId) ?? null;
    const line = lineEndpoints(doc, id, points);
    if (line) {
      // Symmetry of line midpoints when whole lines are paired
      return null;
    }
    return null;
  };

  const pA = resolvePoint(pairIds[0]);
  const pB = resolvePoint(pairIds[1]);
  if (pA && pB) return projectSymmetricPair(pA, pB, reflect);

  const l1 = lineEndpoints(doc, pairIds[0], points);
  const l2 = lineEndpoints(doc, pairIds[1], points);
  if (!l1 || !l2) return 0;
  return projectSymmetricPair(l1.a, l2.a, reflect) + projectSymmetricPair(l1.b, l2.b, reflect);
}

/** One exact step onto B = reflect(A). Both free: split the gap. One fixed: the other snaps. */
function projectSymmetricPair(
  a: PointVar,
  b: PointVar,
  reflect: (x: number, z: number) => { x: number; z: number },
) {
  if (a.fixed && !b.fixed) {
    const reflected = reflect(a.x, a.z);
    return applyExact(b, reflected.x, reflected.z);
  }
  if (!a.fixed && b.fixed) {
    const reflected = reflect(b.x, b.z);
    return applyExact(a, reflected.x, reflected.z);
  }
  const mirrored = reflect(b.x, b.z);
  const ax = (a.x + mirrored.x) / 2;
  const az = (a.z + mirrored.z) / 2;
  const bx = reflect(ax, az);
  return applyExact(a, ax, az) + applyExact(b, bx.x, bx.z);
}

function constraintDofWeight(kind: string): number {
  switch (kind) {
    case "fix":
      return 2;
    case "coincident":
      return 2;
    case "horizontal":
    case "vertical":
    case "midpoint":
    case "concentric":
      return 1;
    case "parallel":
    case "perpendicular":
    case "equal":
    case "tangent":
    case "symmetry":
      return 1;
    default:
      return 1;
  }
}

function dimensionDofWeight(kind: string): number {
  if (kind === "angular") return 1;
  if (kind === "radius" || kind === "diameter") return 1;
  return 1;
}

/** A driving length this far from its geometry means the solver did not satisfy it (mm). */
const DIMENSION_SATISFIED_TOLERANCE = 1e-3;

/**
 * Ids of driving linear dimensions the solved geometry does not actually match.
 *
 * DOF counting alone cannot detect this: a sketch can have spare degrees of freedom and still
 * have abandoned a hard dimension, which used to be reported as a clean "under-defined".
 */
function unsatisfiedDrivingDimensionIds(doc: SketchDoc, points: Map<string, PointVar>): string[] {
  const unsatisfied: string[] = [];
  for (const dim of doc.dimensions) {
    if (!dim.driving || dim.kind !== "linear") continue;
    let a: PointVar | undefined;
    let b: PointVar | undefined;
    if (dim.pointIds && dim.pointIds.length >= 2) {
      a = points.get(dim.pointIds[0]);
      b = points.get(dim.pointIds[1]);
    } else if (dim.entityIds[0]) {
      const line = lineEndpoints(doc, dim.entityIds[0], points);
      if (line) {
        a = line.a;
        b = line.b;
      }
    }
    if (!a || !b) continue;
    const actual = Math.hypot(b.x - a.x, b.z - a.z);
    if (Math.abs(actual - dim.value) > DIMENSION_SATISFIED_TOLERANCE) {
      unsatisfied.push(dim.id);
    }
  }
  return unsatisfied;
}

const GEOMETRY_TOLERANCE = 1e-3;

function lineVector(ends: { a: PointVar; b: PointVar }) {
  return { x: ends.b.x - ends.a.x, z: ends.b.z - ends.a.z, len: Math.hypot(ends.b.x - ends.a.x, ends.b.z - ends.a.z) };
}

/** How far the geometry still is from a constraint, in millimetres. Zero when it already holds. */
function constraintResidual(doc: SketchDoc, constraint: { kind: string; entityIds: string[]; pointIds?: string[] }, points: Map<string, PointVar>): number {
  if (constraint.kind === "fix") return 0;
  if (constraint.kind === "parallel" || constraint.kind === "perpendicular" || constraint.kind === "equal") {
    if (constraint.entityIds.length < 2) return 0;
    const l1 = lineEndpoints(doc, constraint.entityIds[0], points);
    const l2 = lineEndpoints(doc, constraint.entityIds[1], points);
    if (!l1 || !l2) return 0;
    const v1 = lineVector(l1);
    const v2 = lineVector(l2);
    if (v1.len < 1e-9 || v2.len < 1e-9) return 0;
    if (constraint.kind === "equal") return Math.abs(v1.len - v2.len);
    const cross = v1.x * v2.z - v1.z * v2.x;
    const dot = v1.x * v2.x + v1.z * v2.z;
    const sin = Math.abs(cross) / (v1.len * v2.len);
    const cos = Math.abs(dot) / (v1.len * v2.len);
    return (constraint.kind === "parallel" ? sin : cos) * v2.len;
  }
  if (constraint.kind === "midpoint") {
    const line = constraint.entityIds[0] ? lineEndpoints(doc, constraint.entityIds[0], points) : null;
    const midPoint = constraint.pointIds?.[0] ? points.get(constraint.pointIds[0]) : null;
    if (!line || !midPoint) return 0;
    return Math.hypot(midPoint.x - (line.a.x + line.b.x) / 2, midPoint.z - (line.a.z + line.b.z) / 2);
  }
  if (constraint.kind === "concentric") {
    const ids = constraint.entityIds
      .map((id) => {
        const circle = doc.entities.find((e) => e.id === id && e.kind === "circle");
        return circle && circle.kind === "circle" ? circle.centerId : id;
      })
      .filter((id) => points.has(id));
    if (ids.length < 2) return 0;
    const a = points.get(ids[0])!;
    const b = points.get(ids[1])!;
    return Math.hypot(a.x - b.x, a.z - b.z);
  }
  if (constraint.kind === "tangent") {
    return tangentResidual(doc, constraint.entityIds, points);
  }
  if (constraint.kind === "symmetry") {
    return symmetryResidual(doc, constraint, points);
  }
  if (constraint.kind === "horizontal" || constraint.kind === "vertical") {
    const line = constraint.entityIds[0] ? lineEndpoints(doc, constraint.entityIds[0], points) : null;
    if (line) {
      return constraint.kind === "horizontal"
        ? Math.abs(line.a.z - line.b.z)
        : Math.abs(line.a.x - line.b.x);
    }
    if (constraint.pointIds && constraint.pointIds.length >= 2) {
      const a = points.get(constraint.pointIds[0]);
      const b = points.get(constraint.pointIds[1]);
      if (!a || !b) return 0;
      return constraint.kind === "horizontal" ? Math.abs(a.z - b.z) : Math.abs(a.x - b.x);
    }
    return 0;
  }
  if (constraint.kind === "coincident") {
    const ids = [...(constraint.pointIds ?? []), ...constraint.entityIds.filter((id) => points.has(id))];
    const pts = ids.map((id) => points.get(id)).filter((point): point is PointVar => Boolean(point));
    if (pts.length < 2) return 0;
    const ax = pts.reduce((sum, point) => sum + point.x, 0) / pts.length;
    const az = pts.reduce((sum, point) => sum + point.z, 0) / pts.length;
    return Math.max(...pts.map((point) => Math.hypot(point.x - ax, point.z - az)));
  }
  return 0;
}

function tangentResidual(doc: SketchDoc, entityIds: string[], points: Map<string, PointVar>): number {
  if (entityIds.length < 2) return 0;
  const a = doc.entities.find((e) => e.id === entityIds[0]);
  const b = doc.entities.find((e) => e.id === entityIds[1]);
  if (!a || !b) return 0;
  const line = a.kind === "line" ? a : b.kind === "line" ? b : null;
  const circle = a.kind === "circle" ? a : b.kind === "circle" ? b : null;
  if (line && circle && circle.kind === "circle") {
    const ends = lineEndpoints(doc, line.id, points);
    const center = points.get(circle.centerId);
    if (!ends || !center) return 0;
    const v = lineVector(ends);
    if (v.len < 1e-9) return 0;
    const dist = Math.abs(((center.x - ends.a.x) * (-v.z) + (center.z - ends.a.z) * v.x) / v.len);
    return Math.abs(dist - circle.radius);
  }
  if (a.kind === "circle" && b.kind === "circle") {
    const c1 = points.get(a.centerId);
    const c2 = points.get(b.centerId);
    if (!c1 || !c2) return 0;
    return Math.abs(Math.hypot(c2.x - c1.x, c2.z - c1.z) - (a.radius + b.radius));
  }
  return 0;
}

function symmetryResidual(
  doc: SketchDoc,
  constraint: { entityIds: string[]; pointIds?: string[] },
  points: Map<string, PointVar>,
): number {
  const axis = lineEndpoints(doc, constraint.entityIds[constraint.entityIds.length - 1], points);
  if (!axis) return 0;
  const ax = axis.b.x - axis.a.x;
  const az = axis.b.z - axis.a.z;
  const len2 = ax * ax + az * az || 1;
  const reflect = (x: number, z: number) => {
    const t = ((x - axis.a.x) * ax + (z - axis.a.z) * az) / len2;
    const projX = axis.a.x + ax * t;
    const projZ = axis.a.z + az * t;
    return { x: 2 * projX - x, z: 2 * projZ - z };
  };
  const pairIds = (constraint.pointIds && constraint.pointIds.length >= 2)
    ? constraint.pointIds.slice(0, 2)
    : constraint.entityIds.slice(0, 2);
  const pointOf = (id: string) => points.get(id) ?? null;
  const pA = pointOf(pairIds[0]);
  const pB = pointOf(pairIds[1]);
  if (pA && pB) {
    const mirrored = reflect(pA.x, pA.z);
    return Math.hypot(pB.x - mirrored.x, pB.z - mirrored.z);
  }
  const l1 = lineEndpoints(doc, pairIds[0], points);
  const l2 = lineEndpoints(doc, pairIds[1], points);
  if (!l1 || !l2) return 0;
  const ra = reflect(l1.a.x, l1.a.z);
  const rb = reflect(l1.b.x, l1.b.z);
  return Math.hypot(l2.a.x - ra.x, l2.a.z - ra.z) + Math.hypot(l2.b.x - rb.x, l2.b.z - rb.z);
}

function unsatisfiedConstraintIds(
  doc: SketchDoc,
  points: Map<string, PointVar>,
  constraints: Array<{ id: string; kind: string; entityIds: string[]; pointIds?: string[] }>,
): string[] {
  return constraints
    .filter((constraint) => constraintResidual(doc, constraint, points) > GEOMETRY_TOLERANCE)
    .map((constraint) => constraint.id);
}

function estimateDof(doc: SketchDoc, points: Map<string, PointVar>, _lastError: number): { dof: number; status: SketchDefinitionStatus; conflicts: string[] } {
  const freeVars = [...points.values()].filter((p) => !p.fixed).length * 2;
  const circleDof = doc.entities.filter((e) => e.kind === "circle" && !e.fixed).length;
  const totalVars = freeVars + circleDof;
  const activeConstraints = doc.constraints.filter((c) => !c.suppressed);
  const drivingDims = doc.dimensions.filter((d) => d.driving);
  const removed =
    activeConstraints.reduce((sum, c) => sum + constraintDofWeight(c.kind), 0)
    + drivingDims.reduce((sum, d) => sum + dimensionDofWeight(d.kind), 0);
  const dof = Math.max(0, totalVars - removed);
  const conflicts: string[] = [];
  if (points.size === 0 && doc.entities.every((e) => e.kind !== "circle")) {
    return { dof: 0, status: "empty", conflicts };
  }
  if (removed > totalVars + 2) {
    conflicts.push("Too many constraints or dimensions for the available degrees of freedom.");
    return { dof: 0, status: "over-constrained", conflicts };
  }
  // A pull that did not land is an unsolved sketch, not an over-constrained one.
  // Fully defined is reserved for geometry that actually matches every constraint.
  const unsatisfiedConstraints = unsatisfiedConstraintIds(doc, points, activeConstraints);
  const unsatisfied = [...unsatisfiedConstraints, ...unsatisfiedDrivingDimensionIds(doc, points)];
  if (unsatisfied.length) {
    return { dof, status: "unsolved", conflicts: unsatisfied.slice(0, 8) };
  }
  if (dof === 0) return { dof: 0, status: "fully-defined", conflicts };
  return { dof, status: "under-defined", conflicts };
}

/**
 * Constraint solve. Geometric constraints and driving dimensions snap in one step.
 * A sketch is fully defined only when that snap actually landed.
 */
export function solveSketchDoc(input: SketchDoc, iterations = 40): SketchSolveResult {
  const doc = cloneSketchDoc(input);
  const points = getPoints(doc);

  // Fix entities marked fixed
  for (const c of doc.constraints) {
    if (c.kind === "fix" && !c.suppressed) {
      for (const id of c.entityIds) {
        const p = points.get(id);
        if (p) p.fixed = true;
      }
    }
  }

  // Prefer stable order: fix/coincident first (already applied), then geometric, then dims in solveOnce.
  let lastError = 0;
  for (let i = 0; i < iterations; i += 1) {
    lastError = solveOnce(doc, points);
    if (lastError < 1e-5) break;
  }

  // Write back points + circle radii already mutated on entities
  doc.entities = doc.entities.map((entity) => {
    if (entity.kind !== "point") return entity;
    const p = points.get(entity.id);
    if (!p) return entity;
    return { ...entity, x: p.x, z: p.z, fixed: p.fixed || entity.fixed } satisfies SketchPointEntity;
  });

  const { dof, status, conflicts } = estimateDof(doc, points, lastError);
  const profiles = closedProfilesFromDoc(doc);
  return { doc, status, dof, conflicts, profiles };
}

export function setDrivingDimensionValue(doc: SketchDoc, dimensionId: string, value: number): SketchSolveResult {
  const next = cloneSketchDoc(doc);
  next.dimensions = next.dimensions.map((d) => (d.id === dimensionId ? { ...d, value: Math.max(1e-6, value) } : d));
  return solveSketchDoc(next);
}

export function addLinearDimension(
  doc: SketchDoc,
  args: { entityId?: string; pointIds?: string[]; value: number; driving?: boolean },
): SketchSolveResult {
  const next = cloneSketchDoc(doc);
  next.dimensions.push({
    id: `d-${Math.random().toString(36).slice(2, 10)}`,
    kind: "linear",
    entityIds: args.entityId ? [args.entityId] : [],
    pointIds: args.pointIds,
    value: args.value,
    driving: args.driving !== false,
  });
  return solveSketchDoc(next);
}

export function addRadiusDimension(
  doc: SketchDoc,
  circleId: string,
  value: number,
  asDiameter = false,
): SketchSolveResult {
  const next = cloneSketchDoc(doc);
  next.dimensions.push({
    id: `d-${Math.random().toString(36).slice(2, 10)}`,
    kind: asDiameter ? "diameter" : "radius",
    entityIds: [circleId],
    value,
    driving: true,
  });
  return solveSketchDoc(next);
}
