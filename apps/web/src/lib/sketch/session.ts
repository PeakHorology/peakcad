import type { SketchPlane, SketchProfile, WorkplaneShape } from "@/types/sketchforge";
import { defaultSketchPlane, resolveSketchPlane } from "@/lib/sketchPlane";
import { ensureSketchDocOnShape, sketchDocToProfile, sketchProfileToDoc } from "./migrate";
import { createEmptySketchDoc, type SketchDoc, type SketchFocusMode, type SketchSession, type SketchSessionPhase } from "./types";

export function createIdleSketchSession(): SketchSession {
  return {
    phase: "idle",
    focusMode: "3d",
    editingShapeId: null,
    doc: null,
  };
}

export function beginPlanePickSession(prev?: SketchSession): SketchSession {
  return {
    phase: "plane-pick",
    focusMode: prev?.focusMode ?? "3d",
    editingShapeId: null,
    doc: null,
  };
}

export function beginActiveSketchSession(args: {
  doc?: SketchDoc | null;
  profile?: SketchProfile | null;
  plane?: SketchPlane | null;
  editingShapeId?: string | null;
  focusMode?: SketchFocusMode;
}): SketchSession {
  const plane = resolveSketchPlane(args.plane ?? args.doc?.plane ?? args.profile?.sketchPlane ?? defaultSketchPlane());
  const doc =
    args.doc
    ?? (args.profile ? sketchProfileToDoc({ ...args.profile, sketchPlane: plane }) : createEmptySketchDoc(plane));
  if (!args.doc && args.profile) {
    doc.plane = plane;
  } else if (!args.doc && !args.profile) {
    doc.plane = plane;
  }
  return {
    phase: "active",
    focusMode: args.focusMode ?? "2d",
    editingShapeId: args.editingShapeId ?? null,
    doc,
  };
}

/** Open edit session from a shape that has sketchProfile / sketchDoc. */
export function beginEditSketchSession(shape: WorkplaneShape, focusMode: SketchFocusMode = "2d"): SketchSession | null {
  const doc = ensureSketchDocOnShape({
    sketchDoc: (shape as WorkplaneShape & { sketchDoc?: SketchDoc }).sketchDoc,
    sketchProfile: shape.sketchProfile,
    sketchPlane: shape.sketchPlane,
    sketchId: shape.sketchId,
  });
  if (!doc) return null;
  return beginActiveSketchSession({
    doc,
    profile: shape.sketchProfile ?? sketchDocToProfile(doc),
    plane: shape.sketchPlane ?? doc.plane,
    editingShapeId: shape.id,
    focusMode,
  });
}

export function shapeHasEditableSketch(shape: WorkplaneShape | null | undefined): boolean {
  if (!shape) return false;
  if (
    shape.sketchProfile
    || (shape as WorkplaneShape & { sketchDoc?: SketchDoc }).sketchDoc
    || shape.sketchFinish
  ) {
    return true;
  }
  return Boolean(shape.groupedShapes?.some((child) => shapeHasEditableSketch(child)));
}

function leafHasOwnSketch(shape: WorkplaneShape): boolean {
  return Boolean(
    shape.sketchProfile
    || (shape as WorkplaneShape & { sketchDoc?: SketchDoc }).sketchDoc
    || shape.sketchFinish,
  );
}

function sketchHostShapeId(shape: WorkplaneShape): string | null {
  return (
    shape.sketchPlane?.hostShapeId
    ?? shape.sketchProfile?.sketchPlane?.hostShapeId
    ?? (shape as WorkplaneShape & { sketchDoc?: SketchDoc }).sketchDoc?.plane?.hostShapeId
    ?? null
  );
}

/** Collect sketch-bearing leaves under a body (DFS, parents before nested). */
export function collectEditableSketchLeaves(shape: WorkplaneShape | null | undefined): WorkplaneShape[] {
  if (!shape) return [];
  const leaves: WorkplaneShape[] = [];
  const visit = (node: WorkplaneShape) => {
    if (leafHasOwnSketch(node)) leaves.push(node);
    for (const child of node.groupedShapes ?? []) visit(child);
  };
  visit(shape);
  return leaves;
}

export type ResolveEditableSketchOptions = {
  /** Prefer this leaf id when present (Alt-click / Features selection). */
  preferredId?: string | null;
  /**
   * When a CSG body has both an original extrusion sketch and face cut/join features,
   * prefer the face features (Fusion-like: edit the sketch you put on the face).
   */
  preferFaceFeatures?: boolean;
};

/**
 * Resolve which sketch feature to edit.
 * Prefer an explicit feature id, then face-hosted cut/join features, then the body's own sketch.
 */
export function resolveEditableSketchShape(
  shape: WorkplaneShape | null | undefined,
  options?: ResolveEditableSketchOptions,
): WorkplaneShape | null {
  if (!shape) return null;
  const leaves = collectEditableSketchLeaves(shape);
  if (leaves.length === 0) return null;

  if (options?.preferredId) {
    const preferred = leaves.find((leaf) => leaf.id === options.preferredId);
    if (preferred) return preferred;
  }

  if (options?.preferFaceFeatures !== false && leaves.length > 1) {
    const faceFeatures = leaves.filter((leaf) => {
      if (leaf.id === shape.id) return false;
      return Boolean(sketchHostShapeId(leaf));
    });
    if (faceFeatures.length === 1) return faceFeatures[0];
    if (faceFeatures.length > 1) {
      const holes = faceFeatures.filter((leaf) => leaf.hole);
      if (holes.length === 1) return holes[0];
      // Last child is usually the most recent face feature.
      return faceFeatures[faceFeatures.length - 1];
    }
  }

  if (leafHasOwnSketch(shape)) return shape;
  return leaves[0];
}

export type { SketchSessionPhase };
