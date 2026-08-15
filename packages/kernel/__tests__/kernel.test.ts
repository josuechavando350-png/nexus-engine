import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LEVELS,
  FABRIC_DOMAINS,
  MATURITY_STATES,
  NEXUS_KERNEL_CONTRACT_VERSION,
  V7_FABRIC_CONTRACTS,
  assertKernelRef,
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
  });
});
