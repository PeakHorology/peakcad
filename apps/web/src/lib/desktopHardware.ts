/**
 * Desktop / high-end hardware profile.
 * SketchForge shipped with browser-safe caps; PeakCAD raises them in Electron
 * and on capable machines so CAD work can use the GPU and multi-core CPU.
 */

export type HardwareProfile = {
  desktop: boolean;
  highEnd: boolean;
  /** 0 = use native devicePixelRatio with no cap */
  maxPixelRatio: number;
  preserveDrawingBuffer: boolean;
  shadowMapSize: number;
  maxAnisotropy: number;
  maxTextureSide: number;
  booleanTriangleLimit: number;
  importedEdgeTriangleLimit: number;
  historyEntries: number;
  historyBytes: number;
  sketchHistoryEntries: number;
  thumbnailSize: number;
  modifierTimeoutMs: number;
  cadWorkerCount: number;
  maxShapeSides: number;
  maxSvgBytes: number;
  maxSvgTriangles: number;
  maxEdgesPerPart: number;
  maxLocalDownloadBytes: number;
};

function readNavigatorMemoryGb() {
  if (typeof navigator === "undefined") return 0;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof memory === "number" && Number.isFinite(memory) ? memory : 0;
}

function readStaticExportFlag() {
  // Important: do NOT read `process.env.NEXT_PUBLIC_*` with a static property access.
  // Next rewrites those to a main-thread `_N_E` global that does not exist in Workers,
  // which crashes CAD worker startup with `ReferenceError: _N_E is not defined`.
  try {
    if (typeof process === "undefined" || !process.env) return false;
    const env = process.env as Record<string, string | undefined>;
    const key = ["NEXT_PUBLIC", "STATIC_EXPORT"].join("_");
    return env[key] === "true";
  } catch {
    return false;
  }
}

const DESKTOP_SHELL_STORAGE_KEY = "peakcad.desktopShell";

/**
 * True when running inside PeakCAD's own desktop shell.
 *
 * `window.peakcadDesktop` is injected only once the page has finished loading, yet the hardware
 * profile is read while modules initialise — so that flag is not set at the moment it is needed and
 * detection fell through to user-agent sniffing, which is both spoofable and breaks if the shell
 * ever changes its UA. The shell therefore also opens the app with a `shell=desktop` marker that is
 * readable from the first frame, remembered for the session because client-side navigation drops the
 * query string.
 */
export function isDesktopShell() {
  if (typeof window === "undefined") return readStaticExportFlag();
  if (Boolean((window as Window & { peakcadDesktop?: boolean }).peakcadDesktop)) return true;
  try {
    if (new URLSearchParams(window.location.search).get("shell") === "desktop") {
      window.sessionStorage.setItem(DESKTOP_SHELL_STORAGE_KEY, "1");
      return true;
    }
    if (window.sessionStorage.getItem(DESKTOP_SHELL_STORAGE_KEY) === "1") return true;
  } catch {
    // No storage or an opaque location; fall through to the heuristic.
  }
  // Retained for shells that predate the marker.
  if (typeof navigator !== "undefined" && /\bElectron\b/i.test(navigator.userAgent)) return true;
  return readStaticExportFlag();
}

export function getHardwareProfile(): HardwareProfile {
  const desktop = isDesktopShell();
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  const memoryGb = readNavigatorMemoryGb() || (desktop ? 16 : 4);
  const highEnd = desktop || cores >= 8 || memoryGb >= 8;

  if (!highEnd) {
    return {
      desktop,
      highEnd: false,
      maxPixelRatio: 2,
      preserveDrawingBuffer: false,
      shadowMapSize: 2048,
      maxAnisotropy: 4,
      maxTextureSide: 2048,
      booleanTriangleLimit: 150_000,
      importedEdgeTriangleLimit: 40_000,
      historyEntries: 100,
      historyBytes: 64 * 1024 * 1024,
      sketchHistoryEntries: 100,
      thumbnailSize: 640,
      modifierTimeoutMs: 30_000,
      cadWorkerCount: 1,
      maxShapeSides: 512,
      maxSvgBytes: 2 * 1024 * 1024,
      maxSvgTriangles: 200_000,
      maxEdgesPerPart: 6_000,
      maxLocalDownloadBytes: 25 * 1024 * 1024,
    };
  }

  return {
    desktop,
    highEnd: true,
    // Cap HiDPI fill-rate; uncapped 4K soft shadows were too expensive for static CAD scenes.
    maxPixelRatio: 2,
    preserveDrawingBuffer: false,
    shadowMapSize: 2048,
    maxAnisotropy: 16,
    maxTextureSide: 8192,
    booleanTriangleLimit: 2_000_000,
    importedEdgeTriangleLimit: 400_000,
    historyEntries: 250,
    historyBytes: 512 * 1024 * 1024,
    sketchHistoryEntries: 250,
    thumbnailSize: 1280,
    modifierTimeoutMs: 180_000,
    // One primary + at most one warm spare (spares do not take jobs).
    cadWorkerCount: 2,
    maxShapeSides: 1024,
    maxSvgBytes: 32 * 1024 * 1024,
    maxSvgTriangles: 2_000_000,
    maxEdgesPerPart: 40_000,
    maxLocalDownloadBytes: 512 * 1024 * 1024,
  };
}

let cachedProfile: HardwareProfile | null = null;

export function hardwareProfile() {
  if (typeof window === "undefined") {
    return getHardwareProfile();
  }
  cachedProfile ??= getHardwareProfile();
  return cachedProfile;
}

export function resolvePixelRatio(devicePixelRatio: number) {
  const cap = hardwareProfile().maxPixelRatio;
  if (!cap || cap <= 0) return Math.max(1, devicePixelRatio);
  return Math.min(Math.max(1, devicePixelRatio), cap);
}
