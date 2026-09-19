<div align="center">
  <img src="apps/web/public/assets/peakcad/peakcad-logo.png" width="120" alt="PeakCAD logo">
  <h1>PeakCAD</h1>
  <p><strong>Local-first CAD</strong> — as approachable as Tinkercad, with real B-Rep STEP when it counts.</p>
  <p>
    <a href="LICENSE"><img alt="GPLv3 license" src="https://img.shields.io/badge/license-GPLv3-blue"></a>
    <img alt="Local first" src="https://img.shields.io/badge/local--first-no%20account-0ea5e9">
    <img alt="Beta" src="https://img.shields.io/badge/status-beta-f59e0b">
    <img alt="Version 0.9.11" src="https://img.shields.io/badge/version-0.9.11-2563eb">
  </p>
</div>

PeakCAD is desktop + browser CAD from **PeakHorologyLLC**. Projects stay on your machine. No login. No cloud lock-in.

## What you can do

- Drop primitives (box, cylinder, sphere, cone, pyramid, triangle, torus, tube, polygon, threads, text, …)
- Solid / hole + **Group** (exact OpenCascade boolean when possible; mesh fallback otherwise)
- Sketch on a face, extrude / hole / revolve
- Fillet and chamfer edges (re-apply after remesh — see [Beta limitations](docs/BETA-LIMITATIONS.md))
- Import STL / STEP / 3MF / SVG · export STL / OBJ / 3MF / **STEP** (exact vs faceted, labeled)
- Windows desktop app (`npm run package:desktop`)

## Quick start

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Leave the terminal running. See [GETTING-STARTED.md](GETTING-STARTED.md) for packaging and upgrades.

### Desktop (Windows)

```bash
npm run package:desktop
```

Installers land in `dist-release/` (`PeakCAD-Setup-*.exe`, portable build).

### Docker (optional LAN host)

```bash
npm run docker:up
# → http://127.0.0.1:3000
npm run docker:down
```

Projects still live in each browser’s storage — Docker only serves the app files.

## Quality checks

```bash
npm run typecheck
npm test
npm run test:e2e   # STEP round-trip against OpenCascade
npm run ci         # typecheck + unit + e2e
```

## Beta status

PeakCAD **0.9.x is Beta**. Core modeling, multi-body assemblies, hard H/V/coincident dims, sync sketch B-Rep bake before Group, and geometric fillet rematch are ready for real parts. Remaining soft spots (barrel exact bake, soft sketch pulls, no mates): [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md).

## License

[GPL-3.0-or-later](LICENSE) · © PeakHorologyLLC

PeakCAD builds on the open SketchForge lineage with PeakCAD branding, STEP quality work, and desktop packaging.
