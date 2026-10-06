<div align="center">
  <img src="apps/web/public/assets/peakcad/peakcad-logo.png" width="96" alt="PeakCAD logo">
  <h1>PeakCAD</h1>
  <p>Local Windows CAD from Peak Horology.<br>Drop a solid, sketch on a face, and export a real B-Rep STEP file.</p>
  <p>
    <a href="LICENSE"><img alt="GPL-3.0-or-later" src="https://img.shields.io/badge/license-GPL--3.0--or--later-2563eb"></a>
    <img alt="Version 1.0.2" src="https://img.shields.io/badge/version-1.0.2-0f172a">
    <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-0ea5e9">
  </p>
</div>

PeakCAD 1.0 is a desktop CAD application. Projects stay on this computer. There is no account, no cloud, and no hosted edition.

## Features

- Primitives: box, cylinder, sphere, cone, pyramid, polygon, torus, tube, thread, text
- Sketch on a face, then extrude, cut, or revolve
- Group, with an exact OpenCascade boolean when the solid supports it
- Fillet and chamfer
- Import STL, STEP, 3MF, and SVG
- Export STL, OBJ, 3MF, and STEP (exact B-Rep when the solid allows it, faceted otherwise)

Known limits are listed in [docs/BETA-LIMITATIONS.md](docs/BETA-LIMITATIONS.md).

## Install

From a clone of this repository:

```bash
npm install
npm run package:desktop
```

The installer is written to `dist-release/PeakCAD-Setup-1.0.2.exe`. A portable build is written beside it. Close any running PeakCAD window before you install. Setup upgrades an existing install in place and keeps your projects.

Developers can preview the editor locally:

```bash
npm install
npm run dev
```

That serves `http://127.0.0.1:3000` on this machine only. See [GETTING-STARTED.md](GETTING-STARTED.md).

## Checks

```bash
npm run typecheck
npm test
npm run test:e2e
npm run ci
```

`npm run test:e2e` runs the STEP round-trip against OpenCascade.

## License

[GPL-3.0-or-later](LICENSE) · © PeakHorologyLLC

PeakCAD is free software and comes with no warranty. In the app, open **Settings → About** or **Help → About PeakCAD** for the copyright notice, the license, and the written source offer.

Third-party components keep their own licenses. The OpenCascade kernel is LGPL-2.1 with the Open CASCADE exception and ships as a separate `occt-wasm.wasm` file. `npm run stage:legal` writes `THIRD-PARTY-NOTICES.txt` from the installed dependencies. The desktop build ships that file with `LICENSE.txt` and `SOURCE-OFFER.txt`.
