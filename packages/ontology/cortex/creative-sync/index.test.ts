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
import { GoogleAdsApiError } from "@nexus/ontology/cortex/bidding-supervisor/google-ads-rest";
import {
  CreativeSyncError,
  NearRealTimeCreativeSynchronizer,
  createCreativeSyncPolicy,
  type CreativeDesiredState,
  type CreativeDesiredStateProvider,
  type CreativeMutationReceipt,
  type CreativeSyncAction,
  type CustomizerAttributeSnapshot,
  type CustomizerValueSnapshot,
  type DesiredCustomizerValue,
  type GoogleAdsCreativeGateway,
  type ResponsiveSearchAdContent,
  type ResponsiveSearchAdSnapshot,
} from "./index";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const CUSTOMER = "1234567890";
const CAMPAIGN = `customers/${CUSTOMER}/campaigns/2222222222`;
const AD = `customers/${CUSTOMER}/ads/3333333333`;
const NOW = Date.parse("2026-09-05T04:00:00.000Z");

function policy(overrides: Partial<Parameters<typeof createCreativeSyncPolicy>[0]> = {}) {
  return createCreativeSyncPolicy({
    policyId: "creative-sync",
    version: "v1",
    maxSourceAgeMs: 300_000,
    maxDesiredResponsiveSearchAds: 100,
    maxDesiredCustomizerValues: 500,
    maxWriteRetries: 3,
    mode: "ACTIVE",
    ...overrides,
  });
}

function content(headline = "Book your consultation"): ResponsiveSearchAdContent {
  return Object.freeze({
    headlines: Object.freeze([
      Object.freeze({ text: headline, pinnedField: "HEADLINE_1" as const }),
      Object.freeze({ text: "Legal strategy", pinnedField: null }),
      Object.freeze({ text: "Talk to our team", pinnedField: null }),
    ]),
    descriptions: Object.freeze([
      Object.freeze({ text: "Get clear next steps for your legal matter.", pinnedField: null }),
      Object.freeze({ text: "Schedule a consultation with our legal team.", pinnedField: null }),
    ]),
    path1: "legal",
    path2: "consulta",
    finalUrls: Object.freeze(["https://example.com/legal"]),
    finalMobileUrls: Object.freeze([]),
  });
}

function desiredState(overrides: Partial<CreativeDesiredState> = {}): CreativeDesiredState {
  return Object.freeze({
    sourceId: "creative-control-plane",
    sourceVersion: "version-001",
    observedAt: new Date(NOW).toISOString(),
    customizerAttributes: Object.freeze([{ name: "Price", type: "PRICE" as const }]),
    customizerValues: Object.freeze([{
      attributeName: "Price",
      type: "PRICE" as const,
      scopeKind: "CAMPAIGN" as const,
      scopeResourceName: CAMPAIGN,
      stringValue: "100USD",
    }]),
    responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content() }]),
    ...overrides,
  });
}

class Source implements CreativeDesiredStateProvider {
  calls = 0;
  state = desiredState();

  async getDesiredState(): Promise<CreativeDesiredState> {
    this.calls += 1;
    return this.state;
  }
}

function valueResource(scopeKind: string, attributeId: string): string {
  if (scopeKind === "CAMPAIGN") return `customers/${CUSTOMER}/campaignCustomizers/2222222222~${attributeId}`;
  return `customers/${CUSTOMER}/customerCustomizers/${attributeId}`;
}

class Gateway implements GoogleAdsCreativeGateway {
  readonly attributes = new Map<string, CustomizerAttributeSnapshot>();
  readonly values = new Map<string, CustomizerValueSnapshot>();
  rsa: ResponsiveSearchAdSnapshot | null = Object.freeze({
    resourceName: AD,
    adId: "3333333333",
    adGroupResourceName: `customers/${CUSTOMER}/adGroups/4444444444`,
    status: "ENABLED",
    ...content("Old headline"),
  });
  attributeReads = 0;
  valueReads = 0;
  rsaReads = 0;
  mutationCalls = 0;
  nextError: GoogleAdsApiError | null = null;
  applyBeforeError = false;
  private nextAttributeId = 9000;

  async getCustomizerAttributes(): Promise<readonly CustomizerAttributeSnapshot[]> {
    this.attributeReads += 1;
    return Object.freeze([...this.attributes.values()]);
  }

  async getCustomizerValue(
    _customerId: string,
    lookup: Pick<DesiredCustomizerValue, "scopeKind" | "scopeResourceName"> & { readonly attributeResourceName: string },
  ): Promise<CustomizerValueSnapshot | null> {
    this.valueReads += 1;
    return this.values.get(`${lookup.scopeKind}|${lookup.scopeResourceName}|${lookup.attributeResourceName}`) ?? null;
  }

  async getResponsiveSearchAd(): Promise<ResponsiveSearchAdSnapshot | null> {
    this.rsaReads += 1;
    return this.rsa;
  }

  private mutate(action: CreativeSyncAction): string {
    if (action.kind === "CREATE_CUSTOMIZER_ATTRIBUTE") {
      const existing = [...this.attributes.values()].find((item) => item.name.toLowerCase() === action.name.toLowerCase());
      if (existing) return existing.resourceName;
      const id = String(this.nextAttributeId++);
      const resourceName = `customers/${CUSTOMER}/customizerAttributes/${id}`;
      this.attributes.set(resourceName, Object.freeze({ resourceName, id, name: action.name, type: action.type, status: "ENABLED" }));
      return resourceName;
    }
    if (action.kind === "REMOVE_CUSTOMIZER_ATTRIBUTE") {
      this.attributes.delete(action.resourceName);
      return action.resourceName;
    }
    if (action.kind === "UPDATE_RSA") {
      if (!this.rsa) throw new Error("RSA missing");
      this.rsa = Object.freeze({ ...this.rsa, ...action.desired });
      return action.resourceName;
    }
    const key = `${action.scopeKind}|${action.scopeResourceName}|${action.attributeResourceName}`;
    if (action.kind === "REMOVE_CUSTOMIZER_VALUE") {
      const current = this.values.get(key);
      this.values.delete(key);
      return current?.resourceName ?? action.expected.resourceName;
    }
    const attrId = action.attributeResourceName.split("/").at(-1)!;
    const resourceName = action.expected?.resourceName || valueResource(action.scopeKind, attrId);
    this.values.set(key, Object.freeze({
      resourceName,
      attributeResourceName: action.attributeResourceName,
      type: action.type,
      scopeKind: action.scopeKind,
      scopeResourceName: action.scopeResourceName,
      stringValue: action.desiredStringValue,
      status: "ENABLED",
    }));
    return resourceName;
  }

  async applyMutation(_customerId: string, action: CreativeSyncAction): Promise<CreativeMutationReceipt> {
    this.mutationCalls += 1;
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      if (this.applyBeforeError) this.mutate(action);
      this.applyBeforeError = false;
      throw error;
    }
    if (action.kind === "CREATE_CUSTOMIZER_ATTRIBUTE") {
      const existing = [...this.attributes.values()].find((item) => item.name.toLowerCase() === action.name.toLowerCase());
      if (existing) return Object.freeze({ requestId: null, resourceName: existing.resourceName, recoveredAlreadyApplied: true });
    }
    if (action.kind === "REMOVE_CUSTOMIZER_ATTRIBUTE") {
      const existing = this.attributes.get(action.resourceName);
      if (!existing) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
      if (existing.name !== action.name || existing.type !== action.type) throw new GoogleAdsApiError("REMOTE_CONFLICT", "attribute drift");
    }
    if (action.kind === "UPDATE_RSA" && this.rsa) {
      const current = contentFromSnapshot(this.rsa);
      if (JSON.stringify(current) === JSON.stringify(action.desired)) return Object.freeze({ requestId: null, resourceName: action.resourceName, recoveredAlreadyApplied: true });
      if (JSON.stringify(current) !== JSON.stringify(action.expected)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "RSA drift");
    }
    if (action.kind === "REMOVE_CUSTOMIZER_VALUE") {
      const current = await this.getCustomizerValue(CUSTOMER, action);
      if (!current) return Object.freeze({ requestId: null, resourceName: action.expected.resourceName, recoveredAlreadyApplied: true });
      if (JSON.stringify(current) !== JSON.stringify(action.expected)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer drift");
    }
    if (action.kind === "UPSERT_CUSTOMIZER_VALUE") {
      const current = await this.getCustomizerValue(CUSTOMER, action);
      if (current && current.type === action.type && current.stringValue === action.desiredStringValue) return Object.freeze({ requestId: null, resourceName: current.resourceName, recoveredAlreadyApplied: true });
      if (action.expected === null && current) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer appeared");
      if (action.expected && JSON.stringify(current) !== JSON.stringify(action.expected)) throw new GoogleAdsApiError("REMOTE_CONFLICT", "customizer drift");
    }
    const resourceName = this.mutate(action);
    return Object.freeze({ requestId: `request-${this.mutationCalls}`, resourceName, recoveredAlreadyApplied: false });
  }
}

function contentFromSnapshot(snapshot: ResponsiveSearchAdSnapshot): ResponsiveSearchAdContent {
  return {
    headlines: snapshot.headlines,
    descriptions: snapshot.descriptions,
    path1: snapshot.path1,
    path2: snapshot.path2,
    finalUrls: snapshot.finalUrls,
    finalMobileUrls: snapshot.finalMobileUrls,
  };
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

  getObject(scopeValue: OntologyScope, id: string): ObjectRecord | undefined {
    return this.delegate.getObject(scopeValue, id);
  }

  getRelationship(scopeValue: OntologyScope, id: string): RelationshipRecord | undefined {
    return this.delegate.getRelationship(scopeValue, id);
  }
}

function harness(options: {
  readonly source?: Source;
  readonly gateway?: Gateway;
  readonly store?: OntologyTransactionPort;
  readonly supervisorPolicy?: ReturnType<typeof policy>;
  readonly nowMs?: number;
} = {}) {
  let now = options.nowMs ?? NOW;
  const source = options.source ?? new Source();
  const gateway = options.gateway ?? new Gateway();
  const store = options.store ?? new InMemoryOntologyTransactionStore();
  const engine = new NearRealTimeCreativeSynchronizer(store, scope, options.supervisorPolicy ?? policy(), gateway, source, () => now);
  return { engine, source, gateway, store, advance(ms: number) { now += ms; } };
}

async function sync(h: ReturnType<typeof harness>, runId: string, mode?: "ACTIVE" | "OBSERVE_ONLY" | "KILLED") {
  return h.engine.synchronize({ runId, customerId: CUSTOMER, mode });
}

describe("NearRealTimeCreativeSynchronizer", () => {
  it("rejects malformed policies and desired-state contracts", async () => {
    expect(() => policy({ maxDesiredResponsiveSearchAds: 0 })).toThrow(/maxDesiredResponsiveSearchAds/);
    const source = new Source();
    source.state = desiredState({ customizerAttributes: Object.freeze([{ name: "Price", type: "PRICE" }, { name: "price", type: "PRICE" }]) });
    await expect(sync(harness({ source }), "duplicate-attrs")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("enforces RSA static character, URL, CJK-width and section-specific pin contracts while permitting dynamic insertions", async () => {
    const tooLongHeadline = new Source();
    tooLongHeadline.state = desiredState({ responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content("1234567890123456789012345678901") }]) });
    await expect(sync(harness({ source: tooLongHeadline }), "long-headline")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const cjkHeadline = new Source();
    cjkHeadline.state = desiredState({ responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content("漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢漢") }]) });
    await expect(sync(harness({ source: cjkHeadline }), "cjk-headline")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const longDescription = new Source();
    const longDescriptions = content().descriptions.map((asset, index) => index === 0 ? Object.freeze({ text: "x".repeat(91), pinnedField: null }) : asset);
    longDescription.state = desiredState({ responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content(), descriptions: Object.freeze(longDescriptions) }]) });
    await expect(sync(harness({ source: longDescription }), "long-description")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const wrongPin = new Source();
    const wrongHeadlines = content().headlines.map((asset, index) => index === 0 ? Object.freeze({ text: asset.text, pinnedField: "DESCRIPTION_1" as const }) : asset);
    wrongPin.state = desiredState({ responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content(), headlines: Object.freeze(wrongHeadlines) }]) });
    await expect(sync(harness({ source: wrongPin }), "wrong-pin")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const oversizedUrl = new Source();
    oversizedUrl.state = desiredState({ responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content(), finalUrls: Object.freeze([`https://example.com/${"a".repeat(2_100)}`]) }]) });
    await expect(sync(harness({ source: oversizedUrl }), "long-url")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const dynamic = new Source();
    dynamic.state = desiredState({ responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content("Special offer {CUSTOMIZER.Price:10USD}") }]) });
    const dynamicResult = await sync(harness({ source: dynamic }), "dynamic-macro");
    expect(dynamicResult.action?.kind).toBe("CREATE_CUSTOMIZER_ATTRIBUTE");
  });

  it("converges deterministically attribute -> value -> RSA -> IN_SYNC with one remote mutation per run", async () => {
    const h = harness();
    const attribute = await sync(h, "cycle-1");
    expect(attribute.status).toBe("APPLIED");
    expect(attribute.action?.kind).toBe("CREATE_CUSTOMIZER_ATTRIBUTE");
    expect(h.gateway.mutationCalls).toBe(1);

    const value = await sync(h, "cycle-2");
    expect(value.status).toBe("APPLIED");
    expect(value.action?.kind).toBe("UPSERT_CUSTOMIZER_VALUE");
    expect(h.gateway.mutationCalls).toBe(2);

    const rsa = await sync(h, "cycle-3");
    expect(rsa.status).toBe("APPLIED");
    expect(rsa.action?.kind).toBe("UPDATE_RSA");
    expect(h.gateway.mutationCalls).toBe(3);

    const settled = await sync(h, "cycle-4");
    expect(settled.status).toBe("NOOP");
    expect(settled.reason).toBe("IN_SYNC");
    expect(h.gateway.mutationCalls).toBe(3);
  });

  it("OBSERVE_ONLY records a proposal but never mutates and cannot later reactivate that terminal run", async () => {
    const h = harness();
    const proposed = await sync(h, "observe", "OBSERVE_ONLY");
    expect(proposed.status).toBe("NOOP");
    expect(proposed.reason).toBe("OBSERVE_ONLY");
    expect(proposed.action?.kind).toBe("CREATE_CUSTOMIZER_ATTRIBUTE");
    expect(h.gateway.mutationCalls).toBe(0);
    const replay = await sync(h, "observe", "ACTIVE");
    expect(replay.status).toBe("NOOP");
    expect(h.gateway.mutationCalls).toBe(0);
  });

  it("KILLED performs no source or Google reads for a new run", async () => {
    const h = harness();
    const result = await sync(h, "kill", "KILLED");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("KILL_SWITCH");
    expect(h.source.calls).toBe(0);
    expect(h.gateway.attributeReads + h.gateway.valueReads + h.gateway.rsaReads + h.gateway.mutationCalls).toBe(0);
  });

  it("holds stale source data before any Google read", async () => {
    const source = new Source();
    source.state = desiredState({ observedAt: new Date(NOW - 300_001).toISOString() });
    const h = harness({ source });
    const result = await sync(h, "stale");
    expect(result.status).toBe("NOOP");
    expect(result.reason).toBe("SOURCE_STALE");
    expect(h.gateway.attributeReads + h.gateway.valueReads + h.gateway.rsaReads).toBe(0);
  });

  it("fails closed on immutable attribute type conflict and Google 40-attribute limit", async () => {
    const mismatch = new Gateway();
    mismatch.attributes.set("customers/1234567890/customizerAttributes/1", Object.freeze({
      resourceName: "customers/1234567890/customizerAttributes/1", id: "1", name: "Price", type: "TEXT", status: "ENABLED",
    }));
    const conflictResult = await sync(harness({ gateway: mismatch }), "type-conflict");
    expect(conflictResult.reason).toBe("ATTRIBUTE_TYPE_CONFLICT");
    expect(mismatch.mutationCalls).toBe(0);

    const full = new Gateway();
    for (let index = 0; index < 40; index += 1) {
      const resourceName = `customers/${CUSTOMER}/customizerAttributes/${index + 1}`;
      full.attributes.set(resourceName, Object.freeze({ resourceName, id: String(index + 1), name: `Attr${index}`, type: "TEXT", status: "ENABLED" }));
    }
    const limitResult = await sync(harness({ gateway: full }), "attribute-limit");
    expect(limitResult.reason).toBe("ATTRIBUTE_LIMIT");
    expect(full.mutationCalls).toBe(0);
  });

  it("leaves ambiguous writes PREPARED, freezes them under KILLED, and recovers without re-reading source", async () => {
    const h = harness();
    h.gateway.nextError = new GoogleAdsApiError("AMBIGUOUS_MUTATION_OUTCOME", "uncertain write");
    h.gateway.applyBeforeError = true;
    await expect(sync(h, "ambiguous-original")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    expect(h.source.calls).toBe(1);
    expect(h.gateway.mutationCalls).toBe(1);

    await expect(sync(h, "scheduler-killed", "KILLED")).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.source.calls).toBe(1);
    expect(h.gateway.mutationCalls).toBe(1);

    const recovered = await sync(h, "scheduler-recovery");
    expect(recovered.runId).toBe("ambiguous-original");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(h.source.calls).toBe(1);
    expect(h.gateway.mutationCalls).toBe(2);
  });

  it("recovers a certified remote write after local finalization persistence fails", async () => {
    const delegate = new InMemoryOntologyTransactionStore();
    const store = new FailFinalizeOnceStore(delegate);
    const h = harness({ store });
    await expect(sync(h, "post-write-local-failure")).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
    expect(h.gateway.mutationCalls).toBe(1);
    expect(h.gateway.attributes.size).toBe(1);
    expect(h.source.calls).toBe(1);

    const recovered = await sync(h, "next-scheduler-cycle");
    expect(recovered.runId).toBe("post-write-local-failure");
    expect(recovered.status).toBe("APPLIED");
    expect(recovered.reason).toBe("ACTION_RECOVERED");
    expect(h.gateway.mutationCalls).toBe(2);
    expect(h.gateway.attributes.size).toBe(1);
    expect(h.source.calls).toBe(1);
  });

  it("releases the lock after a certified remote conflict", async () => {
    const h = harness();
    h.gateway.nextError = new GoogleAdsApiError("REMOTE_CONFLICT", "third-party edit");
    await expect(sync(h, "conflict-1")).rejects.toMatchObject({ code: "REMOTE_FAILURE" });
    const next = await sync(h, "conflict-2");
    expect(next.runId).toBe("conflict-2");
  });

  it("rolls back a newly created attribute using the certified Google resource name", async () => {
    const h = harness();
    const applied = await sync(h, "attribute-apply");
    expect(applied.action?.kind).toBe("CREATE_CUSTOMIZER_ATTRIBUTE");
    expect(h.gateway.attributes.size).toBe(1);
    const createdResource = applied.receipt?.resourceName;
    expect(createdResource).toMatch(/customizerAttributes\/\d+$/);

    const rollback = await h.engine.rollbackLastMutation({ runId: "attribute-rollback", customerId: CUSTOMER });
    expect(rollback.status).toBe("ROLLED_BACK");
    expect(rollback.action).toMatchObject({ kind: "REMOVE_CUSTOMIZER_ATTRIBUTE", resourceName: createdResource });
    expect(h.gateway.attributes.size).toBe(0);
  });

  it("rolls back a certified RSA update only against its exact applied state", async () => {
    const source = new Source();
    source.state = desiredState({ customizerAttributes: Object.freeze([]), customizerValues: Object.freeze([]) });
    const h = harness({ source });
    const applied = await sync(h, "rsa-apply");
    expect(applied.action?.kind).toBe("UPDATE_RSA");
    const rollback = await h.engine.rollbackLastMutation({ runId: "rsa-rollback", customerId: CUSTOMER });
    expect(rollback.status).toBe("ROLLED_BACK");
    expect(rollback.reason).toBe("ROLLBACK_APPLIED");
    expect(h.gateway.rsa?.headlines[0]?.text).toBe("Old headline");
    await expect(h.engine.rollbackLastMutation({ runId: "rsa-rollback-2", customerId: CUSTOMER })).rejects.toBeInstanceOf(CreativeSyncError);
  });

  it("persists synchronization state across a real SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nexus-creative-sync-"));
    const path = join(directory, "cortex.sqlite");
    const source = new Source();
    const gateway = new Gateway();
    try {
      const firstStore = new SqliteOntologyTransactionStore(path);
      const first = new NearRealTimeCreativeSynchronizer(firstStore, scope, policy(), gateway, source, () => NOW);
      expect((await first.synchronize({ runId: "sqlite-1", customerId: CUSTOMER })).action?.kind).toBe("CREATE_CUSTOMIZER_ATTRIBUTE");
      firstStore.close();

      const secondStore = new SqliteOntologyTransactionStore(path);
      const second = new NearRealTimeCreativeSynchronizer(secondStore, scope, policy(), gateway, source, () => NOW);
      expect((await second.synchronize({ runId: "sqlite-2", customerId: CUSTOMER })).action?.kind).toBe("UPSERT_CUSTOMIZER_VALUE");
      secondStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives 60 near-real-time source revisions without more than one mutation per invocation", async () => {
    const source = new Source();
    source.state = desiredState({ customizerAttributes: Object.freeze([]), customizerValues: Object.freeze([]) });
    const h = harness({ source });
    for (let index = 0; index < 60; index += 1) {
      const headline = `Consultation ${String(index).padStart(2, "0")}`;
      source.state = desiredState({
        sourceVersion: `revision-${String(index).padStart(3, "0")}`,
        customizerAttributes: Object.freeze([]),
        customizerValues: Object.freeze([]),
        responsiveSearchAds: Object.freeze([{ resourceName: AD, ...content(headline) }]),
      });
      const before = h.gateway.mutationCalls;
      const result = await sync(h, `near-real-time-${String(index).padStart(3, "0")}`);
      expect(h.gateway.mutationCalls - before).toBeLessThanOrEqual(1);
      expect(result.status).toBe("APPLIED");
      expect(h.gateway.rsa?.headlines[0]?.text).toBe(headline);
    }
  });
});
