import type { PassiveTechnologyRevivalEngine, RevivalAssessment } from "./revival-intelligence.js";
import type { RedisRevivalJobQueue, RevivalQueueJob } from "./redis-job-queue.js";

export interface RevivalAssessmentSinkPort {
  write(assessment: RevivalAssessment, job: RevivalQueueJob): Promise<void>;
}

export interface RevivalWorkerResult {
  readonly status: "IDLE" | "COMPLETED" | "RETRY_SCHEDULED" | "FAILED_PERMANENTLY";
  readonly jobId: string | null;
  readonly assessmentId: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.normalize("NFKC").replace(/[\r\n\t]+/gu, " ").slice(0, 2_000) || "unknown revival worker error";
}

export class RevivalAsyncWorker {
  constructor(private readonly input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly queue: RedisRevivalJobQueue;
    readonly engine: PassiveTechnologyRevivalEngine;
    readonly sink: RevivalAssessmentSinkPort;
    readonly now?: () => number;
    readonly leaseMs?: number;
  }) {
    if (!input || !ID.test(input.tenantId) || !ID.test(input.workerId) || !input.queue || typeof input.queue.claim !== "function" || !input.engine || typeof input.engine.assess !== "function" || !input.sink || typeof input.sink.write !== "function") {
      throw new TypeError("revival worker configuration is invalid");
    }
    const leaseMs = input.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) throw new TypeError("revival worker leaseMs is invalid");
  }

  async runOnce(): Promise<RevivalWorkerResult> {
    const now = this.input.now ?? Date.now;
    const leaseMs = this.input.leaseMs ?? 60_000;
    const job = await this.input.queue.claim(this.input.tenantId, this.input.workerId, now(), leaseMs);
    if (!job) return Object.freeze({ status: "IDLE" as const, jobId: null, assessmentId: null });
    try {
      const assessment = await this.input.engine.assess(job.candidate);
      await this.input.sink.write(assessment, job);
      await this.input.queue.complete(job, this.input.workerId, now());
      return Object.freeze({ status: "COMPLETED" as const, jobId: job.jobId, assessmentId: assessment.assessmentId });
    } catch (error) {
      const retry = await this.input.queue.retry(job, this.input.workerId, errorMessage(error), now());
      return Object.freeze({ status: retry === "FAILED" ? "FAILED_PERMANENTLY" as const : "RETRY_SCHEDULED" as const, jobId: job.jobId, assessmentId: null });
    }
  }
}
