# PeakCAD Beta limitations

PeakCAD 0.9.x is **Beta**. Core modeling is ready for real parts; these are the remaining gaps versus a full industrial CAD suite.

## Exact STEP vs faceted

- Primitive solids (box, cylinder, sphere, cone, pyramid, …) and many Groups export as **exact B-Rep** STEP when OpenCascade can rebuild them.
- Sketch solids bake to exact STEP when possible (including densified freeform profiles). **Group waits for that bake** before trying OCCT boolean, so sketch holes/joins are less likely to fall to mesh.
- Imported meshes without B-Rep, specialty solids (text, …), and Groups that still fail OCCT export as **faceted** STEP (labeled in download preflight).
- Prefer native shapes + Group when you need manufacturing-grade STEP.
- **Still faceted in Beta:** barrel / cylinder-plane sketch holes (radial wrap) — planar face sketches are the exact path today.

## Group boolean

- When every child is exact-capable, Group tries **OpenCascade** first (after syncing sketch B-Rep bake), then **unifies leftover same-plane faces** so overlapping boxes (knurls, hubs) become one solid.
- If OCCT fails, PeakCAD falls back to **Manifold** mesh boolean and shows a notice — faceted STEP for that solid.
- Complex nested CSG stacks may still fall back to mesh.

## Assemblies (multi-body)

- Group of solids fuses into one body. **Assembly** is only the fallback when that fuse cannot run — children then stay separate.
- Assemblies export as **multi-solid STEP** (one part per child). Boolean Groups still fuse.
- Lock parts to freeze them. No mates, joints, BOM, or PDM/cloud assembly vault in Beta.
- STEP import still collapses to a single body.

## Fillet & chamfer

- Edge modifiers store a recipe (amount, edge fingerprints, optional IDs) and **re-apply after CSG remesh** when possible (feature suppress/reorder, sketch leaf edits, undo).
- Rematch prefers **geometry fingerprints** (midpoint / length / angle), then stable IDs, then sharpest-N fallback.
- If auto re-apply fails (topology changed a lot), use the Edge tools again.
- Exact STEP carries **baked** fillet/chamfer geometry (`cadBrep` / `brepStep`), not parametric CAD feature history.

## Barrel / face holes

- Nested UV loops on cylinder barrels (outer + inner) bake as annular radial cutters (mesh).
- Multiple separate barrel holes on one sketch are supported.
- Planar face holes can Group via OCCT when bake succeeds; barrel holes usually remain mesh until an exact radial bake lands.
- Prefer Group + check Exact vs Faceted on STEP.

## Sketch

- **Hard** constraints: coincident, horizontal, vertical, and linear driving dimensions snap to exact values.
- Snap inferences (H/V/coincident/midpoint) are persisted as real constraints.
- Parallel, perpendicular, equal, tangent, and symmetry remain soft pulls in Beta.
- Circles drawn as polylines have limited solve support versus first-class circle entities.

## Local only

- No PeakCAD account, cloud sync, hosted editor, or LAN/multi-user vault.
- Projects live on this computer (desktop app storage). Export STEP/STL of anything you need to keep.
