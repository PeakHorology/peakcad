# Contributing

Thanks for helping improve PeakCAD.

## Local Setup

```bash
npm install
npm run dev
```

`npm run dev` is a local preview on this machine (`http://127.0.0.1:3000`). PeakCAD itself is the Windows desktop build (`npm run package:desktop`).

## Before Opening a Pull Request

- Keep changes focused.
- Avoid unrelated refactors.
- Run `npm run ci` (typecheck + unit + e2e).
- Manually test the editor workflow you changed.
- Include screenshots or short recordings for UI changes when possible.
- Call out changes to storage, import, export, grouping, or undo/redo behavior.
- Read [docs/BETA-LIMITATIONS.md](../docs/BETA-LIMITATIONS.md) when touching STEP, Group, fillet, or sketch.

## Areas That Need Care

- STL / STEP / 3MF import/export
- Imported mesh transforms
- Grouping, hole subtraction, and ungrouping (OCCT vs Manifold paths)
- Undo/redo history
- Project persistence and dashboard thumbnails
- Shape gizmos, snapping, and rotated-object dimensions

## Style

- Prefer existing project patterns before adding new abstractions.
- Keep UI behavior local to the relevant component unless the behavior is shared.
- Use TypeScript types instead of loose object shapes where practical.
- Keep comments short and useful.

## Contribution Licensing

By contributing, you agree that your contributions are licensed under the same GPL-3.0-or-later terms as the project.
