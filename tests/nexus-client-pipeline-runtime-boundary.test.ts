import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNexusClientPipelineWithWorkspaceRuntime } from "../scripts/nexus-client-pipeline.mjs";

const roots: string[] = [];
const worktrees: string[] = [];
const REPOSITORY_ROOT = process.cwd();

afterEach(() => {
  while (worktrees.length) {
    const worktree = worktrees.pop();
    if (worktree) {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: REPOSITORY_ROOT,
        stdio: "pipe",
      });
    }
  }
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function externalTempSpec(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-client-runtime-boundary-"));
  roots.push(root);
  const path = join(root, "spec.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function linkInstalledDependencies(root: string) {
  const sourceModules = join(REPOSITORY_ROOT, "node_modules");
  const targetModules = join(root, "node_modules");
  mkdirSync(targetModules);
  for (const entry of readdirSync(sourceModules)) {
    const source = join(sourceModules, entry);
    const target = join(targetModules, entry);
    const type = statSync(source).isDirectory() ? "junction" : "file";
    symlinkSync(source, target, type);
  }
}

function isolatedCheckout() {
  const container = mkdtempSync(join(tmpdir(), "nexus-client-runtime-checkout-"));
  roots.push(container);
  const root = join(container, "repo");
  execFileSync("git", ["worktree", "add", "--detach", root, "HEAD"], {
    cwd: REPOSITORY_ROOT,
    stdio: "pipe",
  });
  worktrees.push(root);
  linkInstalledDependencies(root);

  const status = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(status).toBe("");

  return {
    root,
    runner: join(root, "scripts", "nexus-client-run.mjs"),
    missingTargetSpec: join(root, "tests", "fixtures", "client-runtime-missing-target.json"),
    invalidTargetSpec: join(root, "tests", "fixtures", "client-runtime-invalid-target.json"),
    selfRevisionSpec: join(root, "tests", "fixtures", "client-runtime-self-revision.json"),
  };
}

function executeProductionClient(
  checkout: ReturnType<typeof isolatedCheckout>,
  specPath: string,
  cwd = checkout.root,
) {
  return spawnSync(process.execPath, [checkout.runner, "--spec", specPath], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

describe("NEXUS client pipeline production boundary", () => {
  it("refuses workspace execution without an explicit runtime target before evaluating the pipeline brief", async () => {
    await expect(runNexusClientPipelineWithWorkspaceRuntime({})).rejects.toThrow(/requires spec\.runtime\.target/);
  });

  it("refuses a configured runtime target when the factory does not assemble the required production adapters", async () => {
    const runtimeFactory = async () => ({});
    await expect(runNexusClientPipelineWithWorkspaceRuntime(
      { runtime: { target: "client-a" } },
      { runtimeFactory },
    )).rejects.toThrow(/did not assemble required production adapter render/);
  });

  it("executes the supported production entrypoint through an isolated exact-HEAD TypeScript runtime", () => {
    const checkout = isolatedCheckout();
    const execution = executeProductionClient(checkout, checkout.missingTargetSpec);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("workspace runtime execution requires spec.runtime.target");
    expect(execution.stderr).not.toContain("globally clean exact-SHA repository");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("ExperienceBrief");
  });

  it("loads real workspace project discovery before pipeline evaluation", () => {
    const checkout = isolatedCheckout();
    const execution = executeProductionClient(checkout, checkout.invalidTargetSpec);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("client runtime target definitely-not-a-workspace-client is not a discovered workspace app");
    expect(execution.stderr).not.toContain("globally clean exact-SHA repository");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("ExperienceBrief");
  });

  it("binds Git preflight and runtime discovery to the isolated NEXUS checkout instead of caller cwd", () => {
    const checkout = isolatedCheckout();
    const execution = executeProductionClient(checkout, checkout.invalidTargetSpec, dirname(checkout.invalidTargetSpec));
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("client runtime target definitely-not-a-workspace-client is not a discovered workspace app");
    expect(execution.stderr).not.toContain("globally clean exact-SHA repository");
    expect(execution.stderr).not.toContain("not a git repository");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("rejects a persisted sourceRevision before the TypeScript engine graph is loaded", () => {
    const checkout = isolatedCheckout();
    const execution = executeProductionClient(checkout, checkout.selfRevisionSpec);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("production client spec must not self-declare sourceRevision; NEXUS binds it to the verified Git HEAD");
    expect(execution.stderr).not.toContain("globally clean exact-SHA repository");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("client runtime target");
  });

  it("rejects uncommitted production specs outside the isolated NEXUS repository", () => {
    const checkout = isolatedCheckout();
    const execution = executeProductionClient(
      checkout,
      externalTempSpec({ runtime: { target: "definitely-not-a-workspace-client" } }),
    );
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("production client spec must stay inside the NEXUS repository");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("client runtime target");
  });
});
