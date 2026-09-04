export const PROVIDER_ID = "qoder";
export const PROVIDER_NAME = "Qoder";
export const QODER_API = "qoder-api";
export const USER_AGENT = "pi-qoder";

export const QODER_BASE_URL = "https://api3.qoder.sh/";
export const QODER_OPENAPI_URL = "https://openapi.qoder.sh";
export const QODER_CENTER_URL = "https://center.qoder.sh";
export const QODER_MANAGE_URL = "https://qoder.com";
export const QODER_PAT_MANAGE_URL = "https://qoder.com/account/integrations";
export const QODER_DEVICE_LOGIN_URL = "https://qoder.com/device/selectAccounts";

export const PAT_ENV_NAMES = ["QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "QODER_PAT"] as const;

export const USER_NAME_FALLBACK = "Qoder User";
export const USER_EMAIL_FALLBACK = "user@qoder.com";
export const USAGE_TITLE = "Qoder AI Plan";

export const MODEL_CACHE_FILE = "qoder-models-cache.json";
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

export const QODER_GATEWAY_COSY_VERSION = "1.1.38";
export const QODER_OPENAPI_COSY_VERSION = "1.0.1";
export const QODER_CLIENT_TYPE = "5";

export const MAX_OUTPUT_TOKENS = 131072;
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function getModelListURL(): string {
  return `${QODER_BASE_URL}algo/api/v2/model/list?Encode=1`;
}

export function getChatURL(): string {
  return `${QODER_BASE_URL}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}

export function getExchangeURL(): string {
  return `${QODER_OPENAPI_URL}/api/v1/jobToken/exchange`;
}

export function getUserInfoURL(): string {
  return `${QODER_OPENAPI_URL}/api/v1/userinfo`;
}

export function getUsageURL(): string {
  return `${QODER_OPENAPI_URL}/api/v2/quota/usage`;
}

export function getRefreshURL(): string {
  return `${QODER_CENTER_URL}/algo/api/v3/user/refresh_token`;
}

export function getDeviceLoginURL(codeChallenge: string, machineID: string, nonce: string): string {
  return `${QODER_DEVICE_LOGIN_URL}?challenge=${codeChallenge}&challenge_method=S256&machine_id=${machineID}&nonce=${nonce}`;
}

export function getDevicePollURL(nonce: string, codeVerifier: string): string {
  return `${QODER_OPENAPI_URL}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(codeVerifier)}&challenge_method=S256`;
}

export function getPatFromEnvironment(): string {
  for (const name of PAT_ENV_NAMES) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}
