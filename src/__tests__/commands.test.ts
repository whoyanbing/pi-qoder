import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const credentialsMock = vi.hoisted(() => ({
  getCachedCredentials: vi.fn<() => unknown>(),
}));

vi.mock("../auth/credentials.js", () => credentialsMock);

import { formatDoctor, formatModelList, registerQoderCommands } from "../commands.js";
import { PAT_ENV_NAMES } from "../config.js";
import { staticModels } from "../catalog.js";

interface CapturedNotification {
  message: string;
  type?: string;
}

function makeCtx(apiKey?: string): ExtensionCommandContext & { notifications: CapturedNotification[] } {
  const notifications: CapturedNotification[] = [];
  return {
    notifications,
    hasUI: true,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    modelRegistry: {
      getProviderAuth: async () => (apiKey ? { auth: { apiKey } } : undefined),
      refresh: async () => ({ aborted: false, errors: new Map() }),
      getAll: () => [],
    },
  } as unknown as ExtensionCommandContext & { notifications: CapturedNotification[] };
}

interface CommandEntry {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function makePi(): ExtensionAPI & { commands: Map<string, CommandEntry> } {
  const commands = new Map<string, CommandEntry>();
  return {
    commands,
    registerCommand: (name: string, options: CommandEntry) => commands.set(name, options),
  } as unknown as ExtensionAPI & { commands: Map<string, CommandEntry> };
}

const USAGE_RESPONSE = {
  userId: "user-1",
  userType: "teams",
  usageType: "credits",
  totalUsagePercentage: 1,
  isQuotaExceeded: false,
  expiresAt: 1893456000000,
  upgradeUrl: "https://qoder.com/pricing?client=qoder",
  userQuota: { total: 100, used: 12.5, remaining: 87.5, percentage: 0.125, unit: "credits" },
  orgResourcePackage: { used: 5, remaining: 45, percentage: 0.1, unit: "credits", cap: 50, available: true },
};

describe("registerQoderCommands", () => {
  let pi: ReturnType<typeof makePi>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    credentialsMock.getCachedCredentials.mockReturnValue(null);
    for (const name of PAT_ENV_NAMES) delete process.env[name];
    pi = makePi();
    registerQoderCommands(pi);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("registers qoder.usage, qoder.model, qoder.refresh and qoder.doctor with descriptions", () => {
    expect([...pi.commands.keys()].sort()).toEqual(["qoder.doctor", "qoder.model", "qoder.refresh", "qoder.usage"]);
    for (const command of pi.commands.values()) {
      expect(command.description).toBeTruthy();
      expect(typeof command.handler).toBe("function");
    }
  });

  describe("qoder.model", () => {
    it("lists cached/static models with context windows", async () => {
      const ctx = makeCtx();
      await pi.commands.get("qoder.model")!.handler("", ctx);
      expect(ctx.notifications).toHaveLength(1);
      const message = ctx.notifications[0].message;
      expect(message).toContain("Qoder models (");
      expect(message).toContain("Auto");
      expect(message).toMatch(/ctx\s+\d+/);
      expect(ctx.notifications[0].type).toBe("info");
    });

    it("filters models by case-insensitive substring", async () => {
      const ctx = makeCtx();
      await pi.commands.get("qoder.model")!.handler("qwen", ctx);
      const message = ctx.notifications[0].message;
      expect(message).toContain('matching "qwen"');
      expect(message).not.toContain("Auto\n");
    });

    it("reports when no model matches the filter", async () => {
      const ctx = makeCtx();
      await pi.commands.get("qoder.model")!.handler("definitely-no-such-model", ctx);
      const message = ctx.notifications[0].message;
      expect(message).toContain("Qoder models (0");
      expect(message).toContain("No models match");
    });
  });

  describe("qoder.usage", () => {
    it("errors with a login hint when not authenticated", async () => {
      const ctx = makeCtx();
      await pi.commands.get("qoder.usage")!.handler("", ctx);
      expect(ctx.notifications).toHaveLength(1);
      expect(ctx.notifications[0].type).toBe("error");
      expect(ctx.notifications[0].message).toContain("not logged in");
      expect(ctx.notifications[0].message).toContain("/login qoder");
    });

    it("formats quota buckets, summary, reset and manage url", async () => {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify(USAGE_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch;

      const ctx = makeCtx("token-1");
      await pi.commands.get("qoder.usage")!.handler("", ctx);
      expect(ctx.notifications).toHaveLength(1);
      const message = ctx.notifications[0].message;
      expect(message).toContain("Qoder AI Plan");
      expect(message).toContain("User Quota: 12.50 / 100 credits (87.50 remaining) [13% used]");
      expect(message).toContain("Team Balance: 5 / 50 credits (45 remaining) [10% used]");
      expect(message).toContain("Remaining: 45 credits remaining (team)");
      expect(message).toMatch(/Resets: \d{4}-\d{2}-\d{2}T/);
      expect(message).toContain("Manage: https://qoder.com");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://openapi.qoder.sh/api/v2/quota/usage",
        expect.objectContaining({ method: "GET" }),
      );
      const headers = new Headers(vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers);
      expect(headers.get("Authorization")).toBe("Bearer token-1");
    });

    it("surfaces fetch failures as error notifications", async () => {
      globalThis.fetch = vi.fn(
        async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }),
      ) as unknown as typeof fetch;

      const ctx = makeCtx("token-1");
      await pi.commands.get("qoder.usage")!.handler("", ctx);
      expect(ctx.notifications[0].type).toBe("error");
      expect(ctx.notifications[0].message).toContain("503");
    });
  });

  describe("qoder.refresh", () => {
    it("refreshes the live registry and reports provider failures", async () => {
      const ctx = makeCtx("test");
      const refresh = vi.fn().mockResolvedValue({ aborted: false, errors: new Map() });
      ctx.modelRegistry = {
        getProviderAuth: async () => ({ auth: { apiKey: "test" } }),
        refresh, getAll: () => [{ id: "NewModel", provider: "qoder" }],
      } as unknown as ExtensionCommandContext["modelRegistry"];
      await pi.commands.get("qoder.refresh")!.handler("", ctx);
      expect(refresh).toHaveBeenCalledWith({ providers: ["qoder"], allowNetwork: true, force: true, signal: undefined });
      expect(ctx.notifications[0].message).toBe("Qoder catalog refreshed: 1 models.");

      refresh.mockResolvedValueOnce({ aborted: false, errors: new Map([["qoder", new Error("HTTP 403")]]) });
      await pi.commands.get("qoder.refresh")!.handler("", ctx);
      expect(ctx.notifications[1]).toMatchObject({ type: "error", message: "Qoder refresh failed: HTTP 403" });
    });
  });

  describe("qoder.doctor", () => {
    it("shows provider, credentials=none, unset PAT env and cache fallback", async () => {
      const ctx = makeCtx();
      await pi.commands.get("qoder.doctor")!.handler("", ctx);
      const message = ctx.notifications[0].message;
      expect(message).toContain("provider=qoder");
      expect(message).toContain("baseUrl=https://api3.qoder.sh/");
      expect(message).toContain("credentials=none");
      expect(message).toContain("patEnv=unset");
      expect(message).toContain("catalogCache=");
      expect(message).toContain("commands=/qoder.usage /qoder.model /qoder.refresh /qoder.doctor");
      expect(message).toContain("hint=Run /login qoder to authenticate");
    });

    it("reports oauth identity and pat tokenSource", async () => {
      credentialsMock.getCachedCredentials.mockReturnValue({
        type: "oauth",
        access: "token-1",
        refresh: "pat|secret|job-refresh|user-1|machine-1",
        userID: "user-1",
        email: "test@example.com",
        name: "Test User",
        machineID: "machine-1",
      });
      const ctx = makeCtx();
      await pi.commands.get("qoder.doctor")!.handler("", ctx);
      const message = ctx.notifications[0].message;
      expect(message).toContain("credentials=present");
      expect(message).toContain("user=Test User <test@example.com>");
      expect(message).toContain("userID=user-1");
      expect(message).toContain("tokenSource=pat");
    });

    it("reports which PAT env var is set", async () => {
      process.env.QODER_API_KEY = "secret-pat";
      try {
        const ctx = makeCtx();
        await pi.commands.get("qoder.doctor")!.handler("", ctx);
        expect(ctx.notifications[0].message).toContain("patEnv=QODER_API_KEY set");
      } finally {
        delete process.env.QODER_API_KEY;
      }
    });
  });
});

describe("formatters", () => {
  it("formatModelList pads ids and annotates thinking levels and images", () => {
    const message = formatModelList(staticModels, "");
    expect(message).toContain("Qoder models (");
    expect(message).toMatch(/Auto\s+ctx\s+\d+/);
    expect(message).toContain("[");
  });

  it("formatThinkingLevels lists enabled levels", () => {
    const model = staticModels.find((m) => m.thinkingLevelMap) ?? staticModels[0];
    const levels = formatModelList([model], "").toString();
    expect(typeof levels).toBe("string");
  });

  it("formatDoctor reflects logged-out state", () => {
    credentialsMock.getCachedCredentials.mockReturnValue(null);
    const message = formatDoctor();
    expect(message).toContain("provider=qoder");
    expect(message).toContain("credentials=none");
  });
});
