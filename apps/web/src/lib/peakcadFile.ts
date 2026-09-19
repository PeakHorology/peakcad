import {
  PEAKCAD_FILE_EXTENSION,
  peakcadFilename,
  serializePeakcadDocument,
  parsePeakcadDocument,
  type PeakcadDocument,
} from "@/lib/peakcadDocument";
import { downloadTextFile } from "@/lib/downloadFile";

export type PeakcadFileApi = {
  isDesktop?: boolean;
  defaultDir?: () => Promise<string | null>;
  open?: () => Promise<{ path: string; text: string } | null>;
  read?: (filePath: string) => Promise<{ path: string; text: string }>;
  write?: (payload: { path: string; text: string }) => Promise<{ path: string }>;
  saveAs?: (payload: { text: string; defaultName: string }) => Promise<{ path: string } | null>;
  writeNew?: (payload: { text: string; defaultName: string }) => Promise<{ path: string } | null>;
  resolveName?: (defaultName: string) => Promise<{ path: string; text: string } | null>;
  reveal?: (filePath: string) => Promise<void>;
  onOpenPath?: (listener: (filePath: string) => void) => () => void;
  onMenu?: (listener: (action: PeakcadMenuAction) => void) => () => void;
};

export type PeakcadMenuAction = "new" | "open" | "save" | "save-as";

export type OpenedPeakcadFile = {
  document: PeakcadDocument;
  path: string | null;
};

function fileApi(): PeakcadFileApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { peakcadFile?: PeakcadFileApi }).peakcadFile;
}

export function hasDesktopProjectFiles() {
  return Boolean(fileApi()?.isDesktop && fileApi()?.open && fileApi()?.write);
}

function pickBrowserFile() {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${PEAKCAD_FILE_EXTENSION},application/json`;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

export async function openPeakcadFile(): Promise<OpenedPeakcadFile | null> {
  const desktop = fileApi();
  if (desktop?.open) {
    const result = await desktop.open();
    if (!result) return null;
    return { document: parsePeakcadDocument(result.text), path: result.path };
  }
  const file = await pickBrowserFile();
  if (!file) return null;
  const text = await file.text();
  return { document: parsePeakcadDocument(text), path: null };
}

export async function readPeakcadPath(filePath: string): Promise<OpenedPeakcadFile> {
  const desktop = fileApi();
  if (!desktop?.read) {
    throw new Error("Opening a file path is only available in the PeakCAD desktop app.");
  }
  const result = await desktop.read(filePath);
  return { document: parsePeakcadDocument(result.text), path: result.path };
}

export async function writePeakcadPath(filePath: string, document: PeakcadDocument) {
  const desktop = fileApi();
  if (!desktop?.write) {
    throw new Error("Saving to a file path is only available in the PeakCAD desktop app.");
  }
  await desktop.write({ path: filePath, text: serializePeakcadDocument(document) });
}

export async function savePeakcadAs(document: PeakcadDocument, suggestedName: string): Promise<string | null> {
  const text = serializePeakcadDocument(document);
  const defaultName = peakcadFilename(suggestedName);
  const desktop = fileApi();
  if (desktop?.saveAs) {
    const result = await desktop.saveAs({ text, defaultName });
    return result?.path ?? null;
  }
  await downloadTextFile(defaultName, text, "application/json");
  return null;
}

export async function resolveDesktopPeakcadByName(suggestedName: string): Promise<OpenedPeakcadFile | null> {
  const desktop = fileApi();
  if (!desktop?.resolveName) return null;
  const result = await desktop.resolveName(peakcadFilename(suggestedName));
  if (!result) return null;
  return { document: parsePeakcadDocument(result.text), path: result.path };
}

export async function writeNewDesktopPeakcad(document: PeakcadDocument, suggestedName: string): Promise<string | null> {
  const desktop = fileApi();
  if (!desktop?.writeNew) return null;
  const result = await desktop.writeNew({
    text: serializePeakcadDocument(document),
    defaultName: peakcadFilename(suggestedName),
  });
  return result?.path ?? null;
}

export async function revealPeakcadFile(filePath: string) {
  const desktop = fileApi();
  if (!desktop?.reveal) return;
  await desktop.reveal(filePath);
}

export function subscribePeakcadOpenPath(listener: (filePath: string) => void) {
  return fileApi()?.onOpenPath?.(listener);
}

export function subscribePeakcadMenu(listener: (action: PeakcadMenuAction) => void) {
  return fileApi()?.onMenu?.(listener);
}
