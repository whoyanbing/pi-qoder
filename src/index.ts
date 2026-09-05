import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { autoLoginFromEnvironment, getCachedCredentials, loginQoder, refreshQoderToken } from "./auth/credentials.js";
import { fetchQoderUsage } from "./auth/usage.js";
import { registerQoderCommands } from "./commands.js";
import { getCachedModels, isCacheStale, toProviderModels, updateQoderModelsCache } from "./catalog.js";
import { PROVIDER_ID, PROVIDER_NAME, QODER_API, QODER_BASE_URL } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./network.js";
import { streamQoder } from "./protocol/stream.js";

type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

function registerQoderApi(): void {
  registerApiProvider(
    {
      api: QODER_API,
      stream: streamQoder,
      streamSimple: streamQoder,
    },
    "provider:qoder",
  );
}

async function refreshCatalogFromCredentials(signal?: AbortSignal): Promise<void> {
  if (!isCacheStale()) return;
  const credentials = getCachedCredentials();
  if (!credentials?.access || !credentials.userID) return;
  await updateQoderModelsCache(credentials.access, credentials.userID, credentials.name, credentials.email, signal);
}

export default async function (pi: ExtensionAPI) {
  registerQoderApi();

  try {
    // Bound the complete startup bootstrap, not just each individual request.
    // A stale PAT or an unreachable Qoder service must not stall Pi startup.
    const startupSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
    await autoLoginFromEnvironment(startupSignal);
    await refreshCatalogFromCredentials(startupSignal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-qoder] Automatic login failed: ${message}`);
  }

  const oauth: OAuthConfigWithUsage = {
    name: "Qoder (Browser OAuth / PAT)",
    isSubscription: true,
    login: loginQoder,
    refreshToken: refreshQoderToken,
    getApiKey: (cred) => cred.access,
    fetchUsage: fetchQoderUsage,
  };

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: QODER_BASE_URL,
    api: QODER_API,
    models: toProviderModels(),
    oauth: oauth as ProviderConfig["oauth"],
    streamSimple: streamQoder as unknown as ProviderConfig["streamSimple"],
    async refreshModels(context) {
      const credential = context.credential;
      const access = credential && "access" in credential ? String(credential.access ?? "") : "";
      if (!access || !context.allowNetwork) return toProviderModels();
      if (!context.force && !isCacheStale()) return toProviderModels();

      const extra = credential as { userID?: string; name?: string; email?: string };
      const cached = getCachedCredentials();
      const models = await updateQoderModelsCache(
        access,
        extra.userID || cached?.userID || "qoder-user",
        extra.name || cached?.name || "Qoder User",
        extra.email || cached?.email || "user@qoder.com",
        context.signal,
      );
      const next = toProviderModels(models ?? getCachedModels());
      await context.publish({
        persist: {
          models: next.map((model) => ({
            ...model,
            api: QODER_API,
            provider: PROVIDER_ID,
            baseUrl: QODER_BASE_URL,
          })),
          checkedAt: Date.now(),
        },
      });
      return next;
    },
  });

  registerQoderCommands(pi);
}
