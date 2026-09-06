import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import {
  createProgrammaticSeoBundleRef,
  createProgrammaticSeoCatalogSnapshot,
  createProgrammaticSeoPolicy,
  type ProgrammaticSeoBundle,
  type ProgrammaticSeoBundleRef,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoPublishAction,
  type ProgrammaticSeoPublishReceipt,
  type ProgrammaticSeoPublisher,
  type PublishedProgrammaticSeoBundle,
} from "./index";
import { createProgrammaticSeoProductionRuntime, type ProgrammaticSeoProductionConfig } from "./production-runtime";
import { ProgrammaticSeoRuntimeController } from "./runtime-control";

const NOW = Date.parse("2026-09-06T04:00:00.000Z");
const scope = Object.freeze({ tenantId: "tenant-prod", organizationId: "org-prod", brandId: "cano-penal" });
const policyInput = Object.freeze({ policyId: "cano-programmatic", version: "v1", maxCatalogAgeMs: 300_000, maxPages: 20, minDistinctiveStatements: 1, maxPairwiseShingleSimilarity: 0.85, maxRouteDepth: 5, maxWriteRetries: 3, mode: "ACTIVE" as const });
const config: ProgrammaticSeoProductionConfig = Object.freeze({ version: 1, scope, intervalMs: 300_000, siteId: "cano-penal", baseUrl: "https://canopenal.com/", policy: policyInput });

function snapshot(): ProgrammaticSeoCatalogSnapshot {
  return createProgrammaticSeoCatalogSnapshot({
    sourceId: "approved-cano-content",
    siteId: "cano-penal",
    baseUrl: "https://canopenal.com/",
    observedAt: new Date(NOW).toISOString(),
    pages: [{
      pageId: "home",
      routeSegments: [],
      parentPageId: null,
      locale: "es-MX",
      title: "CANO | Defensa Penal",
      description: "Contenido aprobado de defensa penal.",
      heading: "Defensa penal estratégica",
      bodyText: "Defensa penal estratégica. Contenido aprobado y verificado para la página principal.",
      distinctiveStatements: ["Contenido aprobado y verificado para la página principal."],
      evidenceRefs: ["cano:home:approved"],
      updatedAt: new Date(NOW - 1_000).toISOString(),
      indexable: true,
    }],
  });
}

class Source implements ProgrammaticSeoCatalogProvider {
  async getCatalog(): Promise<ProgrammaticSeoCatalogSnapshot> { return snapshot(); }
}

class KillBeforeApplyPublisher implements ProgrammaticSeoPublisher {
  applyCalls = 0;
  private staged: ProgrammaticSeoBundle | null = null;
  constructor(private readonly kill: () => void) {}
  async stage(bundle: ProgrammaticSeoBundle): Promise<ProgrammaticSeoBundleRef> {
    this.staged = bundle;
    const ref = createProgrammaticSeoBundleRef(bundle.siteId, bundle.digest, `bundle-${bundle.digest.slice(7)}`);
    this.kill();
    return ref;
  }
  async load(): Promise<ProgrammaticSeoBundle> {
    if (!this.staged) throw new Error("missing staged bundle");
    return this.staged;
  }
  async read(): Promise<PublishedProgrammaticSeoBundle | null> { return null; }
  async apply(_action: ProgrammaticSeoPublishAction): Promise<ProgrammaticSeoPublishReceipt> {
    this.applyCalls += 1;
    throw new Error("underlying publisher must never be reached after kill");
  }
}

describe("programmatic SEO production runtime", () => {
  it("re-reads durable control at the final publisher boundary and blocks a late kill", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const policy = createProgrammaticSeoPolicy(policyInput);
    const control = new ProgrammaticSeoRuntimeController(store, scope, policy.digest, policy.mode, () => NOW);
    const publisher = new KillBeforeApplyPublisher(() => {
      control.set({ expectedRevision: 0, mode: "KILLED", reason: "late incident containment" });
    });
    const runtime = createProgrammaticSeoProductionRuntime({
      transactions: store,
      config,
      catalog: new Source(),
      publisher,
      runToken: "r".repeat(40),
      controlToken: "c".repeat(40),
      bundleToken: "b".repeat(40),
      now: () => NOW,
    });

    await expect(runtime.runOnce("MANUAL")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(publisher.applyCalls).toBe(0);
    expect(control.effectiveMode()).toBe("KILLED");
    await runtime.close();
  });
});
