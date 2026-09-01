import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNexusClientPipelineWithWorkspaceRuntime } from "../scripts/nexus-client-pipeline.mjs";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempSpec(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nexus-client-runtime-boundary-"));
  roots.push(root);
  const path = join(root, "spec.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function executeClientScript(script: string, specPath: string) {
  return spawnSync(process.execPath, [script, "--spec", specPath], {
    cwd: process.cwd(),
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

  it.each([
    "scripts/nexus-client-pipeline.mjs",
    "scripts/nexus-client-run.mjs",
  ])("proves %s crosses the workspace-runtime boundary instead of silently running adapterless", (script) => {
    const execution = executeClientScript(script, tempSpec({}));
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("workspace runtime execution requires spec.runtime.target");
    expect(execution.stderr).not.toContain("ExperienceBrief");
  });
});
