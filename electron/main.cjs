const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { allowPath, findPeakcadArg, registerProjectFileIpc } = require("./projectFile.cjs");

const HOST = "127.0.0.1";
const APP_PORT = 48173;
const SESSION_PARTITION = "persist:peakcad";
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const APP_USER_MODEL_ID = "com.peakhorology.peakcad";

// Prefer discrete GPU and keep CAD workers/RAF alive when the window is occluded.
app.commandLine.appendSwitch("force_high_performance_gpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
if (process.platform === "win32") {
  app.commandLine.appendSwitch("enable-features", "CanvasOopRasterization");
}

// Must match package.json build.appId so Windows taskbar pins use PeakCAD's icon/name.
if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}
app.setName("PeakCAD");

let server = null;
let mainWindow = null;
function grantOpenPath(filePath) {
  if (!filePath) return null;
  try {
    return allowPath(filePath);
  } catch {
    return filePath;
  }
}

let pendingOpenPath = grantOpenPath(findPeakcadArg(process.argv));

/** License files ship in resources/ when packaged; from source they live in the repo and the staged legal folder. */
function legalFilePath(name) {
  if (app.isPackaged) {
    return name === "LICENSE.txt" ? path.join(process.resourcesPath, "LICENSE.txt") : path.join(process.resourcesPath, "legal", name);
  }
  const repoRoot = path.join(__dirname, "..");
  return name === "LICENSE.txt" ? path.join(repoRoot, "LICENSE") : path.join(repoRoot, "apps", "web", "public", "legal", name);
}

function openLegalFile(name) {
  const filePath = legalFilePath(name);
  if (!fs.existsSync(filePath)) {
    dialog.showErrorBox("PeakCAD", `Could not find ${name}. Reinstall PeakCAD to restore the license files.`);
    return;
  }
  void shell.openPath(filePath);
}

function showAboutDialog() {
  const options = {
    type: "info",
    title: "About PeakCAD",
    message: `PeakCAD ${app.getVersion()}`,
    detail: [
      "Copyright © PeakHorologyLLC",
      "",
      "PeakCAD is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.",
      "",
      "PeakCAD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.",
      "",
      "PeakCAD includes OpenCascade Technology (LGPL-2.1 with the Open CASCADE exception) and other third-party components under their own licenses.",
    ].join("\n"),
    buttons: ["OK", "View License", "Third-Party Notices"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const pending = mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
  void pending.then(({ response }) => {
    if (response === 1) openLegalFile("LICENSE.txt");
    else if (response === 2) openLegalFile("THIRD-PARTY-NOTICES.txt");
  });
}

function installFileMenu() {
  const sendMenu = (action) => {
    mainWindow?.webContents.send("peakcad:menu", action);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          { label: "New design", accelerator: "CmdOrCtrl+N", click: () => sendMenu("new") },
          { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => sendMenu("open") },
          { type: "separator" },
          { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendMenu("save") },
          { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendMenu("save-as") },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: "About PeakCAD", click: () => showAboutDialog() },
          { type: "separator" },
          { label: "License (GPL-3.0-or-later)", click: () => openLegalFile("LICENSE.txt") },
          { label: "Third-Party Notices", click: () => openLegalFile("THIRD-PARTY-NOTICES.txt") },
          { label: "Source Code Offer", click: () => openLegalFile("SOURCE-OFFER.txt") },
        ],
      },
    ]),
  );
}

function staticRoot() {
  return path.join(app.getAppPath(), "apps", "web", ".next-export");
}

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function resolveRequestPath(urlPath) {
  const root = path.resolve(staticRoot());
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const relative = normalized.replace(/^[/\\]+/, "");
  const candidate = path.resolve(root, relative);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    return null;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    const indexPath = path.join(candidate, "index.html");
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  const htmlPath = `${candidate}.html`;
  if (fs.existsSync(htmlPath)) {
    return htmlPath;
  }

  const fallback = path.join(root, "index.html");
  return fs.existsSync(fallback) ? fallback : null;
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const instance = http.createServer((request, response) => {
      const filePath = resolveRequestPath(request.url ?? "/");
      if (!filePath) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        // COOP/COEP unlock SharedArrayBuffer for multi-threaded WASM when available.
        response.writeHead(200, {
          "Content-Type": contentType(filePath),
          "Content-Length": stats.size,
          "Cache-Control": filePath.includes(`${path.sep}_next${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "credentialless",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
        // Stream large assets (especially .wasm) instead of buffering the whole file.
        const stream = fs.createReadStream(filePath);
        stream.on("error", () => {
          if (!response.headersSent) {
            response.writeHead(404);
          }
          response.end("Not found");
        });
        stream.pipe(response);
      });
    });

    instance.listen(APP_PORT, HOST, () => {
      const address = instance.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not start local static server"));
        return;
      }
      resolve({ instance, port: address.port });
    });

    instance.on("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        reject(new Error(`PeakCAD could not bind ${HOST}:${APP_PORT}. Close any other PeakCAD instance and try again.`));
        return;
      }
      reject(error);
    });
  });
}

function appIconPath() {
  const candidates = [
    path.join(process.resourcesPath, "icon.ico"),
    path.join(process.resourcesPath, "app-icon.ico"),
    path.join(__dirname, "icon.ico"),
    path.join(path.dirname(process.execPath), "icon.ico"),
    path.join(__dirname, "..", "build", "icon.ico"),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function appIconImage() {
  const iconPath = appIconPath();
  if (!iconPath) {
    return undefined;
  }

  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? undefined : image;
}

/** Schemes it is reasonable to hand to the operating system from page content. */
const EXTERNALLY_OPENABLE_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

function isExternallyOpenable(url) {
  try {
    return EXTERNALLY_OPENABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isAppUrl(url, appOrigin) {
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

let saveBeforeCloseRequestId = 0;

/**
 * Runs the renderer's explicit Save (exact-STEP bake + project persist) and resolves whether it
 * succeeded. Resolves false if the page goes away before answering.
 */
function requestRendererSave(window) {
  return new Promise((resolve) => {
    const contents = window.webContents;
    saveBeforeCloseRequestId += 1;
    const requestId = saveBeforeCloseRequestId;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("peakcad:save-before-close-result", onResult);
      contents.removeListener("render-process-gone", onGone);
      contents.removeListener("destroyed", onGone);
      contents.removeListener("did-start-loading", onGone);
      resolve(ok);
    };
    const onResult = (event, id, ok) => {
      if (event.sender !== contents || id !== requestId) return;
      finish(ok === true);
    };
    const onGone = () => finish(false);
    ipcMain.on("peakcad:save-before-close-result", onResult);
    contents.on("render-process-gone", onGone);
    contents.on("destroyed", onGone);
    contents.on("did-start-loading", onGone);
    contents.send("peakcad:save-before-close", requestId);
  });
}

function createWindow(port) {
  const iconPath = appIconPath();
  const icon = appIconImage();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "PeakCAD",
    icon: iconPath ?? icon,
    autoHideMenuBar: false,
    backgroundThrottling: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SESSION_PARTITION,
      backgroundThrottling: false,
      v8CacheOptions: "code",
      enableWebSQL: false,
    },
  });

  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingOpenPath && mainWindow) {
      mainWindow.webContents.send("peakcad:open-path", pendingOpenPath);
      pendingOpenPath = null;
    }
  });

  const window = mainWindow;
  let closeRequested = false;
  let saveBeforeCloseInFlight = false;
  // "close" fires before the page's beforeunload, so this tells a window close apart from a reload.
  window.on("close", () => {
    closeRequested = true;
  });

  // Electron shows no prompt for a page's beforeunload veto; without this the window just refuses to close.
  // The page only vetoes while it has unsaved changes, so a clean project closes without asking.
  window.webContents.on("will-prevent-unload", (event) => {
    const closing = closeRequested;
    closeRequested = false;
    // A Save started from this dialog is still running; stay open until it finishes.
    if (saveBeforeCloseInFlight) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      buttons: ["Save", "Don't save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: "PeakCAD",
      message: closing ? "Save changes before closing?" : "Save changes before reloading?",
      detail: "The model is autosaved, but exact STEP for new imports is only kept when you save.",
    });
    if (choice === 1) {
      event.preventDefault();
      return;
    }
    if (choice !== 0) return;
    saveBeforeCloseInFlight = true;
    void requestRendererSave(window).then((ok) => {
      saveBeforeCloseInFlight = false;
      if (!ok || window.isDestroyed()) return;
      // destroy() skips beforeunload: bodies whose exact STEP could not be baked would otherwise ask again.
      if (closing) window.destroy();
      else window.webContents.reload();
    });
  });

  if (icon) {
    mainWindow.setIcon(icon);
  }

  // Makes pinned taskbar shortcuts use PeakCAD's ICO instead of Electron's default.
  if (process.platform === "win32" && typeof mainWindow.setAppDetails === "function") {
    const details = {
      appId: APP_USER_MODEL_ID,
      relaunchDisplayName: "PeakCAD",
      relaunchCommand: `"${process.execPath}"`,
    };
    if (iconPath) {
      details.appIconPath = iconPath;
      details.appIconIndex = 0;
    }
    try {
      mainWindow.setAppDetails(details);
    } catch (error) {
      console.warn("PeakCAD could not set Windows app details for taskbar icon:", error);
    }
  }

  const appOrigin = `http://${HOST}:${port}`;
  // The marker is readable by the first script that runs; the injected window.peakcadDesktop flag
  // below only lands after load, which is too late for hardware profiling done at module init.
  mainWindow.loadURL(`${appOrigin}/?shell=desktop`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Hand the OS only the schemes a browser would follow. shell.openExternal on an arbitrary
    // scheme (file:, smb:, or any registered custom handler) can launch a local program, and the
    // URL here comes from page content such as an imported SVG.
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Keep the window on the local app. Without this the page could navigate the whole window to
  // remote content, which would then be running inside the app's own session partition.
  const blockOffAppNavigation = (event, url) => {
    if (isAppUrl(url, appOrigin)) return;
    event.preventDefault();
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url);
    }
  };
  mainWindow.webContents.on("will-navigate", blockOffAppNavigation);
  mainWindow.webContents.on("will-frame-navigate", (event) => {
    blockOffAppNavigation(event, event.url);
  });
  mainWindow.webContents.on("will-attach-webview", (event) => {
    // Nothing in PeakCAD embeds a webview; one appearing is not something to render.
    event.preventDefault();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  if (!fs.existsSync(staticRoot())) {
    throw new Error(`Static build not found at ${staticRoot()}. Run "npm run export" first.`);
  }

  const { instance, port } = await startStaticServer();
  server = instance;
  createWindow(port);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const opened = findPeakcadArg(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (opened) {
        mainWindow.webContents.send("peakcad:open-path", grantOpenPath(opened));
      }
    } else if (opened) {
      pendingOpenPath = grantOpenPath(opened);
    }
  });

  app.whenReady().then(() => {
    if (process.platform === "win32") {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    }
    registerProjectFileIpc(app, () => mainWindow);
    installFileMenu();
    return bootstrap();
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Not before-quit: that fires before the window's unsaved-changes prompt, which can cancel the quit
// (Cancel) or keep the window open while Save runs, and the page still needs its asset server then.
app.on("will-quit", () => {
  if (server) {
    server.close();
    server = null;
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) {
    const address = server.address();
    if (address && typeof address !== "string") {
      createWindow(address.port);
    }
  }
});
