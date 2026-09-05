import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { updateQoderModelsCache } from "../catalog.js";
import {
  PROVIDER_ID,
  USER_AGENT,
  USER_EMAIL_FALLBACK,
  USER_NAME_FALLBACK,
  getPatFromEnvironment,
  getRefreshURL,
} from "../config.js";
import { getMachineId } from "../cosy.js";
import { fetchWithTimeout, readResponseTextLimited } from "../network.js";
import { interactiveLogin } from "./login.js";
import { credentialsFromPat, decodePatRefresh, fetchUserInfo, isPatRefresh } from "./pat.js";

export interface QoderCredentials extends OAuthCredentials {
  userID: string;
  email: string;
  name: string;
  machineID: string;
}

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const identityCache = new Map<string, QoderCredentials>();

function acquireAuthLock(): () => void {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return lockfile.lockSync(AUTH_FILE, { realpath: false, stale: 30_000 });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
      const deadline = Date.now() + 20;
      while (Date.now() < deadline) {
        // Match Pi's synchronous auth-storage retry policy.
      }
    }
  }
  throw new Error("Failed to acquire Pi auth storage lock");
}

/**
 * Environment-PAT bootstrap happens before Pi owns a credential transaction, so
 * it needs a one-time write. Use an exclusive lock and atomic rename; never
 * replace an auth file that cannot be parsed.
 */
export function saveCredentialsToAuthFile(credentials: OAuthCredentials, providerID = PROVIDER_ID): void {
  const dir = dirname(AUTH_FILE);
  const tempPath = `${AUTH_FILE}.${process.pid}.${Date.now()}.tmp`;
  let release: (() => void) | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(AUTH_FILE)) writeFileSync(AUTH_FILE, "{}", { encoding: "utf-8", mode: 0o600 });
    // Use Pi's own proper-lockfile convention (`auth.json.lock`) so concurrent
    // Pi processes and this bootstrap writer serialize through the same lock.
    release = acquireAuthLock();

    let auth: Record<string, unknown> = {};
    if (existsSync(AUTH_FILE)) {
      const parsed = JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Existing Pi auth storage is not a JSON object");
      }
      auth = parsed as Record<string, unknown>;
    }

    auth[providerID] = { type: "oauth", ...credentials };
    writeFileSync(tempPath, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, AUTH_FILE);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {}
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write Qoder credentials without overwriting Pi auth storage: ${message}`, {
      cause: error,
    });
  } finally {
    try {
      release?.();
    } catch {}
  }
}

export function getCachedCredentials(providerID = PROVIDER_ID): QoderCredentials | null {
  try {
    const stored = readStoredCredential(providerID);
    if (stored && stored.type === "oauth" && (stored.userID || stored.access)) {
      return stored as unknown as QoderCredentials;
    }
  } catch {}
  if (existsSync(AUTH_FILE)) {
    try {
      const auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
      const creds = auth?.[providerID];
      if (creds?.userID || creds?.access) return creds as QoderCredentials;
    } catch {}
  }
  return null;
}

export async function resolveQoderIdentity(
  accessToken: string,
  providerID = PROVIDER_ID,
  signal?: AbortSignal,
): Promise<QoderCredentials> {
  const cached = getCachedCredentials(providerID);
  if (cached?.userID && cached.access === accessToken) return cached;

  const cacheKey = `${providerID}:${accessToken}`;
  const mem = identityCache.get(cacheKey);
  if (mem?.userID) return mem;

  const info = await fetchUserInfo(accessToken, signal);
  const creds: QoderCredentials = {
    access: accessToken,
    userID: info.userID,
    email: info.email || USER_EMAIL_FALLBACK,
    name: info.name || USER_NAME_FALLBACK,
    machineID: cached?.access === accessToken && cached.machineID ? cached.machineID : getMachineId(),
    refresh: cached?.access === accessToken ? cached.refresh || "" : "",
    expires: cached?.access === accessToken ? cached.expires || 0 : 0,
  };
  identityCache.set(cacheKey, creds);
  return creds;
}

function scheduleCatalogRefresh(creds: QoderCredentials, signal?: AbortSignal): void {
  updateQoderModelsCache(creds.access, creds.userID, creds.name, creds.email, signal).catch(() => {});
}

export async function autoLoginFromEnvironment(signal?: AbortSignal): Promise<void> {
  const pat = getPatFromEnvironment();
  if (!pat) return;
  const credentials = await credentialsFromPat(pat, signal);
  saveCredentialsToAuthFile(credentials);
  const qCreds = credentials as QoderCredentials;
  await updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email, signal);
}

export async function loginQoder(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const pat = getPatFromEnvironment();
  if (pat) {
    try {
      const creds = await credentialsFromPat(pat, callbacks.signal);
      scheduleCatalogRefresh(creds as QoderCredentials, callbacks.signal);
      return creds;
    } catch (error) {
      if (callbacks.signal?.aborted) throw error;
      // Fall through to the interactive flow so a stale environment PAT does
      // not make /login unusable.
    }
  }

  const creds = await interactiveLogin(callbacks);
  scheduleCatalogRefresh(creds as QoderCredentials, callbacks.signal);
  return creds;
}

export async function refreshQoderToken(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  signal?.throwIfAborted();

  if (isPatRefresh(credentials.refresh)) {
    const { pat } = decodePatRefresh(credentials.refresh);
    if (!pat) throw new Error("Qoder PAT refresh data is missing the personal access token. Run /login qoder again.");
    try {
      const refreshed = await credentialsFromPat(pat, signal);
      scheduleCatalogRefresh(refreshed as QoderCredentials, signal);
      return refreshed;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Qoder PAT refresh failed. Check the network or run /login qoder again.", { cause: error });
    }
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || "";
  const machineID = parts[2] || getMachineId();
  const prev = credentials as Partial<QoderCredentials>;
  if (!refreshToken || !userID) {
    throw new Error("Qoder OAuth refresh data is incomplete. Run /login qoder again.");
  }

  const response = await fetchWithTimeout(
    getRefreshURL(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ refreshToken }),
    },
    { signal, label: "Qoder OAuth refresh" },
  );

  if (!response.ok) {
    const body = await readResponseTextLimited(response).catch(() => "");
    throw new Error(
      `Qoder OAuth refresh failed: ${response.status} ${response.statusText}${body ? `. ${body.slice(0, 200)}` : ""}`,
    );
  }

  const data = (await response.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };
  if (!data.token) throw new Error("Qoder OAuth refresh returned no access token. Run /login qoder again.");

  let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expireMs = parsed;
  } else if (Number.isFinite(data.expires_in) && data.expires_in! > 0) {
    // OAuth refresh uses the conventional seconds unit.
    expireMs = Date.now() + data.expires_in! * 1000;
  }

  const refreshed: QoderCredentials = {
    ...credentials,
    refresh: `${data.refresh_token || refreshToken}|${userID}|${machineID}`,
    access: data.token,
    expires: Math.max(Date.now(), expireMs - 5 * 60 * 1000),
    userID,
    email: prev.email || USER_EMAIL_FALLBACK,
    name: prev.name || USER_NAME_FALLBACK,
    machineID,
  };
  scheduleCatalogRefresh(refreshed, signal);
  return refreshed;
}
