import crypto from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { getDeviceLoginURL, getDevicePollURL, getUserInfoURL, USER_AGENT } from "../config.js";
import { getMachineId } from "../cosy.js";
import { credentialsFromPat } from "./pat.js";

function getPrompt(callbacks: OAuthLoginCallbacks) {
  return callbacks.onPrompt;
}

function getProgress(callbacks: OAuthLoginCallbacks) {
  return callbacks.onProgress;
}

function getSignal(callbacks: OAuthLoginCallbacks) {
  return callbacks.signal;
}

export function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function parseExpiresAt(s?: string, expiresInSeconds?: number): number {
  if (s) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
    const ms = Number.parseInt(s, 10);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  if (expiresInSeconds && expiresInSeconds > 0) return Date.now() + expiresInSeconds * 1000;
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Login cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new Error("Login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function patLogin(callbacks: OAuthLoginCallbacks, providedPat: string): Promise<OAuthCredentials> {
  if (!providedPat) throw new Error("No Personal Access Token provided");
  getProgress(callbacks)?.("Exchanging access token...");
  const creds = await credentialsFromPat(providedPat);
  getProgress(callbacks)?.("Login successful!");
  return creds;
}

async function runDeviceFlow(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const nonce = crypto.randomUUID();
  const machineID = getMachineId();
  const verificationURI = getDeviceLoginURL(codeChallenge, machineID, nonce);

  getProgress(callbacks)?.("Please complete login in your browser...");
  callbacks.onAuth({
    url: verificationURI,
    instructions: "Click to sign in with your Qoder account in the browser.",
  });

  const pollURL = getDevicePollURL(nonce, codeVerifier);
  const maxAttempts = 90;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
    await abortableDelay(2000, getSignal(callbacks));

    try {
      const response = await fetch(pollURL, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: getSignal(callbacks),
      });

      if (response.status === 202 || response.status === 404) continue;
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Device token poll failed: ${response.status} ${response.statusText}. Response: ${errText}`);
      }

      const tokenData = (await response.json()) as {
        token: string;
        user_id: string;
        refresh_token: string;
        expires_at?: string;
        expires_in?: number;
      };
      if (!tokenData.token) throw new Error("Device token poll returned empty access token");

      getProgress(callbacks)?.("Fetching user profile...");
      let email = "";
      let name = "";
      try {
        const userinfoRes = await fetch(getUserInfoURL(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${tokenData.token}`,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
        });
        if (userinfoRes.ok) {
          const userinfo = (await userinfoRes.json()) as { email?: string; name?: string; username?: string };
          email = userinfo.email || "";
          name = userinfo.name || userinfo.username || "";
        }
      } catch {}

      getProgress(callbacks)?.("Login successful!");
      return {
        refresh: `${tokenData.refresh_token}|${tokenData.user_id}|${machineID}`,
        access: tokenData.token,
        expires: parseExpiresAt(tokenData.expires_at, tokenData.expires_in) - 5 * 60 * 1000,
        userID: tokenData.user_id,
        email,
        name,
        machineID,
      };
    } catch (e: unknown) {
      const err = e as { name?: string };
      if (err.name === "AbortError" || getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
      throw e;
    }
  }

  throw new Error("Authorization timed out");
}

export async function interactiveLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const pat = await getPrompt(callbacks)({
    message: "Paste a Qoder Personal Access Token (pt-...), or leave empty for browser login",
    placeholder: "pt-...",
    allowEmpty: true,
  });
  if (getSignal(callbacks)?.aborted) throw new Error("Login cancelled");
  if (pat?.trim()) return patLogin(callbacks, pat.trim());
  return runDeviceFlow(callbacks);
}
