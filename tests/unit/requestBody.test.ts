import { describe, expect, it } from "vitest";
import { readBoundedRequestJson, readBoundedRequestText } from "@/lib/requestBody";

/** Request whose body arrives in chunks, optionally lying about its content-length. */
function chunkedRequest(chunks: string[], declaredLength?: string): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const headers = new Headers();
  if (declaredLength !== undefined) headers.set("content-length", declaredLength);
  return { headers, body: stream } as unknown as Request;
}

describe("readBoundedRequestText", () => {
  it("returns a body inside the limit", async () => {
    await expect(readBoundedRequestText(chunkedRequest(["hello ", "world"]), 100)).resolves.toBe("hello world");
  });

  it("rejects on the declared content-length before reading", async () => {
    await expect(readBoundedRequestText(chunkedRequest(["x"], "999999"), 100)).resolves.toBeNull();
  });

  it("rejects a body that exceeds the limit despite an understated content-length", async () => {
    // The whole point: a lying or absent content-length must not get past the guard.
    const chunks = Array.from({ length: 50 }, () => "y".repeat(10));
    await expect(readBoundedRequestText(chunkedRequest(chunks, "5"), 100)).resolves.toBeNull();
  });

  it("stops reading rather than buffering the whole oversized body", async () => {
    let chunksRead = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(encoder.encode("z".repeat(64)));
        if (chunksRead > 1000) controller.close();
      },
    });
    const request = { headers: new Headers(), body: stream } as unknown as Request;
    await expect(readBoundedRequestText(request, 128)).resolves.toBeNull();
    expect(chunksRead).toBeLessThan(10);
  });

  it("treats a missing body as empty", async () => {
    const request = { headers: new Headers(), body: null } as unknown as Request;
    await expect(readBoundedRequestText(request, 100)).resolves.toBe("");
  });

  it("does not split a multi-byte character across chunks", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("café");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    const request = { headers: new Headers(), body: stream } as unknown as Request;
    await expect(readBoundedRequestText(request, 100)).resolves.toBe("café");
  });
});

describe("readBoundedRequestJson", () => {
  it("parses a bounded JSON body", async () => {
    const result = await readBoundedRequestJson<{ a: number }>(chunkedRequest(['{"a":', "1}"]), 100);
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it("distinguishes oversized from malformed", async () => {
    await expect(readBoundedRequestJson(chunkedRequest(["{"], "999999"), 100)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
    await expect(readBoundedRequestJson(chunkedRequest(["not json"]), 100)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
