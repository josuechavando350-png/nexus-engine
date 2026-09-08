import type { ProcurementScanResult, PublicProcurementIntelligenceEngine } from "./procurement-intelligence.js";
import { SqliteProcurementJobQueue } from "./sqlite-job-queue.js";

export interface ProcurementResultSinkPort {
  write(input: Readonly<{ tenantId: string; jobId: string; result: ProcurementScanResult }>): Promise<void>;
}

export class ProcurementWorkerError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "RESULT_SINK_FAILURE", message: string) {
    super(message);
    this.name = "ProcurementWorkerError";
  }
}

export class ProcurementAsyncWorker {
  constructor(private readonly input: Readonly<{
    tenantId: string;
    workerId: string;
    queue: SqliteProcurementJobQueue;
    engine: PublicProcurementIntelligenceEngine;
    resultSink: ProcurementResultSinkPort;
    now?: () => number;
  }>) {
    if (!input?.tenantId || !input.workerId || !input.queue || !input.engine || !input.resultSink || typeof input.resultSink.write !== "function") {
      throw new ProcurementWorkerError("INVALID_INPUT", "procurement worker configuration is invalid");
    }
  }

  async runNext(): Promise<Readonly<{ status: "IDLE" | "COMPLETED" | "RETRY_SCHEDULED"; jobId: string | null }>> {
    const now = this.input.now ?? Date.now;
    const job = this.input.queue.claim(this.input.tenantId, this.input.workerId, now());
    if (!job) return Object.freeze({ status: "IDLE" as const, jobId: null });
    try {
      const result = await this.input.engine.scan(job.source);
      try {
        await this.input.resultSink.write({ tenantId: job.tenantId, jobId: job.jobId, result });
      } catch (error) {
        throw new ProcurementWorkerError("RESULT_SINK_FAILURE", `procurement result sink failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      this.input.queue.complete(job.tenantId, job.jobId, this.input.workerId, now());
      return Object.freeze({ status: "COMPLETED" as const, jobId: job.jobId });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown procurement worker error";
      this.input.queue.retry(job.tenantId, job.jobId, this.input.workerId, message.slice(0, 2_000), now());
      return Object.freeze({ status: "RETRY_SCHEDULED" as const, jobId: job.jobId });
    }
  }
}
