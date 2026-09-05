import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  MODEL_CACHE_FILE,
  MODEL_CACHE_TTL_MS,
  PROVIDER_ID,
  QODER_API,
  QODER_BASE_URL,
  ZERO_COST,
  getModelListURL,
} from "./config.js";
import { buildAuthHeaders } from "./cosy.js";
import { fetchWithTimeout } from "./network.js";

export { DEFAULT_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, ZERO_COST } from "./config.js";

export interface QoderModelEntry {
  key?: string;
  enable?: boolean;
  display_name?: string;
  max_input_tokens?: number;
  context_config?: Record<string, { token_count?: number; is_default?: boolean }>;
  is_vl?: boolean;
  is_reasoning?: boolean;
  thinking_config?: {
    disabled?: unknown;
    enabled?: { efforts?: Record<string, { is_default?: boolean }>; is_default?: boolean };
  };
  source?: string;
  [key: string]: unknown;
}

export interface QoderModelDef {
  id: string;
  upstreamKey?: string;
  name: string;
  api: typeof QODER_API;
  provider: typeof PROVIDER_ID;
  baseUrl: string;
  reasoning: boolean;
  supportsEffort: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
}

interface ModelCacheFile {
  updatedAt?: number;
  models?: QoderModelDef[];
  configs?: Record<string, QoderModelEntry>;
}

const PI_THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortMap(efforts: readonly string[], canDisable: boolean): ThinkingLevelMap {
  const supported = new Set(efforts);
  const map: ThinkingLevelMap = { off: canDisable ? "disabled" : null };
  for (const level of PI_THINKING_LEVELS) {
    map[level] = supported.has(level) ? level : null;
  }
  return map;
}

function toggleMap(canDisable: boolean): ThinkingLevelMap {
  const map: ThinkingLevelMap = { off: canDisable ? "disabled" : null };
  for (const level of PI_THINKING_LEVELS) map[level] = "enabled";
  return map;
}

function seed(partial: Omit<QoderModelDef, "api" | "provider" | "baseUrl" | "cost" | "maxTokens">): QoderModelDef {
  return {
    ...partial,
    api: QODER_API,
    provider: PROVIDER_ID,
    baseUrl: QODER_BASE_URL,
    cost: ZERO_COST,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
}

export const staticModels: QoderModelDef[] = [
  seed({
    id: "Auto",
    upstreamKey: "auto",
    name: "Auto",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Ultimate",
    upstreamKey: "ultimate",
    name: "Ultimate",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "medium", "high", "xhigh", "max"], true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Performance",
    upstreamKey: "performance",
    name: "Performance",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "medium", "high", "xhigh"], true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Efficient",
    upstreamKey: "efficient",
    name: "Efficient",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Lite",
    upstreamKey: "lite",
    name: "Lite",
    reasoning: false,
    supportsEffort: false,
    input: ["text"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Cantus",
    upstreamKey: "cmodel",
    name: "Cantus",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "medium", "high", "xhigh", "max"], false),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Qwen3.8-Max",
    upstreamKey: "qmodel_38max",
    name: "Qwen3.8-Max",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "medium", "xhigh"], true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Qwen3.8-Flash",
    upstreamKey: "qfmodel",
    name: "Qwen3.8-Flash",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "medium", "xhigh"], true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Qwen3.7-Max",
    upstreamKey: "qmodel_latest",
    name: "Qwen3.7-Max",
    reasoning: true,
    supportsEffort: false,
    thinkingLevelMap: toggleMap(true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Qwen3.7-Plus",
    upstreamKey: "qmodel",
    name: "Qwen3.7-Plus",
    reasoning: true,
    supportsEffort: false,
    thinkingLevelMap: toggleMap(true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Kimi-K3",
    upstreamKey: "kmodel_latest",
    name: "Kimi-K3",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "high", "max"], false),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "Kimi-K2.7-Code",
    upstreamKey: "kmodel",
    name: "Kimi-K2.7-Code",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: 256000,
  }),
  seed({
    id: "GLM-5.3",
    upstreamKey: "gmodel",
    name: "GLM-5.3",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "high", "max"], false),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "GLM-5.3-Flash",
    upstreamKey: "gfmodel",
    name: "GLM-5.3-Flash",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["high", "max"], false),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "DeepSeek-V4-Pro",
    upstreamKey: "dmodel",
    name: "DeepSeek-V4-Pro",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["high", "max"], true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "DeepSeek-V4-Flash",
    upstreamKey: "dfmodel",
    name: "DeepSeek-V4-Flash",
    reasoning: true,
    supportsEffort: true,
    thinkingLevelMap: effortMap(["low", "high", "max"], true),
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
  seed({
    id: "MiniMax-M3",
    upstreamKey: "mmodel",
    name: "MiniMax-M3",
    reasoning: false,
    supportsEffort: false,
    input: ["text", "image"],
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  }),
];

function getCachePath(): string {
  return join(homedir(), ".pi", "agent", MODEL_CACHE_FILE);
}

function readCacheFile(): ModelCacheFile | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as ModelCacheFile;
  } catch {
    return null;
  }
}

export function toQoderModelId(displayName?: string): string {
  return (displayName || "QoderModel").replace(/\s+/g, "");
}

export function buildThinkingLevelMap(entry: QoderModelEntry): ThinkingLevelMap | undefined {
  const tc = entry.thinking_config;
  if (!tc) return undefined;
  const efforts = tc.enabled?.efforts;
  if (efforts && typeof efforts === "object") {
    return effortMap(Object.keys(efforts), Boolean(tc.disabled));
  }
  if (tc.enabled) return toggleMap(Boolean(tc.disabled));
  return undefined;
}

export function contextWindowFromCatalog(entry: QoderModelEntry): number {
  const contextConfig = entry.context_config;
  if (contextConfig && typeof contextConfig === "object") {
    let advertised = 0;
    for (const configVal of Object.values(contextConfig)) {
      const count = configVal?.token_count;
      if (Number.isFinite(count) && count! > 0) advertised = Math.max(advertised, Math.floor(count!));
    }
    if (advertised > 0) return advertised;
  }
  if (Number.isFinite(entry.max_input_tokens) && entry.max_input_tokens! > 0) {
    return Math.floor(entry.max_input_tokens!);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

function withMaxContextAsDefault(entry: QoderModelEntry): QoderModelEntry {
  const contextConfig = entry.context_config;
  if (!contextConfig || typeof contextConfig !== "object") return entry;
  const maxTokenCount = Math.max(
    ...Object.values(contextConfig).map((config) => (typeof config?.token_count === "number" ? config.token_count : 0)),
  );
  if (maxTokenCount <= 0) return entry;
  return {
    ...entry,
    context_config: Object.fromEntries(
      Object.entries(contextConfig).map(([name, config]) => [
        name,
        { ...config, is_default: config.token_count === maxTokenCount },
      ]),
    ),
  };
}

export function getCachedModels(): QoderModelDef[] {
  const data = readCacheFile();
  if (data && Array.isArray(data.models)) {
    const models: QoderModelDef[] = data.models.map((model: QoderModelDef) => {
      const config = data.configs?.[model.id];
      const display = config?.display_name;
      const staticModel = staticModels.find((seedModel) => seedModel.upstreamKey === model.id);
      const normalized: QoderModelDef = {
        ...model,
        api: QODER_API,
        provider: PROVIDER_ID,
        baseUrl: QODER_BASE_URL,
      };
      if (display) return { ...normalized, id: toQoderModelId(display), name: display };
      if (staticModel) return { ...normalized, id: staticModel.id, name: staticModel.name };
      if (model.name) return { ...normalized, id: toQoderModelId(model.name) };
      return normalized;
    });
    if (data.configs && typeof data.configs === "object" && !data.configs.auto && !data.configs.Auto) {
      return models.filter((model) => model.id.toLowerCase() !== "auto");
    }
    return models;
  }
  return staticModels;
}

export function getCachedModelConfig(modelId: string): QoderModelEntry | null {
  const data = readCacheFile();
  if (data?.configs) {
    const direct = data.configs[modelId];
    if (direct && toQoderModelId(direct.display_name) === modelId) {
      return withMaxContextAsDefault(direct);
    }
    const legacyEntry = Object.values(data.configs).find(
      (entry) => entry && typeof entry === "object" && toQoderModelId(entry.display_name) === modelId,
    );
    if (legacyEntry) return withMaxContextAsDefault(legacyEntry);
  }

  const staticModel = staticModels.find((model) => model.id === modelId);
  if (staticModel) {
    return {
      key: staticModel.upstreamKey || modelId,
      is_reasoning: staticModel.reasoning,
      source: "system",
      thinking_config: staticModel.thinkingLevelMap
        ? {
            disabled: staticModel.thinkingLevelMap.off === "disabled" ? {} : undefined,
            enabled: staticModel.supportsEffort
              ? {
                  efforts: Object.fromEntries(
                    PI_THINKING_LEVELS.filter((level) => staticModel.thinkingLevelMap?.[level] === level).map((level) => [
                      level,
                      {},
                    ]),
                  ),
                }
              : {},
          }
        : undefined,
    };
  }
  return null;
}

export function isCacheStale(): boolean {
  const data = readCacheFile();
  if (!data || typeof data.updatedAt !== "number") return true;
  return Date.now() - data.updatedAt > MODEL_CACHE_TTL_MS;
}

export interface CatalogCacheInfo {
  count: number;
  updatedAt: number | null;
  ageSeconds: number;
  stale: boolean;
}

/** Summary of the on-disk model catalog cache for diagnostics. */
export function getCatalogCacheInfo(): CatalogCacheInfo {
  const data = readCacheFile();
  const count = data && Array.isArray(data.models) && data.models.length > 0 ? data.models.length : staticModels.length;
  const updatedAt = typeof data?.updatedAt === "number" ? data.updatedAt : null;
  const ageSeconds = updatedAt === null ? -1 : Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  return { count, updatedAt, ageSeconds, stale: isCacheStale() };
}

export function toProviderModels(models: QoderModelDef[] = getCachedModels()): ProviderModelConfig[] {
  return models.map(({ id, name, reasoning, thinkingLevelMap, input, cost, contextWindow, maxTokens }) => ({
    id,
    name,
    api: QODER_API,
    baseUrl: QODER_BASE_URL,
    reasoning,
    thinkingLevelMap,
    input,
    cost: { ...cost },
    contextWindow,
    maxTokens,
  }));
}

export async function updateQoderModelsCache(
  authToken: string,
  userID: string,
  name: string,
  email: string,
  signal?: AbortSignal,
): Promise<QoderModelDef[] | undefined> {
  const modelListURL = getModelListURL();
  let tempPath: string | undefined;
  try {
    const headers = buildAuthHeaders(null, modelListURL, { userID, authToken, name, email });
    const response = await fetchWithTimeout(
      modelListURL,
      {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
      },
      { signal, label: "Qoder model catalog request" },
    );
    if (!response.ok) return undefined;

    const resData = (await response.json()) as { chat?: QoderModelEntry[] };
    const chatModels = resData.chat || [];
    if (chatModels.length === 0) return undefined;

    const newModels: QoderModelDef[] = [];
    const configs: Record<string, QoderModelEntry> = {};

    for (const entry of chatModels) {
      const key = entry.key;
      if (!key || !entry.enable || !entry.display_name) continue;

      const display = entry.display_name;
      const modelId = toQoderModelId(display);
      const thinkingLevelMap = buildThinkingLevelMap(entry);
      configs[modelId] = entry;
      newModels.push({
        id: modelId,
        name: display,
        api: QODER_API,
        provider: PROVIDER_ID,
        baseUrl: QODER_BASE_URL,
        reasoning: Boolean(entry.is_reasoning || entry.thinking_config),
        supportsEffort: Boolean(entry.thinking_config?.enabled?.efforts),
        thinkingLevelMap,
        input: entry.is_vl ? ["text", "image"] : ["text"],
        cost: ZERO_COST,
        contextWindow: contextWindowFromCatalog(entry),
        maxTokens: MAX_OUTPUT_TOKENS,
      });
    }

    if (newModels.length === 0) return undefined;

    const cachePath = getCachePath();
    mkdirSync(dirname(cachePath), { recursive: true });
    tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ updatedAt: Date.now(), models: newModels, configs }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tempPath, cachePath);
    tempPath = undefined;
    return newModels;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  } finally {
    if (tempPath) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  }
}
