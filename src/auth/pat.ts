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

export async function exchangeJobToken(pat: string): Promise<PatExchangeResult> {
  const res = await fetch(getExchangeURL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "Cosy-Version": QODER_OPENAPI_COSY_VERSION,
      "Cosy-ClientType": QODER_CLIENT_TYPE,
    },
    body: JSON.stringify({ personal_token: pat }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
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
  } else if (data.expires_in) {
    expiresAt = Date.now() + data.expires_in;
  }

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || "",
    expiresAt,
  };
}

export async function fetchUserInfo(jobToken: string): Promise<{ userID: string; email: string; name: string }> {
  let userID = "";
  let email = "";
  let name = "";
  try {
    const res = await fetch(getUserInfoURL(), {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Cosy-Version": QODER_OPENAPI_COSY_VERSION,
        "Cosy-ClientType": QODER_CLIENT_TYPE,
      },
    });
    if (res.ok) {
      const info = (await res.json()) as { id?: string; email?: string; name?: string; username?: string };
      userID = info.id || "";
      email = info.email || "";
      name = info.name || info.username || "";
    }
  } catch {}
  return { userID, email, name };
}

export async function credentialsFromPat(pat: string): Promise<OAuthCredentials> {
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat);
  const { userID, email, name } = await fetchUserInfo(jobToken);
  const machineID = getMachineId();
  return {
    refresh: encodePatRefresh(pat, jobRefreshToken, userID, machineID),
    access: jobToken,
    expires: expiresAt - 5 * 60 * 1000,
    userID,
    email: email || USER_EMAIL_FALLBACK,
    name: name || USER_NAME_FALLBACK,
    machineID,
  };
}
