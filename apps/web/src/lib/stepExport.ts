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

type BuildOutcome = { solid: BrepSolid; quality: StepExportQuality } | { skip: string };

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
  const sx = shapeWidth(shape) / Math.max(0.001, mesh.baseWidth);
  const sy = h / Math.max(0.001, mesh.baseHeight);
  const sz = shapeDepth(shape) / Math.max(0.001, mesh.baseDepth);
  let body = imported.value as unknown as BrepSolid;

  if (Math.abs(sx - sy) < 1e-6 && Math.abs(sy - sz) < 1e-6) {
    if (Math.abs(sx - 1) > 1e-6) body = brep.scale(body, sx);
  } else {
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
      if (solidChildren.length === 1) {
        solid = solidChildren[0];
      } else {
        const fused = brep.fuseAll(solidChildren);
        if (!fused.ok) throw fused.error;
        solid = fused.value;
      }
    } else if (op === "subtract") {
      let base = solidChildren[0];
      if (solidChildren.length > 1) {
        const fused = brep.fuseAll(solidChildren);
        if (!fused.ok) throw fused.error;
        base = fused.value;
      }
      if (holeChildren.length === 0) {
        solid = base;
      } else {
        const cut = brep.cutAll(base, holeChildren);
        if (!cut.ok) throw cut.error;
        solid = cut.value;
      }
    } else if (op === "intersect") {
      const operands = [...solidChildren, ...holeChildren];
      if (operands.length < 2) return { skip: "CSG intersect needs at least two operands" };
      let acc = operands[0];
      for (let i = 1; i < operands.length; i += 1) {
        const next = brep.intersect(acc, operands[i]);
        if (!next.ok) throw next.error;
        acc = next.value;
      }
      solid = acc;
    } else {
      return { skip: `unsupported CSG op ${op}` };
    }
  } catch (error) {
    if (allowFaceted && shape.importedMesh) return buildFacetedSolid(brep, shape);
    return { skip: `CSG ${op} failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (leafFailures > 0 && allowFaceted && shape.importedMesh?.positions.length && shape.importedMesh.positions.length >= 9) {
    return buildFacetedSolid(brep, shape);
  }

  // Nested under another CSG: keep group-local placement (parent will place).
  // Top-level group: map local → world via group pose.
  return {
    solid: placeGroupLocalSolid(brep, solid, shape),
    quality,
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
  for (const shape of shapes.filter((s) => s.hole && !isEvaluatedCsgBody(s) && !isAssembleBody(s) && !s.csg?.suppressed && !s.hidden)) {
    const built = await buildShapeSolid(brep, shape, skipped, { allowFaceted: true });
    if ("skip" in built) {
      // The cutter is gone, so every part it would have bored ships uncut.
      degraded.push(describe(shape, `hole could not be built (${built.skip}) — parts export without this cut`));
      continue;
    }
    holes.push({ box: worldAabb(shape), solid: built.solid, quality: built.quality });
  }

  const parts: { shape: BrepSolid; name: string; color: string; quality: StepExportQuality }[] = [];
  for (const shape of shapes.filter((s) => !s.hole && !s.csg?.suppressed && !s.hidden && !s.suppressed)) {
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
    const exported = brep.exportSTEP(built.solid as never);
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
      if (solids.length === 1) solid = solids[0];
      else {
        const fused = brep.fuseAll(solids);
        if (!fused.ok) return null;
        solid = fused.value;
      }
    } else if (op === "subtract") {
      if (solids.length === 0) return null;
      let base = solids[0];
      if (solids.length > 1) {
        const fused = brep.fuseAll(solids);
        if (!fused.ok) return null;
        base = fused.value;
      }
      if (holes.length === 0) solid = base;
      else {
        const cut = brep.cutAll(base, holes);
        if (!cut.ok) return null;
        solid = cut.value;
      }
    } else {
      const operands = [...solids, ...holes];
      if (operands.length < 2) return null;
      let acc = operands[0];
      for (let i = 1; i < operands.length; i += 1) {
        const next = brep.intersect(acc, operands[i]);
        if (!next.ok) return null;
        acc = next.value;
      }
      solid = acc;
    }

    // exportSTEP / mesh can WASM-abort on fragile solids — soft-fail so Manifold remesh can run.
    let brepStep: string;
    try {
      const exported = brep.exportSTEP(solid as never);
      if (!exported.ok) return null;
      brepStep = await exported.value.text();
    } catch {
      return null;
    }
    if (!brepStep.trim()) return null;

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
    return { positions, brepStep, quality: "exact" };
  } catch {
    // OCCT WASM Aborted() and similar — callers fall back to Manifold / mesh CSG.
    return null;
  }
}
