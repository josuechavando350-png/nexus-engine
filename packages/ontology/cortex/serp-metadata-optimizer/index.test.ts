import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OntologyScope, ValidatedSchema } from "@nexus/ontology";
import {
  InMemoryOntologyTransactionStore,
  type ObjectRecord,
  type OntologyTransactionPort,
  type RelationshipRecord,
  type TransactionOperation,
  type TransactionResult,
} from "@nexus/ontology/transaction";
import { SqliteOntologyTransactionStore } from "@nexus/ontology/cortex/sqlite-transaction-store";
import {
  MetadataPublisherError,
  SerpMetadataOptimizer,
  createPageInventorySnapshot,
  createPublishedMetadataSnapshot,
  createSearchPerformanceSnapshot,
  createSerpMetadataPolicy,
  type MetadataPublishAction,
  type MetadataPublishReceipt,
  type MetadataPublisher,
  type PageInventoryProvider,
  type PageInventorySnapshot,
  type PublishedMetadataSnapshot,
  type SearchPerformanceProvider,
  type SearchPerformanceSnapshot,
  type SeoPageSnapshot,
} from "./index";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const SITE = "https://example.com/";
const PAGE = "https://example.com/legal";
const PEER_A = "https://example.com/fiscal";
const PEER_B = "https://example.com/amparo";
const NOW = Date.parse("2026-09-05T05:00:00.000Z");
const START = "2026-08-01";
const END = "2026-08-28";
const RAW_QUERY = "federal criminal defense secretquerytoken";

function policy(overrides: Partial<Parameters<typeof createSerpMetadataPolicy>[0]> = {}) {
  return createSerpMetadataPolicy({
    policyId: "serp-metadata", version: "v1", maxInventoryAgeMs: 300_000, maxPerformanceAgeMs: 300_000,
    cooldownMs: 86_400_000, maxWindowDays: 90, minImpressions: 100, minExpectedClicksGain: 10, minPeerPages: 2,
    peerPositionTolerance: 1, minDescriptionQueryCoverageDelta: 0.05, maxGeneratedTitleCharacters: 120,
    maxGeneratedDescriptionCharacters: 240, maxInventoryPages: 100, maxSearchRows: 1_000, maxWriteRetries: 3,
    mode: "ACTIVE", ...overrides,
  });
}

function page(overrides: Partial<SeoPageSnapshot> = {}): SeoPageSnapshot {
  const a = "Federal criminal defense for complex investigations and court proceedings.";
  const b = "Talk with our legal team about federal criminal defense strategy.";
  return Object.freeze({
    pageId: "legal-federal", url: PAGE, locale: "en-US", siteName: "Nexus Legal", indexable: true, canonicalUrl: PAGE,
    currentMetadata: Object.freeze({ title: "Legal Services", metaDescription: "Legal help for clients." }),
    primaryHeading: "Federal Criminal Defense", visibleText: `Federal Criminal Defense. ${a} ${b} Legal help for clients.`,
    summaryCandidates: Object.freeze([a, b]), ...overrides,
  });
}

function inventory(overrides: Partial<Omit<PageInventorySnapshot, "digest">> = {}): PageInventorySnapshot {
  return createPageInventorySnapshot({
    sourceId: "page-inventory", siteUrl: SITE, observedAt: new Date(NOW).toISOString(), pages: Object.freeze([page()]), ...overrides,
  });
}

function performance(overrides: Partial<Omit<SearchPerformanceSnapshot, "digest">> = {}): SearchPerformanceSnapshot {
  return createSearchPerformanceSnapshot({
    sourceId: "google-search-console", siteUrl: SITE, startDate: START, endDate: END, dataState: "FINAL",
    coverage: "TOP_ROWS_BOUNDED", truncated: false, observedAt: new Date(NOW).toISOString(),
    pageRows: Object.freeze([
      { pageUrl: PAGE, query: null, clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 },
      { pageUrl: PEER_A, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 5.2 },
      { pageUrl: PEER_B, query: null, clicks: 70, impressions: 1_000, ctr: 0.07, position: 4.8 },
    ]),
    targetQueryRows: Object.freeze([
      { pageUrl: PAGE, query: RAW_QUERY, clicks: 8, impressions: 600, ctr: 8 / 600, position: 5 },
      { pageUrl: PAGE, query: "criminal defense", clicks: 12, impressions: 400, ctr: 0.03, position: 5 },
    ]),
    ...overrides,
  });
}

class InventorySource implements PageInventoryProvider {
  calls = 0;
  snapshot = inventory();
  async getInventory(): Promise<PageInventorySnapshot> { this.calls += 1; return this.snapshot; }
}
class PerformanceSource implements SearchPerformanceProvider {
  calls = 0;
  snapshot = performance();
  async getPerformance(): Promise<SearchPerformanceSnapshot> { this.calls += 1; return this.snapshot; }
}
class Publisher implements MetadataPublisher {
  calls = 0;
  reads = 0;
  current: PublishedMetadataSnapshot | null = null;
  nextError: MetadataPublisherError | null = null;
  applyBeforeError = false;
  async read(): Promise<PublishedMetadataSnapshot | null> { this.reads += 1; return this.current; }
  private mutate(action: MetadataPublishAction): PublishedMetadataSnapshot | null {
    if (action.kind === "REMOVE_METADATA_OVERRIDE") { this.current = null; return null; }
    this.current = createPublishedMetadataSnapshot({ pageId: action.pageId, pageUrl: action.pageUrl, metadata: action.desired, revision: (this.current?.revision ?? 0) + 1 });
    return this.current;
  }
  async apply(action: MetadataPublishAction): Promise<MetadataPublishReceipt> {
    this.calls += 1;
    if (action.kind === "UPSERT_METADATA_OVERRIDE") {
      if (this.current && JSON.stringify(this.current.metadata) === JSON.stringify(action.desired)) return Object.freeze({ snapshot: this.current, recoveredAlreadyApplied: true, publisherVersion: "test-v1" });
      if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "CAS drift");
    } else if (this.current === null) return Object.freeze({ snapshot: null, recoveredAlreadyApplied: true, publisherVersion: "test-v1" });
    else if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "rollback drift");
    if (this.nextError) {
      const error = this.nextError; this.nextError = null;
      if (this.applyBeforeError) this.mutate(action);
      this.applyBeforeError = false;
      throw error;
    }
    return Object.freeze({ snapshot: this.mutate(action), recoveredAlreadyApplied: false, publisherVersion: "test-v1" });
  }
}
class FailFinalizeOnceStore implements OntologyTransactionPort {
  private fail = true;
  constructor(private readonly delegate: OntologyTransactionPort) {}
  transact(scopeValue: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): TransactionResult {
    if (this.fail && operations.length === 2 && operations.every((op) => op.kind === "UPDATE_OBJECT")) { this.fail = false; throw new Error("synthetic finalize failure"); }
    return this.delegate.transact(scopeValue, schema, operations);
  }
  getObject(scopeValue: OntologyScope, id: string): ObjectRecord | undefined { return this.delegate.getObject(scopeValue, id); }
  getRelationship(scopeValue: OntologyScope, id: string): RelationshipRecord | undefined { return this.delegate.getRelationship(scopeValue, id); }
}

function harness(options: { inventorySource?: InventorySource; performanceSource?: PerformanceSource; publisher?: Publisher; store?: OntologyTransactionPort; optimizerPolicy?: ReturnType<typeof policy>; nowMs?: number } = {}) {
  let now = options.nowMs ?? NOW;
  const inventorySource = options.inventorySource ?? new InventorySource();
  const performanceSource = options.performanceSource ?? new PerformanceSource();
  const publisher = options.publisher ?? new Publisher();
  const store = options.store ?? new InMemoryOntologyTransactionStore();
  const engine = new SerpMetadataOptimizer(store, scope, options.optimizerPolicy ?? policy(), inventorySource, performanceSource, publisher, () => now);
  return { engine, inventorySource, performanceSource, publisher, store, advance(ms: number) { now += ms; } };
}
async function optimize(h: ReturnType<typeof harness>, runId: string, mode?: "ACTIVE" | "OBSERVE_ONLY" | "KILLED") {
  return h.engine.optimize({ runId, siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END, mode });
}

describe("SerpMetadataOptimizer", () => {
  it("rejects invented visible-content candidates and KILLED performs zero external reads", async () => {
    expect(() => inventory({ pages: [page({ summaryCandidates: ["Invented claim"] })] })).toThrow(/visible content/);
    const h = harness();
    const result = await optimize(h, "kill", "KILLED");
    expect(result.reason).toBe("KILL_SWITCH");
    expect(h.inventorySource.calls + h.performanceSource.calls + h.publisher.reads + h.publisher.calls).toBe(0);
  });

  it("holds stale/non-indexable/non-canonical inventory before Search Console", async () => {
    for (const [snapshot, reason] of [
      [inventory({ observedAt: new Date(NOW - 300_001).toISOString() }), "SOURCE_STALE"],
      [inventory({ pages: [page({ indexable: false })] }), "PAGE_NOT_INDEXABLE"],
      [inventory({ pages: [page({ canonicalUrl: "https://example.com/other" })] }), "NON_CANONICAL_PAGE"],
    ] as const) {
      const source = new InventorySource(); source.snapshot = snapshot;
      const h = harness({ inventorySource: source });
      expect((await optimize(h, `guard-${reason}`)).reason).toBe(reason);
      expect(h.performanceSource.calls).toBe(0);
    }
  });

  it("rejects stale/future Search Console snapshots and cross-page query rows", async () => {
    const stale = new PerformanceSource(); stale.snapshot = performance({ observedAt: new Date(NOW - 300_001).toISOString() });
    expect((await optimize(harness({ performanceSource: stale }), "stale-performance")).reason).toBe("SOURCE_STALE");
    const future = new PerformanceSource(); future.snapshot = performance({ observedAt: new Date(NOW + 1).toISOString() });
    await expect(optimize(harness({ performanceSource: future }), "future-performance")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const mixed = new PerformanceSource(); mixed.snapshot = performance({ targetQueryRows: [{ pageUrl: PEER_A, query: "foreign query", clicks: 1, impressions: 100, ctr: 0.01, position: 5 }] });
    await expect(optimize(harness({ performanceSource: mixed }), "mixed-query")).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
  });

  it("requires data and observational CTR opportunity", async () => {
    const low = new PerformanceSource(); low.snapshot = performance({ pageRows: [{ pageUrl: PAGE, query: null, clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] });
    expect((await optimize(harness({ performanceSource: low }), "low")).reason).toBe("INSUFFICIENT_DATA");
    const noGain = new PerformanceSource(); noGain.snapshot = performance({ pageRows: [
      { pageUrl: PAGE, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 5 },
      { pageUrl: PEER_A, query: null, clicks: 70, impressions: 1_000, ctr: 0.07, position: 5.1 },
      { pageUrl: PEER_B, query: null, clicks: 75, impressions: 1_000, ctr: 0.075, position: 4.9 },
    ] });
    expect((await optimize(harness({ performanceSource: noGain }), "no-gain")).reason).toBe("NO_CTR_OPPORTUNITY");
  });

  it("publishes only visible-content metadata and persists no raw query", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const h = harness({ store });
    const result = await optimize(h, "apply");
    expect(result.status).toBe("APPLIED");
    if (result.action?.kind !== "UPSERT_METADATA_OVERRIDE") throw new Error("expected upsert");
    expect(result.action.desired.title).toBe("Federal Criminal Defense | Nexus Legal");
    // Equal query coverage resolves deterministically to the shorter visible summary.
    expect(result.action.desired.metaDescription).toBe("Talk with our legal team about federal criminal defense strategy.");
    expect(result.evidence).toMatchObject({ sourceCoverage: "TOP_ROWS_BOUNDED", sourceTruncated: false, nonClaim: "OBSERVATIONAL_CTR_OPPORTUNITY_NOT_CAUSAL_RANKING_OR_SERP_GUARANTEE" });
    expect(JSON.stringify(store.checkpoint())).not.toContain("secretquerytoken");
  });

  it("OBSERVE_ONLY never mutates, run replay is idempotent, conflicting window reuse is rejected, and cooldown prevents re-read", async () => {
    const observed = harness();
    expect((await optimize(observed, "observe", "OBSERVE_ONLY")).reason).toBe("OBSERVE_ONLY");
    expect(observed.publisher.calls).toBe(0);
    const h = harness();
    const first = await optimize(h, "same-run");
    expect((await optimize(h, "same-run")).digest).toBe(first.digest);
    await expect(h.engine.optimize({ runId: "same-run", siteUrl: SITE, pageId: "legal-federal", startDate: "2026-07-01", endDate: END })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await optimize(h, "next-run")).reason).toBe("COOLDOWN");
    expect(h.inventorySource.calls).toBe(1);
  });

  it("recovers ambiguous publish and post-write persistence failure without re-reading sources", async () => {
    const ambiguous = harness();
    ambiguous.publisher.nextError = new MetadataPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "uncertain");
    ambiguous.publisher.applyBeforeError = true;
    await expect(optimize(ambiguous, "ambiguous-original")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    const recovered = await optimize(ambiguous, "later-run");
    expect(recovered.runId).toBe("ambiguous-original");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(ambiguous.inventorySource.calls).toBe(1);
    expect(ambiguous.performanceSource.calls).toBe(1);

    const failed = harness({ store: new FailFinalizeOnceStore(new InMemoryOntologyTransactionStore()) });
    await expect(optimize(failed, "finalize-failure")).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
    expect((await optimize(failed, "scheduler-run")).reason).toBe("ACTION_RECOVERED");
    expect(failed.inventorySource.calls).toBe(1);
  });

  it("rolls back created and pre-existing overrides exactly", async () => {
    const created = harness();
    await optimize(created, "create");
    expect((await created.engine.rollbackLastMutation({ runId: "rollback-create", siteUrl: SITE, pageId: "legal-federal" })).status).toBe("ROLLED_BACK");
    expect(created.publisher.current).toBeNull();

    const publisher = new Publisher();
    publisher.current = createPublishedMetadataSnapshot({ pageId: "legal-federal", pageUrl: PAGE, metadata: { title: "Legacy", metaDescription: "Legacy description" }, revision: 7 });
    const existing = harness({ publisher });
    await optimize(existing, "replace");
    await existing.engine.rollbackLastMutation({ runId: "rollback-existing", siteUrl: SITE, pageId: "legal-federal" });
    expect(publisher.current?.metadata).toEqual({ title: "Legacy", metaDescription: "Legacy description" });
  });

  it("persists cooldown across SQLite restart and survives repeated opportunities", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-serp-"));
    const path = join(directory, "state.sqlite");
    const inventorySource = new InventorySource(); const performanceSource = new PerformanceSource(); const publisher = new Publisher();
    try {
      const firstStore = new SqliteOntologyTransactionStore(path);
      const first = new SerpMetadataOptimizer(firstStore, scope, policy(), inventorySource, performanceSource, publisher, () => NOW);
      await first.optimize({ runId: "sqlite", siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END });
      firstStore.close();
      const secondStore = new SqliteOntologyTransactionStore(path);
      const second = new SerpMetadataOptimizer(secondStore, scope, policy(), inventorySource, performanceSource, publisher, () => NOW);
      expect((await second.optimize({ runId: "after", siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END })).reason).toBe("COOLDOWN");
      secondStore.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }

    const h = harness({ optimizerPolicy: policy({ cooldownMs: 1 }) });
    for (let index = 0; index < 25; index += 1) {
      if (index) h.advance(2);
      h.inventorySource.snapshot = inventory({ observedAt: new Date(NOW + index * 2).toISOString() });
      h.performanceSource.snapshot = performance({ observedAt: new Date(NOW + index * 2).toISOString() });
      const before = h.publisher.calls;
      await optimize(h, `loop-${index}`);
      expect(h.publisher.calls - before).toBeLessThanOrEqual(1);
    }
  });
});