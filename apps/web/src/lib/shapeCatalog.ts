import { catalogSidesForKind, catalogStepsForKind, getActiveDisplayQuality } from "@/lib/displayTessellation";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import { createLocalId } from "@/lib/localIds";
import { DEFAULT_TEXT_FONT } from "@/lib/textFonts";
import type { DisplayQuality, ShapeAsset, WorkplaneShape } from "@/types/sketchforge";

export type ToolbarShapeAsset = ShapeAsset & { menuIcon: string };

export const toolbarShapeAssets: ToolbarShapeAsset[] = [
  { id: "box", name: "Box", src: "assets/sketchforge/shape-icons-gray/box.png", menuIcon: "assets/sketchforge/shape-icons-gray/box.png", kind: "box", color: "#d41721" },
  { id: "cylinder", name: "Cylinder", src: "assets/sketchforge/shape-icons-gray/cylinder.png", menuIcon: "assets/sketchforge/shape-icons-gray/cylinder.png", kind: "cylinder", color: "#d97813" },
  { id: "roof", name: "Triangle", src: "assets/sketchforge/shape-icons-gray/roof.png", menuIcon: "assets/sketchforge/shape-icons-gray/roof.png", kind: "roof", color: "#a83c32" },
  { id: "polygon", name: "Polygon", src: "assets/sketchforge/shape-icons-gray/polygon.png", menuIcon: "assets/sketchforge/shape-icons-gray/polygon.png", kind: "polygon", color: "#3b82f6" },
  { id: "sphere", name: "Sphere", src: "assets/sketchforge/shape-icons-gray/sphere.png", menuIcon: "assets/sketchforge/shape-icons-gray/sphere.png", kind: "sphere", color: "#0098c7" },
  { id: "cone", name: "Cone", src: "assets/sketchforge/shape-icons-gray/cone.png", menuIcon: "assets/sketchforge/shape-icons-gray/cone.png", kind: "cone", color: "#6e2786" },
  { id: "pyramid", name: "Pyramid", src: "assets/sketchforge/shape-icons-gray/pyramid.png", menuIcon: "assets/sketchforge/shape-icons-gray/pyramid.png", kind: "pyramid", color: "#f2cf10" },
  { id: "round-roof", name: "Round Roof", src: "assets/sketchforge/shape-icons-gray/round-roof.png", menuIcon: "assets/sketchforge/shape-icons-gray/round-roof.png", kind: "roundRoof", color: "#67c4ce" },
  { id: "half-sphere", name: "Half Sphere", src: "assets/sketchforge/shape-icons-gray/half-sphere.png", menuIcon: "assets/sketchforge/shape-icons-gray/half-sphere.png", kind: "halfSphere", color: "#c9009a" },
  { id: "torus", name: "Torus", src: "assets/sketchforge/shape-icons-gray/torus.png", menuIcon: "assets/sketchforge/shape-icons-gray/torus.png", kind: "torus", color: "#0098c7" },
  { id: "tube", name: "Ring", src: "assets/sketchforge/shape-icons-gray/tube.png", menuIcon: "assets/sketchforge/shape-icons-gray/tube.png", kind: "tube", color: "#ce7013" },
  { id: "text", name: "Text", src: "assets/sketchforge/shape-icons-gray/text.png", menuIcon: "assets/sketchforge/shape-icons-gray/text.png", kind: "text", color: "#cf101b" },
  { id: "thread", name: "Threads", src: "assets/sketchforge/shape-icons-gray/thread.png", menuIcon: "assets/sketchforge/shape-icons-gray/thread.png", kind: "thread", color: "#d97813" },
];

export function sceneShape(shape: Partial<WorkplaneShape> & Pick<WorkplaneShape, "name" | "kind" | "color">): WorkplaneShape {
  const width = shape.width ?? shape.size ?? 20;
  const depth = shape.depth ?? shape.size ?? 20;
  const height = shape.height ?? 20;
  // Spread rather than list fields: this is also the clipboard paste path, and any field
  // missing from a whitelist is silently destroyed on paste. That lost mirroring (turning a
  // left-hand part into a right-hand one), baked B-Rep (downgrading STEP to faceted), edge
  // treatments and CSG history.
  return canonicalizeShape({
    ...shape,
    id: shape.id ?? createLocalId("shape"),
    name: shape.name,
    kind: shape.kind,
    color: shape.color,
    x: shape.x ?? 0,
    z: shape.z ?? 0,
    elevation: shape.elevation ?? 0,
    size: shape.size ?? Math.max(width, depth),
    width,
    depth,
    height,
    rotation: shape.rotation ?? 0,
    rotationX: shape.rotationX ?? 0,
    rotationZ: shape.rotationZ ?? 0,
    locked: shape.locked ?? false,
    hidden: shape.hidden ?? false,
  });
}

export function makeShapeFromAsset(
  asset: ShapeAsset,
  point?: { x: number; z: number; elevation?: number },
  displayQuality: DisplayQuality = getActiveDisplayQuality(),
): WorkplaneShape {
  const roundProfile = asset.kind === "sphere" || asset.kind === "torus" || asset.kind === "ring" || asset.kind === "halfSphere" || asset.kind === "icosahedron";
  const flatProfile = asset.kind === "torus" || asset.kind === "ring" || asset.kind === "text";
  const size = roundProfile ? 22 : 20;
  const height = asset.kind === "text" ? 10 : asset.kind === "roundRoof" ? 10 : asset.kind === "halfSphere" ? 11 : flatProfile ? 5 : 20;
  const width = asset.kind === "text" ? 86 : size;
  const depth = asset.kind === "text" ? 28 : size;
  const steps = catalogStepsForKind(asset.kind, displayQuality);
  const sides = catalogSidesForKind(asset.kind, displayQuality);

  return {
    id: createLocalId(asset.id),
    name: asset.name,
    kind: asset.kind,
    color: asset.color,
    hole: asset.hole,
    x: point?.x ?? 0,
    z: point?.z ?? 0,
    elevation: point?.elevation ?? 0,
    size,
    width,
    depth,
    height,
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    radius: asset.kind === "torus" ? height / 2 : asset.kind === "box" ? 0 : undefined,
    text: asset.kind === "text" ? "TEXT" : undefined,
    font: asset.kind === "text" ? DEFAULT_TEXT_FONT : undefined,
    steps,
    sides,
    bevel: asset.kind === "cylinder" ? 0 : asset.kind === "tube" || asset.kind === "ring" ? 4 : undefined,
    segments: asset.kind === "cylinder" ? 1 : undefined,
    topRadius: asset.kind === "cone" ? 0 : undefined,
    baseRadius: asset.kind === "cone" ? size / 2 : undefined,
    locked: false,
    hidden: false,
  };
}
