import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digestFiles, normalizedPath, restoreFromCache, storeInCache, walkFiles } from "./build-core.mjs";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "nexus-build-core-"));
  roots.push(root);
  return root;
}

describe("deterministic build core", () => {
  it("hashes a file tree independently of creation order", () => {
    const a = tempRoot();
    const b = tempRoot();
    mkdirSync(join(a, "x"));
    mkdirSync(join(b, "x"));
    writeFileSync(join(a, "x", "b.txt"), "B");
    writeFileSync(join(a, "x", "a.txt"), "A");
    writeFileSync(join(b, "x", "a.txt"), "A");
    writeFileSync(join(b, "x", "b.txt"), "B");
    const aFiles = walkFiles(a);
    const bFiles = walkFiles(b);
    expect(digestFiles(aFiles, a)).toBe(digestFiles(bFiles, b));
  });

  it("normalizes platform separators for manifests", () => {
    expect(normalizedPath("a\\b\\c")).toBe("a/b/c");
  });

  it("round-trips output bytes through the content cache", () => {
    const root = tempRoot();
    const targetDir = join(root, "packages", "demo");
    mkdirSync(join(targetDir, "dist"), { recursive: true });
    writeFileSync(join(targetDir, "dist", "index.js"), "export const x = 1;\n");
    const target = { dir: targetDir, relativeDir: "packages/demo", command: "noop" };
    storeInCache(target, "abc123", root);
    rmSync(join(targetDir, "dist"), { recursive: true, force: true });
    expect(restoreFromCache(target, "abc123", root)).toBe(true);
    expect(readFileSync(join(targetDir, "dist", "index.js"), "utf8")).toBe("export const x = 1;\n");
  });
});
