import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import { createProgrammaticSeoPolicy } from "./index";
import { ProgrammaticSeoRuntimeController } from "./runtime-control";

const scope = Object.freeze({ tenantId: "tenant-control", organizationId: "org-control", brandId: "cano-penal" });
const NOW = Date.parse("2026-09-06T04:00:00.000Z");
const policy = createProgrammaticSeoPolicy({ policyId: "programmatic-control", version: "v1", maxCatalogAgeMs: 300_000, maxPages: 20, minDistinctiveStatements: 1, maxPairwiseShingleSimilarity: 0.85, maxRouteDepth: 5, maxWriteRetries: 3, mode: "ACTIVE" });

describe("programmatic SEO runtime control", () => {
  it("persists a kill and its digested history across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-programmatic-control-"));
    const path = join(directory, "state.sqlite");
    try {
      const firstStore = new SqliteOntologyTransactionStore(path);
      const first = new ProgrammaticSeoRuntimeController(firstStore, scope, policy.digest, policy.mode, () => NOW);
      const killed = first.set({ expectedRevision: 0, mode: "KILLED", reason: "certified incident containment" });
      expect(killed).toMatchObject({ mode: "KILLED", revision: 1 });
      expect(first.history()).toHaveLength(1);
      firstStore.close();

      const secondStore = new SqliteOntologyTransactionStore(path);
      const second = new ProgrammaticSeoRuntimeController(secondStore, scope, policy.digest, policy.mode, () => NOW + 1_000);
      expect(second.effectiveMode()).toBe("KILLED");
      expect(second.current().revision).toBe(1);
      expect(second.history()[0]).toMatchObject({ fromMode: "ACTIVE", toMode: "KILLED", targetRevision: 1 });
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cannot weaken a restrictive configured mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-programmatic-control-"));
    try {
      const store = new SqliteOntologyTransactionStore(join(directory, "state.sqlite"));
      const configuredKilled = new ProgrammaticSeoRuntimeController(store, scope, policy.digest, "KILLED", () => NOW);
      expect(() => configuredKilled.set({ expectedRevision: 0, mode: "ACTIVE", reason: "unsafe weakening request" })).toThrow(/cannot weaken/i);
      expect(configuredKilled.effectiveMode()).toBe("KILLED");
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
