import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOntologyTransactionStore } from "../sqlite-transaction-store";
import {
  MetadataPublisherError,
  createPageInventorySnapshot,
  createPublishedMetadataSnapshot,
  createSearchPerformanceSnapshot,
  type MetadataPublishAction,
  type MetadataPublishReceipt,
  type MetadataPublisher,
  type PageInventoryProvider,
  type PageInventorySnapshot,
  type PublishedMetadataSnapshot,
  type SearchPerformanceProvider,
  type SearchPerformanceSnapshot,
} from "./index";
import { createSerpProductionRuntime, parseSerpProductionConfig, type SerpProductionRuntime } from "./production-runtime";

const SITE = "https://example.com/";
const PAGE_ID = "legal-federal";
const PAGE = "https://example.com/legal";
const PEER_A = "https://example.com/fiscal";
const PEER_B = "https://example.com/amparo";
const RUN_TOKEN = "serp-run-token-00000000000000000000000000";
const CONTROL_TOKEN = "serp-control-token-00000000000000000000000";
const METADATA_TOKEN = "serp-metadata-token-000000000000000000000";
const directories: string[] = [];

afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function config() {
  return parseSerpProductionConfig({
    version: 1,
    scope: { tenantId: "tenant:serp-production", organizationId: "org:serp-production" },
    intervalMs: 300_000,
    observationWindowDays: 28,
    reportingLagDays: 1,
    siteUrl: SITE,
    policy: {
      policyId: "serp-production-v1", version: "v1", maxInventoryAgeMs: 300_000, maxPerformanceAgeMs: 300_000,
      cooldownMs: 1, maxWindowDays: 90, minImpressions: 100, minExpectedClicksGain: 10, minPeerPages: 2,
      peerPositionTolerance: 1, minDescriptionQueryCoverageDelta: 0.05, maxGeneratedTitleCharacters: 120,
      maxGeneratedDescriptionCharacters: 240, maxInventoryPages: 100, maxSearchRows: 1_000, maxWriteRetries: 3, mode: "ACTIVE",
    },
    pages: [{ pageId: PAGE_ID, pageUrl: PAGE }],
  });
}

function pageInventory(now: number): PageInventorySnapshot {
  const summary = "Federal criminal defense for complex investigations and court proceedings.";
  return createPageInventorySnapshot({
    sourceId: "page-inventory", siteUrl: SITE, observedAt: new Date(now).toISOString(),
    pages: [{
      pageId: PAGE_ID, url: PAGE, locale: "en-US", siteName: "Nexus Legal", indexable: true, canonicalUrl: PAGE,
      currentMetadata: { title: "Legal Services", metaDescription: "Legal help for clients." },
      primaryHeading: "Federal Criminal Defense", visibleText: `Federal Criminal Defense. ${summary} Legal help for clients.`,
      summaryCandidates: [summary],
    }],
  });
}

function searchPerformance(now: number, startDate: string, endDate: string): SearchPerformanceSnapshot {
  return createSearchPerformanceSnapshot({
    sourceId: "google-search-console", siteUrl: SITE, startDate, endDate, dataState: "FINAL", coverage: "TOP_ROWS_BOUNDED", truncated: false,
    observedAt: new Date(now).toISOString(),
    pageRows: [
      { pageUrl: PAGE, query: null, clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 },
      { pageUrl: PEER_A, query: null, clicks: 80, impressions: 1_000, ctr: 0.08, position: 5.2 },
      { pageUrl: PEER_B, query: null, clicks: 70, impressions: 1_000, ctr: 0.07, position: 4.8 },
    ],
    targetQueryRows: [{ pageUrl: PAGE, query: "federal criminal defense", clicks: 20, impressions: 1_000, ctr: 0.02, position: 5 }],
  });
}

class InventorySource implements PageInventoryProvider {
  calls = 0;
  constructor(private readonly now: () => number) {}
  async getInventory(): Promise<PageInventorySnapshot> { this.calls += 1; return pageInventory(this.now()); }
}

class BlockingInventorySource implements PageInventoryProvider {
  calls = 0;
  readonly entered: Promise<void>;
  private enter!: () => void;
  private release!: () => void;
  private readonly released: Promise<void>;
  constructor(private readonly now: () => number) {
    this.entered = new Promise<void>((resolve) => { this.enter = resolve; });
    this.released = new Promise<void>((resolve) => { this.release = resolve; });
  }
  unblock(): void { this.release(); }
  async getInventory(): Promise<PageInventorySnapshot> { this.calls += 1; this.enter(); await this.released; return pageInventory(this.now()); }
}

class PerformanceSource implements SearchPerformanceProvider {
  calls = 0;
  constructor(private readonly now: () => number) {}
  async getPerformance(input: Readonly<{ siteUrl: string; pageUrl: string; startDate: string; endDate: string; maxRows: number }>): Promise<SearchPerformanceSnapshot> {
    this.calls += 1;
    if (input.siteUrl !== SITE || input.pageUrl !== PAGE) throw new Error("unexpected performance identity");
    return searchPerformance(this.now(), input.startDate, input.endDate);
  }
}

class Publisher implements MetadataPublisher {
  mutations = 0;
  current: PublishedMetadataSnapshot | null = null;
  async read(): Promise<PublishedMetadataSnapshot | null> { return this.current; }
  async apply(action: MetadataPublishAction): Promise<MetadataPublishReceipt> {
    if (action.kind === "UPSERT_METADATA_OVERRIDE") {
      if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "fixture CAS drift");
      this.mutations += 1;
      this.current = createPublishedMetadataSnapshot({ pageId: action.pageId, pageUrl: action.pageUrl, metadata: action.desired, revision: (this.current?.revision ?? 0) + 1 });
      return Object.freeze({ snapshot: this.current, recoveredAlreadyApplied: false, publisherVersion: "production-runtime-test-v1" });
    }
    if (JSON.stringify(this.current) !== JSON.stringify(action.expected)) throw new MetadataPublisherError("PUBLISH_CONFLICT", "fixture rollback drift");
    this.mutations += 1;
    this.current = null;
    return Object.freeze({ snapshot: null, recoveredAlreadyApplied: false, publisherVersion: "production-runtime-test-v1" });
  }
}

async function listen(runtime: SerpProductionRuntime): Promise<string> {
  await new Promise<void>((resolve, reject) => { runtime.server.once("error", reject); runtime.server.listen(0, "127.0.0.1", () => resolve()); });
  const address = runtime.server.address();
  if (!address || typeof address === "string") throw new Error("runtime did not expose TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function api(base: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

function runtimeOptions(store: SqliteOntologyTransactionStore, now: () => number, inventory: PageInventoryProvider, performance: SearchPerformanceProvider, publisher: MetadataPublisher) {
  return { transactions: store, config: config(), inventory, performance, publisher, runToken: RUN_TOKEN, controlToken: CONTROL_TOKEN, metadataToken: METADATA_TOKEN, now } as const;
}

describe("CORTEX SERP production runtime", () => {
  it("persists kill, serves the real published override, and permits explicit rollback across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-serp-production-")); directories.push(directory);
    const dbPath = join(directory, "cortex.sqlite");
    let now = Date.parse("2026-09-06T03:00:00.000Z");
    const inventory = new InventorySource(() => now);
    const performance = new PerformanceSource(() => now);
    const publisher = new Publisher();
    let store = new SqliteOntologyTransactionStore(dbPath);
    let runtime = createSerpProductionRuntime(runtimeOptions(store, () => now, inventory, performance, publisher));
    let base = await listen(runtime);

    const first = await runtime.runOnce("MANUAL");
    expect(first[0]).toMatchObject({ status: "APPLIED", reason: "ACTION_APPLIED", action: { kind: "UPSERT_METADATA_OVERRIDE" } });
    expect(publisher.mutations).toBe(1);

    const query = new URLSearchParams({ siteUrl: SITE, pageId: PAGE_ID, pageUrl: PAGE });
    const metadata = await api(base, `/v1/serp/metadata?${query.toString()}`, METADATA_TOKEN);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ siteUrl: SITE, pageId: PAGE_ID, pageUrl: PAGE, metadata: { title: "Federal Criminal Defense | Nexus Legal" } });

    const kill = await api(base, "/v1/serp/control", CONTROL_TOKEN, { method: "POST", body: JSON.stringify({ expectedRevision: 0, mode: "KILLED", reason: "emergency stop for production investigation" }) });
    expect(kill.status).toBe(200);
    expect(await kill.json()).toMatchObject({ state: { mode: "KILLED", revision: 1 } });

    now += 300_000;
    const inventoryCalls = inventory.calls;
    const performanceCalls = performance.calls;
    const killed = await runtime.runOnce("SCHEDULED");
    expect(killed[0]).toMatchObject({ status: "NOOP", reason: "KILL_SWITCH", mode: "KILLED" });
    expect(inventory.calls).toBe(inventoryCalls);
    expect(performance.calls).toBe(performanceCalls);
    expect(publisher.mutations).toBe(1);

    await runtime.close(); store.close();
    store = new SqliteOntologyTransactionStore(dbPath);
    runtime = createSerpProductionRuntime(runtimeOptions(store, () => now, inventory, performance, publisher));
    base = await listen(runtime);
    const persisted = await api(base, "/v1/serp/control", CONTROL_TOKEN);
    expect(await persisted.json()).toMatchObject({ state: { mode: "KILLED", revision: 1 }, history: [{ fromMode: "ACTIVE", toMode: "KILLED", targetRevision: 1 }] });

    const rollback = await api(base, "/v1/serp/rollback", CONTROL_TOKEN, { method: "POST", body: JSON.stringify({ pageId: PAGE_ID, runId: "rollback-001" }) });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ result: { status: "ROLLED_BACK", reason: "ROLLBACK_APPLIED" } });
    expect(publisher.mutations).toBe(2);
    expect(publisher.current).toBeNull();
    await runtime.close(); store.close();
  });

  it("re-reads KILLED at the final metadata publish boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-serp-kill-race-")); directories.push(directory);
    const dbPath = join(directory, "cortex.sqlite");
    const now = Date.parse("2026-09-06T03:30:00.000Z");
    const inventory = new BlockingInventorySource(() => now);
    const performance = new PerformanceSource(() => now);
    const publisher = new Publisher();
    const store = new SqliteOntologyTransactionStore(dbPath);
    const runtime = createSerpProductionRuntime(runtimeOptions(store, () => now, inventory, performance, publisher));
    const base = await listen(runtime);

    const run = runtime.runOnce("MANUAL");
    await inventory.entered;
    const kill = await api(base, "/v1/serp/control", CONTROL_TOKEN, { method: "POST", body: JSON.stringify({ expectedRevision: 0, mode: "KILLED", reason: "last moment production containment" }) });
    expect(kill.status).toBe(200);
    inventory.unblock();
    await expect(run).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(publisher.mutations).toBe(0);
    await runtime.close(); store.close();
  });

  it("separates runtime privileges and rejects unknown configuration fields", async () => {
    expect(() => parseSerpProductionConfig({ ...config(), unexpected: true })).toThrow(/unknown field unexpected/i);
    const directory = mkdtempSync(join(tmpdir(), "nexus-serp-auth-")); directories.push(directory);
    const store = new SqliteOntologyTransactionStore(join(directory, "cortex.sqlite"));
    const now = Date.parse("2026-09-06T04:00:00.000Z");
    const runtime = createSerpProductionRuntime(runtimeOptions(store, () => now, new InventorySource(() => now), new PerformanceSource(() => now), new Publisher()));
    const base = await listen(runtime);
    expect((await api(base, "/v1/serp/control", RUN_TOKEN)).status).toBe(401);
    expect((await api(base, `/v1/serp/metadata?${new URLSearchParams({ siteUrl: SITE, pageId: PAGE_ID, pageUrl: PAGE }).toString()}`, CONTROL_TOKEN)).status).toBe(401);
    await runtime.close(); store.close();
  });
});
