# PeakCAD known limitations

PeakCAD 1.0 is ready for real parts. These are the remaining gaps versus a full industrial CAD suite.

## Exact STEP vs faceted

- Primitive solids (box, cylinder, sphere, cone, pyramid, …) and many Groups export as **exact B-Rep** STEP when OpenCascade can rebuild them.
- Sketch solids bake to exact STEP when possible (including densified freeform profiles). **Group waits for that bake** before trying OCCT boolean, so sketch holes/joins are less likely to fall to mesh.
- Imported meshes without B-Rep (STL, 3MF, SVG), specialty solids (text, …), and Groups that still fail OCCT export as **faceted** STEP (labeled in download preflight).
- Prefer native shapes + Group when you need manufacturing-grade STEP.

## Import & save

- **STEP import:** each solid in the file becomes its own body (large assemblies import as separate bodies). Display meshes are indexed.
- The exact STEP text for imported bodies is written the first time you **Save** (or export STEP) and is kept in the project after that. Autosave does not write it on its own.
- If you leave without saving after a STEP import (and never exported it), a later STEP export of those new bodies is **faceted**. PeakCAD asks to save when you leave a project with unsaved changes.
- **STL** has no unit: one file unit is read as one workplane unit (stored internally in mm, shown in your workplane unit).
- **Barrel sketches:** a circular profile on a cylinder face bakes as an exact radial cylinder at STEP export. Other barrel profiles loft between the inner and outer wraps, and stay faceted only if that loft fails.

## Group boolean

- When every child is exact-capable, Group tries **OpenCascade** first (after syncing sketch B-Rep bake), then **unifies leftover same-plane faces** so overlapping boxes (knurls, hubs) become one solid.
- If OCCT fails, PeakCAD falls back to **Manifold** mesh boolean and shows a notice — faceted STEP for that solid.
- Complex nested CSG stacks may still fall back to mesh.

## Assemblies (multi-body)

- Group of solids fuses into one body. **Assembly** is only the fallback when that fuse cannot run — children then stay separate.
- Assemblies export as **multi-solid STEP** (one part per child). Boolean Groups still fuse.
- Lock parts to freeze them. No mates, joints, BOM, or PDM/cloud assembly vault in Beta.
- Multi-body STEP import keeps each solid as a separate body, but not the file's assembly tree, part names, or colors.

## Fillet & chamfer

- Edge modifiers store a recipe (amount, edge fingerprints, optional IDs) and **re-apply after CSG remesh** when possible (feature suppress/reorder, sketch leaf edits, undo).
- Rematch prefers **geometry fingerprints** (midpoint / length / angle), then stable IDs, then sharpest-N fallback.
- If auto re-apply fails (topology changed a lot), use the Edge tools again.
- Exact STEP carries **baked** fillet/chamfer geometry (`cadBrep` / `brepStep`), not parametric CAD feature history.

## Barrel / face holes

- Nested UV loops on cylinder barrels (outer + inner) bake as annular radial cutters (mesh).
- Multiple separate barrel holes on one sketch are supported.
- Planar face holes Group as a mesh while editing. Circular barrel holes bake as exact radial cylinders when the STEP file is written.
- Prefer Group + check Exact vs Faceted on STEP.

## Sketch

- Constraints snap exactly: coincident, horizontal, vertical, parallel, perpendicular, equal, midpoint, concentric, tangent, symmetry, and driving length, diameter, and angle.
- A sketch is fully defined only when that geometry actually matches. A constraint that cannot land is unsolved.
- Snap inferences (H/V/coincident/midpoint) are persisted as real constraints.
- Circles are analytic entities. Diameter and radius dimensions write the circle radius directly.
- Non-circular barrel profiles export exact only when the radial loft succeeds; otherwise they stay faceted.

## Local only

- No PeakCAD account, cloud sync, hosted editor, or LAN/multi-user vault.
- Projects live on this computer (desktop app storage, plus the `.peakcad` file written by Save). Export STEP/STL of anything you need to keep.
