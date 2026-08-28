import type { WorkplaneShape } from "@/types/sketchforge";
import { roofAnglesFromProfile } from "@/lib/roofGeometry";
import { shapeDepth, shapeWidth } from "@/lib/workplaneShapes";
import type { Brep, BrepSolid } from "@/lib/brepKernel";

const SIZE_EPS = 0.0005;

export type ShapeBrepBuild = { solid: BrepSolid } | { skip: string };

/**
 * Native PeakCAD kinds that can be rebuilt as exact (or exact NURBS) B-Rep
 * from editable params — no mesh bake required. Viewport stays tessellated
 * for speed; STEP uses this path.
 */
export const NATIVE_EXACT_KINDS: ReadonlySet<WorkplaneShape["kind"]> = new Set([
  "box",
  "cylinder",
  "sphere",
  "cone",
  "pyramid",
  "wedge",
  "roof",
  "roundRoof",
  "halfSphere",
  "torus",
  "tube",
  "ring",
  "polygon",
]);

/** Kinds that are intentionally tessellated / font / helix detail. */
export const NATIVE_FACETED_KINDS: ReadonlySet<WorkplaneShape["kind"]> = new Set([
  "text",
  "icosahedron",
  "scribble",
  "sketch",
  "thread",
]);

export function shapeSupportsExactNativeBrep(shape: WorkplaneShape): boolean {
  if (shape.importedMesh && (shape.kind === "mesh" || shape.kind === "thread")) return Boolean(shape.importedMesh.brepStep);
  return NATIVE_EXACT_KINDS.has(shape.kind);
}

function nearlyEqual(a: number, b: number) {
  return Math.abs(a - b) < SIZE_EPS;
}

/** PeakCAD Y-up plane spanning X (U) and Z (V) — sketches extrude along +Y. */
function xzPlane(brep: Brep, origin: [number, number, number] = [0, 0, 0]) {
  return {
    origin,
    xDir: [1, 0, 0] as [number, number, number],
    yDir: [0, 0, 1] as [number, number, number],
    zDir: [0, 1, 0] as [number, number, number],
  };
}

/** Plane spanning X (U) and Y (V) — sketches extrude along +Z. */
function xyPlane(brep: Brep, origin: [number, number, number] = [0, 0, 0]) {
  return {
    origin,
    xDir: [1, 0, 0] as [number, number, number],
    yDir: [0, 1, 0] as [number, number, number],
    zDir: [0, 0, 1] as [number, number, number],
  };
}

function extrudeClosedUv(
  brep: Brep,
  points: Array<[number, number]>,
  plane: ReturnType<typeof xzPlane>,
  distance: number,
  direction: [number, number, number],
): BrepSolid | null {
  if (points.length < 3) return null;
  let pen = brep.draw(points[0]);
  for (let i = 1; i < points.length; i += 1) {
    pen = pen.lineTo(points[i]);
  }
  const drawing = pen.close();
  const sketch = brep.drawingToSketchOnPlane(drawing, plane as never);
  return brep.sketchExtrude(sketch as never, distance, {
    extrusionDirection: direction,
  }) as unknown as BrepSolid;
}

function extrudeEllipseY(brep: Brep, rx: number, rz: number, height: number): BrepSolid {
  const sketch = brep.sketchEllipse(rx, rz, { plane: xzPlane(brep) as never });
  return brep.sketchExtrude(sketch as never, height, {
    extrusionDirection: [0, 1, 0],
  }) as unknown as BrepSolid;
}

function centerOnY(brep: Brep, solid: BrepSolid, height: number): BrepSolid {
  return brep.translate(solid, [0, -height / 2, 0]);
}

/**
 * Build a local-frame solid centered at the origin (AABB mid-height on Y),
 * matching `buildExactSolid` placement conventions.
 */
export function buildNativeShapeSolid(brep: Brep, shape: WorkplaneShape): ShapeBrepBuild {
  const width = shapeWidth(shape);
  const depth = shapeDepth(shape);
  const height = shape.height;
  if (width <= SIZE_EPS || depth <= SIZE_EPS || height <= SIZE_EPS) {
    return { skip: "degenerate dimensions" };
  }

  try {
    switch (shape.kind) {
      case "box":
        return buildBox(brep, shape, width, height, depth);
      case "cylinder":
        return buildCylinder(brep, width, height, depth);
      case "sphere":
        return buildSphere(brep, width, height, depth);
      case "cone":
        return buildCone(brep, shape, width, height, depth);
      case "pyramid":
        return buildPyramid(brep, shape, width, height, depth);
      case "wedge":
        return buildWedge(brep, width, height, depth);
      case "roof":
        return buildRoof(brep, shape, width, height, depth);
      case "roundRoof":
        return buildRoundRoof(brep, width, height, depth);
      case "halfSphere":
        return buildHalfSphere(brep, width, height, depth);
      case "torus":
        return buildTorus(brep, shape, width, height, depth);
      case "tube":
      case "ring":
        return buildHollowCylinder(brep, shape, width, height, depth);
      case "polygon":
        return buildPolygon(brep, shape, width, height, depth);
      default:
        return { skip: "no exact B-Rep mapping" };
    }
  } catch (error) {
    return { skip: error instanceof Error ? error.message : "native B-Rep build failed" };
  }
}

function buildBox(
  brep: Brep,
  shape: WorkplaneShape,
  width: number,
  height: number,
  depth: number,
): ShapeBrepBuild {
  let solid = brep.box(width, height, depth, { centered: true });
  const radius = shape.radius ?? 0;
  if (radius > SIZE_EPS) {
    const maxR = Math.min(width, height, depth) / 2 - SIZE_EPS;
    const r = Math.min(radius, Math.max(SIZE_EPS, maxR));
    const filleted = brep.fillet(solid as never, r);
    if (filleted.ok) solid = filleted.value as unknown as BrepSolid;
  }
  return { solid };
}

function buildCylinder(brep: Brep, width: number, height: number, depth: number): ShapeBrepBuild {
  if (nearlyEqual(width, depth)) {
    return {
      solid: brep.cylinder(width / 2, height, { axis: [0, 1, 0], centered: true }),
    };
  }
  // Exact elliptical cylinder: ellipse sketch extruded along Y.
  const solid = extrudeEllipseY(brep, width / 2, depth / 2, height);
  return { solid: centerOnY(brep, solid, height) };
}

function buildSphere(brep: Brep, width: number, height: number, depth: number): ShapeBrepBuild {
  const rx = width / 2;
  const ry = height / 2;
  const rz = depth / 2;
  const uniform = nearlyEqual(rx, ry) && nearlyEqual(ry, rz);
  return { solid: uniform ? brep.sphere(rx) : brep.ellipsoid(rx, ry, rz) };
}

function buildCone(
  brep: Brep,
  shape: WorkplaneShape,
  width: number,
  height: number,
  depth: number,
): ShapeBrepBuild {
  // Absolute ring radii (mm). Equal radii → cylinder; OCCT rejects zero-taper cones.
  const baseRadius = Math.max(SIZE_EPS, shape.baseRadius ?? width / 2);
  const topRadius = Math.max(0, shape.topRadius ?? 0);
  const maxR = Math.max(baseRadius, topRadius, SIZE_EPS);
  let solid: BrepSolid = nearlyEqual(baseRadius, topRadius)
    ? brep.cylinder(baseRadius, height, { axis: [0, 1, 0], centered: true })
    : brep.cone(baseRadius, topRadius, height, { axis: [0, 1, 0], centered: true });

  // Overall Length/Width may be the outer footprint (not only the base). Scale so the
  // larger ring fills the footprint ellipse — identity when width = depth = 2·maxR.
  const sx = (width / 2) / maxR;
  const sz = (depth / 2) / maxR;
  if (!nearlyEqual(sx, 1) || !nearlyEqual(sz, 1)) {
    const scaled = brep.applyMatrix(solid, {
      linear: [sx, 0, 0, 0, 1, 0, 0, 0, sz],
      translation: [0, 0, 0],
    });
    if (!scaled.ok) return { skip: `cone footprint scale failed: ${String(scaled.error.message ?? scaled.error)}` };
    solid = scaled.value as unknown as BrepSolid;
  }
  return { solid };
}

function buildPyramid(
  brep: Brep,
  shape: WorkplaneShape,
  width: number,
  height: number,
  depth: number,
): ShapeBrepBuild {
  const sides = Math.max(3, Math.round(shape.sides ?? 4));
  if (sides === 4) {
    // Exact rectangular pyramid: loft base rectangle to apex (planar faces).
    const w = width / 2;
    const d = depth / 2;
    const drawing = brep.draw([-w, -d]).lineTo([w, -d]).lineTo([w, d]).lineTo([-w, d]).close();
    const sketch = brep.drawingToSketchOnPlane(drawing, xzPlane(brep) as never);
    const wire = brep.sketchWires(sketch as never);
    const lofted = brep.loft([wire as never], {
      ruled: true,
      endPoint: [0, height, 0],
    });
    if (!lofted.ok) {
      // Fallback: scaled cone (elliptical base) if loft is unavailable.
      let solid = brep.cone(width / 2, 0, height, { axis: [0, 1, 0], centered: true });
      if (!nearlyEqual(width, depth)) {
        const sz = depth / Math.max(SIZE_EPS, width);
        const scaled = brep.applyMatrix(solid, {
          linear: [1, 0, 0, 0, 1, 0, 0, 0, sz],
          translation: [0, 0, 0],
        });
        if (!scaled.ok) return { skip: `pyramid loft/scale failed: ${String(lofted.error.message ?? lofted.error)}` };
        solid = scaled.value as unknown as BrepSolid;
      }
      return { solid };
    }
    return { solid: centerOnY(brep, lofted.value as unknown as BrepSolid, height) };
  }

  // Loft the real n-gon base to the apex. Using brep.cone here exported a smooth circular
  // cone while the viewport drew flat facets, so every face and edge the user designed
  // against was missing from the STEP — and the body was still badged "exact".
  // Radius matches createPyramidGeometry's uniform ConeGeometry(min(w,d)/2, h, sides).
  const radius = Math.min(width, depth) / 2;
  const baseSketch = brep.sketchPolysides(radius, sides, 0, { plane: xzPlane(brep) as never });
  const baseWire = brep.sketchWires(baseSketch as never);
  const nGonLoft = brep.loft([baseWire as never], {
    ruled: true,
    endPoint: [0, height, 0],
  });
  if (nGonLoft.ok) {
    return { solid: centerOnY(brep, nGonLoft.value as unknown as BrepSolid, height) };
  }
  // Last resort only: a pyramid has no mesh for the faceted path, so skipping here would
  // drop the body from the file entirely. An approximate cone beats a missing part.
  return {
    solid: brep.cone(radius, 0, height, { axis: [0, 1, 0], centered: true }),
  };
}

function buildWedge(brep: Brep, width: number, height: number, depth: number): ShapeBrepBuild {
  const w = width / 2;
  // Profile in X-Y: (-w,0) → (w,0) → (w,height) — right-angle wedge, extrude along Z.
  const solid = extrudeClosedUv(
    brep,
    [[-w, 0], [w, 0], [w, height]],
    xyPlane(brep, [0, 0, -depth / 2]),
    depth,
    [0, 0, 1],
  );
  if (!solid) return { skip: "wedge profile failed" };
  return { solid: centerOnY(brep, solid, height) };
}

function buildRoof(
  brep: Brep,
  shape: WorkplaneShape,
  width: number,
  height: number,
  depth: number,
): ShapeBrepBuild {
  const w = width / 2;
  const { ridgeX } = roofAnglesFromProfile(width, height, shape.leftAngle, shape.rightAngle);
  const solid = extrudeClosedUv(
    brep,
    [[-w, 0], [w, 0], [ridgeX, height]],
    xyPlane(brep, [0, 0, -depth / 2]),
    depth,
    [0, 0, 1],
  );
  if (!solid) return { skip: "roof profile failed" };
  return { solid: centerOnY(brep, solid, height) };
}

function buildRoundRoof(brep: Brep, width: number, height: number, depth: number): ShapeBrepBuild {
  // Semicircle of radius width/2 in X-Y, scaled in Y to `height`, extruded along Z.
  const radius = width / 2;
  const plane = xyPlane(brep, [0, 0, -depth / 2]);
  const disk = brep.sketchCircle(radius, { plane: plane as never });
  let solid = brep.sketchExtrude(disk as never, depth, {
    extrusionDirection: [0, 0, 1],
  }) as unknown as BrepSolid;
  // Y size is radius*2+2, so the centre must sit a full half-extent below the y=0
  // plane for the cutter's top face to land exactly on it.
  const cutter = brep.translate(
    brep.box(radius * 4 + 2, radius * 2 + 2, depth + 4, { centered: true }),
    [0, -(radius + 1), 0],
  );
  const cut = brep.cut(solid, cutter);
  if (!cut.ok) {
    const segments = 64;
    const pts: Array<[number, number]> = [[-radius, 0]];
    for (let i = 1; i < segments; i += 1) {
      const a = Math.PI - (i / segments) * Math.PI;
      pts.push([Math.cos(a) * radius, Math.sin(a) * radius]);
    }
    pts.push([radius, 0]);
    const approx = extrudeClosedUv(brep, pts, plane, depth, [0, 0, 1]);
    if (!approx) return { skip: `round roof failed: ${String(cut.error.message ?? cut.error)}` };
    solid = approx;
  } else {
    solid = cut.value;
  }
  const sy = height / Math.max(SIZE_EPS, radius);
  if (!nearlyEqual(sy, 1)) {
    const scaled = brep.applyMatrix(solid, {
      linear: [1, 0, 0, 0, sy, 0, 0, 0, 1],
      translation: [0, 0, 0],
    });
    if (!scaled.ok) return { skip: `round roof scale failed: ${String(scaled.error.message ?? scaled.error)}` };
    solid = scaled.value as unknown as BrepSolid;
  }
  return { solid: centerOnY(brep, solid, height) };
}

function buildHalfSphere(brep: Brep, width: number, height: number, depth: number): ShapeBrepBuild {
  const rx = width / 2;
  const ry = height;
  const rz = depth / 2;
  // Full ellipsoid centered at origin spans y=[-ry, ry]; keep upper half.
  let solid: BrepSolid = nearlyEqual(rx, ry) && nearlyEqual(ry, rz)
    ? brep.sphere(rx)
    : brep.ellipsoid(rx, ry, rz);
  const cutter = brep.box(rx * 4, ry * 2, rz * 4, { centered: true });
  const cutterPlaced = brep.translate(cutter, [0, -ry, 0]);
  const cut = brep.cut(solid, cutterPlaced);
  if (!cut.ok) return { skip: `half sphere cut failed: ${String(cut.error.message ?? cut.error)}` };
  solid = cut.value;
  // Upper half spans y=[0, ry]; center for placement convention.
  return { solid: centerOnY(brep, solid, height) };
}

function buildTorus(
  brep: Brep,
  shape: WorkplaneShape,
  width: number,
  height: number,
  depth: number,
): ShapeBrepBuild {
  const maxTubeRadius = Math.max(0.1, Math.min(width, depth) / 2 - 0.2);
  const tubeRadius = Math.min(Math.max(0.1, shape.radius ?? height / 2), maxTubeRadius);
  const majorRadius = Math.max(0.2, Math.min(width, depth) / 2 - tubeRadius);
  let solid = brep.torus(majorRadius, tubeRadius, { axis: [0, 1, 0] });
  const outerDiameter = (majorRadius + tubeRadius) * 2;
  const sx = width / Math.max(SIZE_EPS, outerDiameter);
  const sy = height / Math.max(SIZE_EPS, tubeRadius * 2);
  const sz = depth / Math.max(SIZE_EPS, outerDiameter);
  if (!nearlyEqual(sx, 1) || !nearlyEqual(sy, 1) || !nearlyEqual(sz, 1)) {
    const scaled = brep.applyMatrix(solid, {
      linear: [sx, 0, 0, 0, sy, 0, 0, 0, sz],
      translation: [0, 0, 0],
    });
    if (!scaled.ok) return { skip: `torus scale failed: ${String(scaled.error.message ?? scaled.error)}` };
    solid = scaled.value as unknown as BrepSolid;
  }
  return { solid };
}

function buildHollowCylinder(
  brep: Brep,
  shape: WorkplaneShape,
  width: number,
  height: number,
  depth: number,
): ShapeBrepBuild {
  const outerX = width / 2;
  const outerZ = depth / 2;
  const thickness = Math.min(
    Math.max(0.1, shape.bevel ?? 4),
    Math.max(0.1, Math.min(outerX, outerZ) - 0.1),
  );
  const innerX = Math.max(0.1, outerX - thickness);
  const innerZ = Math.max(0.1, outerZ - thickness);

  let outer: BrepSolid;
  let inner: BrepSolid;
  if (nearlyEqual(width, depth)) {
    outer = brep.cylinder(outerX, height, { axis: [0, 1, 0], centered: true });
    inner = brep.cylinder(innerX, height + 2, { axis: [0, 1, 0], centered: true });
  } else {
    outer = centerOnY(brep, extrudeEllipseY(brep, outerX, outerZ, height), height);
    inner = centerOnY(brep, extrudeEllipseY(brep, innerX, innerZ, height + 2), height + 2);
  }
  const cut = brep.cut(outer, inner);
  if (!cut.ok) return { skip: `hollow cylinder cut failed: ${String(cut.error.message ?? cut.error)}` };
  return { solid: cut.value };
}

function buildPolygon(
  brep: Brep,
  shape: WorkplaneShape,
  width: number,
  height: number,
  depth: number,
): ShapeBrepBuild {
  const sides = Math.max(3, Math.round(shape.sides ?? 6));
  // Circumscribed radius 1, then scale to width/depth like CylinderGeometry(1).scale(w/2,1,d/2).
  const sketch = brep.sketchPolysides(1, sides, 0, { plane: xzPlane(brep) as never });
  let solid = brep.sketchExtrude(sketch as never, height, {
    extrusionDirection: [0, 1, 0],
  }) as unknown as BrepSolid;
  solid = centerOnY(brep, solid, height);
  const sx = width / 2;
  const sz = depth / 2;
  if (!nearlyEqual(sx, 1) || !nearlyEqual(sz, 1)) {
    const scaled = brep.applyMatrix(solid, {
      linear: [sx, 0, 0, 0, 1, 0, 0, 0, sz],
      translation: [0, 0, 0],
    });
    if (!scaled.ok) return { skip: `polygon scale failed: ${String(scaled.error.message ?? scaled.error)}` };
    solid = scaled.value as unknown as BrepSolid;
  }
  return { solid };
}
