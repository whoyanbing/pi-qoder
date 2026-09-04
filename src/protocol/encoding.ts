const QODER_CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  let out = "";
  for (let i = 0; i < n; i++) {
    const c = rearranged[i];
    if (c === "=") {
      out += "$";
    } else {
      const idx = QODER_STD_ALPHABET.indexOf(c);
      out += idx >= 0 ? QODER_CUSTOM_ALPHABET[idx] : c;
    }
  }
  return out;
}

export function qoderDecodeBody(encoded: string): Buffer {
  const n = encoded.length;
  let std = "";
  for (let i = 0; i < n; i++) {
    const c = encoded[i];
    if (c === "$") {
      std += "=";
    } else {
      const idx = QODER_CUSTOM_ALPHABET.indexOf(c);
      std += idx >= 0 ? QODER_STD_ALPHABET[idx] : c;
    }
  }
  const third = Math.floor(n / 3);
  const base64 = std.slice(n - third) + std.slice(third, n - third) + std.slice(0, third);
  return Buffer.from(base64, "base64");
}
