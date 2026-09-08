import { describe, expect, it } from "vitest";
import { PYME_CAPABILITIES, pymeCapabilityByTechnology, resolvePymeProfile, type PymeCapabilityEvidence } from "./profile";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const SHA = "b".repeat(40);

function readyEvidence(overrides: Partial<Record<number, Partial<PymeCapabilityEvidence>>> = {}): Record<string, PymeCapabilityEvidence> {
  return Object.fromEntries(PYME_CAPABILITIES.map((entry) => {
    const base: PymeCapabilityEvidence = {
      installed: true,
      runtimeReady: true,
      controlReady: true,
      policyDigest: [27, 30, 31, 33].includes(entry.technologyNumber) ? DIGEST : null,
      consentRegistryReady: [30, 31].includes(entry.technologyNumber) ? true : undefined,
      certificationDigest: entry.technologyNumber === 33 ? DIGEST : null,
      sourceRevision: entry.technologyNumber === 33 ? SHA : null,
      statisticalEvidenceReady: entry.technologyNumber === 21 ? false : undefined,
    };
    return [entry.capabilityId, { ...base, ...(overrides[entry.technologyNumber] ?? {}) }];
  }));
}

describe("NEXUS CORTEX PyME capability profile", () => {
  it("contains exactly technologies 15, 20, 21, 27, 30, 31 and 33 and reuses Core implementation references", () => {
    expect(PYME_CAPABILITIES.map((entry) => entry.technologyNumber)).toEqual([15, 20, 21, 27, 30, 31, 33]);
    expect(pymeCapabilityByTechnology(15)?.implementationRef).toBe("@nexus/ontology/cortex/semantic-search");
    expect(pymeCapabilityByTechnology(20)?.implementationRef).toBe("@nexus/ontology/cortex/serverless-form-dlq");
    expect(pymeCapabilityByTechnology(21)?.implementationRef).toContain("bandit-experimentation/control-plane-integration");
    expect(pymeCapabilityByTechnology(27)?.implementationRef).toBe("@nexus/core/cortex/ad-context-edge-personalization");
  });

  it("is deterministic and starts the statistical bandit capability in FALLBACK_ONLY without sufficient evidence", () => {
    const first = resolvePymeProfile(readyEvidence());
    const second = resolvePymeProfile(readyEvidence());
    expect(first).toEqual(second);
    expect(first.ready).toBe(true);
    expect(first.profileDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.capabilities.find((entry) => entry.technologyNumber === 21)?.mode).toBe("FALLBACK_ONLY");
    expect(first.capabilities.filter((entry) => entry.technologyNumber !== 21).every((entry) => entry.mode === "ACTIVE")).toBe(true);
  });

  it("allows #21 to become ACTIVE only when its statistical evidence gate is explicitly ready", () => {
    const resolved = resolvePymeProfile(readyEvidence({ 21: { statisticalEvidenceReady: true } }));
    expect(resolved.capabilities.find((entry) => entry.technologyNumber === 21)?.mode).toBe("ACTIVE");
  });

  it("fails closed when consent or #33 source-bound certification is absent and propagates dependencies", () => {
    const resolved = resolvePymeProfile(readyEvidence({
      30: { consentRegistryReady: false },
      20: { runtimeReady: false },
      33: { certificationDigest: null, sourceRevision: null },
    }));
    expect(resolved.ready).toBe(false);
    expect(resolved.capabilities.find((entry) => entry.technologyNumber === 30)?.reasons).toContain("CONSENT_REGISTRY_NOT_READY");
    expect(resolved.capabilities.find((entry) => entry.technologyNumber === 31)?.reasons).toContain("DEPENDENCY_BLOCKED:serverless-form-dlq");
    expect(resolved.capabilities.find((entry) => entry.technologyNumber === 33)?.reasons).toEqual(expect.arrayContaining(["CWV_CERTIFICATION_MISSING", "SOURCE_REVISION_MISSING"]));
  });

  it("rejects any capability outside the exact PyME allowlist", () => {
    expect(() => resolvePymeProfile(readyEvidence(), [
      ...PYME_CAPABILITIES.slice(0, 6).map((entry) => entry.capabilityId),
      "bidding-revenue-guardrails",
    ])).toThrow(/not part of the default PyME profile/u);
  });
});
