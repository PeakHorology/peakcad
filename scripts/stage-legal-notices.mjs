// Stages PeakCAD's license, written source offer, and third-party notices into
// apps/web/public/legal/ so the static export (Settings > About) and the desktop
// installer (electron-builder extraResources/extraFiles) both ship them. The
// staged folder is gitignored; this script runs before dev/build/export.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = join(root, "node_modules");
const legalSrc = join(root, "legal");
const dest = join(root, "apps", "web", "public", "legal");
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = rootPackage.version;

// Runtime dependencies that are build tooling only, plus native build helpers that never reach the app.
const EXCLUDED_NAMES = new Set(["tailwindcss", "@tailwindcss/postcss", "sharp", "occt-wasm"]);
const EXCLUDED_PREFIXES = ["@types/", "@img/", "@next/swc-"];
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

function isExcluded(name) {
  return EXCLUDED_NAMES.has(name) || EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  while (dir.startsWith(root)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const fallback = join(nodeModules, name);
  return existsSync(join(fallback, "package.json")) ? fallback : null;
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function licenseString(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return "UNKNOWN";
}

function repositoryUrl(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return (repo ?? pkg.homepage ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
}

function licenseFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** Every installed, non-excluded package reachable from the app's runtime dependencies. */
function collectRuntimePackages() {
  const seen = new Map();
  const queue = Object.keys(rootPackage.dependencies ?? {}).map((name) => ({ name, from: root }));
  while (queue.length) {
    const { name, from } = queue.shift();
    if (isExcluded(name)) continue;
    const dir = resolvePackageDir(name, from);
    if (!dir || seen.has(dir)) continue;
    const pkg = readPackage(dir);
    seen.set(dir, pkg);
    const requiredPeers = Object.keys(pkg.peerDependencies ?? {}).filter(
      (dep) => !pkg.peerDependenciesMeta?.[dep]?.optional,
    );
    const deps = [...Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }), ...requiredPeers];
    for (const dep of deps) queue.push({ name: dep, from: dir });
  }
  return [...seen.entries()]
    .map(([dir, pkg]) => ({
      name: pkg.name,
      version: pkg.version,
      license: licenseString(pkg),
      url: repositoryUrl(pkg),
      files: licenseFiles(dir),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function occtWasmVersion() {
  return readPackage(join(nodeModules, "occt-wasm")).version;
}

function electronEntry() {
  const dir = join(nodeModules, "electron");
  const pkg = readPackage(dir);
  return {
    name: "electron",
    version: pkg.version,
    license: licenseString(pkg),
    url: repositoryUrl(pkg),
    files: licenseFiles(dir),
    note:
      "Electron bundles Chromium, Node.js, and other components under their own licenses. Those notices " +
      "ship unmodified next to PeakCAD.exe as LICENSE.electron.txt and LICENSES.chromium.html.",
  };
}

const FONT_ENTRIES = [
  {
    name: "Inter (UI typeface)",
    version: "variable, latin subset",
    license: "OFL-1.1",
    url: "https://github.com/rsms/inter",
    files: [join(root, "apps", "web", "src", "app", "fonts", "Inter-LICENSE.txt")],
  },
  {
    name: "three.js example typefaces (helvetiker, optimer, gentilis, droid) used by the Text shape",
    version: "from three",
    license: "See license texts below",
    url: "https://github.com/mrdoob/three.js/tree/dev/examples/fonts",
    files: [
      join(nodeModules, "three", "examples", "fonts", "LICENSE"),
      join(nodeModules, "three", "examples", "fonts", "README.md"),
      join(nodeModules, "three", "examples", "fonts", "droid", "NOTICE"),
    ].filter((file) => existsSync(file)),
  },
];

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

function readText(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd();
}

function renderEntry(entry) {
  const lines = [RULE, `${entry.name}${entry.version ? ` ${entry.version}` : ""}`, `License: ${entry.license}`];
  if (entry.url) lines.push(`Source: ${entry.url}`);
  if (entry.note) lines.push("", entry.note);
  lines.push(RULE, "");
  if (!entry.files.length) {
    lines.push(`This package does not ship a license file. It is distributed under ${entry.license}.`, "");
  }
  for (const file of entry.files) {
    lines.push(readText(file), "", THIN, "");
  }
  return lines.join("\n");
}

function renderNotices(packages) {
  const occtVersion = occtWasmVersion();
  const occtEntries = [
    {
      name: "OpenCascade Technology (OCCT) compiled to WebAssembly (occt-wasm.wasm)",
      version: `via occt-wasm ${occtVersion}`,
      license: "LGPL-2.1-only WITH OCCT-exception-1.0",
      url: "https://github.com/Open-Cascade-SAS/OCCT (build scripts: https://github.com/andymai/occt-wasm)",
      note:
        "PeakCAD makes use of facilities provided by the Open CASCADE Technology software. The OCCT kernel is\n" +
        "a separate, replaceable file loaded at runtime; it is not linked into PeakCAD.exe. In the installed app\n" +
        "it is resources\\app.asar.unpacked\\apps\\web\\.next-export\\occt\\occt-wasm.wasm. You may replace it\n" +
        "with a modified build of the same interface. The full LGPL-2.1 text is also shipped separately as\n" +
        "legal\\licenses\\LGPL-2.1.txt.",
      files: [join(legalSrc, "licenses", "LGPL-2.1.txt"), join(legalSrc, "licenses", "OCCT_LGPL_EXCEPTION.txt")],
    },
    {
      name: "occt-wasm TypeScript/JavaScript wrapper",
      version: occtVersion,
      license: "MIT OR Apache-2.0 (used here under MIT)",
      url: "https://github.com/andymai/occt-wasm",
      files: [join(legalSrc, "licenses", "occt-wasm-LICENSE-MIT.txt")],
    },
  ];
  const all = [...occtEntries, ...packages, electronEntry(), ...FONT_ENTRIES];
  const summary = all.map((entry) => `  - ${entry.name}${entry.version ? ` ${entry.version}` : ""}: ${entry.license}`);
  return [
    `PeakCAD ${version} - Third-Party Notices`,
    RULE,
    "",
    "PeakCAD is Copyright (C) PeakHorologyLLC and is licensed under the GNU General",
    "Public License, version 3 or (at your option) any later version. See LICENSE.txt.",
    "It comes with ABSOLUTELY NO WARRANTY.",
    "",
    "PeakCAD includes the following third-party components. Each is distributed",
    "under its own license, reproduced in full below.",
    "",
    ...summary,
    "",
    "",
    ...all.map(renderEntry),
  ].join("\n");
}

await rm(dest, { recursive: true, force: true });
await mkdir(join(dest, "licenses"), { recursive: true });

await copyFile(join(root, "LICENSE"), join(dest, "LICENSE.txt"));
for (const name of ["LGPL-2.1.txt", "OCCT_LGPL_EXCEPTION.txt", "occt-wasm-LICENSE-MIT.txt"]) {
  await copyFile(join(legalSrc, "licenses", name), join(dest, "licenses", name));
}
const offer = readFileSync(join(legalSrc, "SOURCE-OFFER.txt"), "utf8").replaceAll("{{VERSION}}", version);
await writeFile(join(dest, "SOURCE-OFFER.txt"), offer);

const packages = collectRuntimePackages();
await writeFile(join(dest, "THIRD-PARTY-NOTICES.txt"), `${renderNotices(packages)}\n`);

console.log(`[stage-legal-notices] staged LICENSE, source offer, and notices for ${packages.length + 3} components into apps/web/public/legal/`);
