import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CsgBodyMeta, CsgOp, WorkplaneShape } from "@/types/sketchforge";

const DEGENERATE_AREA_EPS = 1e-12;
const DEFAULT_WELD_TOLERANCE = 1e-4;
/** Dense unions (radial hubs) need a looser weld to fuse coplanar top scars. */
const DENSE_UNION_WELD_TOLERANCE = 0.05;
const DENSE_UNION_TRIANGLE_THRESHOLD = 200;
/**
 * Elevation stagger used during radial unions is ~0.01 mm. Collapse that micro-step
 * on thin solids so the baked mesh does not keep a visible mid-hub ridge.
 */
const THIN_SOLID_PLANARIZE_HEIGHT = 5;
const THIN_SOLID_PLANARIZE_BAND = 0.03;

/** Infer CSG op from an existing group (migration for pre-csg saves). */
export function inferCsgOp(shape: WorkplaneShape): CsgOp | null {
  if (!shape.groupedShapes?.length) return null;
  if (shape.csg?.op) return shape.csg.op;
  const hasHole = shape.groupedShapes.some((child) => child.hole);
  const hasSolid = shape.groupedShapes.some((child) => !child.hole);
  if (hasHole && hasSolid) return "subtract";
  if (shape.importedMesh) return "union";
  return "assemble";
}

export function withCsgMeta(shape: WorkplaneShape, op: CsgOp, version = 1, dirty = false): WorkplaneShape {
  const csg: CsgBodyMeta = { op, version, dirty: dirty || undefined };
  return { ...shape, csg };
}

export function bumpCsgVersion(shape: WorkplaneShape): WorkplaneShape {
  if (!shape.csg) return shape;
  return {
    ...shape,
    csg: {
      ...shape.csg,
      version: shape.csg.version + 1,
      dirty: true,
    },
  };
}

export function markCsgClean(shape: WorkplaneShape): WorkplaneShape {
  if (!shape.csg) return shape;
  return { ...shape, csg: { ...shape.csg, dirty: undefined } };
}

export function isCsgBody(shape: WorkplaneShape): boolean {
  return Boolean(shape.groupedShapes?.length && (shape.csg || inferCsgOp(shape)));
}

export function isEvaluatedCsgBody(shape: WorkplaneShape): boolean {
  const op = shape.csg?.op ?? inferCsgOp(shape);
  return Boolean(op && op !== "assemble" && shape.groupedShapes?.length);
}

function hasUsableImportedMesh(shape: WorkplaneShape): boolean {
  return Boolean(shape.importedMesh && shape.importedMesh.positions.length >= 9);
}

export function hasUsableCsgResultMesh(shape: WorkplaneShape): boolean {
  return hasUsableImportedMesh(shape);
}

/**
 * Children the viewport may draw for a group. Cutters stay in the feature tree
 * for Ungroup / inspect, but they must never appear in the scene after Group.
 */
export function viewportGroupChildren(shape: WorkplaneShape): WorkplaneShape[] {
  if (hasUsableImportedMesh(shape)) return [];
  return (shape.groupedShapes ?? []).filter((child) => (
    !child.hidden
    && !child.suppressed
    && !child.csg?.suppressed
    && !child.hole
  ));
}

/**
 * Whether Group / Intersection should flatten this body into live children.
 * A baked subtract/union/intersect is a finished solid: inner holes must not
 * cut later operands. Assemblies (and CSG bodies with an empty mesh cache)
 * still flatten so children can participate.
 */
export function shouldExpandGroupForBoolean(shape: WorkplaneShape): boolean {
  if (!shape.groupedShapes?.length) return false;
  const op = shape.csg?.op ?? inferCsgOp(shape);
  if (op && op !== "assemble" && hasUsableImportedMesh(shape)) {
    return false;
  }
  return !hasUsableImportedMesh(shape);
}

/**
 * Flatten assemblies (and empty CSG caches) recursively so a Group of Groups
 * participates as its sealed bodies — not as a leftover local-frame nest.
 */
export function expandBooleanOperands(
  selection: WorkplaneShape[],
  restore: (shape: WorkplaneShape) => WorkplaneShape[],
): WorkplaneShape[] {
  const out: WorkplaneShape[] = [];
  const seen = new Set<string>();
  const visit = (shape: WorkplaneShape) => {
    if (shape.suppressed || shape.csg?.suppressed) return;
    if (seen.has(shape.id)) return;
    seen.add(shape.id);
    if (shouldExpandGroupForBoolean(shape)) {
      restore(shape).forEach(visit);
      return;
    }
    out.push(shape);
  };
  selection.forEach(visit);
  return out;
}

/** Last-selected group id so Ungroup peels one nested Group at a time. */
export function pickGroupToUngroup(selectedIds: string[], groupIds: string[]): string | null {
  if (groupIds.length === 0) return null;
  const nested = new Set(groupIds);
  for (let index = selectedIds.length - 1; index >= 0; index -= 1) {
    const id = selectedIds[index];
    if (nested.has(id)) return id;
  }
  return groupIds[groupIds.length - 1] ?? null;
}

/**
 * Snap near-top / near-bottom vertices onto the slab extremes.
 * Removes the diametric crease left when coplanar-break elevation stagger
 * survives Manifold simplify on dense radial unions.
 */
export function planarizeThinSolidPositions(positions: number[]): number[] {
  if (positions.length < 9) return positions;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i];
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const height = maxY - minY;
  if (!(height > 0) || height > THIN_SOLID_PLANARIZE_HEIGHT) {
    return positions;
  }
  const band = Math.min(THIN_SOLID_PLANARIZE_BAND, height * 0.45);
  // If union stagger left tops at both 1.00 and 1.01, prefer the lower top cluster.
  let topY = maxY;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i];
    if (y >= maxY - band && y < topY) topY = y;
  }
  const out = positions.slice();
  let changed = false;
  for (let i = 1; i < out.length; i += 3) {
    const y = out[i];
    if (y >= topY - band) {
      if (y !== topY) {
        out[i] = topY;
        changed = true;
      }
    } else if (y <= minY + band) {
      if (y !== minY) {
        out[i] = minY;
        changed = true;
      }
    }
  }
  return changed ? out : positions;
}

export type BooleanCleanupOptions = {
  /**
   * Set only for unions built with the 0.01mm elevation stagger (see the union path's
   * `solidsForUnion`). The 0.05mm weld and the thin-solid planarize pass both exist purely to
   * erase that stagger's scars, and both move real vertices — up to 0.05mm, and enough to
   * flatten a shallow engraving on any solid under 5mm tall. Subtractions, intersections and
   * plain mesh bakes never had a stagger applied, so running these on them is pure geometry
   * loss. Defaults to off so an unmapped caller keeps its true geometry.
   */
  staggeredUnion?: boolean;
  /**
   * Looser weld for leftover coplanar seams after a solid-only union (knurls, radial hubs).
   * Does not planarize, so stepped unions keep their real height.
   */
  unifyCoplanar?: boolean;
};

/**
 * Weld near-duplicates and drop degenerate triangles after a boolean.
 * With `staggeredUnion`, also erases the radial-hub coplanar "crease" scars that the
 * elevation stagger leaves behind on dense unions. `unifyCoplanar` only loosens the
 * weld so leftover same-plane seams fuse — it does not flatten real steps.
 */
export function cleanupBooleanPositions(
  positions: number[],
  weldTolerance = DEFAULT_WELD_TOLERANCE,
  options: BooleanCleanupOptions = {},
): number[] {
  if (positions.length < 9) return positions;

  const staggeredUnion = options.staggeredUnion === true;
  const unifyCoplanar = options.unifyCoplanar === true;
  const estimatedTris = Math.floor(positions.length / 9);
  const dense = estimatedTris >= DENSE_UNION_TRIANGLE_THRESHOLD;
  const tol = (staggeredUnion && dense) || unifyCoplanar
    ? Math.max(weldTolerance, DENSE_UNION_WELD_TOLERANCE)
    : weldTolerance;

  // Collapse union elevation-stagger scars before welding so top verts fuse. Hub plates are
  // often under the triangle threshold but still show the diametric ridge, so this does not
  // depend on `dense` — only on the stagger actually having been applied.
  const planarized = staggeredUnion ? planarizeThinSolidPositions(positions) : positions;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(planarized, 3));
  let welded: THREE.BufferGeometry = geometry;
  try {
    welded = mergeVertices(geometry, tol);
    if (welded !== geometry) geometry.dispose();
  } catch {
    welded = geometry;
  }

  const position = welded.getAttribute("position");
  if (!position) {
    welded.dispose();
    return planarized;
  }

  const out: number[] = [];
  const read = (index: number, target: THREE.Vector3) => {
    target.fromBufferAttribute(position, index);
    return target;
  };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  const pushTriangle = (ia: number, ib: number, ic: number) => {
    read(ia, a);
    read(ib, b);
    read(ic, c);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const area2 = ab.cross(ac).lengthSq();
    if (area2 <= DEGENERATE_AREA_EPS) return;
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  const index = welded.index;
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      pushTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    }
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) {
      pushTriangle(i, i + 1, i + 2);
    }
  }

  welded.dispose();
  if (out.length < 9) return planarized;
  // Second pass catches micro-steps the weld left behind on thin plates.
  return staggeredUnion ? planarizeThinSolidPositions(out) : out;
}

/** Migrate legacy groups so they carry csg metadata without remeshing yet. */
export function migrateShapeCsg(shape: WorkplaneShape): WorkplaneShape {
  const nextChildren = shape.groupedShapes?.map(migrateShapeCsg);
  let next: WorkplaneShape = nextChildren ? { ...shape, groupedShapes: nextChildren } : shape;
  if (!next.groupedShapes?.length) return next;
  if (next.csg?.op) return next;
  const op = inferCsgOp(next);
  if (!op) return next;
  return withCsgMeta(next, op, 1, Boolean(next.importedMesh && op !== "assemble"));
}

export function migrateShapesCsg(shapes: WorkplaneShape[]): WorkplaneShape[] {
  return shapes.map(migrateShapeCsg);
}

/** True when `root` is or contains `leafId` in its CSG child tree. */
export function csgTreeContainsId(root: WorkplaneShape, leafId: string): boolean {
  if (root.id === leafId) return true;
  return (root.groupedShapes ?? []).some((child) => csgTreeContainsId(child, leafId));
}

/**
 * Find the top-level evaluated CSG body in `shapes` that owns `leafId`
 * (as a direct or nested child). Use this when replacing a body in the scene list.
 */
export function findCsgBodyOwningLeaf(
  shapes: readonly WorkplaneShape[],
  leafId: string,
): WorkplaneShape | null {
  for (const shape of shapes) {
    if (!shape.groupedShapes?.length) continue;
    const op = shape.csg?.op ?? inferCsgOp(shape);
    if (!op || op === "assemble") continue;
    if (shape.groupedShapes.some((child) => csgTreeContainsId(child, leafId))) {
      return shape;
    }
  }
  return null;
}

/** Deepest evaluated CSG body that owns `leafId` (for nested remesh). */
export function findNearestCsgBodyOwningLeaf(
  shapes: readonly WorkplaneShape[],
  leafId: string,
): WorkplaneShape | null {
  let best: WorkplaneShape | null = null;
  const visit = (shape: WorkplaneShape) => {
    const op = shape.csg?.op ?? inferCsgOp(shape);
    if (!shape.groupedShapes?.length || !op || op === "assemble") return;
    if (!shape.groupedShapes.some((child) => csgTreeContainsId(child, leafId))) return;
    best = shape;
    shape.groupedShapes.forEach(visit);
  };
  shapes.forEach(visit);
  return best;
}

/** Locate a shape by id anywhere in the document tree (bodies + CSG children). */
export function findShapeInTree(
  shapes: readonly WorkplaneShape[],
  id: string,
): WorkplaneShape | null {
  for (const shape of shapes) {
    if (shape.id === id) return shape;
    const nested = shape.groupedShapes?.length
      ? findShapeInTree(shape.groupedShapes, id)
      : null;
    if (nested) return nested;
  }
  return null;
}

/**
 * Replace a leaf (by id) anywhere in a CSG child tree; marks the body dirty by default.
 *
 * Pass `markDirty: false` when the replacement carries no geometry change — attaching a baked
 * B-Rep, say. Marking those dirty was self-defeating: `dirty` makes the export badge report
 * "pending / CSG needs remesh", so recording the exact solid downgraded how the body described
 * itself, and nothing clears the flag until a rebuild the body does not need.
 */
export function replaceLeafInCsgTree(
  root: WorkplaneShape,
  leafId: string,
  nextLeaf: WorkplaneShape,
  options?: { markDirty?: boolean },
): WorkplaneShape {
  if (root.id === leafId) return nextLeaf;
  if (!root.groupedShapes?.length) return root;
  let changed = false;
  const groupedShapes = root.groupedShapes.map((child) => {
    const replaced = replaceLeafInCsgTree(child, leafId, nextLeaf, options);
    if (replaced !== child) changed = true;
    return replaced;
  });
  if (!changed) return root;
  if (options?.markDirty === false) return { ...root, groupedShapes };
  return bumpCsgVersion({ ...root, groupedShapes });
}

/** First sketch feature (extrude/revolve with sketchDoc) under a body, depth-first. */
export function findSketchFeatureInTree(root: WorkplaneShape): WorkplaneShape | null {
  if (root.sketchDoc || root.sketchProfile) return root;
  for (const child of root.groupedShapes ?? []) {
    const found = findSketchFeatureInTree(child);
    if (found) return found;
  }
  return null;
}

/**
 * Face-hole cut-axis overshoot: enough to clear coplanar skins on thin and thick hosts.
 * Exact profile size in-plane; only the cut axis grows.
 */
export function faceHoleOvershootMm(throughDepth: number): number {
  const depth = Math.max(0, throughDepth);
  return Math.max(0.5, depth * 0.02);
}

/**
 * Full cutter length for a through-all face hole: host thickness plus overshoot past
 * BOTH the sketch face and the far face (avoids coplanar skins and short/offset cuts).
 */
export function faceHoleCutDepthMm(throughDepth: number): number {
  const depth = Math.max(0.5, throughDepth);
  return depth + 2 * faceHoleOvershootMm(depth);
}

/**
 * Reorder a direct child of a CSG body (feature timeline move).
 *
 * This is a listing order only. A node applies its single op to the whole operand set at once —
 * subtract is every solid minus every hole, union and intersect are commutative — so no arrangement
 * of the children can change the evaluated result. It used to mark the body dirty and trigger a full
 * rebuild that could only reproduce the same mesh, at the risk of an exact body coming back faceted
 * if the exact path failed on that run. Genuine order-dependent history needs per-child ops and
 * sequential evaluation, which this tree does not have.
 */
export function reorderCsgChild(
  body: WorkplaneShape,
  childId: string,
  direction: "up" | "down",
): WorkplaneShape {
  const children = body.groupedShapes ?? [];
  const index = children.findIndex((child) => child.id === childId);
  if (index < 0) return body;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= children.length) return body;
  const next = children.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return { ...body, groupedShapes: next };
}

/** Suppress or restore a direct child feature. */
export function setCsgChildSuppressed(
  body: WorkplaneShape,
  childId: string,
  suppressed: boolean,
): WorkplaneShape {
  if (!body.groupedShapes?.length) return body;
  let changed = false;
  const groupedShapes = body.groupedShapes.map((child) => {
    if (child.id !== childId) return child;
    changed = true;
    if (child.csg) {
      return { ...child, suppressed, csg: { ...child.csg, suppressed: suppressed || undefined } };
    }
    return { ...child, suppressed: suppressed || undefined };
  });
  if (!changed) return body;
  return bumpCsgVersion({ ...body, groupedShapes });
}

export function isShapeSuppressed(shape: WorkplaneShape): boolean {
  return Boolean(shape.suppressed || shape.csg?.suppressed);
}

const COPLANAR_EDGE_DOT = 0.99;
const DISPLAY_EDGE_SNAP = 0.08;

function quantizeDisplayVertex(x: number, y: number, z: number) {
  const q = 1 / DISPLAY_EDGE_SNAP;
  return `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
}

function undirectedDisplayEdgeKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

type MeshEdgeRecord = { nx: number; ny: number; nz: number; sharp: boolean };

/**
 * Drop leftover same-plane splits (the diametric knurl seam) while keeping
 * real creases — rim teeth, steps, and hole walls.
 */
export function filterCoplanarDisplayEdges(
  edges: Array<{ points: number[] }>,
  meshPositions: ArrayLike<number>,
): Array<{ points: number[] }> {
  if (edges.length === 0 || meshPositions.length < 9) return edges;

  const records = new Map<string, MeshEdgeRecord>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  const markTriangle = (ia: number, ib: number, ic: number) => {
    a.fromArray(meshPositions as number[], ia);
    b.fromArray(meshPositions as number[], ib);
    c.fromArray(meshPositions as number[], ic);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.copy(ab).cross(ac);
    if (normal.lengthSq() <= 1e-14) return;
    normal.normalize();
    const keys = [
      quantizeDisplayVertex(a.x, a.y, a.z),
      quantizeDisplayVertex(b.x, b.y, b.z),
      quantizeDisplayVertex(c.x, c.y, c.z),
    ];
    for (let i = 0; i < 3; i += 1) {
      const edgeKey = undirectedDisplayEdgeKey(keys[i], keys[(i + 1) % 3]);
      const prev = records.get(edgeKey);
      if (!prev) {
        records.set(edgeKey, { nx: normal.x, ny: normal.y, nz: normal.z, sharp: false });
        continue;
      }
      const dot = Math.abs(prev.nx * normal.x + prev.ny * normal.y + prev.nz * normal.z);
      if (dot < COPLANAR_EDGE_DOT) prev.sharp = true;
    }
  };

  for (let i = 0; i + 8 < meshPositions.length; i += 9) {
    markTriangle(i, i + 3, i + 6);
  }

  return edges.filter((edge) => {
    if (edge.points.length < 6) return false;
    for (let i = 0; i + 5 < edge.points.length; i += 3) {
      const aKey = quantizeDisplayVertex(edge.points[i], edge.points[i + 1], edge.points[i + 2]);
      const bKey = quantizeDisplayVertex(edge.points[i + 3], edge.points[i + 4], edge.points[i + 5]);
      if (aKey === bKey) continue;
      const record = records.get(undirectedDisplayEdgeKey(aKey, bKey));
      if (!record) continue;
      if (record.sharp) return true;
    }
    return false;
  });
}
