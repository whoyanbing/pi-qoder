import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const patEnvNames = ["QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"] as const;
const originalPats = Object.fromEntries(patEnvNames.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of patEnvNames) {
    const value = originalPats[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

function liteModel() {
  return {
    id: "Lite",
    name: "Lite",
    api: "qoder-api",
    provider: "qoder",
    baseUrl: "https://api3.qoder.sh/",
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 131072,
  };
}

describe("provider registration", () => {
  it("registers only global qoder", async () => {
    for (const name of patEnvNames) delete process.env[name];
    const providers = new Map<string, Record<string, unknown>>();
    const commands = new Map<string, Record<string, unknown>>();
    const pi = {
      registerProvider(providerID: string, config: Record<string, unknown>) {
        providers.set(providerID, config);
      },
      registerCommand(name: string, options: Record<string, unknown>) {
        commands.set(name, options);
      },
      on: vi.fn(),
    };

    const { default: registerProvider } = await import("../index.js");
    await registerProvider(pi as never);

    expect([...providers.keys()]).toEqual(["qoder"]);
    expect(providers.get("qoder")?.baseUrl).toBe("https://api3.qoder.sh/");
    expect(providers.has("qoder-cn")).toBe(false);
    expect([...commands.keys()].sort()).toEqual(["qoder.doctor", "qoder.model", "qoder.refresh", "qoder.usage"]);

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            userQuota: { total: 100, used: 1, remaining: 99, percentage: 1, unit: "requests" },
            orgResourcePackage: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "requests" },
            totalUsagePercentage: 1,
            isQuotaExceeded: false,
            expiresAt: Date.now() + 3600_000,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const credentials: OAuthCredentials = { access: "test-token", refresh: "", expires: Date.now() + 3600_000 };
    const oauth = providers.get("qoder")?.oauth as {
      fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
    };
    await oauth.fetchUsage(credentials);
    expect(fetchMock).toHaveBeenLastCalledWith("https://openapi.qoder.sh/api/v2/quota/usage", expect.any(Object));
  });
});

describe("qoder-api registry", () => {
  it("registers qoder-api so streamSimple works", async () => {
    for (const name of patEnvNames) delete process.env[name];

    const { getApiProvider, streamSimple, unregisterApiProviders } = await import("@earendil-works/pi-ai/compat");
    const { default: registerProvider } = await import("../index.js");
    unregisterApiProviders("provider:qoder");
    const emptyContext = { systemPrompt: "", messages: [] };

    expect(getApiProvider("qoder-api")).toBeUndefined();
    expect(() => streamSimple(liteModel() as never, emptyContext)).toThrow(
      /No API provider registered for api: qoder-api/,
    );

    const providers = new Map<string, Record<string, unknown>>();
    const registerProviderFn = vi.fn((providerID: string, config: Record<string, unknown>) => {
      providers.set(providerID, config);
    });
    const pi = {
      registerProvider: registerProviderFn,
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    await registerProvider(pi as never);

    expect(registerProviderFn).toHaveBeenCalledTimes(1);
    expect(providers.has("qoder")).toBe(true);
    expect(providers.has("qoder-cn")).toBe(false);
    expect(providers.get("qoder")?.api).toBe("qoder-api");
    expect(typeof providers.get("qoder")?.streamSimple).toBe("function");
    expect(getApiProvider("qoder-api")).toBeDefined();
    expect(() => streamSimple(liteModel() as never, emptyContext)).not.toThrow(
      /No API provider registered for api: qoder-api/,
    );
  });
});
