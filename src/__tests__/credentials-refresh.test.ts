import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshQoderToken } from "../auth/credentials.js";
import { encodePatRefresh } from "../auth/pat.js";

const baseCredentials: OAuthCredentials = {
  access: "expired-access",
  refresh: "refresh-token|user-1|machine-1",
  expires: Date.now() - 1000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshQoderToken", () => {
  it("throws on OAuth refresh failure instead of extending an expired token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401, statusText: "Unauthorized" })),
    );

    await expect(refreshQoderToken(baseCredentials)).rejects.toThrow("Qoder OAuth refresh failed: 401");
  });

  it("throws on PAT re-exchange failure instead of extending an expired token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("revoked", { status: 401, statusText: "Unauthorized" })),
    );
    const credentials: OAuthCredentials = {
      ...baseCredentials,
      refresh: encodePatRefresh("pt-revoked", "job-refresh", "user-1", "machine-1"),
    };

    await expect(refreshQoderToken(credentials)).rejects.toThrow("Qoder PAT refresh failed");
  });

  it("interprets OAuth refresh expires_in as seconds", async () => {
    const before = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token: "new-access", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const refreshed = await refreshQoderToken(baseCredentials);

    // One hour minus the five-minute safety margin.
    expect(refreshed.expires).toBeGreaterThanOrEqual(before + 54 * 60 * 1000);
    expect(refreshed.expires).toBeLessThanOrEqual(Date.now() + 56 * 60 * 1000);
  });

  it("honors cancellation before making a refresh request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel refresh"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(refreshQoderToken(baseCredentials, controller.signal)).rejects.toThrow("cancel refresh");
    expect(fetch).not.toHaveBeenCalled();
  });
});
