import type { SketchConstraint, SketchConstraintKind, SketchDoc } from "./types";

function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createConstraint(
  kind: SketchConstraintKind,
  entityIds: string[],
  pointIds?: string[],
): SketchConstraint {
  return {
    id: newId("c"),
    kind,
    entityIds,
    ...(pointIds?.length ? { pointIds } : {}),
  };
}

export function addConstraints(doc: SketchDoc, constraints: Array<Omit<SketchConstraint, "id"> | SketchConstraint>): SketchDoc {
  const next = {
    ...doc,
    constraints: [...doc.constraints],
  };
  for (const raw of constraints) {
    const constraint: SketchConstraint = "id" in raw && raw.id
      ? raw as SketchConstraint
      : createConstraint(raw.kind, raw.entityIds, raw.pointIds);
    // Deduplicate similar constraints
    const exists = next.constraints.some(
      (c) =>
        !c.suppressed
        && c.kind === constraint.kind
        && c.entityIds.slice().sort().join() === constraint.entityIds.slice().sort().join()
        && (c.pointIds ?? []).slice().sort().join() === (constraint.pointIds ?? []).slice().sort().join(),
    );
    if (!exists) next.constraints.push(constraint);
  }
  return next;
}

export function removeConstraint(doc: SketchDoc, constraintId: string): SketchDoc {
  return {
    ...doc,
    constraints: doc.constraints.filter((c) => c.id !== constraintId),
  };
}

export function suppressConstraint(doc: SketchDoc, constraintId: string, suppressed = true): SketchDoc {
  return {
    ...doc,
    constraints: doc.constraints.map((c) => (c.id === constraintId ? { ...c, suppressed } : c)),
  };
}

/** Apply constraints between two selected curve entities (manual tool). */
export function applyConstraintBetween(
  doc: SketchDoc,
  kind: SketchConstraintKind,
  entityA: string,
  entityB?: string,
): SketchDoc {
  const entityIds = entityB ? [entityA, entityB] : [entityA];
  return addConstraints(doc, [createConstraint(kind, entityIds)]);
}

export const CONSTRAINT_LABELS: Record<SketchConstraintKind, string> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  concentric: "Concentric",
  tangent: "Tangent",
  midpoint: "Midpoint",
  symmetry: "Symmetry",
  fix: "Fix",
};
