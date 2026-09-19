import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const exportRoot = join(repositoryRoot, "apps", "web", ".next-export");
const chunksRoot = join(exportRoot, "_next", "static", "chunks");

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listJavaScriptFiles(path) : [path];
    }),
  );

  return files.flat().filter((path) => path.endsWith(".js"));
}

const indexHtml = await readFile(join(exportRoot, "index.html"), "utf8");
if (indexHtml.includes('="./_next/')) {
  throw new Error(
    "Static HTML uses a relative ./_next asset prefix. Worker chunks resolve that prefix " +
      "relative to their own directory and request a duplicated /_next/static/chunks path.",
  );
}

const workerChunks = [];
for (const path of await listJavaScriptFiles(chunksRoot)) {
  const source = await readFile(path, "utf8");
  // Classic webpack worker runtime (older Next builds).
  const classicWorker = source.includes("importScripts(") && source.includes("static/chunks/");
  // Modern module workers: CAD/manifold runtimes with message handlers and no classic importScripts.
  const modernCadWorker =
    !source.includes("importScripts(")
    && (source.includes("onmessage") || source.includes("addEventListener(\"message\""))
    && (source.includes("/occt") || source.includes("cadModifier") || source.includes("manifold"));
  if (classicWorker || modernCadWorker) {
    workerChunks.push({ path, source, classicWorker });
  }
}

if (workerChunks.length === 0) {
  throw new Error("Could not find the generated CAD worker runtime to verify its public path.");
}

for (const { path, source, classicWorker } of workerChunks) {
  if (/["']\.\/_next\//.test(source)) {
    throw new Error(`Worker runtime ${path} embeds a relative ./_next/ asset path.`);
  }
  if (classicWorker && !source.includes('.p="/_next/"') && !source.includes(".p='/_next/'")) {
    throw new Error(`Worker runtime ${path} does not use the root-relative /_next/ public path.`);
  }
}

console.log(`Verified ${workerChunks.length} static worker runtime(s) for Electron/static export.`);
