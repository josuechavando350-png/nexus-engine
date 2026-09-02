import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDecisionTrace, auditDecisionCoverage } from "../packages/quality/decision-trace.ts";
import { inspectClientDecisionPassportEvidence } from "../scripts/client-decision-passport-contract.mjs";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceRevision = "a".repeat(40);
const projectId = "client-a";

function fixture(overrides: { decisionBuildDigest?: string; browserBuildDigest?: string; rendered?: string[]; coverageRequired?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nexus-decision-passport-"));
  roots.push(root);
  const decisionRoot = join(root, "artifacts", "decision-trace");
  const browserRoot = join(root, "artifacts", "browser-capture", projectId);
  mkdirSync(decisionRoot, { recursive: true });
  mkdirSync(browserRoot, { recursive: true });

  const rendered = overrides.rendered ?? ["contact", "hero"];
  const entries = rendered.map((elementId) => ({
    elementId,
    property: "audit-role",
    value: `role-${elementId}`,
    authority: "ENGINE_RULE" as const,
    authorityRef: "NEXUS_CLIENT_DECISION_PROVENANCE_V2",
    rationale: `Rendered client element ${elementId} participates in the governed delivery surface.`,
  }));
  const trace = createDecisionTrace(entries);
  const coverage = auditDecisionCoverage(overrides.coverageRequired ?? rendered, trace);
  const decisionBuildDigest = overrides.decisionBuildDigest ?? sha256("same-build");
  const browserBuildDigest = overrides.browserBuildDigest ?? decisionBuildDigest;
  const manifestSha256 = sha256("build-manifest");

  writeFileSync(join(decisionRoot, `${projectId}.json`), `${JSON.stringify({
    schemaVersion: 2,
    authority: "NEXUS_CLIENT_DECISION_PROVENANCE_V2",
    projectId,
    sourceRevision,
    route: "/",
    build: { authority: "NEXUS_MCP_BUILD_MANIFEST_V1", target: `apps/${projectId}`, outputDigest: decisionBuildDigest, manifestSha256 },
    renderedElementIds: [...rendered].sort((a, b) => a.localeCompare(b, "en")),
    renderedHtmlByteLength: 1234,
    trace,
    coverage,
  }, null, 2)}\n`);
  writeFileSync(join(browserRoot, "evidence-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    authority: "NEXUS_CLIENT_BROWSER_EVIDENCE_V1",
    projectId,
    sourceRevision,
    route: "/",
    build: { authority: "NEXUS_MCP_BUILD_MANIFEST_V1", target: `apps/${projectId}`, outputDigest: browserBuildDigest, manifestSha256 },
  }, null, 2)}\n`);
  return root;
}

describe("client Decision Trace to Quality Passport binding", () => {
  it("accepts a rendered-DOM trace only when browser evidence is from the same exact build", async () => {
    const result = await inspectClientDecisionPassportEvidence(fixture(), projectId, sourceRevision);
    expect(result?.check.status).toBe("PASS");
    expect(result?.trace.authority).toBe("NEXUS_DECISION_TRACE_V1");
    expect(result?.check.evidenceIds).toHaveLength(2);
  });

  it("rejects decision and browser evidence from different exact builds", async () => {
    await expect(inspectClientDecisionPassportEvidence(fixture({
      decisionBuildDigest: sha256("decision-build"),
      browserBuildDigest: sha256("browser-build"),
    }), projectId, sourceRevision)).rejects.toThrow(/different exact-SHA builds/);
  });

  it("rejects coverage that no longer matches the rendered element inventory", async () => {
    await expect(inspectClientDecisionPassportEvidence(fixture({
      rendered: ["contact", "hero"],
      coverageRequired: ["hero"],
    }), projectId, sourceRevision)).rejects.toThrow(/coverage is not PASS|not bound to the rendered element inventory/);
  });
});
