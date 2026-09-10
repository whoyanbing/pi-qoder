import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCachedModelConfig, getCachedModels, updateQoderModelsCache } from "../catalog.js";
import { loadLiveFixture, responseFromFixture } from "./live-fixture.js";

const CACHE_PATH = join(homedir(), ".pi", "agent", "qoder-models-cache.json");
let originalCache: string | undefined;

beforeEach(() => {
  originalCache = existsSync(CACHE_PATH) ? readFileSync(CACHE_PATH, "utf8") : undefined;
  rmSync(CACHE_PATH, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCache === undefined) rmSync(CACHE_PATH, { force: true });
  else writeFileSync(CACHE_PATH, originalCache, "utf8");
});

describe("Qoder model cache", () => {
  it("maps the recorded-format catalog to friendly picker ids", async () => {
    const interaction = loadLiveFixture().interactions.modelList;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFromFixture(interaction)));

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["Lite", "GLM5.2"]);
    const catalog = interaction.response.body as { chat: Array<{ key: string; display_name: string }> };
    for (const entry of catalog.chat) {
      const friendlyId = entry.display_name.replace(/\s+/g, "");
      expect(cache.configs[friendlyId]?.key).toBe(entry.key);
      expect(cache.configs[entry.key]).toBeUndefined();
      expect(getCachedModelConfig(friendlyId)?.key).toBe(entry.key);
      // case-insensitive fallback: raw key resolves to same entry
      expect(getCachedModelConfig(entry.key)?.key).toBe(entry.key);
    }
  });

  it("does not register raw live-catalog keys as public model ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "lite", enable: true, display_name: "Lite" },
              { key: "qfmodel", enable: true, display_name: "Qwen3.8-Flash" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com");

    expect(getCachedModels().map((model) => model.id)).toEqual(["Lite", "Qwen3.8-Flash"]);
    expect(getCachedModelConfig("Lite")?.key).toBe("lite");
    expect(getCachedModelConfig("Qwen3.8-Flash")?.key).toBe("qfmodel");
    // case-insensitive fallback keeps raw keys usable
    expect(getCachedModelConfig("lite")?.key).toBe("lite");
    expect(getCachedModelConfig("qfmodel")?.key).toBe("qfmodel");
  });

  it("omits catalog entries without a friendly display name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "q37fmodel", enable: true },
              { key: "qfmodel", enable: true, display_name: "Qwen3.8-Flash" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com");

    expect(getCachedModels().map((model) => model.id)).toEqual(["Qwen3.8-Flash"]);
    expect(getCachedModelConfig("q37fmodel")).toBeNull();
  });

  it("keeps only enabled service models without adding auto as a fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              { key: "auto", enable: false, display_name: "Auto" },
              { key: "ultimate", enable: true, display_name: "Ultimate", is_reasoning: true },
              { key: "lite", enable: true, display_name: "Lite" },
              { key: "performance", enable: false, display_name: "Performance" },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["Ultimate", "Lite"]);
    expect(cache.models.some((model: { id: string }) => model.id === "auto")).toBe(false);
  });

  it("keeps the Cantus model returned by the current catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chat: [{ key: "cmodel", enable: true, display_name: "Cantus" }] }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models.map((model: { id: string }) => model.id)).toEqual(["Cantus"]);
  });

  it("filters auto from a legacy fallback cache when the service did not enable it", () => {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({
        updatedAt: Date.now(),
        models: [{ id: "auto" }, { id: "ultimate" }],
        configs: { ultimate: { key: "ultimate", enable: true } },
      }),
      "utf8",
    );

    expect(getCachedModels().map((model) => model.id)).toEqual(["Ultimate"]);
  });

  it("records max_input_tokens when the catalog omits context_config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [{ key: "lite", enable: true, display_name: "Lite", max_input_tokens: 180000 }],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models[0].contextWindow).toBe(180_000);
  });

  it("records the advertised context_config max, even when it is below 1M", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            chat: [
              {
                key: "gm51model",
                enable: true,
                display_name: "GLM 5.2",
                context_config: { default: { token_count: 200000, is_default: true } },
              },
            ],
          }),
      }),
    );

    await updateQoderModelsCache("access-token", "user-id", "Test User", "test@example.com");

    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    expect(cache.models[0].contextWindow).toBe(200000);
  });
});
