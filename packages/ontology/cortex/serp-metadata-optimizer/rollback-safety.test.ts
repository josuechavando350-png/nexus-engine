import { describe, expect, it } from "vitest";
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
  type PageInventorySnapshot,
  type PublishedMetadataSnapshot,
  type SearchPerformanceProvider,
  type SearchPerformanceSnapshot,
} from "./index";

const SCOPE = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const SITE = "https://example.com/";
const PAGE = "https://example.com/legal";
const PEER_A = "https://example.com/fiscal";
const PEER_B = "https://example.com/amparo";
const START = "2026-08-01";
const END = "2026-08-28";
const BASE_NOW = Date.parse("2026-09-05T05:00:00.000Z");

function inventory(heading: string, summary: string): PageInventorySnapshot {
  return createPageInventorySnapshot({
    sourceId: "page-inventory", siteUrl: SITE, observedAt: new Date(BASE_NOW).toISOString(),
    pages: [{
      pageId: "legal-federal", url: PAGE, locale: "en-US", siteName: "Nexus Legal", indexable: true, canonicalUrl: PAGE,
      currentMetadata: { title: "Legacy Legal Services", metaDescription: "Legacy legal description." },
      primaryHeading: heading, visibleText: `${heading}. ${summary} Legacy legal description.`, summaryCandidates: [summary],
    }],
  });
}

function performance(query: string): SearchPerformanceSnapshot {
  return createSearchPerformanceSnapshot({
    sourceId: "google-search-console", siteUrl: SITE, startDate: START, endDate: END, dataState: "FINAL", coverage: "TOP_ROWS_BOUNDED", truncated: false,
    observedAt: new Date(BASE_NOW).toISOString(),
    pageRows: [
      { pageUrl: PAGE, query: null, clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 },
      { pageUrl: PEER_A, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 5.2 },
      { pageUrl: PEER_B, query: null, clicks: 70, impressions: 1_000, ctr: 0.07, position: 4.8 },
    ],
    targetQueryRows: [{ pageUrl: PAGE, query, clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 }],
  });
}

class MutableInventory implements PageInventoryProvider {
  snapshot = inventory("Federal Criminal Defense", "Federal criminal defense for complex investigations and court proceedings.");
  async getInventory(): Promise<PageInventorySnapshot> { return this.snapshot; }
}
class MutablePerformance implements SearchPerformanceProvider {
  snapshot = performance("federal criminal defense");
  async getPerformance(): Promise<SearchPerformanceSnapshot> { return this.snapshot; }
}
class AmbiguousPublisher implements MetadataPublisher {
  calls = 0;
  current: PublishedMetadataSnapshot | null = null;
  failNext = false;
  async read(): Promise<PublishedMetadataSnapshot | null> { return this.current; }
  async apply(action: MetadataPublishAction): Promise<MetadataPublishReceipt> {
    this.calls += 1;
    if (this.failNext) { this.failNext = false; throw new MetadataPublisherError("AMBIGUOUS_PUBLISH_OUTCOME", "synthetic ambiguous outcome"); }
    if (action.kind === "REMOVE_METADATA_OVERRIDE") {
      this.current = null;
      return Object.freeze({ snapshot: null, recoveredAlreadyApplied: false, publisherVersion: "rollback-safety-v1" });
    }
    this.current = createPublishedMetadataSnapshot({ pageId: action.pageId, pageUrl: action.pageUrl, metadata: action.desired, revision: (this.current?.revision ?? 0) + 1 });
    return Object.freeze({ snapshot: this.current, recoveredAlreadyApplied: false, publisherVersion: "rollback-safety-v1" });
  }
}

function harness() {
  let now = BASE_NOW;
  const inventorySource = new MutableInventory();
  const performanceSource = new MutablePerformance();
  const publisher = new AmbiguousPublisher();
  const engine = new SerpMetadataOptimizer(
    new InMemoryOntologyTransactionStore(), SCOPE,
    createSerpMetadataPolicy({ policyId: "serp-rollback-safety", version: "v1", maxInventoryAgeMs: 300_000, maxPerformanceAgeMs: 300_000, cooldownMs: 1, maxWindowDays: 90, minImpressions: 100, minExpectedClicksGain: 10, minPeerPages: 2, peerPositionTolerance: 1, minDescriptionQueryCoverageDelta: 0.05, maxGeneratedTitleCharacters: 120, maxGeneratedDescriptionCharacters: 240, maxInventoryPages: 100, maxSearchRows: 1_000, maxWriteRetries: 3, mode: "ACTIVE" }),
    inventorySource, performanceSource, publisher, () => now,
  );
  return { engine, inventorySource, performanceSource, publisher, advance: () => { now += 2; } };
}

async function prepareForwardRun() {
  const h = harness();
  expect((await h.engine.optimize({ runId: "seed-forward", siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END })).status).toBe("APPLIED");
  h.advance();
  h.inventorySource.snapshot = inventory("Federal Tax Crime Defense", "Federal tax crime defense for complex investigations and court proceedings.");
  h.performanceSource.snapshot = performance("federal tax crime defense");
  h.publisher.failNext = true;
  await expect(h.engine.optimize({ runId: "forward-prepared", siteUrl: SITE, pageId: "legal-federal", startDate: START, endDate: END })).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
  return h;
}

describe("SERP metadata rollback safety", () => {
  it("never executes a prepared forward mutation through either rollback entry path", async () => {
    const h = await prepareForwardRun();
    const callsBeforeRollback = h.publisher.calls;
    await expect(h.engine.rollbackLastMutation({ runId: "forward-prepared", siteUrl: SITE, pageId: "legal-federal" })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.publisher.calls).toBe(callsBeforeRollback);
    await expect(h.engine.rollbackLastMutation({ runId: "rollback-new-id", siteUrl: SITE, pageId: "legal-federal" })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.publisher.calls).toBe(callsBeforeRollback);
  });
});
