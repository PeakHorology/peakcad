import { promises as fs } from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { readBoundedRequestJson } from "@/lib/requestBody";

export const revalidate = false;

const THUMBNAIL_DIR = path.join(process.cwd(), ".codex", "project-thumbnails");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const MAX_THUMBNAIL_REQUEST_BYTES = Math.ceil((MAX_THUMBNAIL_BYTES * 4) / 3) + PNG_DATA_URL_PREFIX.length + 2048;

function safeProjectId(projectId: string) {
  const clean = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
  return clean || null;
}

function thumbnailPath(projectId: string, theme: "light" | "dark" = "light") {
  const safeId = safeProjectId(projectId);
  if (!safeId) {
    return null;
  }
  return path.join(THUMBNAIL_DIR, theme === "dark" ? `${safeId}.dark.png` : `${safeId}.png`);
}

function parseTheme(value: string | null): "light" | "dark" {
  return value === "dark" ? "dark" : "light";
}

function isLocalSameOriginRequest(request: Request) {
  const requestUrl = new URL(request.url);
  if (!LOCAL_HOSTS.has(requestUrl.hostname)) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (!LOCAL_HOSTS.has(originUrl.hostname) || originUrl.port !== requestUrl.port || originUrl.protocol !== requestUrl.protocol) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "same-site" || fetchSite === "none";
}

function decodedBase64ByteLength(value: string) {
  if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

/**
 * Ceiling on cached thumbnail files (two per project, light and dark).
 *
 * Nothing else ever collects these: a thumbnail is only removed when its project is explicitly
 * deleted, so a long-lived install kept growing this directory without bound. Dropping the
 * least-recently-written entries is safe because the dashboard regenerates any it cannot read.
 */
const MAX_THUMBNAIL_FILES = 400;

async function pruneThumbnailCache() {
  let names: string[];
  try {
    names = await fs.readdir(THUMBNAIL_DIR);
  } catch {
    return;
  }
  if (names.length <= MAX_THUMBNAIL_FILES) return;

  const stamped = await Promise.all(names.map(async (name) => {
    const filePath = path.join(THUMBNAIL_DIR, name);
    try {
      return { filePath, modifiedAt: (await fs.stat(filePath)).mtimeMs };
    } catch {
      return null;
    }
  }));
  const oldestFirst = stamped
    .filter((entry): entry is { filePath: string; modifiedAt: number } => entry !== null)
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
  const excess = oldestFirst.length - MAX_THUMBNAIL_FILES;
  await Promise.all(oldestFirst.slice(0, excess).map((entry) => fs.rm(entry.filePath, { force: true }).catch(() => {})));
}

async function writePngDataUrl(filePath: string, dataUrl: string) {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("Invalid thumbnail image");
  }
  const encodedImage = dataUrl.slice(PNG_DATA_URL_PREFIX.length);
  const decodedBytes = decodedBase64ByteLength(encodedImage);
  if (decodedBytes === null) {
    throw new Error("Invalid thumbnail image");
  }
  if (decodedBytes > MAX_THUMBNAIL_BYTES) {
    throw new Error("Thumbnail image is too large");
  }
  await fs.rm(filePath, { force: true });
  await fs.writeFile(filePath, Buffer.from(encodedImage, "base64"));
}

export async function GET(request: Request) {
  if (!isLocalSameOriginRequest(request)) {
    return new NextResponse("Project thumbnails are only available from this localhost app", { status: 403 });
  }

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const theme = parseTheme(url.searchParams.get("theme"));
  const preferredPath = thumbnailPath(projectId, theme);
  const fallbackPath = theme === "dark" ? thumbnailPath(projectId, "light") : null;
  if (!preferredPath) {
    return new NextResponse("Invalid project id", { status: 400 });
  }

  try {
    const image = await fs.readFile(preferredPath);
    return new NextResponse(image, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "image/png",
        "X-PeakCAD-Thumbnail-Theme": theme,
      },
    });
  } catch {
    if (fallbackPath) {
      try {
        const image = await fs.readFile(fallbackPath);
        return new NextResponse(image, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "image/png",
            "X-PeakCAD-Thumbnail-Theme": "light",
          },
        });
      } catch {
        // Fall through to 404.
      }
    }
    return new NextResponse("Thumbnail not found", { status: 404 });
  }
}

export async function POST(request: Request) {
  if (!isLocalSameOriginRequest(request)) {
    return NextResponse.json({ error: "Project thumbnails are only available from this localhost app" }, { status: 403 });
  }

  // Both a light and a dark data URL can arrive together, so allow for two images plus the envelope.
  const parsed = await readBoundedRequestJson<{ dataUrl?: unknown; dataUrlDark?: unknown; projectId?: unknown }>(
    request,
    MAX_THUMBNAIL_REQUEST_BYTES * 2,
  );
  if (!parsed.ok) {
    return parsed.reason === "too-large"
      ? NextResponse.json({ error: "Thumbnail image is too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid thumbnail request" }, { status: 400 });
  }
  const body = parsed.value;

  try {
    if (typeof body.projectId !== "string" || typeof body.dataUrl !== "string") {
      return NextResponse.json({ error: "Invalid thumbnail request" }, { status: 400 });
    }

    const lightPath = thumbnailPath(body.projectId, "light");
    const darkPath = thumbnailPath(body.projectId, "dark");
    if (!lightPath || !darkPath) {
      return NextResponse.json({ error: "Invalid thumbnail image" }, { status: 400 });
    }

    await fs.mkdir(THUMBNAIL_DIR, { recursive: true });
    await writePngDataUrl(lightPath, body.dataUrl);
    if (typeof body.dataUrlDark === "string" && body.dataUrlDark.startsWith(PNG_DATA_URL_PREFIX)) {
      await writePngDataUrl(darkPath, body.dataUrlDark);
    }
    await pruneThumbnailCache();

    return NextResponse.json({ version: Date.now() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save thumbnail" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!isLocalSameOriginRequest(request)) {
    return NextResponse.json({ error: "Project thumbnails are only available from this localhost app" }, { status: 403 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  const lightPath = thumbnailPath(projectId, "light");
  const darkPath = thumbnailPath(projectId, "dark");
  if (!lightPath || !darkPath) {
    return NextResponse.json({ error: "Invalid project id" }, { status: 400 });
  }

  await fs.rm(lightPath, { force: true });
  await fs.rm(darkPath, { force: true });
  return NextResponse.json({ deleted: true });
}
