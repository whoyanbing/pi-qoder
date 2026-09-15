import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, readResponseTextLimited } from "../network.js";

describe("readResponseTextLimited", () => {
  it("cancels an unending body at the byte cap instead of draining it", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024).fill(65)); },
      cancel,
    }));
    expect(await readResponseTextLimited(response, 8)).toBe("AAAAAAAA");
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(2);
    expect(response.body?.locked).toBe(false);
  });

  it("counts UTF-8 bytes and preserves characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("汉😀字");
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        controller.enqueue(bytes.subarray(4));
        controller.close();
      },
    }));
    const text = await readResponseTextLimited(response, 8);
    expect(text).toBe("汉😀");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8);
    expect(await readResponseTextLimited(new Response("short"), 16)).toBe("short");
    expect(await readResponseTextLimited(new Response("unused"), 0)).toBe("");
  });

  it("does not turn a failed body read into an empty success", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("cancelled")); } }));
    await expect(readResponseTextLimited(response)).rejects.toThrow("cancelled");
  });
});

describe("fetchWithTimeout", () => {
  it("aborts a request that exceeds its deadline", async () => {
    const fetch = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason || new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    await expect(
      fetchWithTimeout("https://example.invalid", {}, { fetch, timeoutMs: 5, label: "test request" }),
    ).rejects.toThrow("test request timed out");
  });

  it("keeps the deadline active while the response body is being read", async () => {
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason || new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    });

    const response = await fetchWithTimeout(
      "https://example.invalid",
      {},
      { fetch, timeoutMs: 5, label: "body request" },
    );
    await expect(response.text()).rejects.toThrow("body request timed out");
  });

  it("respects a caller abort signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    const fetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response("ok");
    });

    await expect(
      fetchWithTimeout("https://example.invalid", {}, { fetch, signal: controller.signal }),
    ).rejects.toThrow("cancelled by caller");
  });
});
