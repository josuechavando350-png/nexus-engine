import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNexusClientPipelineWithWorkspaceRuntime } from "../scripts/nexus-client-pipeline.mjs";

const roots: string[] = [];
const REPOSITORY_ROOT = process.cwd();
const RUNNER = join(REPOSITORY_ROOT, "scripts", "nexus-client-run.mjs");
const MISSING_TARGET_SPEC = join(REPOSITORY_ROOT, "tests", "fixtures", "client-runtime-missing-target.json");
const INVALID_TARGET_SPEC = join(REPOSITORY_ROOT, "tests", "fixtures", "client-runtime-invalid-target.json");
const SELF_REVISION_SPEC = join(REPOSITORY_ROOT, "tests", "fixtures", "client-runtime-self-revision.json");

afterEach(() => {
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

function executeProductionClient(specPath: string, cwd = REPOSITORY_ROOT) {
  return spawnSync(process.execPath, [RUNNER, "--spec", specPath], {
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

  it("executes the supported production entrypoint through the repository TypeScript runtime", () => {
    const execution = executeProductionClient(MISSING_TARGET_SPEC);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("workspace runtime execution requires spec.runtime.target");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("ExperienceBrief");
  });

  it("loads real workspace project discovery before pipeline evaluation", () => {
    const execution = executeProductionClient(INVALID_TARGET_SPEC);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("client runtime target definitely-not-a-workspace-client is not a discovered workspace app");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("ExperienceBrief");
  });

  it("binds Git preflight and runtime discovery to the NEXUS checkout instead of caller cwd", () => {
    const execution = executeProductionClient(INVALID_TARGET_SPEC, dirname(INVALID_TARGET_SPEC));
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("client runtime target definitely-not-a-workspace-client is not a discovered workspace app");
    expect(execution.stderr).not.toContain("not a git repository");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("rejects a persisted sourceRevision before the TypeScript engine graph is loaded", () => {
    const execution = executeProductionClient(SELF_REVISION_SPEC);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("production client spec must not self-declare sourceRevision; NEXUS binds it to the verified Git HEAD");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("client runtime target");
  });

  it("rejects uncommitted production specs outside the NEXUS repository", () => {
    const execution = executeProductionClient(externalTempSpec({ runtime: { target: "definitely-not-a-workspace-client" } }));
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("production client spec must stay inside the NEXUS repository");
    expect(execution.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(execution.stderr).not.toContain("client runtime target");
  });
});
