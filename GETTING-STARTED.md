# PeakCAD — Getting Started

PeakCAD is a **local Windows desktop** CAD app from **PeakHorologyLLC** (Beta 0.9.x). There is no hosted, browser-SaaS, or LAN edition. See [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md) for known Beta gaps.

## Use PeakCAD (the app)

```powershell
cd path\to\peakcad
npm install
npm run package:desktop
```

This creates files in the `dist-release/` folder:

- `PeakCAD-Setup-0.9.11.exe` — installer (adds Start Menu + Desktop shortcut; version matches `package.json`)
- `PeakCAD-0.9.11-portable.exe` — portable build (no install needed; not an upgrader)

Close any running PeakCAD window before packaging. Run the Setup or portable exe — that is PeakCAD.

### Upgrade an existing install

You do **not** need to uninstall PeakCAD first. The Setup installer upgrades in place and keeps your projects/settings.

1. Bump `"version"` in `package.json` (for example `0.9.10` → `0.9.11`)
2. Close PeakCAD
3. Run `npm run package:desktop`
4. Run the new `PeakCAD-Setup-*.exe` from `dist-release/`
5. Finish the installer — PeakCAD relaunches on the upgraded build

If a pinned taskbar icon looks wrong after an upgrade, unpin it and pin the Start Menu/Desktop shortcut again (Windows caches icons aggressively).

The portable `.exe` is a separate copy you can run side-by-side; it does not upgrade an installed PeakCAD.

## Build from source (developers)

For UI work in Cursor, you can preview the same editor on this machine only:

```powershell
cd path\to\peakcad
npm run dev
```

Open **http://127.0.0.1:3000** on this computer. Leave the terminal open. Press `Ctrl+C` when you are done. Nothing is served to the network as a PeakCAD product.

## Branding

- App name: **PeakCAD**
- Developer: **PeakHorologyLLC**
- Logo: `apps/web/public/assets/peakcad/peakcad-logo.png`
- App icon / favicon: generated from the PeakCAD logo via `npm run prepare:desktop-icon`
- Color palette defined in `apps/web/src/app/globals.css` (`:root` variables)

## How to make changes (with AI help)

Describe what you want in Cursor, for example:

- "Change the sidebar to forest green"
- "Add a welcome message on the home screen"
- "Rename Box to Cube in the shape picker"

Good files to customize:

| File | What it controls |
|------|------------------|
| `apps/web/src/app/page.tsx` | Home screen, project list |
| `apps/web/src/app/globals.css` | Colors and styling |
| `apps/web/src/lib/shapeCatalog.ts` | Available shapes |

## Quality checks

```powershell
npm run ci
```

Runs typecheck, unit tests, and STEP e2e (OpenCascade).

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `node` or `npm` not recognized | Close and reopen your terminal |
| Port 3000 already in use | Stop other local dev servers |
| Preview page won't load | Make sure `npm run dev` is still running |
| Desktop app won't start | Close every PeakCAD window and run the new Setup exe |
