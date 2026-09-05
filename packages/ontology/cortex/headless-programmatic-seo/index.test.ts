import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import {
  ProgrammaticSeoEngine,
  ProgrammaticSeoPublisherError,
  compileProgrammaticSeoBundle,
  createProgrammaticSeoBundleRef,
  createPublishedProgrammaticSeoBundle,
  createProgrammaticSeoCatalogSnapshot,
  createProgrammaticSeoPolicy,
  toNextMetadata,
  toNextRobots,
  toNextSitemap,
  toNextStaticParams,
  type ProgrammaticSeoBundle,
  type ProgrammaticSeoBundleRef,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoPublishAction,
  type ProgrammaticSeoPublishReceipt,
  type ProgrammaticSeoPublisher,
  type PublishedProgrammaticSeoBundle,
} from "./index";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T07:30:00.000Z");

function policy(overrides: Partial<Parameters<typeof createProgrammaticSeoPolicy>[0]> = {}) {
  return createProgrammaticSeoPolicy({ policyId: "programmatic-seo", version: "v1", maxCatalogAgeMs: 300_000, maxPages: 100, minDistinctiveStatements: 1, maxPairwiseShingleSimilarity: 0.85, maxRouteDepth: 5, maxWriteRetries: 3, mode: "ACTIVE", ...overrides });
}
function page(pageId: string, routeSegments: readonly string[], parentPageId: string | null, body: string, statement: string, overrides: Record<string, unknown> = {}) {
  return { pageId, routeSegments, parentPageId, locale: "en-US", title: `${pageId} | Nexus`, description: `Useful information for ${pageId}.`, heading: `${pageId} heading`, bodyText: `${pageId} heading. ${body} ${statement}`, distinctiveStatements: [statement], evidenceRefs: [`cms:${pageId}:v7`], updatedAt: new Date(NOW - 1_000).toISOString(), indexable: true, ...overrides };
}
function catalog(overrides: Partial<Omit<ProgrammaticSeoCatalogSnapshot, "digest">> = {}) {
  return createProgrammaticSeoCatalogSnapshot({ sourceId: "controlled-cms", siteId: "site-a", baseUrl: "https://example.com/", observedAt: new Date(NOW).toISOString(), pages: [
    page("home", [], null, "Primary navigation connects users to distinct services and resources.", "The home page explains how to navigate the verified service catalog."),
    page("federal", ["services", "federal-defense"], "home", "Federal matters use a dedicated intake path and federal court workflow details.", "Federal defense intake requires jurisdiction-specific document review."),
    page("tax", ["services", "tax-defense"], "home", "Tax matters explain administrative review, deadlines, and evidence preparation.", "Tax defense intake begins with the challenged assessment and filing deadline."),
  ], ...overrides });
}

class CatalogSource implements ProgrammaticSeoCatalogProvider {
  calls = 0;
  snapshot = catalog();
  async getCatalog(): Promise<ProgrammaticSeoCatalogSnapshot> { this.calls += 1; return this.snapshot; }
}
class Publisher implements ProgrammaticSeoPublisher {
  reads = 0; calls = 0; stages = 0; loads = 0; current: PublishedProgrammaticSeoBundle | null = null; ambiguousOnce = false;
  private readonly bundles = new Map<string, ProgrammaticSeoBundle>();
  async stage(bundle: ProgrammaticSeoBundle): Promise<ProgrammaticSeoBundleRef> { this.stages += 1; const ref = createProgrammaticSeoBundleRef(bundle.siteId, bundle.digest, `bundle-${bundle.digest.slice("sha256:".length)}`); this.bundles.set(ref.digest, bundle); return ref; }
  async load(ref: ProgrammaticSeoBundleRef): Promise<ProgrammaticSeoBundle> { this.loads += 1; const bundle = this.bundles.get(ref.digest); if (!bundle) throw new ProgrammaticSeoPublisherError("PUBLISH_FAILURE", "missing staged bundle"); return bundle; }
  async read(): Promise<PublishedProgrammaticSeoBundle | null> { this.reads += 1; return this.current; }
  async apply(action: ProgrammaticSeoPublishAction): Promise<ProgrammaticSeoPublishReceipt> {
    this.calls += 1; if (action.desired) await this.load(action.desired);
    if (this.ambiguousOnce) { this.ambiguousOnce = false; if (action.desired) this.current = createPublishedProgrammaticSeoBundle(action.desired, (this.current?.revision ?? 0) + 1); throw new ProgrammaticSeoPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "synthetic ambiguity"); }
    if (action.desired && this.current?.bundleRef.digest === action.desired.digest) return { snapshot: this.current, recoveredAlreadyApplied: true, publisherVersion: "test-v2" };
    if (action.desired === null && this.current === null) return { snapshot: null, recoveredAlreadyApplied: true, publisherVersion: "test-v2" };
    if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new ProgrammaticSeoPublisherError("PUBLISH_CONFLICT", "CAS drift");
    this.current = action.desired ? createPublishedProgrammaticSeoBundle(action.desired, (this.current?.revision ?? 0) + 1) : null; return { snapshot: this.current, recoveredAlreadyApplied: false, publisherVersion: "test-v2" };
  }
}
function harness(options: { source?: CatalogSource; publisher?: Publisher; nowMs?: number } = {}) {
  const source = options.source ?? new CatalogSource(); const publisher = options.publisher ?? new Publisher(); const store = new InMemoryOntologyTransactionStore(); const engine = new ProgrammaticSeoEngine(store, scope, policy(), source, publisher, () => options.nowMs ?? NOW); return { engine, source, publisher, store };
}

describe("headless programmatic SEO", () => {
  it("compiles browseable self-canonical routes into deterministic Next-compatible artifacts", () => {
    const bundle = compileProgrammaticSeoBundle(catalog(), policy()); expect(bundle.pages.map((item) => item.path)).toEqual(["/", "/services/federal-defense/", "/services/tax-defense/"]);
    expect(toNextStaticParams(bundle)).toEqual([{ slug: ["services", "federal-defense"] }, { slug: ["services", "tax-defense"] }]);
    expect(toNextMetadata(bundle.pages[1]!)).toMatchObject({ alternates: { canonical: "https://example.com/services/federal-defense/" }, robots: { index: true, follow: true } });
    expect(toNextSitemap(bundle).map((item) => item.url)).toEqual(bundle.sitemap.map((item) => item.url)); expect(toNextRobots(bundle)).toMatchObject({ rules: { userAgent: "*", allow: "/", disallow: [] }, sitemap: "https://example.com/sitemap.xml" });
    expect(compileProgrammaticSeoBundle(catalog(), policy()).digest).toBe(bundle.digest);
  });

  it("renders noindex routes but omits them from sitemap while keeping them crawlable", () => {
    const source = createProgrammaticSeoCatalogSnapshot({ sourceId: "cms", siteId: "site-a", baseUrl: "https://example.com/", observedAt: new Date(NOW).toISOString(), pages: [
      page("home", [], null, "Root navigation.", "Root-only statement."), page("draft", ["draft"], "home", "Draft material visible to users but not intended for indexing.", "Draft-only statement.", { indexable: false, evidenceRefs: [], canonicalPath: "/" }),
    ] });
    const bundle = compileProgrammaticSeoBundle(source, policy()); expect(toNextStaticParams(bundle)).toContainEqual({ slug: ["draft"] }); expect(bundle.sitemap.map((item) => item.url)).not.toContain("https://example.com/draft/");
    expect(toNextMetadata(bundle.pages.find((item) => item.pageId === "draft")!)).toMatchObject({ robots: { index: false, follow: true }, alternates: { canonical: "https://example.com/" } }); expect(toNextRobots(bundle)).toMatchObject({ rules: { allow: "/", disallow: [] } });
  });

  it("rejects doorway-like hierarchy, shared distinctive evidence, near duplicates, and non-self canonicals", () => {
    expect(() => compileProgrammaticSeoBundle(createProgrammaticSeoCatalogSnapshot({ sourceId: "cms", siteId: "site-a", baseUrl: "https://example.com/", observedAt: new Date(NOW).toISOString(), pages: [page("orphan", ["city-a"], null, "Standalone page.", "Unique orphan statement.")] }), policy())).toThrow(/browseable hierarchy/);
    const shared = "This same statement is reused to manufacture multiple landing pages.";
    expect(() => compileProgrammaticSeoBundle(createProgrammaticSeoCatalogSnapshot({ sourceId: "cms", siteId: "site-a", baseUrl: "https://example.com/", observedAt: new Date(NOW).toISOString(), pages: [page("home", [], null, "Root content.", "Root statement."), page("a", ["a"], "home", "Alpha content.", shared), page("b", ["b"], "home", "Beta content.", shared)] }), policy())).toThrow(/distinctive statement is shared/);
    const repeated = "Long reusable template text about legal intake steps evidence documents deadlines consultation workflow court preparation strategy and client communication repeated for every location.";
    expect(() => compileProgrammaticSeoBundle(createProgrammaticSeoCatalogSnapshot({ sourceId: "cms", siteId: "site-a", baseUrl: "https://example.com/", observedAt: new Date(NOW).toISOString(), pages: [page("home", [], null, "Root navigation text.", "Root unique statement."), page("a", ["a"], "home", repeated, "Alpha-only fact."), page("b", ["b"], "home", repeated, "Beta-only fact.")] }), policy({ maxPairwiseShingleSimilarity: 0.6 }))).toThrow(/near-duplicate/);
    expect(() => compileProgrammaticSeoBundle(catalog({ pages: [page("home", [], null, "Root.", "Root unique."), page("a", ["a"], "home", "Alpha.", "Alpha unique.", { canonicalPath: "/other/" })] }), policy())).toThrow(/self-canonical/);
  });

  it("requires source evidence and rejects stale or tampered catalogs", async () => {
    expect(() => createProgrammaticSeoCatalogSnapshot({ sourceId: "cms", siteId: "site-a", baseUrl: "https://example.com/", observedAt: new Date(NOW).toISOString(), pages: [page("home", [], null, "Root.", "Root unique.", { evidenceRefs: [] })] })).toThrow(/requires evidenceRefs/);
    const stale = new CatalogSource(); stale.snapshot = catalog({ observedAt: new Date(NOW - 300_001).toISOString() }); expect((await harness({ source: stale }).engine.build({ runId: "stale", siteId: "site-a" })).reason).toBe("SOURCE_STALE");
    const tampered = new CatalogSource(); tampered.snapshot = Object.freeze({ ...catalog(), digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }); await expect(harness({ source: tampered }).engine.build({ runId: "tampered", siteId: "site-a" })).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
  });

  it("KILLED performs zero external I/O and OBSERVE_ONLY performs no stage or publish write", async () => {
    const killed = harness(); const result = await killed.engine.build({ runId: "kill", siteId: "site-a", mode: "KILLED" }); expect(result.reason).toBe("KILL_SWITCH"); expect(killed.source.calls + killed.publisher.reads + killed.publisher.calls + killed.publisher.stages + killed.publisher.loads).toBe(0);
    const observed = harness(); const proposed = await observed.engine.build({ runId: "observe", siteId: "site-a", mode: "OBSERVE_ONLY" }); expect(proposed.reason).toBe("OBSERVE_ONLY"); expect(proposed.bundleDigest).toMatch(/^sha256:/); expect(proposed.action).toBeNull(); expect(observed.publisher.calls + observed.publisher.stages).toBe(0);
  });

  it("persists only content-addressed references in Ontology, not page bodies", async () => {
    const h = harness(); await h.engine.build({ runId: "reference-only", siteId: "site-a" }); const checkpoint = JSON.stringify((h.store as unknown as { checkpoint(): unknown }).checkpoint());
    expect(checkpoint).not.toContain("Federal defense intake requires jurisdiction-specific document review."); expect(checkpoint).not.toContain("Tax defense intake begins with the challenged assessment and filing deadline."); expect(checkpoint).toContain("bundle-");
  });

  it("publishes once, replays idempotently, recovers ambiguity before source reread, and rolls back exactly", async () => {
    const h = harness(); const first = await h.engine.build({ runId: "apply", siteId: "site-a" }); expect(first.status).toBe("APPLIED"); expect(h.publisher.calls).toBe(1); expect((await h.engine.build({ runId: "apply", siteId: "site-a" })).digest).toBe(first.digest); expect(h.publisher.calls).toBe(1);
    expect((await h.engine.rollbackLastMutation({ runId: "rollback", siteId: "site-a" })).status).toBe("ROLLED_BACK"); expect(h.publisher.current).toBeNull();
    const source = new CatalogSource(); const publisher = new Publisher(); publisher.ambiguousOnce = true; const store = new InMemoryOntologyTransactionStore(); const engine = new ProgrammaticSeoEngine(store, scope, policy(), source, publisher, () => NOW);
    await expect(engine.build({ runId: "ambiguous", siteId: "site-a" })).rejects.toMatchObject({ code: "REMOTE_FAILURE" }); expect(source.calls).toBe(1); const recovered = await engine.build({ runId: "scheduler-next", siteId: "site-a" }); expect(recovered.reason).toBe("BUNDLE_RECOVERED"); expect(source.calls).toBe(1);
  });

  it("does not execute an old prepared mutation under a different policy revision", async () => {
    const source = new CatalogSource(); const publisher = new Publisher(); publisher.ambiguousOnce = true; const store = new InMemoryOntologyTransactionStore(); const first = new ProgrammaticSeoEngine(store, scope, policy(), source, publisher, () => NOW);
    await expect(first.build({ runId: "old-policy", siteId: "site-a" })).rejects.toMatchObject({ code: "REMOTE_FAILURE" }); const changed = new ProgrammaticSeoEngine(store, scope, policy({ version: "v2" }), source, publisher, () => NOW); await expect(changed.build({ runId: "new-policy", siteId: "site-a" })).rejects.toMatchObject({ code: "CONFLICT" }); expect(source.calls).toBe(1);
  });

  it("persists certified rollback state across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-pseo-state-")); const path = join(directory, "state.sqlite"); const source = new CatalogSource(); const publisher = new Publisher();
    try {
      const firstStore = new SqliteOntologyTransactionStore(path); const first = new ProgrammaticSeoEngine(firstStore, scope, policy(), source, publisher, () => NOW); expect((await first.build({ runId: "sqlite-apply", siteId: "site-a" })).status).toBe("APPLIED"); firstStore.close();
      const secondStore = new SqliteOntologyTransactionStore(path); const second = new ProgrammaticSeoEngine(secondStore, scope, policy(), source, publisher, () => NOW); expect((await second.rollbackLastMutation({ runId: "sqlite-rollback", siteId: "site-a" })).status).toBe("ROLLED_BACK"); expect(publisher.current).toBeNull(); secondStore.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("isolates telemetry failures from committed semantics", async () => {
    const source = new CatalogSource(); const publisher = new Publisher(); const store = new InMemoryOntologyTransactionStore(); const telemetryErrors: unknown[] = [];
    const engine = new ProgrammaticSeoEngine(store, scope, policy(), source, publisher, () => NOW, () => { throw new Error("sink down"); }, (error) => telemetryErrors.push(error));
    expect((await engine.build({ runId: "telemetry", siteId: "site-a" })).status).toBe("APPLIED"); expect(telemetryErrors).toHaveLength(1); expect(publisher.current).not.toBeNull();
  });
});
