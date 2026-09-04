import { describe, expect, it } from "vitest";
import { qoderDecodeBody, qoderEncodeBody } from "../protocol/encoding.js";

describe("qoderEncodeBody", () => {
  it("encodes a simple string", () => {
    const result = qoderEncodeBody("hello");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    // Should not contain standard base64 padding char '='
    expect(result).not.toContain("=");
  });

  it("encodes a Buffer", () => {
    const buf = Buffer.from("hello world");
    const result = qoderEncodeBody(buf);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("produces deterministic output", () => {
    const a = qoderEncodeBody("test input");
    const b = qoderEncodeBody("test input");
    expect(a).toBe(b);
  });

  it("produces different output for different inputs", () => {
    const a = qoderEncodeBody("input A");
    const b = qoderEncodeBody("input B");
    expect(a).not.toBe(b);
  });

  it("handles empty string", () => {
    const result = qoderEncodeBody("");
    expect(result).toBe("");
  });

  it("handles empty Buffer", () => {
    const result = qoderEncodeBody(Buffer.alloc(0));
    expect(result).toBe("");
  });

  it("stays wire-compatible with the original rearrange+map codec", () => {
    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const stdAlpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    function legacyEncode(plaintext: string | Buffer): string {
      const std = Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
      const n = std.length;
      const a = Math.floor(n / 3);
      const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
      let out = "";
      for (let i = 0; i < n; i++) {
        const c = rearranged[i];
        if (c === "=") out += "$";
        else {
          const idx = stdAlpha.indexOf(c);
          out += idx >= 0 ? custom[idx] : c;
        }
      }
      return out;
    }
    const samples: Array<string | Buffer> = ["hello", "a", "The quick brown fox", Buffer.from([0x00, 0xff, 0x80]), JSON.stringify({ n: 42 })];
    for (const sample of samples) {
      expect(qoderEncodeBody(sample)).toBe(legacyEncode(sample));
    }
  });

  it("round-trips a larger buffer", () => {
    const binary = Buffer.alloc(100_000);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) & 0xff;
    const encoded = qoderEncodeBody(binary);
    expect(qoderDecodeBody(encoded).equals(binary)).toBe(true);
  });

  it("replaces '=' padding with '$'", () => {
    // Base64 of "a" is "YQ==" which has padding — our encoding should use $
    const result = qoderEncodeBody("a");
    expect(result).not.toContain("=");
    expect(result).toContain("$");
  });

  it("uses custom alphabet (not standard base64)", () => {
    const result = qoderEncodeBody("The quick brown fox");
    // Standard base64 would use A-Za-z0-9+/=
    // Our encoding uses a custom alphabet, so the output should differ
    const stdBase64 = Buffer.from("The quick brown fox").toString("base64");
    expect(result).not.toBe(stdBase64);
  });

  it("handles binary content", () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
    const result = qoderEncodeBody(binary);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    const result = qoderEncodeBody(json);
    expect(result).toBeTruthy();
    expect(result).not.toContain("=");
  });

  it("round-trips strings, JSON, and binary", () => {
    const samples = ["hello", "a", JSON.stringify({ key: "value", num: 42 })];
    for (const sample of samples) {
      expect(qoderDecodeBody(qoderEncodeBody(sample)).toString("utf8")).toBe(sample);
    }
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
    expect(qoderDecodeBody(qoderEncodeBody(binary)).equals(binary)).toBe(true);
  });
});
