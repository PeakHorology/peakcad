import type { WorkplaneShape } from "@/types/sketchforge";
import { inferCsgOp, isEvaluatedCsgBody } from "@/lib/csgTree";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import { aabbsOverlap, shapeYawDegrees, worldAabb, type Aabb } from "@/lib/shapeBounds";
import { loadBrepWithOcct, type Brep, type BrepSolid } from "@/lib/brepKernel";
import {
  importFacetedSolidFromMesh,
  localBoxMesh,
  localMeshFromImportedShape,
} from "@/lib/stepFacetedExport";
import { buildNativeShapeSolid, NATIVE_EXACT_KINDS } from "@/lib/shapeBrep";

export { aabbsOverlap, shapeYawDegrees, worldAabb, type Aabb };

export type SkippedShape = {
  name: string;
  kind: WorkplaneShape["kind"];
  reason: string;
};

export type StepExportQuality = "exact" | "faceted";

export type StepExportResult = {
  blob: Blob;
  exportedCount: number;
  exactCount: number;
  facetedCount: number;
  /** Bodies left out of the file entirely. */
  skipped: SkippedShape[];
  /**
   * Bodies that ARE in the file but came out wrong — chiefly a part whose holes could not be
   * subtracted, which exports as solid stock. These used to be reported in `skipped` and summed
   * into a "skipped empty/degenerate shapes" note, so the one outcome a machinist must not miss
   * read as a body that had simply been omitted.
   */
  degraded: SkippedShape[];
};

// PeakCAD-native solids rebuilt as exact (or exact-NURBS) B-Rep from params.
// Mesh imports / text / helix threads fall back to faceted STEP when needed.
const EXACT_KINDS = NATIVE_EXACT_KINDS;
function unsupportedReason(): string {
  return "no exact B-Rep mapping";
}

type BuildOutcome = { solid: BrepSolid; quality: StepExportQuality; warning?: string } | { skip: string };

/** Bottom-center of a triangle soup, matching meshPositionsToGroupShape. */
export function meshFrameOriginFromPositions(positions: ArrayLike<number>): { x: number; y: number; z: number } | null {
  if (positions.length < 9) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  if (![minX, minY, minZ, maxX, maxZ].every(Number.isFinite)) return null;
  return { x: (minX + maxX) / 2, y: minY, z: (minZ + maxZ) / 2 };
}

function isLocalMeshFrameOrigin(origin: { x: number; y: number; z: number }): boolean {
  return Math.abs(origin.x) < 0.05 && Math.abs(origin.z) < 0.05 && Math.abs(origin.y) < 0.05;
}

export type AxisExtents = {
  width: number;
  height: number;
  depth: number;
};

export function extentsFromPositions(positions: ArrayLike<number>): AxisExtents | null {
  if (positions.length < 9) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return null;
  return { width: maxX - minX, height: maxY - minY, depth: maxZ - minZ };
}

export function booleanResultLooksExploded(before: AxisExtents, after: AxisExtents): boolean {
  const beforeDiag = Math.hypot(before.width, before.height, before.depth);
  const afterDiag = Math.hypot(after.width, after.height, after.depth);
  if (!(beforeDiag > 1e-6)) return afterDiag > 1;
  return afterDiag > beforeDiag * 6 || afterDiag < beforeDiag * 0.05;
}

/**
 * Scale a reimported Group STEP so it matches the live shape size.
 * Always prefer measured STEP extents over stored baseWidth — a stale bake or
 * unit/frame mismatch is what made stacked knurl Groups explode or vanish.
 */
export function resolveImportedSolidScale(shape: AxisExtents, step: AxisExtents): AxisExtents {
  const axis = (live: number, measured: number) => {
    if (!(measured > 1e-6) || !(live > 1e-6)) return 1;
    const scale = live / measured;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  };
  return {
    width: axis(shape.width, step.width),
    height: axis(shape.height, step.height),
    depth: axis(shape.depth, step.depth),
  };
}

/**
 * Fuse/cut leftover same-plane faces into one face. Without this, overlapping
 * boxes (knurls, radial hubs) stay a starburst of intersection seams.
 */
const BOOLEAN_UNIFY = {
  fuzzyValue: 1e-4,
} as const;

function solidExtents(brep: Brep, solid: BrepSolid): AxisExtents | null {
  try {
    const tess = brep.mesh(solid as never);
    return tess?.vertices ? extentsFromPositions(tess.vertices) : null;
  } catch {
    return null;
  }
}

function unifyBooleanSolid(brep: Brep, solid: BrepSolid): BrepSolid {
  const before = solidExtents(brep, solid);
  try {
    const simplified = brep.simplify(solid);
    if (!simplified.ok) return solid;
    const next = simplified.value as BrepSolid;
    const after = solidExtents(brep, next);
    if (before && after && booleanResultLooksExploded(before, after)) return solid;
    return next;
  } catch {
    // Keep the fused solid when UnifySameDomain rejects a valid result.
  }
  return solid;
}

function fuseAllUnified(brep: Brep, solids: BrepSolid[]): { ok: true; value: BrepSolid } | { ok: false; error?: unknown } {
  if (solids.length === 0) return { ok: false };
  if (solids.length === 1) return { ok: true, value: unifyBooleanSolid(brep, solids[0]) };
  const native = brep.fuseAll(solids, BOOLEAN_UNIFY);
  if (native.ok) return { ok: true, value: unifyBooleanSolid(brep, native.value) };
  const pairwise = brep.fuseAll(solids, { ...BOOLEAN_UNIFY, strategy: "pairwise" });
  if (pairwise.ok) return { ok: true, value: unifyBooleanSolid(brep, pairwise.value) };
  return native;
}

function cutAllUnified(
  brep: Brep,
  base: BrepSolid,
  holes: BrepSolid[],
): { ok: true; value: BrepSolid } | { ok: false; error?: unknown } {
  if (holes.length === 0) return { ok: true, value: unifyBooleanSolid(brep, base) };
  const cut = brep.cutAll(base, holes, BOOLEAN_UNIFY);
  if (!cut.ok) return cut;
  return { ok: true, value: unifyBooleanSolid(brep, cut.value) };
}

function intersectAllUnified(
  brep: Brep,
  operands: BrepSolid[],
): { ok: true; value: BrepSolid } | { ok: false; error?: unknown } {
  if (operands.length === 0) return { ok: false };
  if (operands.length === 1) return { ok: true, value: unifyBooleanSolid(brep, operands[0]) };
  let acc = operands[0];
  for (let i = 1; i < operands.length; i += 1) {
    const next = brep.intersect(acc, operands[i], BOOLEAN_UNIFY);
    if (!next.ok) return next;
    acc = next.value;
  }
  return { ok: true, value: unifyBooleanSolid(brep, acc) };
}

function displayEdgesFromBooleanSolid(
  brep: Brep,
  solid: BrepSolid,
): { points: number[] }[] {
  try {
    const edges = brep.meshEdges(solid as never);
    const lines = edges?.lines;
    if (!lines || lines.length < 6) return [];
    const groups = edges.edgeGroups ?? [];
    const raw: number[][] = [];
    for (const group of groups) {
      let slice = Array.from(lines.slice(group.start, group.start + group.count));
      if (slice.length < 6 && group.count >= 2) {
        slice = Array.from(lines.slice(group.start * 3, (group.start + group.count) * 3));
      }
      if (slice.length >= 6) raw.push(slice);
    }
    if (raw.length === 0) raw.push(Array.from(lines));
    return raw.map((points) => ({ points })).filter((edge) => edge.points.length >= 6);
  } catch {
    return [];
  }
}

/** Move a world-space solid into the imported-mesh local frame (XZ centered, Y from 0). */
function recenterSolidToLocalMeshFrame(brep: Brep, solid: BrepSolid): BrepSolid {
  try {
    const tess = brep.mesh(solid as never);
    const origin = tess?.vertices ? meshFrameOriginFromPositions(tess.vertices) : null;
    if (!origin || isLocalMeshFrameOrigin(origin)) return solid;
    return brep.translate(solid, [-origin.x, -origin.y, -origin.z]);
  } catch {
    return solid;
  }
}

function buildExactSolid(brep: Brep, shape: WorkplaneShape): BuildOutcome {
  const built = buildNativeShapeSolid(brep, shape);
  if ("skip" in built) return built;

  let solid = built.solid;
  // Mirror before rotating, matching the viewport's T·R·S composition and buildImportedBody.
  // Omitting this exported mirrored asymmetric solids (roof, wedge, pyramid) unmirrored,
  // turning a left-hand part into a right-hand one.
  if (shape.mirrorX) solid = brep.mirror(solid, { normal: [1, 0, 0] });
  if (shape.mirrorY) solid = brep.mirror(solid, { normal: [0, 1, 0] });
  if (shape.mirrorZ) solid = brep.mirror(solid, { normal: [0, 0, 1] });
  const rotZ = shape.rotationZ ?? 0;
  const rotY = shapeYawDegrees(shape);
  const rotX = shape.rotationX ?? 0;
  if (rotZ) solid = brep.rotate(solid, rotZ, { axis: [0, 0, 1] });
  if (rotY) solid = brep.rotate(solid, rotY, { axis: [0, 1, 0] });
  if (rotX) solid = brep.rotate(solid, rotX, { axis: [1, 0, 0] });

  const height = shape.height;
  const center: [number, number, number] = [shape.x, (shape.elevation ?? 0) + height / 2, shape.z];
  solid = brep.translate(solid, center);
  return { solid, quality: "exact" };
}

function toCadZUp(brep: Brep, solid: BrepSolid): BrepSolid {
  return brep.rotate(solid, 90, { axis: [1, 0, 0] });
}

async function buildImportedBody(brep: Brep, shape: WorkplaneShape): Promise<BuildOutcome> {
  const mesh = shape.importedMesh;
  if (!mesh?.brepStep) {
    return { skip: "imported mesh has no B-Rep source; re-import as STEP to round-trip" };
  }
  const imported = await brep.importSTEP(new Blob([mesh.brepStep]));
  if (!imported.ok) {
    return { skip: "stored B-Rep failed to re-import" };
  }

  const h = shape.height;
  // Group booleans used to store world-space STEP. Recenter those leftovers so
  // applying the shape pose does not double-offset nested unions.
  let body = recenterSolidToLocalMeshFrame(brep, imported.value as unknown as BrepSolid);
  const measured = solidExtents(brep, body);
  const scale = measured
    ? resolveImportedSolidScale(
      { width: shapeWidth(shape), height: h, depth: shapeDepth(shape) },
      measured,
    )
    : {
      width: shapeWidth(shape) / Math.max(0.001, mesh.baseWidth),
      height: h / Math.max(0.001, mesh.baseHeight),
      depth: shapeDepth(shape) / Math.max(0.001, mesh.baseDepth),
    };
  const sx = scale.width;
  const sy = scale.height;
  const sz = scale.depth;

  if (Math.abs(sx - sy) < 1e-6 && Math.abs(sy - sz) < 1e-6) {
    if (Math.abs(sx - 1) > 1e-6) body = brep.scale(body, sx);
  } else if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6 || Math.abs(sz - 1) > 1e-6) {
    const scaled = brep.applyMatrix(body, { linear: [sx, 0, 0, 0, sy, 0, 0, 0, sz], translation: [0, 0, 0] });
    if (!scaled.ok) {
      return { skip: `non-uniform scale failed: ${String(scaled.error.message ?? scaled.error)}` };
    }
    body = scaled.value as unknown as BrepSolid;
  }

  body = brep.translate(body, [0, -h / 2, 0]);
  if (shape.mirrorX) body = brep.mirror(body, { normal: [1, 0, 0] });
  if (shape.mirrorY) body = brep.mirror(body, { normal: [0, 1, 0] });
  if (shape.mirrorZ) body = brep.mirror(body, { normal: [0, 0, 1] });
  const rotZ = shape.rotationZ ?? 0;
  const rotY = shapeYawDegrees(shape);
  const rotX = shape.rotationX ?? 0;
  if (rotZ) body = brep.rotate(body, rotZ, { axis: [0, 0, 1] });
  if (rotY) body = brep.rotate(body, rotY, { axis: [0, 1, 0] });
  if (rotX) body = brep.rotate(body, rotX, { axis: [1, 0, 0] });
  body = brep.translate(body, [shape.x, (shape.elevation ?? 0) + h / 2, shape.z]);
  return { solid: body, quality: "exact" };
}

/**
 * Place a cadBrep payload (local mesh frame like imported STEP) into the shape pose.
 * cadBrepFrame records the capture pose; resize uses current vs frame extents.
 */
async function buildCadBrepBody(brep: Brep, shape: WorkplaneShape): Promise<BuildOutcome> {
  if (!shape.cadBrep) return { skip: "no cadBrep payload" };
  try {
    const restored = brep.fromBREP(shape.cadBrep);
    if (!restored.ok) {
      return { skip: `cadBrep restore failed: ${String(restored.error.message ?? restored.error)}` };
    }
    let body = restored.value as unknown as BrepSolid;
    // Fillet/chamfer stores cadBrep in the worker's world frame. The display
    // mesh is recentered to local (XZ centered, Y from 0). Recenter here too
    // so Group does not apply the pose twice and slide the hole off the body.
    body = recenterSolidToLocalMeshFrame(brep, body);
    const h = shape.height;
    const frame = shape.cadBrepFrame;
    if (frame) {
      const sx = shapeWidth(shape) / Math.max(0.001, frame.width);
      const sy = h / Math.max(0.001, frame.height);
      const sz = shapeDepth(shape) / Math.max(0.001, frame.depth);
      if (Math.abs(sx - sy) < 1e-6 && Math.abs(sy - sz) < 1e-6) {
        if (Math.abs(sx - 1) > 1e-6) body = brep.scale(body, sx);
      } else {
        const scaled = brep.applyMatrix(body, { linear: [sx, 0, 0, 0, sy, 0, 0, 0, sz], translation: [0, 0, 0] });
        if (!scaled.ok) {
          return { skip: `cadBrep scale failed: ${String(scaled.error.message ?? scaled.error)}` };
        }
        body = scaled.value as unknown as BrepSolid;
      }
    }
    body = brep.translate(body, [0, -h / 2, 0]);
    if (shape.mirrorX) body = brep.mirror(body, { normal: [1, 0, 0] });
    if (shape.mirrorY) body = brep.mirror(body, { normal: [0, 1, 0] });
    if (shape.mirrorZ) body = brep.mirror(body, { normal: [0, 0, 1] });
    const rotZ = shape.rotationZ ?? 0;
    const rotY = shapeYawDegrees(shape);
    const rotX = shape.rotationX ?? 0;
    if (rotZ) body = brep.rotate(body, rotZ, { axis: [0, 0, 1] });
    if (rotY) body = brep.rotate(body, rotY, { axis: [0, 1, 0] });
    if (rotX) body = brep.rotate(body, rotX, { axis: [1, 0, 0] });
    body = brep.translate(body, [shape.x, (shape.elevation ?? 0) + h / 2, shape.z]);
    return { solid: body, quality: "exact" };
  } catch (error) {
    return { skip: error instanceof Error ? error.message : "cadBrep restore failed" };
  }
}

function describe(shape: WorkplaneShape, reason: string): SkippedShape {
  return { name: shape.name, kind: shape.kind, reason };
}

/** Apply parent group pose to a solid already placed in group-local coordinates. */
function placeGroupLocalSolid(brep: Brep, solid: BrepSolid, group: WorkplaneShape): BrepSolid {
  let body = solid;
  if (group.mirrorX) body = brep.mirror(body, { normal: [1, 0, 0] });
  if (group.mirrorY) body = brep.mirror(body, { normal: [0, 1, 0] });
  if (group.mirrorZ) body = brep.mirror(body, { normal: [0, 0, 1] });
  const rotZ = group.rotationZ ?? 0;
  const rotY = shapeYawDegrees(group);
  const rotX = group.rotationX ?? 0;
  if (rotZ) body = brep.rotate(body, rotZ, { axis: [0, 0, 1] });
  if (rotY) body = brep.rotate(body, rotY, { axis: [0, 1, 0] });
  if (rotX) body = brep.rotate(body, rotX, { axis: [1, 0, 0] });
  // Children are relative to group bottom-center; lift so local y=0 maps to group.elevation.
  body = brep.translate(body, [group.x, group.elevation ?? 0, group.z]);
  return body;
}

async function buildFacetedSolid(brep: Brep, shape: WorkplaneShape): Promise<BuildOutcome> {
  const mesh = localMeshFromImportedShape(shape) ?? (shape.kind === "box" ? localBoxMesh(shape) : null);
  if (!mesh) {
    return {
      skip: shape.kind === "text" || shape.kind === "icosahedron"
        ? `${shape.kind} geometry exists only in the viewport; export this body as STL or 3MF`
        : "no mesh available for faceted STEP",
    };
  }
  const imported = await importFacetedSolidFromMesh(brep, mesh);
  if ("skip" in imported) return imported;

  // Same placement as buildImportedBody for local mesh frame (y in [0, height]).
  const h = shape.height;
  let body = imported.solid;
  body = brep.translate(body, [0, -h / 2, 0]);
  if (shape.mirrorX) body = brep.mirror(body, { normal: [1, 0, 0] });
  if (shape.mirrorY) body = brep.mirror(body, { normal: [0, 1, 0] });
  if (shape.mirrorZ) body = brep.mirror(body, { normal: [0, 0, 1] });
  const rotZ = shape.rotationZ ?? 0;
  const rotY = shapeYawDegrees(shape);
  const rotX = shape.rotationX ?? 0;
  if (rotZ) body = brep.rotate(body, rotZ, { axis: [0, 0, 1] });
  if (rotY) body = brep.rotate(body, rotY, { axis: [0, 1, 0] });
  if (rotX) body = brep.rotate(body, rotX, { axis: [1, 0, 0] });
  body = brep.translate(body, [shape.x, (shape.elevation ?? 0) + h / 2, shape.z]);
  return { solid: body, quality: "faceted" };
}

async function buildLeafSolidExact(brep: Brep, shape: WorkplaneShape): Promise<BuildOutcome> {
  // Modifier results (fillet/chamfer) win over the underlying primitive kind.
  if (shape.cadBrep) {
    return buildCadBrepBody(brep, shape);
  }
  // Promoted rect/circle sketches keep kind=box/cylinder — prefer analytic B-Rep
  // over a leftover mesh cache (and over brepStep when both exist).
  if (EXACT_KINDS.has(shape.kind)) {
    return buildExactSolid(brep, shape);
  }
  if (shape.importedMesh?.brepStep) {
    return buildImportedBody(brep, shape);
  }
  return {
    skip: shape.kind === "mesh"
      ? "imported mesh has no B-Rep source"
      : unsupportedReason(),
  };
}

async function buildCsgBodySolid(
  brep: Brep,
  shape: WorkplaneShape,
  skipped: SkippedShape[],
  allowFaceted: boolean,
): Promise<BuildOutcome> {
  // Prefer a baked exact payload on the group itself.
  if (shape.importedMesh?.brepStep) {
    return buildImportedBody(brep, shape);
  }
  if (shape.cadBrep) {
    return buildCadBrepBody(brep, shape);
  }

  const op = shape.csg?.op ?? inferCsgOp(shape) ?? "union";
  const children = (shape.groupedShapes ?? []).filter((child) => !child.suppressed && !child.csg?.suppressed);
  if (children.length === 0) {
    return allowFaceted ? buildFacetedSolid(brep, shape) : { skip: "CSG body has no children" };
  }

  const solidChildren: BrepSolid[] = [];
  const holeChildren: BrepSolid[] = [];
  let quality: StepExportQuality = "exact";
  let leafFailures = 0;

  for (const child of children) {
    // Child x/z/elevation are group-local; treat them as world within this frame.
    const built = await buildShapeSolid(brep, child, skipped, { allowFaceted, nested: true });
    if ("skip" in built) {
      skipped.push(describe(child, `CSG leaf ${built.skip}`));
      leafFailures += 1;
      continue;
    }
    if (built.quality === "faceted") quality = "faceted";
    if (child.hole) holeChildren.push(built.solid);
    else solidChildren.push(built.solid);
  }

  if (solidChildren.length === 0 && op !== "intersect") {
    if (allowFaceted && shape.importedMesh) return buildFacetedSolid(brep, shape);
    return { skip: "CSG body has no solid operands" };
  }

  let solid: BrepSolid;
  try {
    // Nested assemble under another boolean still fuses — top-level assemble is
    // expanded to multi-solid STEP in exportShapesToStep.
    if (op === "union" || op === "assemble") {
      const fused = fuseAllUnified(brep, solidChildren);
      if (!fused.ok) throw fused.error;
      solid = fused.value;
    } else if (op === "subtract") {
      const fused = fuseAllUnified(brep, solidChildren);
      if (!fused.ok) throw fused.error;
      const cut = cutAllUnified(brep, fused.value, holeChildren);
      if (!cut.ok) throw cut.error;
      solid = cut.value;
    } else if (op === "intersect") {
      const operands = [...solidChildren, ...holeChildren];
      if (operands.length < 2) return { skip: "CSG intersect needs at least two operands" };
      const next = intersectAllUnified(brep, operands);
      if (!next.ok) throw next.error;
      solid = next.value;
    } else {
      return { skip: `unsupported CSG op ${op}` };
    }
  } catch (error) {
    if (allowFaceted && shape.importedMesh) return buildFacetedSolid(brep, shape);
    return { skip: `CSG ${op} failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (leafFailures > 0 && allowFaceted && shape.importedMesh?.positions.length && shape.importedMesh.positions.length >= 9) {
    const faceted = await buildFacetedSolid(brep, shape);
    if ("skip" in faceted) return faceted;
    return {
      ...faceted,
      warning: "One or more CSG features could not be rebuilt — exported the last good mesh",
    };
  }

  return {
    solid: placeGroupLocalSolid(brep, solid, shape),
    quality,
    warning: leafFailures > 0 ? "One or more CSG features could not be rebuilt" : undefined,
  };
}

type BuildOptions = {
  allowFaceted?: boolean;
  /** True when building a CSG leaf already expressed in parent-local coords. */
  nested?: boolean;
};

async function buildShapeSolid(
  brep: Brep,
  shape: WorkplaneShape,
  skipped: SkippedShape[],
  options?: BuildOptions,
): Promise<BuildOutcome> {
  if (shape.csg?.suppressed || shape.suppressed) {
    return { skip: "feature suppressed" };
  }

  const allowFaceted = options?.allowFaceted !== false;
  const op = shape.csg?.op ?? inferCsgOp(shape);

  if (shape.groupedShapes?.length && op) {
    const built = await buildCsgBodySolid(brep, shape, skipped, allowFaceted);
    // When nested, buildCsgBodySolid already placed via the nested group's own pose
    // relative to its parent local frame — placeGroupLocalSolid used nested group's x/elev/z
    // which are themselves parent-local. That is correct for cloneAsGroupChild nesting.
    return built;
  }

  const exact = await buildLeafSolidExact(brep, shape);
  if (!("skip" in exact)) return exact;
  if (!allowFaceted) return exact;
  return buildFacetedSolid(brep, shape);
}

function isAssembleBody(shape: WorkplaneShape): boolean {
  const op = shape.csg?.op ?? inferCsgOp(shape);
  return op === "assemble" && Boolean(shape.groupedShapes?.length);
}

export async function exportShapesToStep(shapes: WorkplaneShape[]): Promise<StepExportResult> {
  const brep = await loadBrepWithOcct();

  const skipped: SkippedShape[] = [];
  const degraded: SkippedShape[] = [];
  const holes: { box: Aabb; solid: BrepSolid; quality: StepExportQuality }[] = [];
  for (const shape of shapes.filter((s) => s.hole && !s.construction && !isEvaluatedCsgBody(s) && !isAssembleBody(s) && !s.csg?.suppressed && !s.hidden)) {
    const built = await buildShapeSolid(brep, shape, skipped, { allowFaceted: true });
    if ("skip" in built) {
      // The cutter is gone, so every part it would have bored ships uncut.
      degraded.push(describe(shape, `hole could not be built (${built.skip}) — parts export without this cut`));
      continue;
    }
    holes.push({ box: worldAabb(shape), solid: built.solid, quality: built.quality });
  }

  const parts: { shape: BrepSolid; name: string; color: string; quality: StepExportQuality }[] = [];
  for (const shape of shapes.filter((s) => !s.hole && !s.construction && !s.csg?.suppressed && !s.hidden && !s.suppressed)) {
    // Multi-body assemblies: keep children as separate STEP solids (do not fuse).
    if (isAssembleBody(shape)) {
      const children = (shape.groupedShapes ?? []).filter(
        (child) => !child.hole && !child.suppressed && !child.csg?.suppressed && !child.hidden,
      );
      for (const child of children) {
        const built = await buildShapeSolid(brep, child, skipped, { allowFaceted: true, nested: true });
        if ("skip" in built) {
          skipped.push(describe(child, `assembly leaf ${built.skip}`));
          continue;
        }
        let solid = placeGroupLocalSolid(brep, built.solid, shape);
        let quality = built.quality;
        if (holes.length > 0) {
          const childWorld = {
            ...child,
            x: shape.x + child.x,
            z: shape.z + child.z,
            elevation: (shape.elevation ?? 0) + (child.elevation ?? 0),
          };
          const solidBox = worldAabb(childWorld);
          const overlapping = holes.filter((hole) => aabbsOverlap(solidBox, hole.box));
          if (overlapping.length > 0) {
            const cut = brep.cutAll(solid, overlapping.map((hole) => hole.solid));
            if (cut.ok) {
              solid = cut.value;
              if (overlapping.some((hole) => hole.quality === "faceted")) quality = "faceted";
            } else {
              degraded.push(describe(child, "hole subtraction failed — exported as solid stock, holes missing"));
            }
          }
        }
        parts.push({
          shape: toCadZUp(brep, solid),
          name: child.name || shape.name,
          color: child.color || shape.color,
          quality,
        });
      }
      continue;
    }

    const built = await buildShapeSolid(brep, shape, skipped, { allowFaceted: true });
    if ("skip" in built) {
      skipped.push(describe(shape, built.skip));
      continue;
    }
    if (built.warning) {
      degraded.push(describe(shape, built.warning));
    }

    let solid = built.solid;
    let quality = built.quality;
    // Evaluated CSG bodies already include hole cuts in their mesh/B-Rep — don't re-cut.
    if (!isEvaluatedCsgBody(shape) && holes.length > 0) {
      const solidBox = worldAabb(shape);
      const overlapping = holes.filter((hole) => aabbsOverlap(solidBox, hole.box));
      if (overlapping.length > 0) {
        const cut = brep.cutAll(solid, overlapping.map((hole) => hole.solid));
        if (cut.ok) {
          solid = cut.value;
          if (overlapping.some((hole) => hole.quality === "faceted")) quality = "faceted";
        } else {
          degraded.push(describe(shape, "hole subtraction failed — exported as solid stock, holes missing"));
        }
      }
    }

    parts.push({ shape: toCadZUp(brep, solid), name: shape.name, color: shape.color, quality });
  }

  if (parts.length === 0) {
    throw new Error("No solid geometry to export as STEP");
  }

  const result = brep.exportAssemblySTEP(parts, { unit: "MM" });
  if (!result.ok) {
    throw new Error(`STEP export failed: ${String(result.error.message ?? result.error)}`);
  }

  const exactCount = parts.filter((part) => part.quality === "exact").length;
  const facetedCount = parts.filter((part) => part.quality === "faceted").length;
  return {
    blob: result.value,
    exportedCount: parts.length,
    exactCount,
    facetedCount,
    skipped,
    degraded,
  };
}

/**
 * After a successful OCCT CSG rebuild, persist STEP text on the grouped body so
 * later exports can skip remeshing mesh cutters.
 */
export async function bakeCsgBodyBrepStep(shape: WorkplaneShape): Promise<WorkplaneShape | null> {
  if (!shape.groupedShapes?.length) return null;
  try {
    const brep = await loadBrepWithOcct();
    const skipped: SkippedShape[] = [];
    const built = await buildShapeSolid(brep, shape, skipped, { allowFaceted: false });
    if ("skip" in built) return null;
    const localSolid = recenterSolidToLocalMeshFrame(brep, built.solid);
    const exported = brep.exportSTEP(localSolid as never);
    if (!exported.ok) return null;
    const brepStep = await exported.value.text();
    if (!brepStep.trim()) return null;
    const mesh = shape.importedMesh;
    if (!mesh) return null;
    return {
      ...shape,
      importedMesh: {
        ...mesh,
        brepStep,
      },
    };
  } catch {
    return null;
  }
}

export type OcctBooleanMeshResult = {
  positions: number[];
  brepStep: string;
  quality: StepExportQuality;
  /** World-space B-Rep feature edges after unify, for a clean viewport outline. */
  displayEdges?: { points: number[] }[];
};

/**
 * Prefer OCCT fuse/cut when every operand has exact B-Rep (native / brepStep / cadBrep).
 * Returns world-space triangle soup + STEP text for the result solid.
 */
export async function evaluateOcctBooleanOnWorldShapes(
  shapes: WorkplaneShape[],
  op: "subtract" | "union" | "intersect",
): Promise<OcctBooleanMeshResult | null> {
  const active = shapes.filter((shape) => !shape.suppressed && !shape.csg?.suppressed && !shape.locked);
  if (active.length === 0) return null;

  try {
    const brep = await loadBrepWithOcct();
    const skipped: SkippedShape[] = [];
    const solids: BrepSolid[] = [];
    const holes: BrepSolid[] = [];

    for (const shape of active) {
      const built = await buildShapeSolid(brep, shape, skipped, { allowFaceted: false });
      if ("skip" in built) return null;
      if (shape.hole) holes.push(built.solid);
      else solids.push(built.solid);
    }

    let solid: BrepSolid;
    if (op === "union") {
      if (solids.length === 0) return null;
      const fused = fuseAllUnified(brep, solids);
      if (!fused.ok) return null;
      solid = fused.value;
    } else if (op === "subtract") {
      if (solids.length === 0) return null;
      const fused = fuseAllUnified(brep, solids);
      if (!fused.ok) return null;
      const cut = cutAllUnified(brep, fused.value, holes);
      if (!cut.ok) return null;
      solid = cut.value;
    } else {
      const operands = [...solids, ...holes];
      if (operands.length < 2) return null;
      const next = intersectAllUnified(brep, operands);
      if (!next.ok) return null;
      solid = next.value;
    }

    // Tessellate in world space first so the editor can recenter the display mesh.
    // Export STEP in the same local frame as that mesh (XZ centered, Y from 0) so a
    // later Group does not apply the body pose a second time and pull parts apart.
    let positions: number[] = [];
    try {
      const tess = brep.mesh(solid as never);
      if (!tess?.vertices || tess.vertices.length < 9 || !tess.triangles?.length) return null;
      for (let i = 0; i < tess.triangles.length; i += 1) {
        const v = tess.triangles[i] * 3;
        positions.push(tess.vertices[v], tess.vertices[v + 1], tess.vertices[v + 2]);
      }
    } catch {
      return null;
    }
    if (positions.length < 9) return null;

    let brepStep: string;
    try {
      const origin = meshFrameOriginFromPositions(positions);
      const toExport = origin
        ? brep.translate(solid, [-origin.x, -origin.y, -origin.z])
        : solid;
      const exported = brep.exportSTEP(toExport as never);
      if (!exported.ok) return null;
      brepStep = await exported.value.text();
    } catch {
      return null;
    }
    if (!brepStep.trim()) return null;
    return {
      positions,
      brepStep,
      quality: "exact",
      displayEdges: displayEdgesFromBooleanSolid(brep, solid),
    };
  } catch {
    // OCCT WASM Aborted() and similar — callers fall back to Manifold / mesh CSG.
    return null;
  }
}
