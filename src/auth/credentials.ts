import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
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

export function saveCredentialsToAuthFile(credentials: OAuthCredentials, providerID = PROVIDER_ID): void {
  try {
    const dir = dirname(AUTH_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    let auth: Record<string, unknown> = {};
    if (existsSync(AUTH_FILE)) {
      try {
        auth = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
      } catch {}
    }
    auth[providerID] = { type: "oauth", ...credentials };
    writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    console.error(`[pi-qoder] Failed to write auth storage for ${providerID}:`, err);
  }
}

function persistCredentials(credentials: OAuthCredentials, providerID = PROVIDER_ID): void {
  saveCredentialsToAuthFile(credentials, providerID);
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

export async function resolveQoderIdentity(accessToken: string, providerID = PROVIDER_ID): Promise<QoderCredentials> {
  const cached = getCachedCredentials(providerID);
  if (cached?.userID) return cached;

  const cacheKey = `${providerID}:${accessToken}`;
  const mem = identityCache.get(cacheKey);
  if (mem?.userID) return mem;

  const info = await fetchUserInfo(accessToken);
  const creds: QoderCredentials = {
    access: accessToken,
    userID: info.userID || "qoder-user",
    email: info.email || USER_EMAIL_FALLBACK,
    name: info.name || USER_NAME_FALLBACK,
    machineID: getMachineId(),
    refresh: cached?.refresh || "",
    expires: cached?.expires || 0,
  };
  identityCache.set(cacheKey, creds);
  saveCredentialsToAuthFile({ ...cached, ...creds }, providerID);
  return creds;
}

function scheduleCatalogRefresh(creds: QoderCredentials): void {
  updateQoderModelsCache(creds.access, creds.userID, creds.name, creds.email).catch(() => {});
}

export async function autoLoginFromEnvironment(): Promise<void> {
  const pat = getPatFromEnvironment();
  if (!pat) return;
  const credentials = await credentialsFromPat(pat);
  persistCredentials(credentials);
  const qCreds = credentials as QoderCredentials;
  await updateQoderModelsCache(qCreds.access, qCreds.userID, qCreds.name, qCreds.email);
}

export async function loginQoder(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const pat = getPatFromEnvironment();
  if (pat) {
    try {
      const creds = await credentialsFromPat(pat);
      persistCredentials(creds);
      scheduleCatalogRefresh(creds as QoderCredentials);
      return creds;
    } catch {}
  }

  const creds = await interactiveLogin(callbacks);
  persistCredentials(creds);
  scheduleCatalogRefresh(creds as QoderCredentials);
  return creds;
}

export async function refreshQoderToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  if (isPatRefresh(credentials.refresh)) {
    const { pat } = decodePatRefresh(credentials.refresh);
    if (pat) {
      try {
        const refreshed = await credentialsFromPat(pat);
        scheduleCatalogRefresh(refreshed as QoderCredentials);
        return refreshed;
      } catch {}
    }
    return { ...credentials, expires: Date.now() + 60 * 60 * 1000 };
  }

  const parts = credentials.refresh.split("|");
  const refreshToken = parts[0] || "";
  const userID = parts[1] || "";
  const machineID = parts[2] || getMachineId();
  const prev = credentials as Partial<QoderCredentials>;

  try {
    const response = await fetch(getRefreshURL(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        token: string;
        refresh_token?: string;
        expires_at?: string;
        expires_in?: number;
      };

      let expireMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
      if (data.expires_at) {
        const parsed = Date.parse(data.expires_at);
        if (!Number.isNaN(parsed)) expireMs = parsed;
      } else if (data.expires_in) {
        expireMs = Date.now() + data.expires_in * 1000;
      }

      const refreshed = {
        ...credentials,
        refresh: `${data.refresh_token || refreshToken}|${userID}|${machineID}`,
        access: data.token,
        expires: expireMs - 5 * 60 * 1000,
        userID,
        email: prev.email || "",
        name: prev.name || "",
        machineID,
      };
      scheduleCatalogRefresh(refreshed as QoderCredentials);
      return refreshed;
    }
  } catch {}

  return { ...credentials, expires: Date.now() + 60 * 60 * 1000 };
}
