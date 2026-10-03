import { describe, expect, it } from "vitest";
import {
  folderKeepsProjectsInside,
  hashFolderPassword,
  parseFolderPasswordLock,
  projectStaysInsideFolder,
  verifyFolderPassword,
} from "@/lib/folderLock";

const TEST_ITERATIONS = 1_000;

describe("folder password lock", () => {
  it("stores a salted hash and not the password", async () => {
    const password = "watch-case-secret";
    const lock = await hashFolderPassword(password, { iterations: TEST_ITERATIONS });
    const encoded = JSON.stringify(lock);

    expect(lock.algorithm).toBe("pbkdf2-sha256");
    expect(lock.iterations).toBe(TEST_ITERATIONS);
    expect(encoded.includes(password)).toBe(false);
    expect(Object.keys(lock).sort()).toEqual(["algorithm", "hash", "iterations", "salt"]);
    expect(parseFolderPasswordLock(lock)).toEqual(lock);
  });

  it("rejects an empty password", async () => {
    await expect(hashFolderPassword("")).rejects.toThrow(/empty/i);
    await expect(hashFolderPassword("   ")).rejects.toThrow(/empty/i);
  });

  it("accepts the password that was set and rejects a different one", async () => {
    const lock = await hashFolderPassword("correct-horse", { iterations: TEST_ITERATIONS });
    await expect(verifyFolderPassword("correct-horse", lock)).resolves.toBe(true);
    await expect(verifyFolderPassword("wrong-horse", lock)).resolves.toBe(false);
    await expect(verifyFolderPassword("", lock)).resolves.toBe(false);
  });

  it("uses a fresh salt so the same password does not produce the same record", async () => {
    const first = await hashFolderPassword("same-password", { iterations: TEST_ITERATIONS });
    const second = await hashFolderPassword("same-password", { iterations: TEST_ITERATIONS });
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    await expect(verifyFolderPassword("same-password", first)).resolves.toBe(true);
    await expect(verifyFolderPassword("same-password", second)).resolves.toBe(true);
  });

  it("ignores a folder record with no password", () => {
    expect(parseFolderPasswordLock(undefined)).toBeNull();
    expect(parseFolderPasswordLock({ algorithm: "plain", hash: "secret" })).toBeNull();
    expect(folderKeepsProjectsInside({ id: "folder-1", name: "Shop" })).toBe(false);
    expect(folderKeepsProjectsInside(null)).toBe(false);
  });

  it("keeps projects inside a passworded folder even when the caller does not pass an unlock flag", async () => {
    const lock = await hashFolderPassword("bench-lock", { iterations: TEST_ITERATIONS });
    const folders = [
      { id: "open-folder", name: "Open" },
      { id: "private-folder", name: "Private", passwordLock: lock },
    ];
    const loose = { id: "design-a", folderId: "open-folder" };
    const home = { id: "design-b", folderId: null };
    const hidden = { id: "design-c", folderId: "private-folder" };

    expect(projectStaysInsideFolder(loose, folders)).toBe(false);
    expect(projectStaysInsideFolder(home, folders)).toBe(false);
    expect(projectStaysInsideFolder(hidden, folders)).toBe(true);
    expect(folderKeepsProjectsInside(folders[1])).toBe(true);
  });
});
