import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { NextResponse } from "next/server";
import { readBoundedRequestJson } from "@/lib/requestBody";

export const revalidate = false;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MAX_LOCAL_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/**
 * The only formats this endpoint exists to write (see ProjectExportFormat). The destination
 * folder is caller-supplied, so without this list any local process could drop an executable
 * or script anywhere the app user can write.
 */
const ALLOWED_EXPORT_EXTENSIONS = new Set([".stl", ".obj", ".step", ".stp", ".3mf", ".pdf", ".dxf", ".svg"]);

/** Directories where a dropped file runs on login. Exports never belong in them. */
const AUTO_RUN_DIRECTORIES = [
  path.join("microsoft", "windows", "start menu", "programs", "startup"),
  path.join("library", "launchagents"),
  path.join(".config", "autostart"),
];

/**
 * Ceiling on the raw request body, allowing for base64 inflation plus the JSON envelope.
 *
 * The byte-length check below only runs after the body has already been decoded, so on its own it
 * cannot stop a caller from having the server buffer an arbitrarily large payload first.
 */
const MAX_REQUEST_BODY_BYTES = Math.ceil((MAX_LOCAL_DOWNLOAD_BYTES * 4) / 3) + 64 * 1024;

function safeFileName(filename: string) {
  const base = path.basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return base || "download.txt";
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Exports may land in the user's own files, never in a system or auto-run location. */
function isPermittedTarget(targetPath: string) {
  const roots = [os.homedir(), os.tmpdir(), process.cwd()]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.resolve(root));
  if (!roots.some((root) => isInside(root, targetPath))) {
    return false;
  }
  const normalized = targetPath.toLowerCase().split(path.sep).join(path.sep);
  return !AUTO_RUN_DIRECTORIES.some((directory) => normalized.includes(directory));
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
      if (originUrl.origin !== requestUrl.origin || !LOCAL_HOSTS.has(originUrl.hostname)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

export async function POST(request: Request) {
  try {
    if (!isLocalSameOriginRequest(request)) {
      return NextResponse.json({ error: "Local folder downloads are only available from this localhost app" }, { status: 403 });
    }

    const parsed = await readBoundedRequestJson<{
      content?: unknown;
      filename?: unknown;
      folder?: unknown;
      encoding?: unknown;
    }>(request, MAX_REQUEST_BODY_BYTES);
    if (!parsed.ok) {
      return parsed.reason === "too-large"
        ? NextResponse.json({ error: "File is too large for local folder download" }, { status: 413 })
        : NextResponse.json({ error: "Invalid download request" }, { status: 400 });
    }
    const body = parsed.value;
    if (typeof body.content !== "string" || typeof body.filename !== "string" || typeof body.folder !== "string") {
      return NextResponse.json({ error: "Invalid download request" }, { status: 400 });
    }

    const encoding = body.encoding === "base64" ? "base64" : "utf8";
    const fileBytes =
      encoding === "base64" ? Buffer.from(body.content, "base64") : Buffer.from(body.content, "utf8");

    if (fileBytes.byteLength > MAX_LOCAL_DOWNLOAD_BYTES) {
      return NextResponse.json({ error: "File is too large for local folder download" }, { status: 413 });
    }

    const trimmedFolder = body.folder.trim();
    if (!trimmedFolder) {
      return NextResponse.json({ error: "Choose a folder first" }, { status: 400 });
    }

    const fileName = safeFileName(body.filename);
    if (!ALLOWED_EXPORT_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
      return NextResponse.json({ error: "That file type cannot be saved to a folder" }, { status: 400 });
    }

    const targetDirectory = path.resolve(path.isAbsolute(trimmedFolder) ? trimmedFolder : path.join(process.cwd(), trimmedFolder));
    const targetPath = path.resolve(targetDirectory, fileName);
    if (!isInside(targetDirectory, targetPath)) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
    }
    // Validate before creating anything: mkdir -p on an unchecked path is itself a write.
    if (!isPermittedTarget(targetPath)) {
      return NextResponse.json({ error: "Choose a folder inside your home directory" }, { status: 403 });
    }

    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.writeFile(targetPath, fileBytes);

    return NextResponse.json({ path: targetPath });
  } catch {
    // Deliberately opaque: the message would otherwise disclose absolute paths and
    // filesystem layout to whatever made the request.
    return NextResponse.json({ error: "Could not save file" }, { status: 500 });
  }
}
