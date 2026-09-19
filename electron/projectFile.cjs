const { dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const {
  EXTENSION,
  MAX_BYTES,
  defaultProjectDir,
  findPeakcadArg,
  isWritablePeakcadPath,
  normalizePeakcadPath,
  uniquePath,
} = require("./peakcadPath.cjs");

const allowedPaths = new Set();

function allowPath(filePath) {
  const resolved = normalizePeakcadPath(filePath);
  allowedPaths.add(resolved.toLowerCase());
  return resolved;
}

function isAllowlisted(filePath) {
  return allowedPaths.has(normalizePeakcadPath(filePath).toLowerCase());
}

function assertWritable(app, filePath) {
  const resolved = normalizePeakcadPath(filePath);
  if (isWritablePeakcadPath(resolved, defaultProjectDir(app), allowedPaths)) {
    return resolved;
  }
  throw new Error("That file path is not available for save.");
}

function writeTextFile(filePath, text) {
  if (typeof text !== "string") {
    throw new Error("PeakCAD file contents must be text.");
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BYTES) {
    throw new Error("This PeakCAD file is too large to save.");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
  return allowPath(filePath);
}

function readTextFile(filePath) {
  const resolved = normalizePeakcadPath(filePath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error("That PeakCAD path is not a file.");
  }
  if (stat.size > MAX_BYTES) {
    throw new Error("This PeakCAD file is too large to open.");
  }
  return { path: resolved, text: fs.readFileSync(resolved, "utf8") };
}

function registerProjectFileIpc(app, getWindow) {
  ipcMain.handle("peakcad:file-default-dir", async () => defaultProjectDir(app));

  ipcMain.handle("peakcad:file-open", async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window ?? undefined, {
      title: "Open PeakCAD project",
      filters: [{ name: "PeakCAD project", extensions: ["peakcad"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const resolved = allowPath(result.filePaths[0]);
    return readTextFile(resolved);
  });

  ipcMain.handle("peakcad:file-read", async (_event, filePath) => readTextFile(filePath));

  ipcMain.handle("peakcad:file-write", async (_event, payload) => {
    const resolved = assertWritable(app, payload?.path);
    return { path: writeTextFile(resolved, payload?.text) };
  });

  ipcMain.handle("peakcad:file-save-as", async (_event, payload) => {
    const window = getWindow();
    const result = await dialog.showSaveDialog(window ?? undefined, {
      title: "Save PeakCAD project",
      defaultPath: path.join(defaultProjectDir(app), typeof payload?.defaultName === "string" ? payload.defaultName : `Untitled design${EXTENSION}`),
      filters: [{ name: "PeakCAD project", extensions: ["peakcad"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const target = allowPath(result.filePath.endsWith(EXTENSION) ? result.filePath : `${result.filePath}${EXTENSION}`);
    return { path: writeTextFile(target, payload?.text) };
  });

  ipcMain.handle("peakcad:file-resolve-name", async (_event, defaultName) => {
    const dir = defaultProjectDir(app);
    const name = typeof defaultName === "string" ? defaultName : `Untitled design${EXTENSION}`;
    const target = path.join(dir, name.toLowerCase().endsWith(EXTENSION) ? name : `${name}${EXTENSION}`);
    if (!fs.existsSync(target)) return null;
    return readTextFile(target);
  });

  ipcMain.handle("peakcad:file-write-new", async (_event, payload) => {
    const dir = defaultProjectDir(app);
    fs.mkdirSync(dir, { recursive: true });
    const name = typeof payload?.defaultName === "string" ? payload.defaultName : `Untitled design${EXTENSION}`;
    const target = uniquePath(path.join(dir, name.endsWith(EXTENSION) ? name : `${name}${EXTENSION}`));
    return { path: writeTextFile(target, payload?.text) };
  });

  ipcMain.handle("peakcad:file-reveal", async (_event, filePath) => {
    const resolved = normalizePeakcadPath(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error("That PeakCAD file is no longer on disk.");
    }
    shell.showItemInFolder(resolved);
  });
}

module.exports = {
  allowPath,
  defaultProjectDir,
  findPeakcadArg,
  isAllowlisted,
  readTextFile,
  registerProjectFileIpc,
};
