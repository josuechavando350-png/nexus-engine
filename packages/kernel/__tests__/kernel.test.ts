import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LEVELS,
  FABRIC_DOMAINS,
  MATURITY_STATES,
  NEXUS_KERNEL_CONTRACT_VERSION,
  V7_FABRIC_CONTRACTS,
  assertKernelRef,
  contractEvidenceIdFor,
  contractIdFor,
  isProductionProven
} from "../index";

describe("NEXUS V7 Kernel contracts", () => {
  it("keeps the canonical V7 maturity vocabulary stable", () => {
    expect(MATURITY_STATES).toEqual([
      "PLANNED",
      "EXPERIMENTAL",
      "IMPLEMENTED",
      "TESTED",
      "BENCHMARKED",
      "INTEGRATED",
      "OPERATIONALLY_EVIDENCED",
      "PRODUCTION_PROVEN"
    ]);
  });

  it("declares every Enterprise Fabric domain exactly once", () => {
    expect(new Set(FABRIC_DOMAINS).size).toBe(FABRIC_DOMAINS.length);
    expect(V7_FABRIC_CONTRACTS.map((descriptor) => descriptor.contract.domain)).toEqual(FABRIC_DOMAINS);
  });

  it("describes contracts without claiming production proof", () => {
    expect(V7_FABRIC_CONTRACTS.every((descriptor) => descriptor.adapterBoundary === "SPEC_ONLY")).toBe(true);
    expect(V7_FABRIC_CONTRACTS.some(isProductionProven)).toBe(false);
    expect(EVIDENCE_LEVELS).toContain("PRODUCTION_AUDIT");
  });

  it("validates V7 kernel contract references", () => {
    const ref = V7_FABRIC_CONTRACTS[0]?.contract;
    expect(ref).toBeDefined();
    expect(assertKernelRef(ref!)).toEqual(ref);
    expect(() =>
      assertKernelRef({
        id: "nexus.v8.future",
        version: NEXUS_KERNEL_CONTRACT_VERSION,
        domain: "ENTERPRISE_ONTOLOGY"
      })
    ).toThrow(/nexus\.v7/);
    expect(() =>
      assertKernelRef({
        id: "nexus.v7.identity",
        version: NEXUS_KERNEL_CONTRACT_VERSION,
        domain: "ENTERPRISE_ONTOLOGY"
      })
    ).toThrow(/does not match/);
  });

  it("derives deterministic contract and evidence ids from the same canonical slug", () => {
    for (const domain of FABRIC_DOMAINS) {
      const descriptor = V7_FABRIC_CONTRACTS.find((item) => item.contract.domain === domain);
      expect(descriptor?.contract.id).toBe(contractIdFor(domain));
      expect(descriptor?.evidence[0]?.evidenceId).toBe(contractEvidenceIdFor(domain));
      expect(descriptor?.evidence[0]?.evidenceId).toMatch(/^ev\.v7\.[a-z0-9]+(?:-[a-z0-9]+)*\.contract$/);
    }
  });
});
