import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getCachedCredentials } from "./auth/credentials.js";
import { isPatRefresh } from "./auth/pat.js";
import { fetchQoderUsage, type QoderProviderUsage } from "./auth/usage.js";
import { PI_THINKING_LEVELS as THINKING_LEVELS, getCatalogCacheInfo, getCachedModels, lastCatalogRefresh, type QoderModelDef } from "./catalog.js";
import { lastStreamDiag } from "./protocol/stream.js";
import {
  PAT_ENV_NAMES,
  PROVIDER_ID,
  PROVIDER_NAME,
  QODER_BASE_URL,
  QODER_MANAGE_URL,
} from "./config.js";

type NotifyType = "info" | "warning" | "error";

function notify(ctx: ExtensionCommandContext, message: string, type: NotifyType = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }
  if (type === "error") {
    console.error(message);
    return;
  }
  console.log(message);
}

function formatUsage(usage: QoderProviderUsage): string {
  const lines: string[] = [usage.subscriptionTitle || "Qoder usage", ""];

  for (const bucket of usage.usageBuckets ?? []) {
    const limit = bucket.limitDisplay ? ` / ${bucket.limitDisplay}` : "";
    const unit = bucket.unit ? ` ${bucket.unit}` : "";
    const remaining = bucket.remainingDisplay ? ` (${bucket.remainingDisplay} remaining)` : "";
    const pct = bucket.percentDisplay ? ` [${bucket.percentDisplay} used]` : "";
    lines.push(`${bucket.label}: ${bucket.usedDisplay}${limit}${unit}${remaining}${pct}`);
  }
  if (usage.summary) lines.push("", `Remaining: ${usage.summary}`);
  if (usage.isQuotaExceeded) {
    lines.push("", "Quota exceeded: yes");
    if (usage.upgradeUrl) lines.push(`Upgrade: ${usage.upgradeUrl}`);
  }
  if (usage.resetAt) lines.push(`Resets: ${usage.resetAt}`);
  if (usage.manageUrl) lines.push(`Manage: ${usage.manageUrl}`);
  return lines.join("\n");
}


function formatThinkingLevels(model: QoderModelDef): string {
  const map = model.thinkingLevelMap;
  if (!map) return "";
  const parts: string[] = [];
  if (map.off === "disabled") parts.push("off");
  for (const level of THINKING_LEVELS) {
    const value = map[level];
    if (typeof value === "string" && value) parts.push(level);
  }
  return parts.length > 0 ? parts.join("/") : "";
}

function formatModelList(models: readonly QoderModelDef[], filter: string): string {
  const needle = filter.trim().toLowerCase();
  const filtered = needle
    ? models.filter(
        (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
      )
    : models;

  const header = `Qoder models (${filtered.length}${needle ? ` matching "${filter.trim()}"` : ""})`;
  if (filtered.length === 0) {
    return [header, "", `No models match "${filter.trim()}". Run /qoder.model without arguments to see all.`].join(
      "\n",
    );
  }

  const lines: string[] = [header, ""];
  const width = Math.max(...filtered.map((model) => model.id.length));
  for (const model of filtered) {
    const levels = formatThinkingLevels(model);
    const tags = [
      model.reasoning || levels ? "thinking" : "",
      levels ? `levels=${levels}` : "",
      model.input.includes("image") ? "images" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `${model.id.padEnd(width)}  ctx ${String(model.contextWindow).padStart(9)}  ${model.name}${tags ? `  [${tags}]` : ""}`,
    );
  }
  lines.push("", "Use /model to switch models.");
  return lines.join("\n");
}

function formatDoctor(): string {
  const creds = getCachedCredentials();
  const patEnvName = PAT_ENV_NAMES.find((name) => process.env[name]) ?? "";
  const cache = getCatalogCacheInfo();

  const lines: string[] = [
    `provider=${PROVIDER_ID} (${PROVIDER_NAME})`,
    `baseUrl=${QODER_BASE_URL}`,
    `credentials=${creds ? "present" : "none"}`,
  ];
  if (creds) {
    lines.push(`user=${creds.name} <${creds.email}>`);
    lines.push(`userID=${creds.userID}`);
    lines.push(`tokenSource=${creds.refresh && isPatRefresh(creds.refresh) ? "pat" : "oauth"}`);
  }
  lines.push(`patEnv=${patEnvName ? `${patEnvName} set` : "unset"}`);
  lines.push(
    `catalogCache=${cache.count} models, ${cache.updatedAt === null ? "no cache file (static fallback)" : `age ${cache.ageSeconds}s`}, stale=${cache.stale ? "yes" : "no"}`,
  );
  lines.push("transport=qoder sse (COSY-signed)");
  if (lastCatalogRefresh.at !== null) {
    lines.push(
      `lastRefresh=${Math.round((Date.now() - lastCatalogRefresh.at) / 1000)}s ago, latency=${lastCatalogRefresh.latencyMs ?? "?"}ms, error=${lastCatalogRefresh.error ?? "none"}`,
    );
  }
  if (lastStreamDiag.at !== null) {
    lines.push(
      `lastStreamError=${Math.round((Date.now() - lastStreamDiag.at) / 1000)}s ago: ${(lastStreamDiag.error ?? "").slice(0, 160)}`,
    );
  }
  lines.push("commands=/qoder.usage /qoder.model /qoder.refresh /qoder.doctor");
  if (!creds && !patEnvName) {
    lines.push("hint=Run /login qoder to authenticate");
  }
  if (creds && cache.stale) {
    lines.push("hint=Model cache is stale; run /qoder.refresh");
  }
  return lines.join("\n");
}

export function registerQoderCommands(pi: ExtensionAPI): void {
  pi.registerCommand("qoder.usage", {
    description: "Show Qoder plan quota and usage",
    handler: async (_args, ctx) => {
      try {
        ctx.signal?.throwIfAborted();
        const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
        ctx.signal?.throwIfAborted();
        if (!resolved?.auth.apiKey) throw new Error("not logged in. Run /login qoder first.");
        const usage = await fetchQoderUsage(
          { access: resolved.auth.apiKey, refresh: "", expires: 0 },
          ctx.signal,
        );
        notify(ctx, formatUsage(usage));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `Qoder usage unavailable: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("qoder.model", {
    description: "List Qoder models registered by this provider",
    handler: async (args, ctx) => {
      const cache = getCatalogCacheInfo();
      const age = cache.updatedAt === null ? "static fallback (no cache file)" : `cache age ${cache.ageSeconds}s, stale=${cache.stale ? "yes" : "no"}`;
      notify(ctx, `${formatModelList(getCachedModels(), args)}\n\n[${age}]`);
    },
  });

  pi.registerCommand("qoder.refresh", {
    description: "Force refresh Qoder model catalog from server",
    handler: async (_args, ctx) => {
      try {
        ctx.signal?.throwIfAborted();
        const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
        ctx.signal?.throwIfAborted();
        if (!resolved?.auth.apiKey) throw new Error("not logged in. Run /login qoder first.");
        const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: true, force: true, signal: ctx.signal });
        if (result.aborted) throw new Error("Refresh cancelled");
        const error = result.errors.get(PROVIDER_ID);
        if (error) throw error;
        const count = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
        notify(ctx, `Qoder catalog refreshed: ${count} models.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `Qoder refresh failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("qoder.doctor", {
    description: "Show Qoder provider diagnostics",
    handler: async (_args, ctx) => {
      notify(ctx, formatDoctor());
    },
  });
}

export { formatDoctor, formatModelList, formatUsage, formatThinkingLevels };
