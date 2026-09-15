import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { getCachedCredentials, saveCredentialsToAuthFile } from "../auth/credentials.js";
import { getCachedModels, updateQoderModelsCache } from "../catalog.js";
import { getMachineId } from "../cosy.js";

it("uses PI_CODING_AGENT_DIR for credential round-trips, catalog and machine id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-custom-dir-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    chat: [{ key: "custom", enable: true, display_name: "Custom" }],
  }))));
  try {
    const credentials = { access: "test", refresh: "refresh", expires: Date.now() + 1000, userID: "user" };
    saveCredentialsToAuthFile(credentials);
    expect(getCachedCredentials()).toMatchObject(credentials);
    expect(existsSync(join(dir, "auth.json"))).toBe(true);
    expect(getMachineId()).toBe(readFileSync(join(dir, "qoder-machine-id"), "utf8"));
    await updateQoderModelsCache("test", "user", "name", "email");
    expect(existsSync(join(dir, "qoder-models-cache.json"))).toBe(true);
    expect(getCachedModels().map((model) => model.id)).toEqual(["Custom"]);
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
});
