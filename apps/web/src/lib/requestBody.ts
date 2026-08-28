/**
 * Read a request body as text, abandoning it as soon as it exceeds `limit` bytes.
 *
 * `request.json()` buffers the whole body first, so a size check on the parsed result cannot stop a
 * caller from making the server hold an arbitrarily large payload in memory. A declared
 * content-length can also lie under chunked encoding, so the running total is the real guard.
 *
 * Returns `null` when the limit is exceeded.
 */
export async function readBoundedRequestText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

/** Parse a bounded JSON body. `null` means the body was oversized or not valid JSON. */
export async function readBoundedRequestJson<T>(request: Request, limit: number): Promise<
  { ok: true; value: T } | { ok: false; reason: "too-large" | "invalid" }
> {
  const text = await readBoundedRequestText(request, limit);
  if (text === null) return { ok: false, reason: "too-large" };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
