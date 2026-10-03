export const FOLDER_PASSWORD_ALGORITHM = "pbkdf2-sha256" as const;
export const FOLDER_PASSWORD_ITERATIONS = 120_000;

const FOLDER_PASSWORD_HASH_BYTES = 32;
const FOLDER_PASSWORD_SALT_BYTES = 16;
const MIN_FOLDER_PASSWORD_ITERATIONS = 1_000;
const MAX_FOLDER_PASSWORD_ITERATIONS = 600_000;

export type FolderPasswordLock = {
  algorithm: typeof FOLDER_PASSWORD_ALGORITHM;
  iterations: number;
  salt: string;
  hash: string;
};

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

export function parseFolderPasswordLock(value: unknown): FolderPasswordLock | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<FolderPasswordLock>;
  if (record.algorithm !== FOLDER_PASSWORD_ALGORITHM) return null;
  if (typeof record.iterations !== "number" || !Number.isInteger(record.iterations)) return null;
  if (record.iterations < MIN_FOLDER_PASSWORD_ITERATIONS || record.iterations > MAX_FOLDER_PASSWORD_ITERATIONS) return null;
  if (typeof record.salt !== "string" || typeof record.hash !== "string") return null;
  const salt = base64ToBytes(record.salt);
  const hash = base64ToBytes(record.hash);
  if (!salt || salt.length < FOLDER_PASSWORD_SALT_BYTES) return null;
  if (!hash || hash.length !== FOLDER_PASSWORD_HASH_BYTES) return null;
  return {
    algorithm: FOLDER_PASSWORD_ALGORITHM,
    iterations: record.iterations,
    salt: record.salt,
    hash: record.hash,
  };
}

/** A password-protected folder lists its projects only inside that folder. */
export function folderKeepsProjectsInside(folder: { passwordLock?: unknown } | null | undefined): boolean {
  return parseFolderPasswordLock(folder?.passwordLock) !== null;
}

/**
 * True when the project belongs to a password-protected folder.
 * Session unlock does not change this: those projects stay out of Recents,
 * the root list, and search outside the folder until the password is removed.
 */
export function projectStaysInsideFolder(
  project: { folderId?: string | null },
  folders: readonly { id: string; passwordLock?: unknown }[],
): boolean {
  if (!project.folderId) return false;
  const folder = folders.find((item) => item.id === project.folderId);
  return folderKeepsProjectsInside(folder);
}

async function deriveFolderPasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("Password lock is unavailable");
  }
  const key = await subtle.importKey("raw", asBufferSource(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: asBufferSource(salt), iterations },
    key,
    FOLDER_PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashFolderPassword(password: string, options?: { iterations?: number }): Promise<FolderPasswordLock> {
  if (typeof password !== "string" || password.trim().length === 0) {
    throw new Error("Password cannot be empty");
  }
  const iterations = options?.iterations ?? FOLDER_PASSWORD_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_FOLDER_PASSWORD_ITERATIONS || iterations > MAX_FOLDER_PASSWORD_ITERATIONS) {
    throw new Error("Password lock iterations are out of range");
  }
  const salt = new Uint8Array(FOLDER_PASSWORD_SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);
  const hash = await deriveFolderPasswordHash(password, salt, iterations);
  return {
    algorithm: FOLDER_PASSWORD_ALGORITHM,
    iterations,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash),
  };
}

export async function verifyFolderPassword(password: string, lock: FolderPasswordLock): Promise<boolean> {
  const parsed = parseFolderPasswordLock(lock);
  if (!parsed || typeof password !== "string" || password.trim().length === 0) return false;
  const salt = base64ToBytes(parsed.salt);
  if (!salt) return false;
  const actual = await deriveFolderPasswordHash(password, salt, parsed.iterations);
  const expected = base64ToBytes(parsed.hash);
  if (!expected) return false;
  return timingSafeEqual(actual, expected);
}
