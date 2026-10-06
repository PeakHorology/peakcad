# Changelog

## 1.0.2

- Fillets and chamfers keep merged flat faces, skip a full edge walk when adding another edge, and draw every highlight from one line.
- A click selects the surface under the cursor. Empty space in the view clears the selection. The shape under the cursor shows a light outline before you click.
- Dense imported meshes build a pick index on the first click. A part's shadow hides while you drag it and returns when you let go.
- Selecting a shape no longer rebuilds its mesh. Pattern copies share one geometry.
- Startup shows the PeakCAD mark while the CAD engine loads, then Start Modeling opens your projects.

## 1.0.1

- Reduce File Size lowers the triangle count of an imported mesh for STL export, keeping sharp edges and small parts.
- Optional folder passwords. Projects in a locked folder stay out of Recents and the main project list.
- Snap mates one side of a shape to a side of another, with a highlight on the face under the cursor.
- A click on empty workplane space clears the selection. Shapes can sit past the workplane.
- Measurement labels fade while the camera moves and return when you let go.
- The shape list scrolls when the window is short. Panels, menus, and dialogs ease in and out.

## 1.0.0

- First 1.0 desktop release, licensed GPL-3.0-or-later.
- STEP files import as separate bodies. Display meshes stay indexed, and exact STEP text is written when you save or export.
- Leaving a project asks you to save. Closing the desktop window offers Save, Don't save, and Cancel.
- STL import follows the workplane unit.
- Settings → About and Help → About PeakCAD show the copyright, the no-warranty notice, and the license texts.
- The installer ships `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` (including the OpenCascade LGPL-2.1 text), and a written source offer.

## 0.9.6

- Circular pattern tool with radius, count, and 90° rotation controls.
- Remappable hotkeys in Settings (defaults match existing shortcuts).
- Settings Tools index with searchable tool descriptions.
- Shape Properties stay editable while circular pattern is active.
- Undo cancels an active circular pattern session.
- Right-click help tips across editor tools.
- Import / Export text actions, snap-to-grid near the workplane bar, and related editor UI polish.

## 0.1.0

- Initial open-source alpha.
- Browser-based 3D workspace with primitive shape editing.
- STL import and STL/OBJ export.
- Grouping and hole subtraction workflows.
- Local project dashboard with generated thumbnails.
