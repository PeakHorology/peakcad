const { app, BrowserWindow, nativeImage, shell } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

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

function staticRoot() {
  return path.join(app.getAppPath(), "apps", "web", ".next-export");
}

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function resolveRequestPath(urlPath) {
  const root = staticRoot();
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const relative = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const candidate = path.join(root, relative);

  if (!candidate.startsWith(root)) {
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
    autoHideMenuBar: true,
    backgroundThrottling: false,
    webPreferences: {
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
    void mainWindow?.webContents.executeJavaScript("window.peakcadDesktop = true;");
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

  mainWindow.loadURL(`http://${HOST}:${port}/`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
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
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === "win32") {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    }
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

app.on("before-quit", () => {
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
