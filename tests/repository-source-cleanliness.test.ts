import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRepositorySourceClean,
  inspectRepositorySourceCleanliness,
} from "../scripts/repository-source-cleanliness.mjs";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "nexus-source-cleanliness-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "nexus-test@example.invalid"]);
  git(root, ["config", "user.name", "NEXUS Test"]);
  mkdirSync(join(root, "apps", "client-a"), { recursive: true });
  writeFileSync(join(root, "apps", "client-a", "source.ts"), "export const value = 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

describe("repository source cleanliness", () => {
  it("allows only caller-declared governed derived evidence while source remains pristine", () => {
    const root = createRepository();
    mkdirSync(join(root, "artifacts", "browser-capture"), { recursive: true });
    writeFileSync(join(root, "artifacts", "browser-capture", "evidence.json"), "{}\n");

    const inspection = inspectRepositorySourceCleanliness(root, { allowedUntrackedRoots: ["artifacts"] });
    expect(inspection.clean).toBe(true);
    expect(inspection.trackedChanges).toEqual([]);
    expect(inspection.disallowedUntrackedPaths).toEqual([]);
    expect(inspection.allowedUntrackedPaths).toEqual(["artifacts/browser-capture/evidence.json"]);
    expect(() => assertRepositorySourceClean(root, { allowedUntrackedRoots: ["artifacts"] })).not.toThrow();
  });

  it("rejects arbitrary untracked source even when governed evidence also exists", () => {
    const root = createRepository();
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "decision.json"), "{}\n");
    writeFileSync(join(root, "apps", "client-a", "untracked.ts"), "export const injected = true;\n");

    const inspection = inspectRepositorySourceCleanliness(root, { allowedUntrackedRoots: ["artifacts"] });
    expect(inspection.clean).toBe(false);
    expect(inspection.allowedUntrackedPaths).toEqual(["artifacts/decision.json"]);
    expect(inspection.disallowedUntrackedPaths).toEqual(["apps/client-a/untracked.ts"]);
    expect(() => assertRepositorySourceClean(root, { allowedUntrackedRoots: ["artifacts"], context: "decision trace source" }))
      .toThrow(/untracked source paths: apps\/client-a\/untracked\.ts/);
  });

  it("rejects tracked source modifications regardless of allowed evidence roots", () => {
    const root = createRepository();
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "evidence.json"), "{}\n");
    writeFileSync(join(root, "apps", "client-a", "source.ts"), "export const value = 2;\n");

    const inspection = inspectRepositorySourceCleanliness(root, { allowedUntrackedRoots: ["artifacts"] });
    expect(inspection.clean).toBe(false);
    expect(inspection.trackedChanges.length).toBeGreaterThan(0);
    expect(inspection.disallowedUntrackedPaths).toEqual([]);
    expect(() => assertRepositorySourceClean(root, { allowedUntrackedRoots: ["artifacts"] })).toThrow(/tracked changes:/);
  });

  it("uses path-segment-aware allowlisting and refuses repository-root allowlists", () => {
    const root = createRepository();
    mkdirSync(join(root, "artifacts-escape"), { recursive: true });
    writeFileSync(join(root, "artifacts-escape", "payload.json"), "{}\n");

    const inspection = inspectRepositorySourceCleanliness(root, { allowedUntrackedRoots: ["artifacts"] });
    expect(inspection.clean).toBe(false);
    expect(inspection.disallowedUntrackedPaths).toEqual(["artifacts-escape/payload.json"]);
    expect(() => inspectRepositorySourceCleanliness(root, { allowedUntrackedRoots: ["."] })).toThrow(/equals repository root/);
  });
});
