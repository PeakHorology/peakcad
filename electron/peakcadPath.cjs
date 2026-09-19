const fs = require("node:fs");
const path = require("node:path");

const EXTENSION = ".peakcad";
const MAX_BYTES = 80 * 1024 * 1024;

function defaultProjectDir(app) {
  return path.join(app.getPath("documents"), "PeakCAD");
}

function normalizePeakcadPath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Missing PeakCAD file path.");
  }
  const resolved = path.resolve(filePath.trim());
  if (path.extname(resolved).toLowerCase() !== EXTENSION) {
    throw new Error("PeakCAD files must use the .peakcad extension.");
  }
  return resolved;
}

function isWritablePeakcadPath(filePath, defaultDir, allowedPaths) {
  const resolved = normalizePeakcadPath(filePath);
  const defaultRoot = `${path.resolve(defaultDir)}${path.sep}`.toLowerCase();
  return resolved.toLowerCase().startsWith(defaultRoot) || allowedPaths.has(resolved.toLowerCase());
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  let index = 2;
  let next = path.join(dir, `${stem} (${index})${ext}`);
  while (fs.existsSync(next)) {
    index += 1;
    next = path.join(dir, `${stem} (${index})${ext}`);
  }
  return next;
}

function findPeakcadArg(argv = []) {
  return argv.find((arg) => typeof arg === "string" && arg.toLowerCase().endsWith(EXTENSION) && !arg.startsWith("-")) ?? null;
}

module.exports = {
  EXTENSION,
  MAX_BYTES,
  defaultProjectDir,
  findPeakcadArg,
  isWritablePeakcadPath,
  normalizePeakcadPath,
  uniquePath,
};
