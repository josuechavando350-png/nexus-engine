import { describe, expect, it } from "vitest";
import { InMemoryEvidenceSink, InMemoryMemoryStore } from "../testing";
import {
  AppendOnlyMemoryService,
  DeterministicMemoryRetriever,
  MemoryError,
  validateMemoryRecord,
  type ArtDirectionMemoryRecord,
  type MemoryQuery,
  type MemoryStore
} from "../memory";

const scope = { tenantId: "tenant-a", brandId: "brand-a" } as const;

function record(overrides: Partial<ArtDirectionMemoryRecord> = {}): ArtDirectionMemoryRecord {
  return {
    schemaVersion: 1,
    recordId: "record-1",
    scope,
    subjectId: "homepage",
    createdAt: "2026-08-15T00:00:00.000Z",
    validFrom: "2026-08-15T00:00:00.000Z",
    validUntil: "2026-09-15T00:00:00.000Z",
    confidence: 0.8,
    keywords: ["editorial", "coffee"],
    provenance: { sourceId: "designer-1", sourceType: "HUMAN", capturedAt: "2026-08-15T00:00:00.000Z", evidenceIds: ["evidence-1"] },
    payload: { kind: "OBSERVATION", statement: "Asymmetric editorial pacing tested well." },
    ...overrides
  };
}

function query(overrides: Partial<MemoryQuery> = {}): MemoryQuery {
  return {
    scope,
    subjectId: "homepage",
    keywords: ["editorial"],
    at: "2026-08-20T00:00:00.000Z",
    minimumConfidence: 0.5,
    limit: 10,
    correlationId: "corr-1",
    inputsDigest: "inputs-1",
    ...overrides
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("Art Direction Memory", () => {
  it("enforces append-only identity", async () => {
    const store = new InMemoryMemoryStore();
    const service = new AppendOnlyMemoryService(store, 90 * 24 * 60 * 60 * 1000);
    const item = record();
    await service.append(item);
    await expectCode(service.append(item), "DUPLICATE_ID");
    await expectCode(service.append(record({ payload: { kind: "OBSERVATION", statement: "Different" } })), "IDENTITY_COLLISION");
  });

  it("requires provenance evidence", () => {
    expect(() => validateMemoryRecord(record({ provenance: { sourceId: "designer-1", sourceType: "HUMAN", capturedAt: "2026-08-15T00:00:00.000Z", evidenceIds: [] } }))).toThrowError(MemoryError);
  });

  it("rejects non-canonical timestamps", () => {
    expect(() => validateMemoryRecord(record({ createdAt: "2026-08-15" }))).toThrowError(MemoryError);
  });

  it("rejects infinite or non-finite outcome values", () => {
    expect(() => validateMemoryRecord(record({ payload: { kind: "OUTCOME", directionId: "dir-1", metric: "ctr", value: Number.POSITIVE_INFINITY, interpretation: "bad" } }))).toThrowError(MemoryError);
  });

  it("rejects duplicate or empty normalized keywords", () => {
    expect(() => validateMemoryRecord(record({ keywords: ["Editorial", " editorial "] }))).toThrowError(MemoryError);
    expect(() => validateMemoryRecord(record({ keywords: [""] }))).toThrowError(MemoryError);
  });

  it("requires finite retention and prevents records without validUntil from escaping it", async () => {
    const store = new InMemoryMemoryStore();
    expect(() => new AppendOnlyMemoryService(store, Infinity)).toThrowError(MemoryError);
    const service = new AppendOnlyMemoryService(store, 90 * 24 * 60 * 60 * 1000);
    await expectCode(service.append(record({ validUntil: undefined })), "RETENTION_VIOLATION");
  });

  it("rejects validity longer than retention", async () => {
    const store = new InMemoryMemoryStore();
    const service = new AppendOnlyMemoryService(store, 24 * 60 * 60 * 1000);
    await expectCode(service.append(record()), "RETENTION_VIOLATION");
  });

  it("rejects self supersession", async () => {
    const service = new AppendOnlyMemoryService(new InMemoryMemoryStore(), 90 * 24 * 60 * 60 * 1000);
    await expectCode(service.append(record({ supersedes: "record-1" })), "SUPERSESSION_INCONSISTENT");
  });

  it("rejects missing or cross-scope supersession chains", async () => {
    const store = new InMemoryMemoryStore();
    const service = new AppendOnlyMemoryService(store, 90 * 24 * 60 * 60 * 1000);
    await expectCode(service.append(record({ recordId: "record-2", supersedes: "missing" })), "SUPERSESSION_INCONSISTENT");
  });

  it("rejects supersession cycles and forks", async () => {
    const store = new InMemoryMemoryStore();
    const first = record({ recordId: "record-1", createdAt: "2026-08-10T00:00:00.000Z", validFrom: "2026-08-10T00:00:00.000Z" });
    const second = record({ recordId: "record-2", createdAt: "2026-08-11T00:00:00.000Z", validFrom: "2026-08-11T00:00:00.000Z", supersedes: "record-1" });
    store.unsafeInject(first);
    store.unsafeInject(second);
    const service = new AppendOnlyMemoryService(store, 90 * 24 * 60 * 60 * 1000);
    await expectCode(service.append(record({ recordId: "record-3", createdAt: "2026-08-12T00:00:00.000Z", validFrom: "2026-08-12T00:00:00.000Z", supersedes: "record-1" })), "SUPERSESSION_INCONSISTENT");

    const cyclicStore = new InMemoryMemoryStore();
    const cycleA = record({ recordId: "a", createdAt: "2026-08-10T00:00:00.000Z", validFrom: "2026-08-10T00:00:00.000Z", supersedes: "b" });
    const cycleB = record({ recordId: "b", createdAt: "2026-08-09T00:00:00.000Z", validFrom: "2026-08-09T00:00:00.000Z", supersedes: "a" });
    cyclicStore.unsafeInject(cycleA);
    cyclicStore.unsafeInject(cycleB);
    const cyclicService = new AppendOnlyMemoryService(cyclicStore, 90 * 24 * 60 * 60 * 1000);
    await expectCode(cyclicService.append(record({ recordId: "c", createdAt: "2026-08-12T00:00:00.000Z", validFrom: "2026-08-12T00:00:00.000Z", supersedes: "a" })), "SUPERSESSION_INCONSISTENT");
  });

  it("ranks deterministically with lexical tie break", async () => {
    const store = new InMemoryMemoryStore();
    store.unsafeInject(record({ recordId: "b" }));
    store.unsafeInject(record({ recordId: "a" }));
    const results = await new DeterministicMemoryRetriever(store).retrieve(query());
    expect(results.results.map((item) => item.record.recordId)).toEqual(["a", "b"]);
  });

  it("excludes stale and superseded records while emitting evidence", async () => {
    const store = new InMemoryMemoryStore();
    const old = record({ recordId: "old", createdAt: "2026-08-01T00:00:00.000Z", validFrom: "2026-08-01T00:00:00.000Z", validUntil: "2026-08-10T00:00:00.000Z" });
    const prior = record({ recordId: "prior", createdAt: "2026-08-11T00:00:00.000Z", validFrom: "2026-08-11T00:00:00.000Z" });
    const current = record({ recordId: "current", createdAt: "2026-08-12T00:00:00.000Z", validFrom: "2026-08-12T00:00:00.000Z", supersedes: "prior" });
    store.unsafeInject(old);
    store.unsafeInject(prior);
    store.unsafeInject(current);
    const result = await new DeterministicMemoryRetriever(store).retrieve(query());
    expect(result.results.map((item) => item.record.recordId)).toEqual(["current"]);
    expect(result.evidence.filter((event) => event.kind === "MEMORY_STALE_OR_SUPERSEDED").length).toBe(2);
  });

  it("keeps conflicting outcomes visible", async () => {
    const store = new InMemoryMemoryStore();
    store.unsafeInject(record({ recordId: "o1", payload: { kind: "OUTCOME", directionId: "dir-1", metric: "ctr", value: 1, interpretation: "up" } }));
    store.unsafeInject(record({ recordId: "o2", payload: { kind: "OUTCOME", directionId: "dir-1", metric: "ctr", value: 2, interpretation: "higher" } }));
    const result = await new DeterministicMemoryRetriever(store).retrieve(query());
    expect(result.results[0]?.conflicts.length).toBe(1);
    expect(result.results[1]?.conflicts.length).toBe(1);
  });

  it("does not create conflicts across different subjects", async () => {
    const store = new InMemoryMemoryStore();
    store.unsafeInject(record({ recordId: "o1", subjectId: "homepage", payload: { kind: "OUTCOME", directionId: "dir-1", metric: "ctr", value: 1, interpretation: "up" } }));
    store.unsafeInject(record({ recordId: "o2", subjectId: "product", payload: { kind: "OUTCOME", directionId: "dir-1", metric: "ctr", value: 2, interpretation: "higher" } }));
    const result = await new DeterministicMemoryRetriever(store).retrieve(query({ subjectId: undefined }));
    expect(result.results.every((item) => item.conflicts.length === 0)).toBe(true);
  });

  it("rejects low-confidence records without granting them authority", async () => {
    const store = new InMemoryMemoryStore();
    store.unsafeInject(record({ recordId: "low", confidence: 0.1 }));
    const result = await new DeterministicMemoryRetriever(store).retrieve(query({ minimumConfidence: 0.5 }));
    expect(result.rejectedLowConfidence).toEqual(["low"]);
    expect(result.authority).toBe("EVIDENCE_ONLY");
    expect(result.mayFinalizeDirection).toBe(false);
  });

  it("never exposes cross-scope records even if a backend violates its contract", async () => {
    const wrong = record({ recordId: "wrong", scope: { tenantId: "tenant-b", brandId: "brand-b" } });
    const leakyStore: MemoryStore = {
      async append() {},
      async get() { return undefined; },
      async list() { return [wrong]; }
    };
    const sink = new InMemoryEvidenceSink();
    const result = await new DeterministicMemoryRetriever(leakyStore, sink).retrieve(query());
    expect(result.results).toEqual([]);
    expect(result.evidence.some((event) => event.kind === "SCOPE_REJECTION")).toBe(true);
  });

  it("returns typed backend failure even when evidence delivery also fails", async () => {
    const store = new InMemoryMemoryStore();
    store.failReads = true;
    const sink = new InMemoryEvidenceSink();
    sink.fail = true;
    await expectCode(new DeterministicMemoryRetriever(store, sink).retrieve(query()), "BACKEND_OUTAGE");
  });

  it("retrieval is evidence only and cannot finalize an art direction", async () => {
    const store = new InMemoryMemoryStore();
    store.unsafeInject(record());
    const result = await new DeterministicMemoryRetriever(store).retrieve(query());
    expect(result).toMatchObject({ authority: "EVIDENCE_ONLY", mayFinalizeDirection: false });
  });
});
