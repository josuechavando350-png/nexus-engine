import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("NEXUS V2 package boundaries", () => {
  it("keeps Experience Engine pure TypeScript without React/Next imports", () => {
    const files = walk(join(root, "packages/experience")).filter((file) => file.endsWith(".ts") && !file.includes("/__tests__/"));
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/from\s+["']react["']/);
    expect(source).not.toMatch(/from\s+["']next(?:\/[^"']*)?["']/);
  });

  it("keeps Core independent from Experience Engine", () => {
    const files = walk(join(root, "packages/core")).filter((file) => /\.(ts|tsx)$/.test(file));
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toContain("@nexus/experience");
  });

  it("keeps capability and recipe contracts free from common UI implementation keys", () => {
    const files = ["capabilities.ts", "recipes.ts"].map((file) => readFileSync(join(root, "packages/experience", file), "utf8"));
    for (const source of files) {
      expect(source).not.toMatch(/buttonVariant|cardVariant|heroVariant|borderRadius|fontFamily|className/);
    }
  });
});
