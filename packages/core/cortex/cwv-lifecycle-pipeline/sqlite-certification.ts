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
} from "./index";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{2,127})$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface CwvSourceBoundCertificationInput {
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

export interface CwvSourceBoundCertificationRecord {
  readonly deploymentId: string;
  readonly sourceRevision: string;
  readonly profileDigest: `sha256:${string}`;
  readonly policyDigest: `sha256:${string}`;
  readonly lifecycle: CwvLifecycleCertification;
  readonly certificationDigest: `sha256:${string}`;
  readonly certifiedAt: string;
}

export class CwvSourceBoundCertificationError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "CwvSourceBoundCertificationError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function sha256(value: unknown, label: string): `sha256:${string}` { if (typeof value !== "string" || !SHA256.test(value)) throw new CwvSourceBoundCertificationError("INVALID_INPUT", `${label} must be lowercase sha256`); return value as `sha256:${string}`; }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !ID.test(value.trim())) throw new CwvSourceBoundCertificationError("INVALID_INPUT", `${label} is invalid`); return value.trim(); }
function canonicalUtc(value: unknown): string { if (typeof value !== "string") throw new CwvSourceBoundCertificationError("INTEGRITY_FAILURE", "certifiedAt is invalid"); const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new CwvSourceBoundCertificationError("INTEGRITY_FAILURE", "certifiedAt is invalid"); return value; }

export class SqliteCwvSourceBoundCertificationStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new CwvSourceBoundCertificationError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex33_source_certification(
      deployment_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      profile_digest TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      certification_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      certified_at TEXT NOT NULL,
      PRIMARY KEY(deployment_id,source_revision)
    );`);
  }
  close(): void { this.db.close(); }

  certify(input: CwvSourceBoundCertificationInput): CwvSourceBoundCertificationRecord {
    const deploymentId = identifier(input.deploymentId, "deploymentId");
    if (typeof input.sourceRevision !== "string" || !SOURCE_SHA.test(input.sourceRevision)) throw new CwvSourceBoundCertificationError("INVALID_INPUT", "sourceRevision must be an exact 40-character commit SHA");
    const profileDigest = sha256(input.profileDigest, "profileDigest"); const policyDigest = sha256(input.policyDigest, "policyDigest");
    const lifecycle = certifyCwvLifecycleOptimization({ plan: input.plan, receipts: input.receipts, before: input.before, after: input.after, proofs: input.proofs, guardrails: input.guardrails });
    const core = Object.freeze({ deploymentId, sourceRevision: input.sourceRevision, profileDigest, policyDigest, lifecycle });
    const certificationDigest = digest(core);
    const existing = this.get(deploymentId, input.sourceRevision);
    if (existing) { if (existing.certificationDigest !== certificationDigest) throw new CwvSourceBoundCertificationError("CONFLICT", "deployment/source revision is already certified with different evidence"); return existing; }
    const certifiedAt = new Date(this.now()).toISOString();
    const record: CwvSourceBoundCertificationRecord = Object.freeze({ ...core, certificationDigest, certifiedAt });
    this.db.prepare("INSERT INTO cortex33_source_certification(deployment_id,source_revision,profile_digest,policy_digest,certification_digest,payload_json,certified_at) VALUES(?,?,?,?,?,?,?)").run(deploymentId, input.sourceRevision, profileDigest, policyDigest, certificationDigest, canonical(record), certifiedAt);
    return record;
  }

  get(deploymentIdInput: string, sourceRevision: string): CwvSourceBoundCertificationRecord | undefined {
    const deploymentId = identifier(deploymentIdInput, "deploymentId");
    if (!SOURCE_SHA.test(sourceRevision)) throw new CwvSourceBoundCertificationError("INVALID_INPUT", "sourceRevision must be an exact commit SHA");
    const row = this.db.prepare("SELECT certification_digest,payload_json,certified_at FROM cortex33_source_certification WHERE deployment_id=? AND source_revision=?").get(deploymentId, sourceRevision) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (typeof row.certification_digest !== "string" || !SHA256.test(row.certification_digest) || typeof row.payload_json !== "string" || canonicalUtc(row.certified_at) !== row.certified_at) throw new CwvSourceBoundCertificationError("INTEGRITY_FAILURE", "stored source certification is corrupt");
    let parsed: unknown; try { parsed = JSON.parse(row.payload_json); } catch { throw new CwvSourceBoundCertificationError("INTEGRITY_FAILURE", "stored source certification payload is malformed"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CwvSourceBoundCertificationError("INTEGRITY_FAILURE", "stored source certification payload is invalid");
    const record = parsed as CwvSourceBoundCertificationRecord;
    const core = { deploymentId: record.deploymentId, sourceRevision: record.sourceRevision, profileDigest: record.profileDigest, policyDigest: record.policyDigest, lifecycle: record.lifecycle };
    if (record.deploymentId !== deploymentId || record.sourceRevision !== sourceRevision || record.certificationDigest !== row.certification_digest || digest(core) !== record.certificationDigest || record.certifiedAt !== row.certified_at) throw new CwvSourceBoundCertificationError("INTEGRITY_FAILURE", "stored source certification digest or identity mismatch");
    return Object.freeze(record);
  }
}
