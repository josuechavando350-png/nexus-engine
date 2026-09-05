import { describe, expect, it } from "vitest";
import { evaluateClientDecisionManifest } from "../scripts/client-decision-contract.mjs";

const entry = (elementId: string) => ({
  elementId,
  property: "audit-role",
  value: `role-${elementId}`,
  authority: "ENGINE_RULE" as const,
  authorityRef: "NEXUS_CLIENT_DECISION_PROVENANCE_V2",
  rationale: `Rendered element ${elementId} is explicitly included in the governed client decision surface.`,
});

const manifest = (entries: ReturnType<typeof entry>[]) => ({
  schemaVersion: 2,
  authority: "NEXUS_CLIENT_DECISION_MANIFEST_V2",
  projectId: "client-a",
  route: "/",
  entries,
});

describe("client decision manifest v2", () => {
  it("passes only when trace entries exactly cover rendered element identities", () => {
    const result = evaluateClientDecisionManifest({
      projectId: "client-a",
      renderedElementIds: ["hero", "contact"],
      manifest: manifest([entry("hero"), entry("contact")]),
    });
    expect(result.coverage.status).toBe("PASS");
    expect(result.coverage.requiredElementIds).toEqual(["contact", "hero"]);
  });

  it("rejects the legacy self-declared elementIds field", () => {
    expect(() => evaluateClientDecisionManifest({
      projectId: "client-a",
      renderedElementIds: ["hero"],
      manifest: { ...manifest([entry("hero")]), elementIds: ["hero"] },
    })).toThrow(/unsupported fields: elementIds/);
  });

  it("rejects trace entries that are missing from or absent in the rendered DOM", () => {
    expect(() => evaluateClientDecisionManifest({
      projectId: "client-a",
      renderedElementIds: ["hero", "contact"],
      manifest: manifest([entry("hero")]),
    })).toThrow(/missing=contact/);

    expect(() => evaluateClientDecisionManifest({
      projectId: "client-a",
      renderedElementIds: ["hero"],
      manifest: manifest([entry("hero"), entry("phantom")]),
    })).toThrow(/unknown=phantom/);
  });

  it("rejects cross-project manifests before trace evaluation", () => {
    expect(() => evaluateClientDecisionManifest({
      projectId: "client-a",
      renderedElementIds: ["hero"],
      manifest: { ...manifest([entry("hero")]), projectId: "client-b" },
    })).toThrow(/project mismatch/);
  });
});
