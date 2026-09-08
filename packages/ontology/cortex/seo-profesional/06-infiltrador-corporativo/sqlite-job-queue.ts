import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ProcurementSourceConfig } from "./procurement-intelligence.js";

export class ProcurementJobQueueError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "STATE_CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "ProcurementJobQueueError";
  }
}

export interface ProcurementScanJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly source: ProcurementSourceConfig;
  readonly attempt: number;
  readonly leasedBy: string | null;
  readonly leaseUntil: string | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/u;
const MAX_ATTEMPTS = 8;

function sourceFingerprint(tenantId: string, source: ProcurementSourceConfig, scanKey: string): string {
  return createHash("sha256").update(`${tenantId}\n${source.sourceId}\n${source.kind}\n${source.url}\n${scanKey}`, "utf8").digest("hex");
}

function canonicalTime(ms: number): string {
  if (!Number.isFinite(ms)) throw new ProcurementJobQueueError("INVALID_INPUT", "queue clock value is invalid");
  return new Date(ms).toISOString();
}

function parseSource(raw: unknown): ProcurementSourceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProcurementJobQueueError("INTEGRITY_FAILURE", "stored procurement source is invalid");
  const value = raw as Record<string, unknown>;
  if (typeof value.sourceId !== "string" || (value.kind !== "OCDS_JSON" && value.kind !== "PUBLIC_HTML") || typeof value.url !== "string" ||
    (value.noticePathPrefixes !== undefined && (!Array.isArray(value.noticePathPrefixes) || value.noticePathPrefixes.some((item) => typeof item !== "string")))) {
    throw new ProcurementJobQueueError("INTEGRITY_FAILURE", "stored procurement source contract is invalid");
  }
  return Object.freeze({ sourceId: value.sourceId, kind: value.kind, url: value.url, ...(value.noticePathPrefixes === undefined ? {} : { noticePathPrefixes: Object.freeze([...(value.noticePathPrefixes as string[])]) }) });
}

export class SqliteProcurementJobQueue {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (!databasePath) throw new ProcurementJobQueueError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS seo_procurement_jobs (
        job_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        scan_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        source_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('PENDING','LEASED','DONE','FAILED')),
        attempt INTEGER NOT NULL DEFAULT 0,
        leased_by TEXT,
        lease_until TEXT,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS seo_procurement_jobs_ready
      ON seo_procurement_jobs(tenant_id, state, next_attempt_at, lease_until);
    `);
  }

  close(): void { this.db.close(); }

  enqueue(tenantId: string, source: ProcurementSourceConfig, scanKey: string, nowMs: number): string {
    if (!ID.test(tenantId) || !source || !ID.test(source.sourceId) || !ID.test(scanKey)) throw new ProcurementJobQueueError("INVALID_INPUT", "queue enqueue input is invalid");
    const now = canonicalTime(nowMs);
    const fingerprint = sourceFingerprint(tenantId, source, scanKey);
    const existing = this.db.prepare("SELECT job_id FROM seo_procurement_jobs WHERE tenant_id=? AND fingerprint=?").get(tenantId, fingerprint) as { job_id?: unknown } | undefined;
    if (existing?.job_id) return String(existing.job_id);
    const jobId = `proc_${randomUUID()}`;
    this.db.prepare(`INSERT INTO seo_procurement_jobs(job_id,tenant_id,source_id,scan_key,fingerprint,source_json,state,attempt,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'PENDING',0,?,?,?)`).run(jobId, tenantId, source.sourceId, scanKey, fingerprint, JSON.stringify(source), now, now, now);
    return jobId;
  }

  claim(tenantId: string, workerId: string, nowMs: number, leaseMs = 60_000): ProcurementScanJob | null {
    if (!ID.test(tenantId) || !ID.test(workerId) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
      throw new ProcurementJobQueueError("INVALID_INPUT", "queue claim input is invalid");
    }
    const now = canonicalTime(nowMs);
    const leaseUntil = canonicalTime(nowMs + leaseMs);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE seo_procurement_jobs SET state='PENDING',leased_by=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND state='LEASED' AND lease_until<=?").run(now, tenantId, now);
      const row = this.db.prepare(`SELECT job_id,source_json,attempt FROM seo_procurement_jobs
        WHERE tenant_id=? AND state='PENDING' AND next_attempt_at<=? ORDER BY created_at,job_id LIMIT 1`).get(tenantId, now) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      const jobId = String(row.job_id);
      const updated = this.db.prepare("UPDATE seo_procurement_jobs SET state='LEASED',leased_by=?,lease_until=?,updated_at=? WHERE job_id=? AND tenant_id=? AND state='PENDING'").run(workerId, leaseUntil, now, jobId, tenantId);
      if (updated.changes !== 1) throw new ProcurementJobQueueError("STATE_CONFLICT", "procurement job lease raced");
      this.db.exec("COMMIT");
      return Object.freeze({ jobId, tenantId, source: parseSource(JSON.parse(String(row.source_json)) as unknown), attempt: Number(row.attempt), leasedBy: workerId, leaseUntil });
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  complete(tenantId: string, jobId: string, workerId: string, nowMs: number): void {
    const now = canonicalTime(nowMs);
    const result = this.db.prepare("UPDATE seo_procurement_jobs SET state='DONE',leased_by=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND job_id=? AND state='LEASED' AND leased_by=?").run(now, tenantId, jobId, workerId);
    if (result.changes !== 1) throw new ProcurementJobQueueError("STATE_CONFLICT", "procurement job completion does not own the active lease");
  }

  retry(tenantId: string, jobId: string, workerId: string, errorMessage: string, nowMs: number): void {
    if (!errorMessage || errorMessage.length > 2_000) throw new ProcurementJobQueueError("INVALID_INPUT", "retry error message is invalid");
    const row = this.db.prepare("SELECT attempt FROM seo_procurement_jobs WHERE tenant_id=? AND job_id=? AND state='LEASED' AND leased_by=?").get(tenantId, jobId, workerId) as { attempt?: unknown } | undefined;
    if (!row) throw new ProcurementJobQueueError("STATE_CONFLICT", "procurement retry does not own the active lease");
    const nextAttempt = Number(row.attempt) + 1;
    if (!Number.isSafeInteger(nextAttempt) || nextAttempt > MAX_ATTEMPTS) throw new ProcurementJobQueueError("INTEGRITY_FAILURE", "procurement job attempt counter is invalid");
    const now = canonicalTime(nowMs);
    if (nextAttempt === MAX_ATTEMPTS) {
      this.db.prepare("UPDATE seo_procurement_jobs SET state='FAILED',attempt=?,leased_by=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE tenant_id=? AND job_id=?").run(nextAttempt, errorMessage, now, tenantId, jobId);
      return;
    }
    const delayMs = Math.min(60 * 60_000, 5_000 * (2 ** (nextAttempt - 1)));
    const next = canonicalTime(nowMs + delayMs);
    this.db.prepare("UPDATE seo_procurement_jobs SET state='PENDING',attempt=?,leased_by=NULL,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=? WHERE tenant_id=? AND job_id=?").run(nextAttempt, next, errorMessage, now, tenantId, jobId);
  }

  counts(tenantId: string): Readonly<Record<"pending" | "leased" | "done" | "failed", number>> {
    if (!ID.test(tenantId)) throw new ProcurementJobQueueError("INVALID_INPUT", "tenantId is invalid");
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM seo_procurement_jobs WHERE tenant_id=? GROUP BY state").all(tenantId) as Array<{ state?: unknown; count?: unknown }>;
    const result = { pending: 0, leased: 0, done: 0, failed: 0 };
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new ProcurementJobQueueError("INTEGRITY_FAILURE", "queue count is invalid");
      if (row.state === "PENDING") result.pending = count;
      else if (row.state === "LEASED") result.leased = count;
      else if (row.state === "DONE") result.done = count;
      else if (row.state === "FAILED") result.failed = count;
    }
    return Object.freeze(result);
  }
}
