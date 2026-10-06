import { describe, expect, it } from "vitest";
import { decryptPeakcadText, encryptPeakcadText, isEncryptedPeakcadText } from "@/lib/peakcadFileLock";

const TEST_ITERATIONS = 1_000;

describe("peakcad file password", () => {
  it("hides the project text and opens it again with the same password", async () => {
    const plain = `${JSON.stringify({
      format: "peakcad",
      version: 1,
      project: { id: "proj-1", name: "Secret movement" },
      shapes: [{ id: "jewel-hole", type: "box" }],
    })}\n`;
    const locked = await encryptPeakcadText(plain, "folder-secret", { iterations: TEST_ITERATIONS });

    expect(isEncryptedPeakcadText(locked)).toBe(true);
    expect(locked.includes("Secret movement")).toBe(false);
    expect(locked.includes("jewel-hole")).toBe(false);
    expect(locked.includes("folder-secret")).toBe(false);
    await expect(decryptPeakcadText(locked, "folder-secret")).resolves.toBe(plain);
  });

  it("rejects a different password", async () => {
    const locked = await encryptPeakcadText('{"format":"peakcad"}\n', "correct", { iterations: TEST_ITERATIONS });
    await expect(decryptPeakcadText(locked, "wrong")).rejects.toThrow(/wrong password/i);
    await expect(decryptPeakcadText(locked, "")).rejects.toThrow(/wrong password/i);
  });

  it("leaves an ordinary project file unmarked", () => {
    expect(isEncryptedPeakcadText('{"format":"peakcad","version":1,"project":{}}\n')).toBe(false);
  });
});
