import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  isWritablePeakcadPath,
  normalizePeakcadPath,
} = require("../../electron/peakcadPath.cjs") as {
  isWritablePeakcadPath: (filePath: string, defaultDir: string, allowed: Set<string>) => boolean;
  normalizePeakcadPath: (filePath: string) => string;
};
const {
  allowPath,
  isAllowlisted,
  readTextFile,
} = require("../../electron/projectFile.cjs") as {
  allowPath: (filePath: string) => string;
  isAllowlisted: (filePath: string) => boolean;
  readTextFile: (filePath: string) => { path: string; text: string };
};

const defaultDir = path.join("C:", "Users", "docs", "PeakCAD");

describe("normalizePeakcadPath", () => {
  it("requires a .peakcad extension", () => {
    expect(() => normalizePeakcadPath(path.join(defaultDir, "notes.txt"))).toThrow(/extension/);
  });
});

describe("isWritablePeakcadPath", () => {
  it("allows files under the default PeakCAD documents folder", () => {
    const target = path.join(defaultDir, "hub.peakcad");
    expect(isWritablePeakcadPath(target, defaultDir, new Set())).toBe(true);
  });

  it("rejects a sibling folder until the user picks it in a dialog", () => {
    const outsider = path.join("C:", "Users", "docs", "Other", "secret.peakcad");
    expect(isWritablePeakcadPath(outsider, defaultDir, new Set())).toBe(false);
  });

  it("allows a path only after it is explicitly allowlisted", () => {
    const outsider = path.join("C:", "Users", "docs", "Other", "picked.peakcad");
    const allowed = new Set([path.resolve(outsider).toLowerCase()]);
    expect(isWritablePeakcadPath(outsider, defaultDir, allowed)).toBe(true);
  });
});

describe("readTextFile", () => {
  it("does not grant write after a file is read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peakcad-read-"));
    const file = path.join(dir, "opened.peakcad");
    fs.writeFileSync(file, "{\"name\":\"demo\"}", "utf8");
    try {
      expect(readTextFile(file).text).toContain("demo");
      expect(isAllowlisted(file)).toBe(false);
      expect(isWritablePeakcadPath(file, defaultDir, new Set())).toBe(false);
      allowPath(file);
      expect(isAllowlisted(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
