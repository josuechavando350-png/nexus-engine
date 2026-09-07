import { describe, expect, it, vi } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
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
  type PublishedMetadataSnapshot,
  type SearchPerformanceProvider,
  type SearchPerformanceSnapshot,
} from "./index";
import { StatisticalSerpRollbackSupervisor } from "./statistical-rollback";

const scope = { tenantId: "tenant-stat-rollback", organizationId: "org-stat-rollback" } as const;
const SITE = "https://example.com/";
const PAGE_ID = "legal-federal";
const PAGE = "https://example.com/legal";
const PEER_A = "https://example.com/fiscal";
const PEER_B = "https://example.com/amparo";
const MUTATION_NOW = Date.parse("2026-08-15T12:00:00.000Z");
const EVALUATION_NOW = Date.parse("2026-09-15T12:00:00.000Z");

class Publisher implements MetadataPublisher {
  current: PublishedMetadataSnapshot | null = null;
  async read(): Promise<PublishedMetadataSnapshot | null> { return this.current; }
  async apply(action: MetadataPublishAction): Promise<MetadataPublishReceipt> {
    if (action.kind === "REMOVE_METADATA_OVERRIDE") {
      if (!this.current || JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "rollback CAS drift");
      this.current = null;
      return { snapshot: null, recoveredAlreadyApplied: false, publisherVersion: "test-v1" };
    }
    if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "publish CAS drift");
    this.current = createPublishedMetadataSnapshot({ pageId: action.pageId, pageUrl: action.pageUrl, metadata: action.desired, revision: (this.current?.revision ?? 0) + 1 });
    return { snapshot: this.current, recoveredAlreadyApplied: false, publisherVersion: "test-v1" };
  }
}

function inventory(nowMs: number): PageInventoryProvider {
  return {
    async getInventory() {
      return createPageInventorySnapshot({
        sourceId: "page-inventory",
        siteUrl: SITE,
        observedAt: new Date(nowMs).toISOString(),
        pages: [{
          pageId: PAGE_ID,
          url: PAGE,
          locale: "en-US",
          siteName: "Nexus Legal",
          indexable: true,
          canonicalUrl: PAGE,
          currentMetadata: { title: "Legal Services", metaDescription: "Legal help for clients." },
          primaryHeading: "Federal Criminal Defense",
          visibleText: "Federal Criminal Defense. Federal criminal defense for complex investigations and court proceedings. Talk with our legal team about federal criminal defense strategy. Legal help for clients.",
          summaryCandidates: ["Federal criminal defense for complex investigations and court proceedings.", "Talk with our legal team about federal criminal defense strategy."],
        }],
      });
    },
  };
}

function initialPerformance(): SearchPerformanceProvider {
  return {
    async getPerformance(input) {
      return createSearchPerformanceSnapshot({
        sourceId: "google-search-console",
        siteUrl: SITE,
        startDate: input.startDate,
        endDate: input.endDate,
        dataState: "FINAL",
        coverage: "TOP_ROWS_BOUNDED",
        truncated: false,
        observedAt: new Date(MUTATION_NOW).toISOString(),
        pageRows: [
          { pageUrl: PAGE, query: null, clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 },
          { pageUrl: PEER_A, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 5.1 },
          { pageUrl: PEER_B, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 4.9 },
        ],
        targetQueryRows: [
          { pageUrl: PAGE, query: "federal criminal defense", clicks: 10, impressions: 500, ctr: 0.02, position: 5 },
          { pageUrl: PAGE, query: "criminal defense", clicks: 10, impressions: 500, ctr: 0.02, position: 5 },
        ],
      });
    },
  };
}

function evaluationPerformance(options: { peerSeasonalDrop?: boolean; position?: number; truncated?: boolean } = {}): SearchPerformanceProvider {
  return {
    async getPerformance(input): Promise<SearchPerformanceSnapshot> {
      const baseline = input.endDate === "2026-08-14";
      const targetClicks = baseline ? 100 : 20;
      const peerClicks = baseline ? 100 : options.peerSeasonalDrop ? 20 : 100;
      return createSearchPerformanceSnapshot({
        sourceId: "google-search-console",
        siteUrl: SITE,
        startDate: input.startDate,
        endDate: input.endDate,
        dataState: "FINAL",
        coverage: "TOP_ROWS_BOUNDED",
        truncated: options.truncated ?? false,
        observedAt: new Date(EVALUATION_NOW).toISOString(),
        pageRows: [
          { pageUrl: PAGE, query: null, clicks: targetClicks, impressions: 1_000, ctr: targetClicks / 1_000, position: baseline ? 5 : (options.position ?? 5) },
          { pageUrl: PEER_A, query: null, clicks: peerClicks, impressions: 1_000, ctr: peerClicks / 1_000, position: 5 },
          { pageUrl: PEER_B, query: null, clicks: peerClicks, impressions: 1_000, ctr: peerClicks / 1_000, position: 5 },
        ],
        targetQueryRows: [],
      });
    },
  };
}

async function appliedMutation() {
  const store = new InMemoryOntologyTransactionStore();
  const publisher = new Publisher();
  let now = MUTATION_NOW;
  const engine = new SerpMetadataOptimizer(
    store,
    scope,
    createSerpMetadataPolicy({
      policyId: "serp-statistical-rollback",
      version: "v1",
      maxInventoryAgeMs: 300_000,
      maxPerformanceAgeMs: 300_000,
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
    }),
    inventory(MUTATION_NOW),
    initialPerformance(),
    publisher,
    () => now,
  );
  const applied = await engine.optimize({ runId: "apply-before-statistical-watch", siteUrl: SITE, pageId: PAGE_ID, startDate: "2026-08-01", endDate: "2026-08-07", mode: "ACTIVE" });
  expect(applied.status).toBe("APPLIED");
  expect(publisher.current).not.toBeNull();
  now = EVALUATION_NOW;
  return { store, publisher, engine };
}

function supervisor(h: Awaited<ReturnType<typeof appliedMutation>>, performance: SearchPerformanceProvider, rollback = vi.fn((pageId: string, runId: string) => h.engine.rollbackLastMutation({ pageId, siteUrl: SITE, runId }))) {
  return {
    rollback,
    supervisor: new StatisticalSerpRollbackSupervisor({
      transactions: h.store,
      scope,
      siteUrl: SITE,
      targets: [{ pageId: PAGE_ID, pageUrl: PAGE }],
      performance,
      policy: {
        version: 1,
        evaluationWindowDays: 7,
        reportingLagDays: 2,
        minimumTargetImpressionsPerWindow: 500,
        minimumPeerImpressionsPerWindow: 1_000,
        minimumPeerPages: 2,
        minimumAbsoluteCtrDrop: 0.02,
        minimumRelativeCtrDrop: 0.2,
        minimumZScore: 2,
        maximumAveragePositionDelta: 0.5,
        maxRows: 1_000,
      },
      rollback,
      now: () => EVALUATION_NOW,
    }),
  };
}

describe("CORTEX #24 statistical rollback", () => {
  it("rolls back the exact live mutation when deterioration survives seasonality and position controls", async () => {
    const h = await appliedMutation();
    const watch = supervisor(h, evaluationPerformance());
    const decision = await watch.supervisor.evaluate(PAGE_ID, true);
    expect(decision).toMatchObject({ status: "ROLLED_BACK", baselineCtr: 0.1, currentCtr: 0.02, baselinePeerCtr: 0.1, currentPeerCtr: 0.1 });
    expect(decision.adjustedCtrDrop).toBeCloseTo(0.08);
    expect(decision.zScore).toBeGreaterThan(2);
    expect(watch.rollback).toHaveBeenCalledTimes(1);
    expect(h.publisher.current).toBeNull();
    expect((await watch.supervisor.evaluate(PAGE_ID, true)).status).toBe("NO_LIVE_MUTATION");
  });

  it("does not rollback when the same CTR drop is explained by site-wide seasonality", async () => {
    const h = await appliedMutation();
    const watch = supervisor(h, evaluationPerformance({ peerSeasonalDrop: true }));
    const decision = await watch.supervisor.evaluate(PAGE_ID, true);
    expect(decision.status).toBe("HEALTHY");
    expect(decision.adjustedCtrDrop).toBeCloseTo(0);
    expect(watch.rollback).not.toHaveBeenCalled();
    expect(h.publisher.current).not.toBeNull();
  });

  it("does not attribute CTR deterioration to metadata when average position moved materially", async () => {
    const h = await appliedMutation();
    const watch = supervisor(h, evaluationPerformance({ position: 7 }));
    const decision = await watch.supervisor.evaluate(PAGE_ID, true);
    expect(decision.status).toBe("SEASONAL_OR_POSITION_CONFOUNDED");
    expect(watch.rollback).not.toHaveBeenCalled();
  });

  it("fails closed on truncated Search Console evidence", async () => {
    const h = await appliedMutation();
    const watch = supervisor(h, evaluationPerformance({ truncated: true }));
    await expect(watch.supervisor.evaluate(PAGE_ID, true)).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(watch.rollback).not.toHaveBeenCalled();
  });
});