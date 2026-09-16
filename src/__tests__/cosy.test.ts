import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthHeaders } from "../cosy.js";

describe("COSY client identity", () => {
  it("sends Cosy-Version and cosyVersion as current qodercli 1.1.38", () => {
    const headers = buildAuthHeaders(null, "https://api3.qoder.sh/algo/api/v2/model/list", {
      userID: "user-1",
      authToken: "token-1",
      name: "Test",
      email: "test@example.com",
      machineID: "machine-1",
    });
    expect(headers["Cosy-Version"]).toBe("1.1.38");

    const auth = headers.Authorization;
    expect(auth.startsWith("Bearer COSY.")).toBe(true);
    const payloadB64 = auth.slice("Bearer COSY.".length).split(".")[0];
    const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as { cosyVersion: string };
    expect(payload.cosyVersion).toBe("1.1.38");
  });

  it("signs md5(payload, key, date, utf8 body, sigpath) for string and buffer bodies", () => {
    const url = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1";
    const creds = { userID: "u", authToken: "t", name: "n", email: "e", machineID: "m" };
    const bodies: Array<string | Buffer> = ["plain ascii", "世界 🎉", Buffer.from("_doRT$$"), Buffer.from([0x61, 0xff, 0x62])];
    for (const body of bodies) {
      const headers = buildAuthHeaders(body, url, creds);
      const [payloadB64, sig] = headers.Authorization.slice("Bearer COSY.".length).split(".");
      const bodyStr = Buffer.isBuffer(body) ? body.toString("utf8") : body;
      const expected = crypto
        .createHash("md5")
        .update(`${payloadB64}\n${headers["Cosy-Key"]}\n${headers["Cosy-Date"]}\n${bodyStr}\n${headers["Cosy-Sigpath"]}`)
        .digest("hex");
      expect(sig).toBe(expected);
    }
  });
});
