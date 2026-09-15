import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { autoLoginFromEnvironment, getCachedCredentials, loginQoder, refreshCatalogIfNeeded, refreshQoderToken } from "./auth/credentials.js";
import { fetchQoderUsage } from "./auth/usage.js";
import { registerQoderCommands } from "./commands.js";
import { isCacheStale, lastCatalogRefresh, toProviderModels, updateQoderModelsCache } from "./catalog.js";
import { PROVIDER_ID, PROVIDER_NAME, QODER_API, QODER_BASE_URL } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./network.js";
import { streamQoder } from "./protocol/stream.js";

type OAuthConfigWithUsage = NonNullable<ProviderConfig["oauth"]> & {
  fetchUsage: (credentials: OAuthCredentials) => Promise<unknown>;
};

let bootstrapController: AbortController | undefined;

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

export default async function (pi: ExtensionAPI) {
  registerQoderApi();

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
      if (!models) {
        throw new Error(lastCatalogRefresh.error || "Qoder refresh returned no models; kept existing cache.");
      }
      const next = toProviderModels(models);
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

  // Bootstrap in background: never block pi startup on Qoder network.
  // Abort the previous bootstrap on reload so a stale task cannot overwrite
  // credentials or the catalog written by the new instance.
  bootstrapController?.abort();
  const controller = new AbortController();
  bootstrapController = controller;
  void (async () => {
    try {
      const startupSignal = AbortSignal.any([AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS), controller.signal]);
      await autoLoginFromEnvironment(startupSignal);
      const credentials = getCachedCredentials();
      if (credentials?.access && credentials.userID) {
        await refreshCatalogIfNeeded(credentials, startupSignal);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pi-qoder] background login/catalog refresh failed: ${message}`);
    }
  })();
}

export function __cancelBootstrapForTests(): void {
  bootstrapController?.abort();
  bootstrapController = undefined;
}
