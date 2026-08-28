export type DownloadResult = { mode: "browser" } | { mode: "folder"; path: string };

export const DOWNLOAD_FOLDER_STORAGE_KEY = "sketchForge.downloadFolder";

const STATIC_EXPORT_BUILD = process.env.NEXT_PUBLIC_STATIC_EXPORT === "true";

function triggerBrowserDownload(filename: string, content: BlobPart, type: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function saveToFolder(filename: string, content: string, encoding?: "base64"): Promise<DownloadResult> {
  const folder = window.localStorage.getItem(DOWNLOAD_FOLDER_STORAGE_KEY)?.trim() ?? "";
  if (STATIC_EXPORT_BUILD || !folder) {
    return { mode: "browser" };
  }
  const response = await fetch("/api/local-download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, filename, folder, ...(encoding ? { encoding } : {}) }),
  });
  const payload = (await response.json().catch(() => null)) as { error?: string; path?: string } | null;
  if (!response.ok || !payload?.path) {
    throw new Error(payload?.error ?? "Could not save export");
  }
  return { mode: "folder", path: payload.path };
}

export async function downloadTextFile(filename: string, content: string, type: string): Promise<DownloadResult> {
  const folderResult = await saveToFolder(filename, content);
  if (folderResult.mode === "folder") {
    return folderResult;
  }
  triggerBrowserDownload(filename, content, type);
  return { mode: "browser" };
}

export async function downloadBlobFile(filename: string, bytes: Uint8Array, type: string): Promise<DownloadResult> {
  const folderResult = await saveToFolder(filename, bytesToBase64(bytes), "base64");
  if (folderResult.mode === "folder") {
    return folderResult;
  }
  const copy = Uint8Array.from(bytes);
  triggerBrowserDownload(filename, new Blob([copy.buffer], { type }), type);
  return { mode: "browser" };
}
