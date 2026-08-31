import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

function request() {
  return {
    tenantId: "tenant-a",
    scope: "public-site",
    documentUrl: "https://example.com/",
    candidates: [
      {
        id: "critical-css",
        target: "/assets/site.css",
        kind: "subresource",
        action: "preload",
        as: "style",
        estimatedBytes: 18_000,
        priority: 1,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
      },
      {
        id: "next-page",
        target: "/next",
        kind: "navigation",
        action: "prefetch",
        estimatedBytes: 90_000,
        priority: 0.9,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
        eagerness: "moderate",
      },
      {
        id: "high-confidence-page",
        target: "/contact",
        kind: "navigation",
        action: "prerender",
        estimatedBytes: 120_000,
        priority: 0.8,
        sideEffectFree: true,
        requiresAuthentication: false,
        cacheSafety: "CACHEABLE",
        eagerness: "conservative",
      },
    ],
    context: { saveData: false, prefersReducedData: false, effectiveType: "4g" },
  };
}

function run(input: unknown, extra: readonly string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "nexus-speculative-"));
  try {
    const inputPath = join(directory, "input.json");
    writeFileSync(inputPath, JSON.stringify(input));
    return spawnSync(process.execPath, [
      "scripts/verify-speculative-delivery.mjs",
      "--input", inputPath,
      "--tenant", "tenant-a",
      "--scope", "public-site",
      ...extra,
    ], { cwd: root, encoding: "utf8", timeout: 15_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("speculative delivery operational consumer", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["--filter", "@nexus/transport-http3", "build"], {
      cwd: root,
      stdio: "pipe",
      timeout: 60_000,
    });
  });

  it("emits preload plus Speculation Rules without fabricating browser or BBRv3 observation", () => {
    const execution = run(request());
    expect(execution.status).toBe(0);
    const output = JSON.parse(execution.stdout) as {
      resourceHints: Array<{ rel: string }>;
      speculationRules: { prefetch?: unknown[]; prerender?: unknown[] };
      browserStatus: string;
      bbrv3: { state: string; active: boolean };
      planDigest: string;
    };
    expect(output.resourceHints.some((hint) => hint.rel === "preload")).toBe(true);
    expect(output.speculationRules.prefetch).toHaveLength(1);
    expect(output.speculationRules.prerender).toHaveLength(1);
    expect(output.browserStatus).toBe("NOT_VERIFIED");
    expect(output.bbrv3).toMatchObject({ state: "NOT_VERIFIED", active: false });
    expect(output.planDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects tenant escalation", () => {
    const input = { ...request(), tenantId: "tenant-b" };
    const execution = run(input);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("tenant mismatch");
  });

  it("rejects malformed or widened request contracts", () => {
    const execution = run({ ...request(), privileged: true });
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("unknown field privileged");
  });

  it("does not allow an observed-BBRv3 requirement without a live probe", () => {
    const execution = run(request(), ["--require-bbrv3-observed"]);
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain("requires --probe-bbrv3");
  });
});
