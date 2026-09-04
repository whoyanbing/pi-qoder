import { describe, expect, it } from "vitest";
import {
  contextWindowFromCatalog,
  DEFAULT_CONTEXT_WINDOW,
  getCachedModelConfig,
  staticModels,
  toQoderModelId,
  ZERO_COST,
} from "../catalog.js";

describe("staticModels", () => {
  it("is a non-empty global catalog", () => {
    expect(staticModels.length).toBeGreaterThan(0);
    expect(staticModels[0].id).toBe("Auto");
  });

  it("every model has required fields and unique ids", () => {
    const ids = staticModels.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of staticModels) {
      expect(m.id).toBeTruthy();
      expect(m.name).toBeTruthy();
      expect(m.api).toBe("qoder-api");
      expect(m.provider).toBe("qoder");
      expect(m.baseUrl).toBe("https://api3.qoder.sh/");
      expect(typeof m.reasoning).toBe("boolean");
      expect(typeof m.supportsEffort).toBe("boolean");
      expect(Array.isArray(m.input)).toBe(true);
      expect(m.cost).toBe(ZERO_COST);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
      expect(m.id).toBe(toQoderModelId(m.name));
      expect(m.id).not.toBe(m.upstreamKey);
    }
  });

  it("uses a 1M context window for models confirmed to support it", () => {
    for (const key of ["auto", "efficient", "lite", "gmodel"]) {
      const model = staticModels.find((m) => m.upstreamKey === key);
      expect(model, key).toBeDefined();
      expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  });

  it("keeps kmodel at the catalog-advertised 256K window", () => {
    expect(staticModels.find((m) => m.upstreamKey === "kmodel")?.contextWindow).toBe(256000);
  });

  it("maps friendly ids to static upstream keys without raw-key aliases", () => {
    expect(getCachedModelConfig("Lite")?.key).toBe("lite");
    expect(getCachedModelConfig("Qwen3.8-Max")?.key).toBe("qmodel_38max");
    expect(getCachedModelConfig("lite")).toBeNull();
    expect(getCachedModelConfig("qmodel_38max")).toBeNull();
  });
});

describe("contextWindowFromCatalog", () => {
  it("uses the largest advertised context_config token_count", () => {
    expect(
      contextWindowFromCatalog({
        context_config: {
          small: { token_count: 200000 },
          large: { token_count: 1000000, is_default: true },
        },
      }),
    ).toBe(1000000);
  });

  it("keeps an advertised 200K window instead of the 1M fallback", () => {
    expect(
      contextWindowFromCatalog({
        context_config: { default: { token_count: 200000, is_default: true } },
      }),
    ).toBe(200000);
  });

  it("falls back to 1M when the catalog omits context_config", () => {
    expect(contextWindowFromCatalog({ key: "lite", max_input_tokens: 180000 })).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe("toQoderModelId", () => {
  it("strips whitespace from catalog display names", () => {
    expect(toQoderModelId("Qwen3.8-Flash")).toBe("Qwen3.8-Flash");
    expect(toQoderModelId("Qwen 3.8 Max")).toBe("Qwen3.8Max");
    expect(toQoderModelId()).toBe("QoderModel");
    expect(toQoderModelId("")).toBe("QoderModel");
  });
});

describe("ZERO_COST", () => {
  it("is frozen zeros", () => {
    expect(ZERO_COST).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(Object.isFrozen(ZERO_COST)).toBe(true);
  });
});
