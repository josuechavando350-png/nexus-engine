import { describe, expect, it, vi } from "vitest";
import type { PassiveTechnologyRevivalEngine } from "./revival-intelligence.js";
import type { RedisRevivalJobQueue, RevivalQueueJob } from "./redis-job-queue.js";
import { RevivalAsyncWorker } from "./worker.js";

const job: RevivalQueueJob = Object.freeze({
  jobId: "revjob_123e4567-e89b-12d3-a456-426614174000",
  tenantId: "tenant-revival",
  candidate: Object.freeze({ tenantId: "tenant-revival", candidateId: "lead-0001", websiteUrl: "https://candidate.example/", relationship: "FIRST_PARTY_CRM", dormantSince: "2025-01-01T00:00:00.000Z" }),
  attempt: 0,
  state: "LEASED",
  leasedBy: "worker-001",
  leaseUntil: 61_000,
  nextAttemptAt: 1_000,
  createdAt: 1_000,
  updatedAt: 1_000,
  lastError: null,
});

const assessment = Object.freeze({
  assessmentId: "rev_assessment000000000000000000000001",
  assessedAt: "2026-09-08T20:00:00.000Z",
  tenantId: "tenant-revival",
  candidateId: "lead-0001",
  websiteOrigin: "https://candidate.example",
  relationship: "FIRST_PARTY_CRM" as const,
  dormantDays: 600,
  classification: "REVIEW_REACTIVATION" as const,
  score: 50,
  reasons: Object.freeze(["DORMANT_365_PLUS_DAYS"]),
  publicSite: Object.freeze({ status: 200, title: null, description: null, hasCanonical: false, hasViewport: false, hasJsonLd: false }),
  technology: null,
  handoffUrl: "https://nexus.example/revival-review?assessment=rev_assessment000000000000000000000001",
  receiptDigest: `sha256:${"a".repeat(64)}`,
});

describe("RevivalAsyncWorker", () => {
  it("acknowledges the Redis lease only after assessment persistence succeeds", async () => {
    const order: string[] = [];
    const queue = {
      claim: vi.fn(async () => { order.push("claim"); return job; }),
      complete: vi.fn(async () => { order.push("complete"); }),
      retry: vi.fn(async () => "PENDING" as const),
    } as unknown as RedisRevivalJobQueue;
    const engine = { assess: vi.fn(async () => { order.push("assess"); return assessment; }) } as unknown as PassiveTechnologyRevivalEngine;
    const sink = { write: vi.fn(async () => { order.push("sink"); }) };
    const worker = new RevivalAsyncWorker({ tenantId: "tenant-revival", workerId: "worker-001", queue, engine, sink, now: () => 2_000 });
    await expect(worker.runOnce()).resolves.toEqual({ status: "COMPLETED", jobId: job.jobId, assessmentId: assessment.assessmentId });
    expect(order).toEqual(["claim", "assess", "sink", "complete"]);
  });

  it("schedules a bounded Redis retry when assessment or sink processing fails", async () => {
    const queue = {
      claim: vi.fn(async () => job),
      complete: vi.fn(async () => undefined),
      retry: vi.fn(async () => "PENDING" as const),
    } as unknown as RedisRevivalJobQueue;
    const engine = { assess: vi.fn(async () => { throw new Error("temporary failure"); }) } as unknown as PassiveTechnologyRevivalEngine;
    const worker = new RevivalAsyncWorker({ tenantId: "tenant-revival", workerId: "worker-001", queue, engine, sink: { write: async () => undefined }, now: () => 2_000 });
    await expect(worker.runOnce()).resolves.toEqual({ status: "RETRY_SCHEDULED", jobId: job.jobId, assessmentId: null });
    expect(queue.retry).toHaveBeenCalledWith(job, "worker-001", expect.stringContaining("temporary failure"), 2_000);
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it("returns IDLE when no Redis job is claimable", async () => {
    const queue = { claim: vi.fn(async () => null) } as unknown as RedisRevivalJobQueue;
    const worker = new RevivalAsyncWorker({ tenantId: "tenant-revival", workerId: "worker-001", queue, engine: { assess: async () => assessment } as unknown as PassiveTechnologyRevivalEngine, sink: { write: async () => undefined } });
    await expect(worker.runOnce()).resolves.toEqual({ status: "IDLE", jobId: null, assessmentId: null });
  });
});
