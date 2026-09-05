import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../network.js";

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
