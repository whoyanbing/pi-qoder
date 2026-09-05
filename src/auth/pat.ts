import type { OAuthCredentials } from "@earendil-works/pi-ai";
import {
  QODER_CLIENT_TYPE,
  QODER_OPENAPI_COSY_VERSION,
  USER_AGENT,
  USER_EMAIL_FALLBACK,
  USER_NAME_FALLBACK,
  getExchangeURL,
  getUserInfoURL,
} from "../config.js";
import { getMachineId } from "../cosy.js";
import { fetchWithTimeout, readResponseTextLimited } from "../network.js";

export const PAT_REFRESH_PREFIX = "pat";

export interface PatExchangeResult {
  jobToken: string;
  jobRefreshToken: string;
  expiresAt: number;
}

export function isPatRefresh(refresh: string): boolean {
  return refresh.startsWith(`${PAT_REFRESH_PREFIX}|`);
}

export function encodePatRefresh(pat: string, jobRefreshToken: string, userID: string, machineID: string): string {
  return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join("|");
}

export function decodePatRefresh(refresh: string): {
  pat: string;
  jobRefreshToken: string;
  userID: string;
  machineID: string;
} {
  const parts = refresh.split("|");
  return {
    pat: parts[1] || "",
    jobRefreshToken: parts[2] || "",
    userID: parts[3] || "",
    machineID: parts[4] || "",
  };
}

export async function exchangeJobToken(pat: string, signal?: AbortSignal): Promise<PatExchangeResult> {
  const res = await fetchWithTimeout(
    getExchangeURL(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Cosy-Version": QODER_OPENAPI_COSY_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
      body: JSON.stringify({ personal_token: pat }),
    },
    { signal, label: "Qoder PAT exchange" },
  );

  if (!res.ok) {
    const text = await readResponseTextLimited(res).catch(() => "");
    throw new Error(`Qoder PAT exchange failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };
  if (!data.token) throw new Error("Qoder PAT exchange returned no job token");

  let expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (Number.isFinite(data.expires_in) && data.expires_in! > 0) {
    // Qoder's PAT exchange endpoint reports expires_in in milliseconds.
    expiresAt = Date.now() + data.expires_in!;
  }

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || "",
    expiresAt,
  };
}

export async function fetchUserInfo(
  jobToken: string,
  signal?: AbortSignal,
): Promise<{ userID: string; email: string; name: string }> {
  const res = await fetchWithTimeout(
    getUserInfoURL(),
    {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Cosy-Version": QODER_OPENAPI_COSY_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
    },
    { signal, label: "Qoder user-info request" },
  );
  if (!res.ok) {
    throw new Error(`Qoder user-info request failed: ${res.status} ${res.statusText}`);
  }
  const info = (await res.json()) as { id?: string; email?: string; name?: string; username?: string };
  const userID = info.id || "";
  if (!userID) throw new Error("Qoder user-info response did not include a user id");
  return { userID, email: info.email || "", name: info.name || info.username || "" };
}

export async function credentialsFromPat(pat: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, signal);
  const { userID, email, name } = await fetchUserInfo(jobToken, signal);
  const machineID = getMachineId();
  return {
    refresh: encodePatRefresh(pat, jobRefreshToken, userID, machineID),
    access: jobToken,
    expires: Math.max(Date.now(), expiresAt - 5 * 60 * 1000),
    userID,
    email: email || USER_EMAIL_FALLBACK,
    name: name || USER_NAME_FALLBACK,
    machineID,
  };
}
