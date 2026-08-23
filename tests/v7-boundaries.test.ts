import { describe, expect, it } from "vitest";
import {
  FABRIC_DOMAINS,
  MATURITY_STATES,
  V7_FABRIC_CONTRACTS
} from "../packages/kernel/index";

describe("NEXUS V7 runtime boundaries", () => {
  it("does not claim production proof through Kernel descriptors", () => {
    expect(MATURITY_STATES).toContain("PRODUCTION_PROVEN");
    expect(FABRIC_DOMAINS).toHaveLength(11);
    expect(V7_FABRIC_CONTRACTS.every((descriptor) => descriptor.maturity !== "PRODUCTION_PROVEN")).toBe(true);
  });

  it("derives canonical evidence ids from every executable TypeScript descriptor", () => {
    for (const descriptor of V7_FABRIC_CONTRACTS) {
      const slug = descriptor.contract.id.replace("nexus.v7.", "");
      expect(descriptor.evidence[0]?.evidenceId).toBe(`ev.v7.${slug}.contract`);
    }
  });
});
