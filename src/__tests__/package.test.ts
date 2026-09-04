import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  files: string[];
  pi: { extensions: string[] };
};

describe("Pi extension package", () => {
  it("is named pi-qoder and points pi.extensions at TypeScript source", () => {
    expect(pkg.name).toBe("pi-qoder");
    expect(pkg.files).toContain("src");
    expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
  });
});
