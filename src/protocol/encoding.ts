const QODER_CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ENCODE_MAP = Buffer.alloc(256);
const DECODE_MAP = Buffer.alloc(256);
for (let i = 0; i < 256; i++) {
  ENCODE_MAP[i] = i;
  DECODE_MAP[i] = i;
}
for (let i = 0; i < 64; i++) {
  ENCODE_MAP[QODER_STD_ALPHABET.charCodeAt(i)] = QODER_CUSTOM_ALPHABET.charCodeAt(i);
  DECODE_MAP[QODER_CUSTOM_ALPHABET.charCodeAt(i)] = QODER_STD_ALPHABET.charCodeAt(i);
}
ENCODE_MAP[61] = 36; // '=' -> '$'
DECODE_MAP[36] = 61; // '$' -> '='

function remapRearranged(src: Buffer, map: Buffer): Buffer {
  const n = src.byteLength;
  if (n === 0) return src;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let o = 0;
  for (let i = n - a; i < n; i++) out[o++] = map[src[i]];
  for (let i = a; i < n - a; i++) out[o++] = map[src[i]];
  for (let i = 0; i < a; i++) out[o++] = map[src[i]];
  return out;
}

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
  if (std.length === 0) return "";
  return remapRearranged(Buffer.from(std, "latin1"), ENCODE_MAP).toString("latin1");
}

export function qoderDecodeBody(encoded: string): Buffer {
  if (encoded.length === 0) return Buffer.alloc(0);
  const std = remapRearranged(Buffer.from(encoded, "latin1"), DECODE_MAP).toString("latin1");
  return Buffer.from(std, "base64");
}
