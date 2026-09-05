import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoLoginFromEnvironment,
  getCachedCredentials,
  resolveQoderIdentity,
  saveCredentialsToAuthFile,
} from "../auth/credentials.js";
import { credentialsFromPat, fetchUserInfo } from "../auth/pat.js";
import { updateQoderModelsCache } from "../catalog.js";
import { getPatFromEnvironment } from "../config.js";
import { loadLiveFixture } from "./live-fixture.js";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

vi.mock("../auth/pat.js", () => ({
  credentialsFromPat: vi.fn().mockResolvedValue({
    access: "mock-access-token",
    refresh: "mock-refresh-token",
    expires: Date.now() + 3600000,
    userID: "mock-user-123",
    email: "test@example.com",
    name: "Test User",
    machineID: "mock-machine-id",
    type: "oauth",
  }),
  isPatRefresh: vi.fn().mockReturnValue(false),
  decodePatRefresh: vi.fn(),
  fetchUserInfo: vi.fn().mockResolvedValue({
    userID: "new-user",
    email: "new@example.com",
    name: "New User",
  }),
}));

vi.mock("../catalog.js", () => ({
  updateQoderModelsCache: vi.fn().mockResolvedValue(undefined),
  getCachedModels: vi.fn().mockReturnValue([]),
  isCacheStale: vi.fn().mockReturnValue(true),
  staticModels: [],
}));

describe("oauth autoLoginFromEnvironment", () => {
  const originalEnv = process.env;
  let originalAuth: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    originalAuth = existsSync(AUTH_FILE) ? readFileSync(AUTH_FILE, "utf8") : undefined;
  });

  afterEach(() => {
    process.env = originalEnv;
    if (originalAuth === undefined) rmSync(AUTH_FILE, { force: true });
    else writeFileSync(AUTH_FILE, originalAuth, "utf8");
  });

  it("extracts PAT from documented env names", () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-123";
    expect(getPatFromEnvironment()).toBe("pt-global-123");
  });

  it("preserves other providers while writing environment credentials", () => {
    writeFileSync(
      AUTH_FILE,
      JSON.stringify({ other: { type: "api_key", key: "keep-me" } }),
      { encoding: "utf8", mode: 0o600 },
    );

    saveCredentialsToAuthFile({ access: "qoder-access", refresh: "qoder-refresh", expires: Date.now() + 3600000 });

    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    expect(auth.other.key).toBe("keep-me");
    expect(auth.qoder.access).toBe("qoder-access");
  });

  it("refuses to overwrite malformed shared auth storage", () => {
    writeFileSync(AUTH_FILE, "{malformed", { encoding: "utf8", mode: 0o600 });

    expect(() =>
      saveCredentialsToAuthFile({ access: "qoder-access", refresh: "qoder-refresh", expires: Date.now() + 3600000 }),
    ).toThrow("without overwriting Pi auth storage");
    expect(readFileSync(AUTH_FILE, "utf8")).toBe("{malformed");
  });

  it("does nothing if no PAT in environment", async () => {
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    delete process.env.QODER_API_KEY;
    delete process.env.QODER_PAT;

    await autoLoginFromEnvironment();
    expect(getCachedCredentials("qoder-test-provider")).toBeNull();
  });

  it("re-exchanges an environment PAT even when cached credentials exist", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global-new-account";
    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
    auth.qoder = {
      type: "oauth",
      access: "old-access-token",
      refresh: "old-refresh-token",
      expires: Date.now() + 3600000,
      userID: "old-user",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");

    await autoLoginFromEnvironment();

    expect(credentialsFromPat).toHaveBeenCalledWith("pt-global-new-account", undefined);
    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "mock-access-token",
      "mock-user-123",
      "Test User",
      "test@example.com",
      undefined,
    );
  });

  it("does not reuse identity metadata from a different access token", async () => {
    const auth = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {};
    auth.qoder = {
      type: "oauth",
      access: "old-access-token",
      refresh: "old-refresh-token",
      expires: Date.now() + 3600000,
      userID: "old-user",
      email: "old@example.com",
      name: "Old User",
      machineID: "old-machine",
    };
    writeFileSync(AUTH_FILE, JSON.stringify(auth), "utf8");

    const resolved = await resolveQoderIdentity("new-access-token");

    expect(fetchUserInfo).toHaveBeenCalledWith("new-access-token", undefined);
    expect(resolved.userID).toBe("new-user");
    expect(resolved.access).toBe("new-access-token");
  });

  it("passes a recorded-format identity into the model catalog refresh", async () => {
    const identity = loadLiveFixture().interactions.userinfo.response.body as {
      id: string;
      email: string;
      name: string;
    };
    vi.mocked(credentialsFromPat).mockResolvedValueOnce({
      access: "<redacted:job-token>",
      refresh: "<redacted:refresh-token>",
      expires: Date.now() + 3600000,
      userID: identity.id,
      email: identity.email,
      name: identity.name,
      machineID: "<redacted:machine-id>",
      type: "oauth",
    } as never);
    process.env.QODER_PAT = "test-only-pat";

    await autoLoginFromEnvironment();

    expect(updateQoderModelsCache).toHaveBeenCalledWith(
      "<redacted:job-token>",
      identity.id,
      identity.name,
      identity.email,
      undefined,
    );
  });
});
