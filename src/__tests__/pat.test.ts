import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodePatRefresh,
  encodePatRefresh,
  exchangeJobToken,
  fetchUserInfo,
  isPatRefresh,
  PAT_REFRESH_PREFIX,
} from "../auth/pat.js";
import { loadLiveFixture, responseFromFixture } from "./live-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPatRefresh", () => {
  it("returns true for PAT refresh strings", () => {
    expect(isPatRefresh("pat|mytoken|refresh123|user1|machine1")).toBe(true);
  });

  it("returns true for minimal PAT prefix", () => {
    expect(isPatRefresh("pat|")).toBe(true);
  });

  it("returns false for non-PAT refresh strings", () => {
    expect(isPatRefresh("some-other-refresh-token")).toBe(false);
    expect(isPatRefresh("refresh|user|machine")).toBe(false);
    expect(isPatRefresh("")).toBe(false);
  });
});

describe("encodePatRefresh / decodePatRefresh roundtrip", () => {
  it("encodes and decodes correctly", () => {
    const encoded = encodePatRefresh("pt-abc123", "jrt-xyz", "user-42", "machine-7");
    expect(encoded).toBe("pat|pt-abc123|jrt-xyz|user-42|machine-7");
    expect(decodePatRefresh(encoded)).toEqual({
      pat: "pt-abc123",
      jobRefreshToken: "jrt-xyz",
      userID: "user-42",
      machineID: "machine-7",
    });
  });

  it("handles empty fields", () => {
    const encoded = encodePatRefresh("", "", "", "");
    expect(encoded).toBe("pat||||");
    expect(decodePatRefresh(encoded)).toEqual({
      pat: "",
      jobRefreshToken: "",
      userID: "",
      machineID: "",
    });
  });
});

describe("PAT_REFRESH_PREFIX", () => {
  it('is "pat"', () => {
    expect(PAT_REFRESH_PREFIX).toBe("pat");
  });
});

describe("recorded-format PAT protocol fixtures", () => {
  const fixture = loadLiveFixture();

  it("replays PAT exchange response shape", async () => {
    const interaction = fixture.interactions.patExchange;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromFixture(interaction)));

    const result = await exchangeJobToken("test-pat");

    expect(result.jobToken).toBe("<redacted:job-token>");
    expect(result.jobRefreshToken).toBe("<redacted:refresh-token>");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(fetch).toHaveBeenCalledWith(
      interaction.request.url,
      expect.objectContaining({
        method: interaction.request.method,
        headers: expect.objectContaining({
          "Cosy-Version": interaction.request.headers["cosy-version"],
        }),
      }),
    );
  });

  it("replays userinfo response shape", async () => {
    const interaction = fixture.interactions.userinfo;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromFixture(interaction)));
    const body = interaction.response.body as { id: string; email: string; name: string };

    await expect(fetchUserInfo("test-job-token")).resolves.toEqual({
      userID: body.id,
      email: body.email,
      name: body.name,
    });
  });
});
