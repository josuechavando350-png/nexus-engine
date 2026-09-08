import { describe, expect, it, vi } from "vitest";
import type { PassiveTechnologyRevivalEngine, RevivalAssessment } from "./revival-intelligence.js";
import type { RedisRevivalJobQueue } from "./redis-job-queue.js";
import { PassiveTechnologyRevivalRuntime } from "./runtime.js";

const candidate = Object.freeze({ tenantId: "tenant-revival", candidateId: "lead-0001", websiteUrl: "https://candidate.example/", relationship: "FIRST_PARTY_CRM" as const, dormantSince: "2025-01-01T00:00:00.000Z" });
const assessment = Object.freeze({ assessmentId: "rev_a", assessedAt: "2026-09-08T20:00:00.000Z" }) as unknown as RevivalAssessment;

describe("PassiveTechnologyRevivalRuntime", () => {
  it("binds passive enrichment and the Redis queue under one strategy identity", async () => {
    const engine = { assess: vi.fn(async () => assessment) } as unknown as PassiveTechnologyRevivalEngine;
    const queue = { enqueue: vi.fn(async () => "revjob_123e4567-e89b-12d3-a456-426614174000") } as unknown as RedisRevivalJobQueue;
    const runtime = new PassiveTechnologyRevivalRuntime({ engine, queue, operatorWebsiteOrigin: "https://nexus.example", now: () => 1_000 });
    expect(runtime.identity()).toEqual({ strategy: 8, provider: "PASSIVE_TECH_ENRICHMENT_REDIS", queue: "REDIS_RESP2_LUA", operatorWebsiteOrigin: "https://nexus.example" });
    await expect(runtime.assess(candidate)).resolves.toBe(assessment);
    await expect(runtime.enqueue({ candidate, scanKey: "cycle-001" })).resolves.toMatch(/^revjob_/u);
    expect(queue.enqueue).toHaveBeenCalledWith(candidate, "cycle-001", 1_000);
  });

  it("rejects non-canonical operator origins", () => {
    expect(() => new PassiveTechnologyRevivalRuntime({ engine: { assess: async () => assessment } as unknown as PassiveTechnologyRevivalEngine, queue: { enqueue: async () => "x" } as unknown as RedisRevivalJobQueue, operatorWebsiteOrigin: "http://nexus.example" })).toThrow(/bare HTTPS origin/u);
  });
});
