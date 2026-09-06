import { describe, expect, it } from "vitest";
import type { OntologyScope } from "@nexus/ontology";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { DurableEnhancedConversionControl } from "./runtime-control";

const scope: OntologyScope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });

describe("CORTEX #10 durable control", () => {
  it("defaults KILLED and advances by compare-and-set revision", () => {
    let now = Date.parse("2026-09-06T12:00:00.000Z");
    const store = new InMemoryOntologyTransactionStore();
    const control = new DurableEnhancedConversionControl(store, scope, () => now);
    expect(control.read()).toEqual({ mode: "KILLED", revision: 0, updatedAt: "1970-01-01T00:00:00.000Z" });
    expect(control.setMode("OBSERVE_ONLY", 0)).toEqual({ mode: "OBSERVE_ONLY", revision: 1, updatedAt: "2026-09-06T12:00:00.000Z" });
    now += 1_000;
    expect(control.setMode("ACTIVE", 1)).toEqual({ mode: "ACTIVE", revision: 2, updatedAt: "2026-09-06T12:00:01.000Z" });
    expect(() => control.setMode("KILLED", 1)).toThrowError(/revision conflict/u);
  });
});
