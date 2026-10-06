import { FOLDER_PASSWORD_ITERATIONS } from "@/lib/folderLock";

export const PEAKCAD_FILE_LOCK = "aes-256-gcm" as const;
const PEAKCAD_FILE_KDF = "pbkdf2-sha256";
const PEAKCAD_FILE_SALT_BYTES = 16;
const PEAKCAD_FILE_IV_BYTES = 12;
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 600_000;

type PeakcadFileEnvelope = {
  format: "peakcad";
  version: 1;
  lock: typeof PEAKCAD_FILE_LOCK;
  kdf: typeof PEAKCAD_FILE_KDF;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
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

const encryptKeyCache = new Map<string, { salt: Uint8Array; key: CryptoKey; iterations: number }>();

function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("Password protection is unavailable");
  }
  return subtle;
}

export function isEncryptedPeakcadText(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  const head = raw.slice(0, 240);
  return head.includes(`"lock":"${PEAKCAD_FILE_LOCK}"`);
}

function readEnvelope(raw: string): PeakcadFileEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("This is not a valid PeakCAD file.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("This is not a valid PeakCAD file.");
  }
  const record = parsed as Partial<PeakcadFileEnvelope>;
  if (record.format !== "peakcad" || record.lock !== PEAKCAD_FILE_LOCK || record.kdf !== PEAKCAD_FILE_KDF) {
    throw new Error("This PeakCAD file is not password protected.");
  }
  if (typeof record.iterations !== "number" || !Number.isInteger(record.iterations)) {
    throw new Error("This PeakCAD file is not password protected.");
  }
  if (record.iterations < MIN_ITERATIONS || record.iterations > MAX_ITERATIONS) {
    throw new Error("This PeakCAD file is not password protected.");
  }
  if (typeof record.salt !== "string" || typeof record.iv !== "string" || typeof record.ciphertext !== "string") {
    throw new Error("This PeakCAD file is not password protected.");
  }
  return record as PeakcadFileEnvelope;
}

async function deriveFileKey(password: string, salt: Uint8Array, iterations: number) {
  const subtle = subtleCrypto();
  const base = await subtle.importKey("raw", asBufferSource(new TextEncoder().encode(password)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: asBufferSource(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a serialized `.peakcad` document. The password is not stored in the file. */
export async function encryptPeakcadText(plain: string, password: string, options?: { iterations?: number }): Promise<string> {
  if (typeof password !== "string" || password.trim().length === 0) {
    throw new Error("Password cannot be empty");
  }
  const iterations = options?.iterations ?? FOLDER_PASSWORD_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error("Password lock iterations are out of range");
  }
  const iv = new Uint8Array(PEAKCAD_FILE_IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  let cached = encryptKeyCache.get(password);
  if (!cached || cached.iterations !== iterations) {
    const salt = new Uint8Array(PEAKCAD_FILE_SALT_BYTES);
    globalThis.crypto.getRandomValues(salt);
    cached = { salt, key: await deriveFileKey(password, salt, iterations), iterations };
    encryptKeyCache.set(password, cached);
  }
  const { salt, key } = cached;
  const ciphertext = new Uint8Array(
    await subtleCrypto().encrypt({ name: "AES-GCM", iv: asBufferSource(iv) }, key, asBufferSource(new TextEncoder().encode(plain))),
  );
  const envelope: PeakcadFileEnvelope = {
    format: "peakcad",
    version: 1,
    lock: PEAKCAD_FILE_LOCK,
    kdf: PEAKCAD_FILE_KDF,
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
  return `${JSON.stringify(envelope)}\n`;
}

/** Decrypt a password-protected `.peakcad` file. A wrong password throws. */
export async function decryptPeakcadText(raw: string, password: string): Promise<string> {
  if (typeof password !== "string" || password.trim().length === 0) {
    throw new Error("Wrong password.");
  }
  const envelope = readEnvelope(raw);
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (!salt || !iv || !ciphertext) {
    throw new Error("This PeakCAD file is not password protected.");
  }
  try {
    const key = await deriveFileKey(password, salt, envelope.iterations);
    const plain = await subtleCrypto().decrypt({ name: "AES-GCM", iv: asBufferSource(iv) }, key, asBufferSource(ciphertext));
    return new TextDecoder().decode(plain);
  } catch (error) {
    if (error instanceof Error && error.message === "Password protection is unavailable") throw error;
    throw new Error("Wrong password.");
  }
}
