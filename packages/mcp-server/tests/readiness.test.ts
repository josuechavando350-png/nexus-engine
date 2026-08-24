import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "../src/artifacts.js";
import { DEFAULT_BUILD_TIMEOUT_MS } from "../src/build.js";
import { ConcurrencyLimitError, ExecutionCoordinator } from "../src/execution.js";
import { defaultGateTimeoutMs } from "../src/gates.js";
import { enabledToolsFromEnv, runtimeLimitsFromEnv } from "../src/policy.js";
import { DEFAULT_PROJECT_VALIDATION_TIMEOUT_MS } from "../src/project-new.js";

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "nexus-readiness-repo-")); roots.push(root);
  await exec("git", ["init", "-q"], { cwd: root }); await exec("git", ["config", "user.name", "Test"], { cwd: root }); await exec("git", ["config", "user.email", "test@nexus.invalid"], { cwd: root });
  await writeFile(join(root, "state.txt"), "source\n"); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-qm", "source"], { cwd: root });
  return { root, sha: (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim() };
}

describe("remote readiness isolation", () => {
  it("uses distinct ephemeral worktrees and cannot mutate the source checkout", async () => {
    const { root, sha } = await repository(); const worktrees = join(root, ".isolated"); const coordinator = new ExecutionCoordinator(root, worktrees, 2);
    const observed = await Promise.all(["one", "two"].map((id) => coordinator.run(id, sha, true, async (isolatedRoot) => { await writeFile(join(isolatedRoot, "state.txt"), `${id}\n`); return isolatedRoot; })));
    expect(new Set(observed).size).toBe(2); expect(await readFile(join(root, "state.txt"), "utf8")).toBe("source\n"); expect(coordinator.active).toBe(0);
    expect((await exec("git", ["worktree", "list", "--porcelain"], { cwd: root })).stdout).not.toContain(worktrees);
  });

  it("rejects work above the configured concurrency limit", async () => {
    const { root, sha } = await repository(); const coordinator = new ExecutionCoordinator(root, join(root, ".isolated"), 1); let release!: () => void;
    const held = coordinator.run("held", sha, false, async () => await new Promise<void>((resolve) => { release = resolve; }));
    await expect(coordinator.run("second", sha, false, async () => undefined)).rejects.toBeInstanceOf(ConcurrencyLimitError); release(); await held;
  });
});

describe("remote readiness artifacts and policy", () => {
  it("preserves historical operation timeouts unless an explicit override is configured", () => {
    expect(runtimeLimitsFromEnv({}).executionTimeoutMs).toBeUndefined();
    expect(defaultGateTimeoutMs("lint")).toBe(300_000);
    expect(defaultGateTimeoutMs("typecheck")).toBe(300_000);
    expect(defaultGateTimeoutMs("test")).toBe(300_000);
    expect(defaultGateTimeoutMs("build")).toBe(900_000);
    expect(defaultGateTimeoutMs("browser")).toBe(900_000);
    expect(defaultGateTimeoutMs("quality-gates")).toBe(900_000);
    expect(DEFAULT_PROJECT_VALIDATION_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_BUILD_TIMEOUT_MS).toBe(900_000);
    expect(runtimeLimitsFromEnv({ NEXUS_MCP_EXECUTION_TIMEOUT_MS: "450000" }).executionTimeoutMs).toBe(450_000);
  });

  it.each(["", "0", "-1", "1.5", "not-a-number", "9007199254740992"])("rejects invalid execution timeout %j", (value) => {
    expect(() => runtimeLimitsFromEnv({ NEXUS_MCP_EXECUTION_TIMEOUT_MS: value })).toThrow(/positive integer/);
  });

  it("stores request-scoped artifacts with digest, manifest and confined retrieval", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-readiness-artifacts-")); roots.push(root); const source = join(root, "source.log"); await writeFile(source, "evidence\n");
    const store = new LocalArtifactStore(join(root, "store"), 1024); const record = await store.putFile("request-1", "gate.log", source, "text/plain", { gate: "lint" });
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/); expect(record.byteLength).toBe(9); expect(await store.manifest("request-1")).toEqual([record]); expect((await store.resolve("request-1", "gate.log"))?.record).toEqual(record); expect((await store.resolve("request-1", "manifest.json"))?.record.mediaType).toBe("application/json"); expect(await store.resolve("request-1", "../source.log")).toBeNull();
  });

  it("preserves every record during concurrent writes to one request manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-readiness-concurrent-artifacts-")); roots.push(root);
    const store = new LocalArtifactStore(join(root, "store"), 1024);
    const sources = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const source = join(root, `source-${index}.log`); await writeFile(source, `evidence-${index}\n`); return source;
    }));
    const records = await Promise.all(sources.map((source, index) => store.putFile("request-concurrent", `gate-${index}.log`, source, "text/plain")));
    const manifest = await store.manifest("request-concurrent");
    expect(manifest).toHaveLength(records.length);
    expect(manifest.map((record) => record.id).sort()).toEqual(records.map((record) => record.id).sort());
  });

  it("rejects an artifact whose stored bytes no longer match its registered digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-readiness-tampered-artifact-")); roots.push(root); const source = join(root, "source.log"); await writeFile(source, "evidence\n");
    const store = new LocalArtifactStore(join(root, "store"), 1024); await store.putFile("request-tampered", "gate.log", source, "text/plain");
    const artifact = await store.resolve("request-tampered", "gate.log"); expect(artifact).not.toBeNull();
    await writeFile(artifact!.path, "tampered\n");
    expect(await store.resolve("request-tampered", "gate.log")).toBeNull();
  });

  it("rejects oversized artifacts and invalid policy values", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-readiness-limits-")); roots.push(root); const source = join(root, "large.log"); await writeFile(source, "too large");
    await expect(new LocalArtifactStore(join(root, "store"), 3).putFile("request-1", "large.log", source, "text/plain")).rejects.toThrow(/exceeds configured/);
    expect(() => runtimeLimitsFromEnv({ NEXUS_MCP_MAX_CONCURRENCY: "0" })).toThrow(/positive integer/); expect(() => enabledToolsFromEnv("nexus_status,unknown")).toThrow(/unknown/);
  });
});
