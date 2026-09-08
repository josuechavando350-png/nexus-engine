import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  certifyCwvLifecycleOptimization,
  type CwvBuildOptimizationPlan,
  type CwvLifecycleCertification,
  type CwvMetricsSnapshot,
  type CwvOptimizationReceipt,
  type CwvProofDigest,
  type CwvRegressionGuardrails,
} from "@nexus/core/cortex/cwv-lifecycle-pipeline";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{2,127})$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface PymeCwvCertificationInput {
  readonly deploymentId: string;
  readonly sourceRevision: string;
  readonly profileDigest: `sha256:${string}`;
  readonly policyDigest: `sha256:${string}`;
  readonly plan: CwvBuildOptimizationPlan;
  readonly receipts: readonly CwvOptimizationReceipt[];
  readonly before: CwvMetricsSnapshot;
  readonly after: CwvMetricsSnapshot;
  readonly proofs: CwvProofDigest;
  readonly guardrails: CwvRegressionGuardrails;
}

export interface PymeCwvCertificationRecord {
  readonly deploymentId: string;
  readonly sourceRevision: string;
  readonly profileDigest: `sha256:${string}`;
  readonly policyDigest: `sha256:${string}`;
  readonly lifecycle: CwvLifecycleCertification;
  readonly certificationDigest: `sha256:${string}`;
  readonly certifiedAt: string;
}

export class PymeCwvCertificationError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "PymeCwvCertificationError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function sha256(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !SHA256.test(value)) throw new PymeCwvCertificationError("INVALID_INPUT", `${label} must be lowercase sha256`);
  return value as `sha256:${string}`;
}

function utc(value: unknown, label: string): string {
  if (typeof value !== "string") throw new PymeCwvCertificationError("INTEGRITY_FAILURE", `${label} must be canonical UTC`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new PymeCwvCertificationError("INTEGRITY_FAILURE", `${label} must be canonical UTC`);
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value.trim())) throw new PymeCwvCertificationError("INVALID_INPUT", `${label} is invalid`);
  return value.trim();
}

export class SqlitePymeCwvCertificationStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new PymeCwvCertificationError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex_pyme_cwv_certification(
      deployment_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      profile_digest TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      certification_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      certified_at TEXT NOT NULL,
      PRIMARY KEY(deployment_id,source_revision)
    );
    CREATE TABLE IF NOT EXISTS cortex_pyme_cwv_certification_audit(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      deployment_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      certification_digest TEXT NOT NULL,
      certified_at TEXT NOT NULL,
      audit_digest TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  certify(input: PymeCwvCertificationInput): PymeCwvCertificationRecord {
    const deploymentId = id(input.deploymentId, "deploymentId");
    if (typeof input.sourceRevision !== "string" || !SOURCE_SHA.test(input.sourceRevision)) throw new PymeCwvCertificationError("INVALID_INPUT", "sourceRevision must be an exact 40-character commit SHA");
    const profileDigest = sha256(input.profileDigest, "profileDigest");
    const policyDigest = sha256(input.policyDigest, "policyDigest");
    const lifecycle = certifyCwvLifecycleOptimization({
      plan: input.plan,
      receipts: input.receipts,
      before: input.before,
      after: input.after,
      proofs: input.proofs,
      guardrails: input.guardrails,
    });
    const certifiedAt = new Date(this.now()).toISOString();
    const core = Object.freeze({ deploymentId, sourceRevision: input.sourceRevision, profileDigest, policyDigest, lifecycle });
    const certificationDigest = digest(core);
    const existing = this.get(deploymentId, input.sourceRevision);
    if (existing) {
      if (existing.certificationDigest !== certificationDigest) throw new PymeCwvCertificationError("CONFLICT", "deployment/source revision is already certified with different evidence");
      return existing;
    }
    const record: PymeCwvCertificationRecord = Object.freeze({ ...core, certificationDigest, certifiedAt });
    const payloadJson = canonical(record);
    const auditDigest = digest({ deploymentId, sourceRevision: input.sourceRevision, certificationDigest, certifiedAt });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO cortex_pyme_cwv_certification(deployment_id,source_revision,profile_digest,policy_digest,certification_digest,payload_json,certified_at) VALUES(?,?,?,?,?,?,?)").run(deploymentId, input.sourceRevision, profileDigest, policyDigest, certificationDigest, payloadJson, certifiedAt);
      this.db.prepare("INSERT INTO cortex_pyme_cwv_certification_audit(deployment_id,source_revision,certification_digest,certified_at,audit_digest) VALUES(?,?,?,?,?)").run(deploymentId, input.sourceRevision, certificationDigest, certifiedAt, auditDigest);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      const raced = this.get(deploymentId, input.sourceRevision);
      if (raced?.certificationDigest === certificationDigest) return raced;
      throw error;
    }
    return record;
  }

  get(deploymentIdInput: string, sourceRevision: string): PymeCwvCertificationRecord | undefined {
    const deploymentId = id(deploymentIdInput, "deploymentId");
    if (!SOURCE_SHA.test(sourceRevision)) throw new PymeCwvCertificationError("INVALID_INPUT", "sourceRevision must be an exact commit SHA");
    const row = this.db.prepare("SELECT profile_digest,policy_digest,certification_digest,payload_json,certified_at FROM cortex_pyme_cwv_certification WHERE deployment_id=? AND source_revision=?").get(deploymentId, sourceRevision) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (typeof row.profile_digest !== "string" || !SHA256.test(row.profile_digest) || typeof row.policy_digest !== "string" || !SHA256.test(row.policy_digest) || typeof row.certification_digest !== "string" || !SHA256.test(row.certification_digest) || typeof row.payload_json !== "string") throw new PymeCwvCertificationError("INTEGRITY_FAILURE", "stored CWV certification metadata is corrupt");
    let parsed: unknown;
    try { parsed = JSON.parse(row.payload_json); } catch { throw new PymeCwvCertificationError("INTEGRITY_FAILURE", "stored CWV certification payload is malformed"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PymeCwvCertificationError("INTEGRITY_FAILURE", "stored CWV certification payload is invalid");
    const record = parsed as PymeCwvCertificationRecord;
    if (record.deploymentId !== deploymentId || record.sourceRevision !== sourceRevision || record.profileDigest !== row.profile_digest || record.policyDigest !== row.policy_digest || record.certificationDigest !== row.certification_digest || utc(record.certifiedAt, "certifiedAt") !== row.certified_at) throw new PymeCwvCertificationError("INTEGRITY_FAILURE", "stored CWV certification identity mismatch");
    const core = { deploymentId: record.deploymentId, sourceRevision: record.sourceRevision, profileDigest: record.profileDigest, policyDigest: record.policyDigest, lifecycle: record.lifecycle };
    if (digest(core) !== record.certificationDigest) throw new PymeCwvCertificationError("INTEGRITY_FAILURE", "stored CWV certification digest mismatch");
    return Object.freeze(record);
  }
}
