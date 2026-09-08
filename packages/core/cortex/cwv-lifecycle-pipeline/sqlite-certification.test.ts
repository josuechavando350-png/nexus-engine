import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCwvBuildOptimizationPlan } from "./index";
import { CwvSourceBoundCertificationError, SqliteCwvSourceBoundCertificationStore } from "./sqlite-certification";

const dirs: string[] = [];
const D1 = `sha256:${"1".repeat(64)}` as const;
const D2 = `sha256:${"2".repeat(64)}` as const;
const D3 = `sha256:${"3".repeat(64)}` as const;
const SOURCE = "a".repeat(40);
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function input() {
  return {
    deploymentId: "pyme-site-0001",
    sourceRevision: SOURCE,
    profileDigest: D1,
    policyDigest: D2,
    plan: createCwvBuildOptimizationPlan("pyme-cwv-policy-v1", [{ actionId: "critical-css-main", kind: "CRITICAL_CSS", target: "/app.css", required: true }]),
    receipts: [{ actionId: "critical-css-main", kind: "CRITICAL_CSS" as const, status: "APPLIED" as const, beforeDigest: D1, afterDigest: D2, evidenceDigest: D3 }],
    before: { lcpMs: 2800, inpMs: 250, cls: 0.08, ttfbMs: 700, totalJsBytes: 400_000, totalCssBytes: 90_000, imageBytes: 1_000_000, fontBytes: 180_000 },
    after: { lcpMs: 2200, inpMs: 180, cls: 0.04, ttfbMs: 550, totalJsBytes: 360_000, totalCssBytes: 70_000, imageBytes: 900_000, fontBytes: 170_000 },
    proofs: { visual: D2, functional: D3 },
    guardrails: { maxLcpRegressionMs: 100, maxInpRegressionMs: 50, maxClsRegression: 0.01, maxTtfbRegressionMs: 100, maxJsGrowthBytes: 10_000, maxCssGrowthBytes: 5_000, maxImageGrowthBytes: 10_000, maxFontGrowthBytes: 5_000 },
  } as const;
}

describe("CORTEX #33 source-bound certification", () => {
  it("persists deterministic evidence and replays the same source idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-cwv-cert-")); dirs.push(dir);
    const store = new SqliteCwvSourceBoundCertificationStore(join(dir, "cert.sqlite"), () => Date.parse("2026-09-08T05:00:00.000Z"));
    const first = store.certify(input());
    expect(store.certify(input())).toEqual(first);
    expect(first.certificationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(store.get("pyme-site-0001", SOURCE)).toEqual(first);
    store.close();
  });

  it("rejects conflicting policy/evidence for the same deployment and exact source SHA", () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-cwv-cert-")); dirs.push(dir);
    const store = new SqliteCwvSourceBoundCertificationStore(join(dir, "cert.sqlite"));
    store.certify(input());
    expect(() => store.certify({ ...input(), policyDigest: D3 })).toThrow(CwvSourceBoundCertificationError);
    store.close();
  });
});
