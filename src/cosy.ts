import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { QODER_CLIENT_TYPE, QODER_GATEWAY_COSY_VERSION } from "./config.js";

const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

const QODER_DATA_POLICY = "disagree";
const QODER_LOGIN_VERSION = "v2";
const QODER_MACHINE_TYPE = "5";

// Qoder's gateway currently expects the linux/windows COSY machine-os labels
// used by qodercli. Reporting darwin here causes a reduced model catalog.
const QODER_MACHINE_OS =
  process.platform === "win32"
    ? process.arch === "arm64"
      ? "aarch64_windows"
      : "x86_64_windows"
    : process.arch === "arm64"
      ? "aarch64_linux"
      : "x86_64_linux";

export interface CosyCredentials {
  userID: string;
  authToken: string;
  name: string;
  email: string;
  machineID?: string;
}

function rsaEncryptBase64(data: Buffer | string): string {
  return crypto
    .publicEncrypt(
      { key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      typeof data === "string" ? Buffer.from(data) : data,
    )
    .toString("base64");
}

function aesEncryptCBCBase64(plaintext: string, keyStr: string): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
  return cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
}

function computeSigPath(urlStr: string): string {
  const parsed = new URL(urlStr);
  return parsed.pathname.startsWith("/algo") ? parsed.pathname.slice("/algo".length) : parsed.pathname;
}

export function getMachineId(): string {
  const paths = [join(homedir(), ".qoder", ".auth", "machine_id"), join(homedir(), ".pi", "agent", "qoder-machine-id")];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const val = readFileSync(p, "utf8").trim();
      if (val) return val;
    } catch {}
  }
  const newId = crypto.randomUUID();
  try {
    const savePath = paths[1];
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, newId, { encoding: "utf-8", mode: 0o600 });
  } catch {}
  try {
    chmodSync(paths[1], 0o600);
  } catch {}
  return newId;
}

export function buildAuthHeaders(
  body: Buffer | string | null,
  requestURL: string,
  creds: CosyCredentials,
): Record<string, string> {
  if (!creds.userID) throw new Error("cosy: user id is empty");
  if (!creds.authToken) throw new Error("cosy: auth token is empty");

  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const infoB64 = aesEncryptCBCBase64(
    JSON.stringify({
      uid: creds.userID,
      security_oauth_token: creds.authToken,
      name: creds.name || "",
      aid: "",
      email: creds.email || "",
    }),
    aesKey,
  );
  const cosyKey = rsaEncryptBase64(aesKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadB64 = Buffer.from(
    JSON.stringify({
      version: "v1",
      requestId: crypto.randomUUID(),
      info: infoB64,
      cosyVersion: QODER_GATEWAY_COSY_VERSION,
      ideVersion: "",
    }),
  ).toString("base64");

  const sigPath = computeSigPath(requestURL);
  const bodyStr = body ? (Buffer.isBuffer(body) ? body.toString("utf8") : body) : "";
  const sig = crypto.createHash("md5").update(`${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`).digest("hex");
  const bodyHash = crypto
    .createHash("md5")
    .update(body || "")
    .digest("hex");
  const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : "0";
  const machineID = creds.machineID || getMachineId();

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": QODER_GATEWAY_COSY_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": QODER_MACHINE_TYPE,
    "Cosy-Machineos": QODER_MACHINE_OS,
    "Cosy-Clienttype": QODER_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": bodyLen,
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": QODER_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": QODER_LOGIN_VERSION,
    "X-Request-Id": crypto.randomUUID(),
  };
}
