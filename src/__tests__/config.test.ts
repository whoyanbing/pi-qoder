import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  PROVIDER_ID,
  QODER_API,
  QODER_BASE_URL,
  getChatURL,
  getDeviceLoginURL,
  getDevicePollURL,
  getExchangeURL,
  getModelListURL,
  getPatFromEnvironment,
  getRefreshURL,
  getUsageURL,
  getUserInfoURL,
} from "../config.js";

describe("qoder endpoints", () => {
  it("binds only the global Qoder hosts", () => {
    expect(PROVIDER_ID).toBe("qoder");
    expect(QODER_API).toBe("qoder-api");
    expect(QODER_BASE_URL).toBe("https://api3.qoder.sh/");
    expect(getModelListURL()).toBe("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1");
    expect(getChatURL()).toContain("api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation");
    expect(getExchangeURL()).toBe("https://openapi.qoder.sh/api/v1/jobToken/exchange");
    expect(getUserInfoURL()).toBe("https://openapi.qoder.sh/api/v1/userinfo");
    expect(getUsageURL()).toBe("https://openapi.qoder.sh/api/v2/quota/usage");
    expect(getRefreshURL()).toBe("https://center.qoder.sh/algo/api/v3/user/refresh_token");
  });

  it("builds device-login URLs", () => {
    expect(getDeviceLoginURL("chal", "mid", "nonce")).toBe(
      "https://qoder.com/device/selectAccounts?challenge=chal&challenge_method=S256&machine_id=mid&nonce=nonce",
    );
    expect(getDevicePollURL("n", "v")).toContain("https://openapi.qoder.sh/api/v1/deviceToken/poll?");
  });

  it("reads PAT env in documented order", () => {
    const original = {
      QODER_API_KEY: process.env.QODER_API_KEY,
      QODER_PERSONAL_ACCESS_TOKEN: process.env.QODER_PERSONAL_ACCESS_TOKEN,
      QODER_PAT: process.env.QODER_PAT,
    };
    delete process.env.QODER_API_KEY;
    delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    delete process.env.QODER_PAT;
    expect(getPatFromEnvironment()).toBe("");
    process.env.QODER_PAT = "pt-pat";
    expect(getPatFromEnvironment()).toBe("pt-pat");
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-personal";
    expect(getPatFromEnvironment()).toBe("pt-personal");
    process.env.QODER_API_KEY = "pt-api";
    expect(getPatFromEnvironment()).toBe("pt-api");
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("keeps output and fallback context ceilings", () => {
    expect(MAX_OUTPUT_TOKENS).toBe(131072);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
  });
});
