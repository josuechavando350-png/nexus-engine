import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const coreRoot = join(root);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

function importsOf(source: string): string[] {
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  const imports: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) imports.push(match[1]);
    }
  }
  return imports;
}

describe("NEXUS Core boundaries", () => {
  it("does not import apps or experimental", () => {
    const violations: string[] = [];

    for (const file of walk(coreRoot)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importsOf(source)) {
        if (
          specifier === "@nexus/experimental" ||
          specifier.startsWith("@nexus/experimental/") ||
          specifier.includes("/apps/") ||
          specifier.includes("/experimental/") ||
          specifier.startsWith("../../../apps") ||
          specifier.startsWith("../../experimental") ||
          specifier.startsWith("../../../experimental")
        ) {
          violations.push(`${relative(coreRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps foundation isolated from higher Core layers", () => {
    const foundation = join(coreRoot, "foundation");
    const violations: string[] = [];

    for (const file of walk(foundation)) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importsOf(source)) {
        if (
          specifier.includes("/data/") ||
          specifier.includes("/motion/") ||
          specifier.includes("/components/") ||
          specifier.includes("/composition/") ||
          specifier.includes("/a11y/")
        ) {
          violations.push(`${relative(coreRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
