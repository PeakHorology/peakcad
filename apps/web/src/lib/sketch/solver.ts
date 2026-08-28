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

function applySoftPull(target: PointVar, goalX: number, goalZ: number, weight: number) {
  if (target.fixed) return 0;
  const dx = (goalX - target.x) * weight;
  const dz = (goalZ - target.z) * weight;
  target.x += dx;
  target.z += dz;
  return Math.hypot(dx, dz);
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
          const nx = -tz;
          const nz = tx;
          tx = nx;
          tz = nz;
        }
        const len2 = Math.hypot(l2.b.x - l2.a.x, l2.b.z - l2.a.z) || 1;
        const mid = { x: (l2.a.x + l2.b.x) / 2, z: (l2.a.z + l2.b.z) / 2 };
        error += applySoftPull(l2.a, mid.x - (tx * len2) / 2, mid.z - (tz * len2) / 2, 0.35);
        error += applySoftPull(l2.b, mid.x + (tx * len2) / 2, mid.z + (tz * len2) / 2, 0.35);
        break;
      }
      case "equal": {
        if (c.entityIds.length < 2) break;
        const l1 = lineEndpoints(doc, c.entityIds[0], points);
        const l2 = lineEndpoints(doc, c.entityIds[1], points);
        if (!l1 || !l2) break;
        const len1 = Math.hypot(l1.b.x - l1.a.x, l1.b.z - l1.a.z);
        const len2 = Math.hypot(l2.b.x - l2.a.x, l2.b.z - l2.a.z);
        if (len2 < 1e-9) break;
        const scale = len1 / len2;
        const mid = { x: (l2.a.x + l2.b.x) / 2, z: (l2.a.z + l2.b.z) / 2 };
        const hx = ((l2.b.x - l2.a.x) * scale) / 2;
        const hz = ((l2.b.z - l2.a.z) * scale) / 2;
        error += applySoftPull(l2.a, mid.x - hx, mid.z - hz, 0.35);
        error += applySoftPull(l2.b, mid.x + hx, mid.z + hz, 0.35);
        break;
      }
      case "midpoint": {
        const line = c.entityIds[0] ? lineEndpoints(doc, c.entityIds[0], points) : null;
        const midPoint = c.pointIds?.[0] ? points.get(c.pointIds[0]) : null;
        if (!line || !midPoint) break;
        const mx = (line.a.x + line.b.x) / 2;
        const mz = (line.a.z + line.b.z) / 2;
        error += applySoftPull(midPoint, mx, mz, 0.5);
        break;
      }
      case "concentric": {
        // Keep circle centers coincident when two circle center points listed
        const ids = c.entityIds
          .map((id) => {
            const circle = doc.entities.find((e) => e.id === id && e.kind === "circle");
            return circle && circle.kind === "circle" ? circle.centerId : id;
          })
          .filter((id) => points.has(id));
        if (ids.length >= 2) {
          const a = points.get(ids[0])!;
          const b = points.get(ids[1])!;
          const mx = (a.x + b.x) / 2;
          const mz = (a.z + b.z) / 2;
          error += applySoftPull(a, mx, mz, 0.5);
          error += applySoftPull(b, mx, mz, 0.5);
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
    const mid = { x: (l2.a.x + l2.b.x) / 2, z: (l2.a.z + l2.b.z) / 2 };
    const hx = (Math.cos(target) * len2) / 2;
    const hz = (Math.sin(target) * len2) / 2;
    error += applySoftPull(l2.a, mid.x - hx, mid.z - hz, 0.3);
    error += applySoftPull(l2.b, mid.x + hx, mid.z + hz, 0.3);
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
    // Split correction: nudge center along normal, and line the opposite way.
    let error = applySoftPull(center, center.x + nx * delta * 0.5, center.z + nz * delta * 0.5, 0.4);
    error += applySoftPull(ends.a, ends.a.x - nx * delta * 0.25, ends.a.z - nz * delta * 0.25, 0.35);
    error += applySoftPull(ends.b, ends.b.x - nx * delta * 0.25, ends.b.z - nz * delta * 0.25, 0.35);
    return error;
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
    let error = applySoftPull(c1, mx - hx, mz - hz, 0.4);
    error += applySoftPull(c2, mx + hx, mz + hz, 0.4);
    return error;
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
  if (pA && pB) {
    const rA = reflect(pA.x, pA.z);
    const rB = reflect(pB.x, pB.z);
    let error = applySoftPull(pB, rA.x, rA.z, 0.4);
    error += applySoftPull(pA, rB.x, rB.z, 0.25);
    return error;
  }

  // Line–line symmetry: pull midpoints / endpoints toward reflections
  const l1 = lineEndpoints(doc, pairIds[0], points);
  const l2 = lineEndpoints(doc, pairIds[1], points);
  if (!l1 || !l2) return 0;
  const r1a = reflect(l1.a.x, l1.a.z);
  const r1b = reflect(l1.b.x, l1.b.z);
  let error = applySoftPull(l2.a, r1a.x, r1a.z, 0.35);
  error += applySoftPull(l2.b, r1b.x, r1b.z, 0.35);
  return error;
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

function estimateDof(doc: SketchDoc, points: Map<string, PointVar>, lastError: number): { dof: number; status: SketchDefinitionStatus; conflicts: string[] } {
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
  // Residual stayed high on a fully/over-constrained sketch → report conflict ids.
  if (lastError > 0.05 && removed >= totalVars && activeConstraints.length > 0) {
    for (const c of activeConstraints) {
      if (c.kind === "fix") continue;
      conflicts.push(c.id);
    }
    if (conflicts.length) {
      return { dof: 0, status: "over-constrained", conflicts: conflicts.slice(0, 8) };
    }
  }
  // The geometry does not match what the user typed. Never report this as solved: an
  // abandoned dimension is exactly the kind of silent error that reaches the machine shop.
  const unsatisfied = unsatisfiedDrivingDimensionIds(doc, points);
  if (unsatisfied.length) {
    return { dof, status: "unsolved", conflicts: unsatisfied.slice(0, 8) };
  }
  if (dof === 0) return { dof: 0, status: "fully-defined", conflicts };
  return { dof, status: "under-defined", conflicts };
}

/**
 * Constraint solve: hard projectors for coincident / H / V / linear driving dims,
 * soft pulls for parallel / perp / equal / tangent / symmetry. Writes points back.
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
