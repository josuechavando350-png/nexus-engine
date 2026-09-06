import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import {
  ProgrammaticSeoEngine,
  ProgrammaticSeoPublisherError,
  createProgrammaticSeoBundleRef,
  createPublishedProgrammaticSeoBundle,
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

const SCOPE = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-06T04:00:00.000Z");

function catalog(version: 1 | 2): ProgrammaticSeoCatalogSnapshot {
  const title = version === 1 ? "Federal Criminal Defense" : "Federal Tax Crime Defense";
  const statement = version === 1
    ? "Federal criminal defense uses a dedicated intake and evidence review process."
    : "Federal tax crime defense starts with the challenged tax record and criminal-file review.";
  return createProgrammaticSeoCatalogSnapshot({
    sourceId: "approved-cano-content",
    siteId: "cano-penal",
    baseUrl: "https://canopenal.com/",
    observedAt: new Date(NOW).toISOString(),
    pages: [
      {
        pageId: "home",
        routeSegments: [],
        parentPageId: null,
        locale: "es-MX",
        title: "CANO | Estrategia Penal",
        description: "Defensa penal estratégica.",
        heading: "Defensa penal estratégica",
        bodyText: "Defensa penal estratégica. La página principal conecta con las áreas de práctica verificadas.",
        distinctiveStatements: ["La página principal conecta con las áreas de práctica verificadas."],
        evidenceRefs: ["cano:home:approved"],
        updatedAt: new Date(NOW - 1_000).toISOString(),
        indexable: true,
      },
      {
        pageId: "federal",
        routeSegments: ["areas", "delitos-fiscales-y-financieros"],
        parentPageId: "home",
        locale: "es-MX",
        title,
        description: statement,
        heading: title,
        bodyText: `${title}. ${statement}`,
        distinctiveStatements: [statement],
        evidenceRefs: [`cano:federal:approved:v${version}`],
        updatedAt: new Date(NOW - 1_000).toISOString(),
        indexable: true,
      },
    ],
  });
}

class Source implements ProgrammaticSeoCatalogProvider {
  snapshot = catalog(1);
  async getCatalog(): Promise<ProgrammaticSeoCatalogSnapshot> { return this.snapshot; }
}

class AmbiguousPublisher implements ProgrammaticSeoPublisher {
  calls = 0;
  current: PublishedProgrammaticSeoBundle | null = null;
  ambiguousNext = false;
  private readonly bundles = new Map<string, ProgrammaticSeoBundle>();

  async stage(bundle: ProgrammaticSeoBundle): Promise<ProgrammaticSeoBundleRef> {
    const ref = createProgrammaticSeoBundleRef(bundle.siteId, bundle.digest, `bundle-${bundle.digest.slice("sha256:".length)}`);
    this.bundles.set(ref.digest, bundle);
    return ref;
  }

  async load(ref: ProgrammaticSeoBundleRef): Promise<ProgrammaticSeoBundle> {
    const bundle = this.bundles.get(ref.digest);
    if (!bundle) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "missing staged bundle");
    return bundle;
  }

  async read(): Promise<PublishedProgrammaticSeoBundle | null> { return this.current; }

  async apply(action: ProgrammaticSeoPublishAction): Promise<ProgrammaticSeoPublishReceipt> {
    this.calls += 1;
    if (this.ambiguousNext) {
      this.ambiguousNext = false;
      throw new ProgrammaticSeoPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "synthetic ambiguous outcome");
    }
    this.current = action.desired ? createPublishedProgrammaticSeoBundle(action.desired, (this.current?.revision ?? 0) + 1) : null;
    return Object.freeze({ snapshot: this.current, recoveredAlreadyApplied: false, publisherVersion: "rollback-safety-v1" });
  }
}

describe("programmatic SEO rollback safety", () => {
  it("never executes a prepared forward bundle through either rollback entry path", async () => {
    const source = new Source();
    const publisher = new AmbiguousPublisher();
    const engine = new ProgrammaticSeoEngine(
      new InMemoryOntologyTransactionStore(),
      SCOPE,
      createProgrammaticSeoPolicy({
        policyId: "programmatic-seo-rollback",
        version: "v1",
        maxCatalogAgeMs: 300_000,
        maxPages: 20,
        minDistinctiveStatements: 1,
        maxPairwiseShingleSimilarity: 0.85,
        maxRouteDepth: 5,
        maxWriteRetries: 3,
        mode: "ACTIVE",
      }),
      source,
      publisher,
      () => NOW,
    );

    expect((await engine.build({ runId: "seed-forward", siteId: "cano-penal" })).status).toBe("APPLIED");
    source.snapshot = catalog(2);
    publisher.ambiguousNext = true;
    await expect(engine.build({ runId: "forward-prepared", siteId: "cano-penal" })).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    const callsBeforeRollback = publisher.calls;

    await expect(engine.rollbackLastMutation({ runId: "forward-prepared", siteId: "cano-penal" }))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(publisher.calls).toBe(callsBeforeRollback);

    await expect(engine.rollbackLastMutation({ runId: "rollback-new-id", siteId: "cano-penal" }))
      .rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(publisher.calls).toBe(callsBeforeRollback);
  });
});
