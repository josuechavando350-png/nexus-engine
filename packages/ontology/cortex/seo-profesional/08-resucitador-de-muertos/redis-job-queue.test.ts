import { describe, expect, it, vi } from "vitest";
import type { RedisScriptPort } from "./redis-resp-client.js";
import { RedisRevivalJobQueue } from "./redis-job-queue.js";

const candidate = Object.freeze({
  tenantId: "tenant-revival",
  candidateId: "lead-0001",
  websiteUrl: "https://candidate.example/",
  relationship: "FIRST_PARTY_CRM" as const,
  dormantSince: "2025-01-01T00:00:00.000Z",
});

describe("RedisRevivalJobQueue", () => {
  it("uses cluster-slot-safe tenant keys and Lua EVAL for deduplicated enqueue", async () => {
    const evalFn = vi.fn(async () => "revjob_123e4567-e89b-12d3-a456-426614174000");
    const queue = new RedisRevivalJobQueue({ eval: evalFn });
    await expect(queue.enqueue(candidate, "cycle-2026-09-08", 1_000)).resolves.toBe("revjob_123e4567-e89b-12d3-a456-426614174000");
    expect(evalFn).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalFn.mock.calls[0]!;
    expect(script).toMatch(/HGET|HSET|ZADD/u);
    expect(keys).toEqual([
      "nexus:seo8:{tenant-revival}:dedupe",
      "nexus:seo8:{tenant-revival}:jobs",
      "nexus:seo8:{tenant-revival}:pending",
    ]);
    expect(args[0]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("parses and verifies a claimed lease before exposing the job", async () => {
    const leased = {
      jobId: "revjob_123e4567-e89b-12d3-a456-426614174000",
      tenantId: "tenant-revival",
      candidate,
      attempt: 0,
      state: "LEASED",
      leasedBy: "worker-001",
      leaseUntil: 61_000,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      lastError: null,
    };
    const redis: RedisScriptPort = { eval: vi.fn(async () => JSON.stringify(leased)) };
    const queue = new RedisRevivalJobQueue(redis);
    await expect(queue.claim("tenant-revival", "worker-001", 1_000)).resolves.toMatchObject({ state: "LEASED", leasedBy: "worker-001", candidate: { candidateId: "lead-0001" } });
  });

  it("fails closed when Redis returns a lease for another worker", async () => {
    const redis: RedisScriptPort = { eval: vi.fn(async () => JSON.stringify({
      jobId: "revjob_123e4567-e89b-12d3-a456-426614174000",
      tenantId: "tenant-revival",
      candidate,
      attempt: 0,
      state: "LEASED",
      leasedBy: "worker-other",
      leaseUntil: 61_000,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      lastError: null,
    })) };
    await expect(new RedisRevivalJobQueue(redis).claim("tenant-revival", "worker-001", 1_000)).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
  });

  it("requires active lease ownership for complete and retry results", async () => {
    const job = {
      jobId: "revjob_123e4567-e89b-12d3-a456-426614174000",
      tenantId: "tenant-revival",
      candidate,
      attempt: 0,
      state: "LEASED" as const,
      leasedBy: "worker-001",
      leaseUntil: 61_000,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      lastError: null,
    };
    const evalFn = vi.fn<RedisScriptPort["eval"]>();
    evalFn.mockResolvedValueOnce("OK").mockResolvedValueOnce("PENDING");
    const queue = new RedisRevivalJobQueue({ eval: evalFn });
    await expect(queue.complete(job, "worker-001", 2_000)).resolves.toBeUndefined();
    await expect(queue.retry(job, "worker-001", "temporary transport error", 3_000)).resolves.toBe("PENDING");
  });
});
