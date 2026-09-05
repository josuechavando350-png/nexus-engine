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
  SerpMetadataOptimizerError,
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
    policyId: "serp-metadata",
    version: "v1",
    maxInventoryAgeMs: 300_000,
    cooldownMs: 86_400_000,
    maxWindowDays: 90,
    minImpressions: 100,
    minExpectedClicksGain: 10,
    minPeerPages: 2,
    peerPositionTolerance: 1,
    minDescriptionQueryCoverageDelta: 0.05,
    maxGeneratedTitleCharacters: 120,
    maxGeneratedDescriptionCharacters: 240,
    maxInventoryPages: 100,
    maxSearchRows: 1_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
    ...overrides,
  });
}

function targetPage(overrides: Partial<SeoPageSnapshot> = {}): SeoPageSnapshot {
  const summaryA = "Federal criminal defense for complex investigations and court proceedings.";
  const summaryB = "Talk with our legal team about federal criminal defense strategy.";
  return Object.freeze({
    pageId: "legal-federal",
    url: PAGE,
    locale: "en-US",
    siteName: "Nexus Legal",
    indexable: true,
    canonicalUrl: PAGE,
    currentMetadata: Object.freeze({ title: "Legal Services", metaDescription: "Legal help for clients." }),
    primaryHeading: "Federal Criminal Defense",
    visibleText: `Federal Criminal Defense. ${summaryA} ${summaryB} Legal help for clients.`,
    summaryCandidates: Object.freeze([summaryA, summaryB]),
    ...overrides,
  });
}

function inventory(overrides: Partial<Omit<PageInventorySnapshot, "digest">> = {}): PageInventorySnapshot {
  return createPageInventorySnapshot({
    sourceId: "page-inventory",
    siteUrl: SITE,
    observedAt: new Date(NOW).toISOString(),
    pages: Object.freeze([
      targetPage(),
      Object.freeze({
        pageId: "peer-fiscal", url: PEER_A, locale: "en-US", siteName: "Nexus Legal", indexable: true,
        canonicalUrl: PEER_A, currentMetadata: Object.freeze({ title: "Fiscal Defense", metaDescription: "Tax dispute strategy." }),
        primaryHeading: "Fiscal Defense", visibleText: "Fiscal Defense. Tax dispute strategy.", summaryCandidates: Object.freeze(["Tax dispute strategy."]),
      }),
      Object.freeze({
        pageId: "peer-amparo", url: PEER_B, locale: "en-US", siteName: "Nexus Legal", indexable: true,
        canonicalUrl: PEER_B, currentMetadata: Object.freeze({ title: "Federal Injunctions", metaDescription: "Federal injunction strategy." }),
        primaryHeading: "Federal Injunctions", visibleText: "Federal Injunctions. Federal injunction strategy.", summaryCandidates: Object.freeze(["Federal injunction strategy."]),
      }),
    ]),
    ...overrides,
  });
}

function performance(overrides: Partial<Omit<SearchPerformanceSnapshot, "digest">> = {}): SearchPerformanceSnapshot {
  return createSearchPerformanceSnapshot({
    sourceId: "google-search-console",
    siteUrl: SITE,
    startDate: START,
    endDate: END,
    dataState: "FINAL",
    coverage: "TOP_ROWS_BOUNDED",
    truncated: false,
    observedAt: new Date(NOW).toISOString(),
    pageRows: Object.freeze([
      Object.freeze({ pageUrl: PAGE, query: null, clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 }),
      Object.freeze({ pageUrl: PEER_A, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 5.2 }),
      Object.freeze({ pageUrl: PEER_B, query: null, clicks: 70, impressions: 1_000, ctr: 0.07, position: 4.8 }),
    ]),
    targetQueryRows: Object.freeze([
      Object.freeze({ pageUrl: PAGE, query: RAW_QUERY, clicks: 8, impressions: 600, ctr: 8 / 600, position: 5 }),
      Object.freeze({ pageUrl: PAGE, query: "criminal defense", clicks: 12, impressions: 400, ctr: 0.03, position: 5 }),
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

  async read(_siteUrl: string, pageId: string, pageUrl: string): Promise<PublishedMetadataSnapshot | null> {
    this.reads += 1;
    if (this.current && (this.current.pageId !== pageId || this.current.pageUrl !== pageUrl)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "identity drift");
    return this.current;
  }

  private mutate(action: MetadataPublishAction): PublishedMetadataSnapshot | null {
    if (action.kind === "REMOVE_METADATA_OVERRIDE") {
      this.current = null;
      return null;
    }
    this.current = createPublishedMetadataSnapshot({
      pageId: action.pageId,
      pageUrl: action.pageUrl,
      metadata: action.desired,
      revision: (this.current?.revision ?? 0) + 1,
    });
    return this.current;
  }

  async apply(action: MetadataPublishAction): Promise<MetadataPublishReceipt> {
    this.calls += 1;
    if (action.kind === "UPSERT_METADATA_OVERRIDE") {
      if (this.current && JSON.stringify(this.current.metadata) === JSON.stringify(action.desired)) {
        return Object.freeze({ snapshot: this.current, recoveredAlreadyApplied: true, publisherVersion: "test-publisher-v1" });
      }
      if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "CAS drift");
    } else {
      if (this.current === null) return Object.freeze({ snapshot: null, recoveredAlreadyApplied: true, publisherVersion: "test-publisher-v1" });
      if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "rollback CAS drift");
    }
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      if (this.applyBeforeError) this.mutate(action);
      this.applyBeforeError = false;
      throw error;
    }
    const snapshot = this.mutate(action);
    return Object.freeze({ snapshot, recoveredAlreadyApplied: false, publisherVersion: "test-publisher-v1" });
  }
}

class FailFinalizeOnceStore implements OntologyTransactionPort {
  private fail = true;
  constructor(private readonly delegate: OntologyTransactionPort) {}
  transact(scopeValue: OntologyScope, schema: ValidatedSchema, operations: readonly TransactionOperation[]): TransactionResult {
    if (this.fail && operations.length === 2 && operations.every((operation) => operation.kind === "UPDATE_OBJECT")) {
      this.fail = false;
      throw new Error("synthetic finalize persistence failure");
    }
    return this.delegate.transact(scopeValue, schema, operations);
  }
  getObject(scopeValue: OntologyScope, objectId: string): ObjectRecord | undefined { return this.delegate.getObject(scopeValue, objectId); }
  getRelationship(scopeValue: OntologyScope, relationshipId: string): RelationshipRecord | undefined { return this.delegate.getRelationship(scopeValue, relationshipId); }
}

function harness(options: {
  readonly inventorySource?: InventorySource;
  readonly performanceSource?: PerformanceSource;
  readonly publisher?: Publisher;
  readonly store?: OntologyTransactionPort;
  readonly optimizerPolicy?: ReturnType<typeof policy>;
  readonly nowMs?: number;
  readonly onTelemetry?: ConstructorParameters<typeof SerpMetadataOptimizer>[6];
  readonly onTelemetryError?: ConstructorParameters<typeof SerpMetadataOptimizer>[7];
} = {}) {
  let now = options.nowMs ?? NOW;
  const inventorySource = options.inventorySource ?? new InventorySource();
  const performanceSource = options.performanceSource ?? new PerformanceSource();
  const publisher = options.publisher ?? new Publisher();
  const store = options.store ?? new InMemoryOntologyTransactionStore();
  const engine = new SerpMetadataOptimizer(
    store, scope, options.optimizerPolicy ?? policy(), inventorySource, performanceSource, publisher, () => now,
    options.onTelemetry, options.onTelemetryError,
  );
  return { engine, inventorySource, performanceSource, publisher, store, advance(ms: number) { now += ms; } };
}

async function optimize(h: ReturnType<typeof harness>, runId: string, mode?: "ACTIVE" | "OBSERVE_ONLY" | "KILLED") {
  return h.engine.optimize({ runId, siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END, mode });
}

describe("SerpMetadataOptimizer", () => {
  it("rejects malformed policy and inventory contracts before remote reads", async () => {
    expect(() => policy({ maxWindowDays: 0 })).toThrow(/maxWindowDays/);
    expect(() => createPageInventorySnapshot({
      sourceId: "inventory", siteUrl: SITE, observedAt: new Date(NOW).toISOString(),
      pages: [targetPage({ summaryCandidates: ["Invented claim that is not visible"] })],
    })).toThrow(/visible content/);
  });

  it("KILLED performs no inventory, Search Console, or publisher reads", async () => {
    const h = harness();
    const result = await optimize(h, "kill", "KILLED");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("KILL_SWITCH");
    expect(h.inventorySource.calls).toBe(0);
    expect(h.performanceSource.calls).toBe(0);
    expect(h.publisher.reads + h.publisher.calls).toBe(0);
  });

  it("fails closed on stale, non-indexable, and non-canonical pages before Search Console", async () => {
    const stale = new InventorySource();
    stale.snapshot = inventory({ observedAt: new Date(NOW - 300_001).toISOString() });
    const staleHarness = harness({ inventorySource: stale });
    expect((await optimize(staleHarness, "stale")).reason).toBe("SOURCE_STALE");
    expect(staleHarness.performanceSource.calls).toBe(0);

    const blocked = new InventorySource();
    blocked.snapshot = inventory({ pages: [targetPage({ indexable: false })] });
    const blockedHarness = harness({ inventorySource: blocked });
    expect((await optimize(blockedHarness, "blocked")).reason).toBe("PAGE_NOT_INDEXABLE");
    expect(blockedHarness.performanceSource.calls).toBe(0);

    const canonical = new InventorySource();
    canonical.snapshot = inventory({ pages: [targetPage({ canonicalUrl: "https://example.com/other" })] });
    const canonicalHarness = harness({ inventorySource: canonical });
    expect((await optimize(canonicalHarness, "canonical")).reason).toBe("NON_CANONICAL_PAGE");
    expect(canonicalHarness.performanceSource.calls).toBe(0);
  });

  it("requires enough target impressions, comparable peers, and expected click opportunity", async () => {
    const low = new PerformanceSource();
    low.snapshot = performance({ pageRows: [{ pageUrl: PAGE, query: null, clicks: 1, impressions: 10, ctr: 0.1, position: 5 }] });
    expect((await optimize(harness({ performanceSource: low }), "low-data")).reason).toBe("INSUFFICIENT_DATA");

    const noPeers = new PerformanceSource();
    noPeers.snapshot = performance({ pageRows: [{ pageUrl: PAGE, query: null, clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 }] });
    expect((await optimize(harness({ performanceSource: noPeers }), "no-peers")).reason).toBe("INSUFFICIENT_DATA");

    const noGain = new PerformanceSource();
    noGain.snapshot = performance({ pageRows: [
      { pageUrl: PAGE, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 5 },
      { pageUrl: PEER_A, query: null, clicks: 70, impressions: 1_000, ctr: 0.07, position: 5.1 },
      { pageUrl: PEER_B, query: null, clicks: 75, impressions: 1_000, ctr: 0.075, position: 4.9 },
    ] });
    expect((await optimize(harness({ performanceSource: noGain }), "no-gain")).reason).toBe("NO_CTR_OPPORTUNITY");
  });

  it("selects only visible-content metadata using observational CTR and query coverage evidence", async () => {
    const h = harness();
    const result = await optimize(h, "apply");
    expect(result.status).toBe("APPLIED");
    expect(result.reason).toBe("ACTION_APPLIED");
    expect(result.action?.kind).toBe("UPSERT_METADATA_OVERRIDE");
    if (result.action?.kind !== "UPSERT_METADATA_OVERRIDE") throw new Error("expected metadata upsert");
    expect(result.action.desired.title).toBe("Federal Criminal Defense | Nexus Legal");
    expect(result.action.desired.metaDescription).toBe("Federal criminal defense for complex investigations and court proceedings.");
    expect(result.action.desired.title).not.toContain("secretquerytoken");
    expect(result.action.desired.metaDescription).not.toContain("secretquerytoken");
    expect(result.evidence?.nonClaim).toBe("OBSERVATIONAL_CTR_OPPORTUNITY_NOT_CAUSAL_RANKING_OR_SERP_GUARANTEE");
    expect(result.evidence?.expectedClicksGain).toBeGreaterThan(10);
    expect(h.publisher.calls).toBe(1);
  });

  it("OBSERVE_ONLY persists the exact proposal without publisher mutation", async () => {
    const h = harness();
    const result = await optimize(h, "observe", "OBSERVE_ONLY");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("OBSERVE_ONLY");
    expect(result.action?.kind).toBe("UPSERT_METADATA_OVERRIDE");
    expect(h.publisher.calls).toBe(0);
  });

  it("never persists raw Search Console query text", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const h = harness({ store });
    await optimize(h, "privacy");
    const serialized = JSON.stringify(store.checkpoint());
    expect(serialized).not.toContain(RAW_QUERY);
    expect(serialized).not.toContain("secretquerytoken");
  });

  it("is idempotent by run and enforces a cooldown after a certified publish", async () => {
    const h = harness();
    const first = await optimize(h, "same-run");
    const replay = await optimize(h, "same-run");
    expect(replay.digest).toBe(first.digest);
    expect(h.publisher.calls).toBe(1);
    const cooldown = await optimize(h, "next-run");
    expect(cooldown.status).toBe("NOOP");
    expect(cooldown.reason).toBe("COOLDOWN");
    expect(h.inventorySource.calls).toBe(1);
    expect(h.performanceSource.calls).toBe(1);
  });

  it("keeps ambiguous publishes PREPARED and recovers the same run without re-reading sources", async () => {
    const h = harness();
    h.publisher.nextError = new MetadataPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "uncertain publish");
    h.publisher.applyBeforeError = true;
    await expect(optimize(h, "ambiguous-original")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(h.publisher.current?.metadata.title).toBe("Federal Criminal Defense | Nexus Legal");
    expect(h.inventorySource.calls).toBe(1);
    expect(h.performanceSource.calls).toBe(1);

    await expect(optimize(h, "scheduler-killed", "KILLED")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    const recovered = await optimize(h, "scheduler-recovery");
    expect(recovered.runId).toBe("ambiguous-original");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(h.inventorySource.calls).toBe(1);
    expect(h.performanceSource.calls).toBe(1);
    expect(h.publisher.calls).toBe(2);
  });

  it("recovers when publish succeeds but local finalization persistence fails", async () => {
    const delegate = new InMemoryOntologyTransactionStore();
    const store = new FailFinalizeOnceStore(delegate);
    const h = harness({ store });
    await expect(optimize(h, "finalize-failure")).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
    expect(h.publisher.current?.metadata.title).toBe("Federal Criminal Defense | Nexus Legal");
    expect(h.publisher.calls).toBe(1);
    const recovered = await optimize(h, "later-scheduler-run");
    expect(recovered.runId).toBe("finalize-failure");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(h.publisher.calls).toBe(2);
    expect(h.inventorySource.calls).toBe(1);
    expect(h.performanceSource.calls).toBe(1);
  });

  it("rolls back a newly created override and restores a pre-existing override exactly", async () => {
    const created = harness();
    await optimize(created, "create-override");
    expect(created.publisher.current).not.toBeNull();
    const removed = await created.engine.rollbackLastMutation({ runId: "rollback-create", siteUrl: SITE, pageId: "legal-federal" });
    expect(removed.status).toBe("ROLLED_BACK");
    expect(created.publisher.current).toBeNull();

    const existingPublisher = new Publisher();
    existingPublisher.current = createPublishedMetadataSnapshot({
      pageId: "legal-federal", pageUrl: PAGE,
      metadata: { title: "Legacy Metadata", metaDescription: "Legacy description." }, revision: 7,
    });
    const existing = harness({ publisher: existingPublisher });
    await optimize(existing, "replace-existing");
    expect(existingPublisher.current?.metadata.title).toBe("Federal Criminal Defense | Nexus Legal");
    const restored = await existing.engine.rollbackLastMutation({ runId: "rollback-existing", siteUrl: SITE, pageId: "legal-federal" });
    expect(restored.status).toBe("ROLLED_BACK");
    expect(existingPublisher.current?.metadata).toEqual({ title: "Legacy Metadata", metaDescription: "Legacy description." });
  });

  it("persists state across a real SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-serp-metadata-"));
    const path = join(directory, "cortex.sqlite");
    const inventorySource = new InventorySource();
    const performanceSource = new PerformanceSource();
    const publisher = new Publisher();
    try {
      const firstStore = new SqliteOntologyTransactionStore(path);
      const first = new SerpMetadataOptimizer(firstStore, scope, policy(), inventorySource, performanceSource, publisher, () => NOW);
      expect((await first.optimize({ runId: "sqlite-apply", siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END })).status).toBe("APPLIED");
      firstStore.close();

      const secondStore = new SqliteOntologyTransactionStore(path);
      const second = new SerpMetadataOptimizer(secondStore, scope, policy(), inventorySource, performanceSource, publisher, () => NOW);
      const result = await second.optimize({ runId: "sqlite-after-restart", siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END });
      expect(result.reason).toBe("COOLDOWN");
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates telemetry failures from committed transaction semantics", async () => {
    const telemetryErrors: unknown[] = [];
    const h = harness({
      onTelemetry: () => { throw new Error("telemetry sink down"); },
      onTelemetryError: (error) => { telemetryErrors.push(error); },
    });
    const result = await optimize(h, "telemetry");
    expect(result.status).toBe("APPLIED");
    expect(telemetryErrors).toHaveLength(1);
    expect(h.publisher.current).not.toBeNull();
  });

  it("survives 50 independent page opportunities without more than one publish per run", async () => {
    const h = harness({ optimizerPolicy: policy({ cooldownMs: 1 }) });
    for (let index = 0; index < 50; index += 1) {
      if (index > 0) h.advance(2);
      h.inventorySource.snapshot = inventory({ observedAt: new Date(NOW + index * 2).toISOString() });
      h.performanceSource.snapshot = performance({ observedAt: new Date(NOW + index * 2).toISOString() });
      const before = h.publisher.calls;
      const result = await optimize(h, `adversarial-${String(index).padStart(2, "0")}`);
      expect(h.publisher.calls - before).toBeLessThanOrEqual(1);
      if (index === 0) expect(result.status).toBe("APPLIED");
      else expect(["NOOP", "APPLIED"]).toContain(result.status);
    }
  });

  it("classifies certified publisher conflicts as terminal remote failures that release the lock", async () => {
    const h = harness();
    h.publisher.nextError = new MetadataPublisherError("PUBLISH_CONFLICT", "third-party edit");
    await expect(optimize(h, "conflict-1")).rejects.toBeInstanceOf(SerpMetadataOptimizerError);
    const next = await optimize(h, "conflict-2");
    expect(next.runId).toBe("conflict-2");
  });
});
