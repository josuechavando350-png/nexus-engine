import type { PassiveTechnologyRevivalEngine, RevivalAssessment, RevivalCandidate } from "./revival-intelligence.js";
import type { RedisRevivalJobQueue } from "./redis-job-queue.js";
import { RevivalAsyncWorker, type RevivalAssessmentSinkPort } from "./worker.js";

export interface RevivalEnqueueRequest {
  readonly candidate: RevivalCandidate;
  readonly scanKey: string;
}

export class PassiveTechnologyRevivalRuntime {
  constructor(private readonly input: {
    readonly engine: PassiveTechnologyRevivalEngine;
    readonly queue: RedisRevivalJobQueue;
    readonly operatorWebsiteOrigin: string;
    readonly now?: () => number;
  }) {
    if (!input || !input.engine || typeof input.engine.assess !== "function" || !input.queue || typeof input.queue.enqueue !== "function") throw new TypeError("revival runtime dependencies are invalid");
    let origin: URL;
    try { origin = new URL(input.operatorWebsiteOrigin); }
    catch { throw new TypeError("revival runtime operatorWebsiteOrigin is invalid"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || origin.port) throw new TypeError("revival runtime operatorWebsiteOrigin must be a bare HTTPS origin");
    this.operatorWebsiteOrigin = origin.origin;
  }

  private readonly operatorWebsiteOrigin: string;

  identity() {
    return Object.freeze({
      strategy: 8 as const,
      provider: "PASSIVE_TECH_ENRICHMENT_REDIS" as const,
      queue: "REDIS_RESP2_LUA" as const,
      operatorWebsiteOrigin: this.operatorWebsiteOrigin,
    });
  }

  assess(candidate: RevivalCandidate): Promise<RevivalAssessment> {
    return this.input.engine.assess(candidate);
  }

  enqueue(request: RevivalEnqueueRequest): Promise<string> {
    if (!request || typeof request !== "object") throw new TypeError("revival enqueue request is required");
    return this.input.queue.enqueue(request.candidate, request.scanKey, (this.input.now ?? Date.now)());
  }

  createWorker(input: { readonly tenantId: string; readonly workerId: string; readonly sink: RevivalAssessmentSinkPort; readonly leaseMs?: number }): RevivalAsyncWorker {
    return new RevivalAsyncWorker({
      tenantId: input.tenantId,
      workerId: input.workerId,
      queue: this.input.queue,
      engine: this.input.engine,
      sink: input.sink,
      now: this.input.now,
      leaseMs: input.leaseMs,
    });
  }
}
