export type ProjectExportFormat = "stl" | "obj" | "step" | "3mf" | "pdf" | "dxf" | "svg";

/** Windows refuses these as filenames whatever the extension, e.g. "CON.stl". */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function projectExportFileName(projectName: string, format: ProjectExportFormat) {
  const safeProjectName = projectName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  if (!safeProjectName) {
    return `PeakCAD design.${format}`;
  }
  const usableName = WINDOWS_RESERVED_NAMES.test(safeProjectName) ? `${safeProjectName}-design` : safeProjectName;
  return `${usableName}.${format}`;
}
