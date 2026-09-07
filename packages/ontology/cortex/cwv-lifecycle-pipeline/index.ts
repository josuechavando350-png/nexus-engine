import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,127})$/u;
const PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/u;

export type CwvAuditMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type CwvRuntimeState = "NORMAL" | "PRESSURE" | "PAUSED";

export interface CwvBuildCertification {
  readonly formatVersion: 1;
  readonly sourceRevision: string;
  readonly app: string;
  readonly prebuildDigest: `sha256:${string}`;
  readonly inputDigest: `sha256:${string}`;
  readonly buildPolicyDigest: `sha256:${string}`;
  readonly edgePolicyDigest: `sha256:${string}`;
  readonly outputDigest: `sha256:${string}`;
  readonly evidence: Readonly<{
    jsFiles: number;
    cssFiles: number;
    staticFiles: number;
    totalJsBytes: number;
    totalCssBytes: number;
    maxObservedJsChunkBytes: number;
    maxObservedCssFileBytes: number;
  }>;
  readonly certificationDigest: `sha256:${string}`;
}

export interface CwvRuntimeEvidenceInput {
  readonly sampleId: string;
  readonly occurredAt: string;
  readonly routePath: string;
  readonly prebuildDigest: string;
  readonly edgePolicyDigest: string;
  readonly sourceRevision: string;
  readonly visibility: "VISIBLE" | "HIDDEN";
  readonly lcpMs: number | null;
  readonly cls: number;
  readonly inpMs: number | null;
  readonly recentLongTaskMs: number;
  readonly state: CwvRuntimeState;
  readonly reasons: readonly ("HIDDEN" | "LCP" | "CLS" | "INP" | "LONG_TASK")[];
  readonly speculationSuspended: boolean;
}

export interface CwvRuntimeEvidenceRecord extends CwvRuntimeEvidenceInput {
  readonly certificationDigest: `sha256:${string}`;
  readonly outputDigest: `sha256:${string}`;
  readonly evidenceDigest: `sha256:${string}`;
  readonly recordedAt: string;
}

export interface CwvAuditControlState {
  readonly mode: CwvAuditMode;
  readonly revision: number;
  readonly changedAt: string;
}

export class CwvPipelineAuditError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "INTEGRITY_FAILURE" | "PIPELINE_MISMATCH" | "MODE_BLOCKED" | "CONFLICT" | "PERSISTENCE_FAILURE", message: string) {
    super(message);
    this.name = "CwvPipelineAuditError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function canonicalUtc(value: unknown, label: string): string {
  if (typeof value !== "string") throw new CwvPipelineAuditError("INVALID_INPUT", `${label} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new CwvPipelineAuditError("INVALID_INPUT", `${label} must be canonical UTC`);
  return value;
}
function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new CwvPipelineAuditError("INVALID_INPUT", `${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new CwvPipelineAuditError("INVALID_INPUT", `${label} is out of range`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  const parsed = finite(value, label, min, max);
  if (!Number.isSafeInteger(parsed)) throw new CwvPipelineAuditError("INVALID_INPUT", `${label} must be an integer`);
  return parsed;
}
function sha256(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !SHA256.test(value)) throw new CwvPipelineAuditError("INVALID_INPUT", `${label} must be sha256`);
  return value as `sha256:${string}`;
}

export function parseCwvBuildCertification(value: unknown): CwvBuildCertification {
  const raw = plain(value, "CWV build certification");
  if (Object.keys(raw).sort().join(",") !== "app,buildPolicyDigest,certificationDigest,edgePolicyDigest,evidence,formatVersion,inputDigest,outputDigest,prebuildDigest,sourceRevision" || raw.formatVersion !== 1) {
    throw new CwvPipelineAuditError("INTEGRITY_FAILURE", "CWV build certification contract/version is invalid");
  }
  if (raw.app !== "apps/pipeline-probe" || typeof raw.sourceRevision !== "string" || !SHA.test(raw.sourceRevision)) throw new CwvPipelineAuditError("INTEGRITY_FAILURE", "CWV build certification identity is invalid");
  const evidenceRaw = plain(raw.evidence, "CWV build evidence");
  const evidenceKeys = ["cssFiles","jsFiles","maxObservedCssFileBytes","maxObservedJsChunkBytes","staticFiles","totalCssBytes","totalJsBytes"];
  if (Object.keys(evidenceRaw).sort().join(",") !== evidenceKeys.sort().join(",")) throw new CwvPipelineAuditError("INTEGRITY_FAILURE", "CWV build evidence contract is invalid");
  const evidence = Object.freeze({
    jsFiles: integer(evidenceRaw.jsFiles, "jsFiles", 0, 100_000),
    cssFiles: integer(evidenceRaw.cssFiles, "cssFiles", 0, 100_000),
    staticFiles: integer(evidenceRaw.staticFiles, "staticFiles", 1, 1_000_000),
    totalJsBytes: integer(evidenceRaw.totalJsBytes, "totalJsBytes", 0, 1_000_000_000),
    totalCssBytes: integer(evidenceRaw.totalCssBytes, "totalCssBytes", 0, 1_000_000_000),
    maxObservedJsChunkBytes: integer(evidenceRaw.maxObservedJsChunkBytes, "maxObservedJsChunkBytes", 0, 100_000_000),
    maxObservedCssFileBytes: integer(evidenceRaw.maxObservedCssFileBytes, "maxObservedCssFileBytes", 0, 100_000_000),
  });
  const base = {
    formatVersion: 1 as const,
    sourceRevision: raw.sourceRevision,
    app: "apps/pipeline-probe",
    prebuildDigest: sha256(raw.prebuildDigest, "prebuildDigest"),
    inputDigest: sha256(raw.inputDigest, "inputDigest"),
    buildPolicyDigest: sha256(raw.buildPolicyDigest, "buildPolicyDigest"),
    edgePolicyDigest: sha256(raw.edgePolicyDigest, "edgePolicyDigest"),
    outputDigest: sha256(raw.outputDigest, "outputDigest"),
    evidence,
  };
  const certificationDigest = sha256(raw.certificationDigest, "certificationDigest");
  if (digest(base) !== certificationDigest) throw new CwvPipelineAuditError("INTEGRITY_FAILURE", "CWV build certification digest mismatch");
  return Object.freeze({ ...base, certificationDigest });
}

export function parseCwvRuntimeEvidence(value: unknown, certification: CwvBuildCertification, nowMs: number, maxAgeMs: number): CwvRuntimeEvidenceInput {
  const raw = plain(value, "CWV runtime evidence");
  const expected = ["cls","edgePolicyDigest","inpMs","lcpMs","occurredAt","prebuildDigest","reasons","recentLongTaskMs","routePath","sampleId","sourceRevision","speculationSuspended","state","visibility"];
  if (Object.keys(raw).sort().join(",") !== expected.sort().join(",")) throw new CwvPipelineAuditError("INVALID_INPUT", "CWV runtime evidence contract is invalid");
  if (typeof raw.sampleId !== "string" || !ID.test(raw.sampleId)) throw new CwvPipelineAuditError("INVALID_INPUT", "sampleId is malformed");
  const occurredAt = canonicalUtc(raw.occurredAt, "occurredAt");
  const age = nowMs - Date.parse(occurredAt);
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1_000 || maxAgeMs > 86_400_000 || age < 0 || age > maxAgeMs) throw new CwvPipelineAuditError("INVALID_INPUT", "runtime evidence is stale or future-dated");
  if (typeof raw.routePath !== "string" || !PATH.test(raw.routePath) || raw.routePath.includes("?") || raw.routePath.includes("#")) throw new CwvPipelineAuditError("INVALID_INPUT", "routePath is invalid");
  if (raw.prebuildDigest !== certification.prebuildDigest || raw.edgePolicyDigest !== certification.edgePolicyDigest || raw.sourceRevision !== certification.sourceRevision) {
    throw new CwvPipelineAuditError("PIPELINE_MISMATCH", "runtime Build/Edge identity does not match certified build");
  }
  if (!(raw.visibility === "VISIBLE" || raw.visibility === "HIDDEN")) throw new CwvPipelineAuditError("INVALID_INPUT", "visibility is invalid");
  if (!(raw.state === "NORMAL" || raw.state === "PRESSURE" || raw.state === "PAUSED")) throw new CwvPipelineAuditError("INVALID_INPUT", "runtime state is invalid");
  if (typeof raw.speculationSuspended !== "boolean") throw new CwvPipelineAuditError("INVALID_INPUT", "speculationSuspended must be boolean");
  const lcpMs = raw.lcpMs === null ? null : finite(raw.lcpMs, "lcpMs", 0, 600_000);
  const inpMs = raw.inpMs === null ? null : finite(raw.inpMs, "inpMs", 0, 60_000);
  const cls = finite(raw.cls, "cls", 0, 100);
  const recentLongTaskMs = finite(raw.recentLongTaskMs, "recentLongTaskMs", 0, 60_000);
  if (!Array.isArray(raw.reasons) || raw.reasons.length > 5) throw new CwvPipelineAuditError("INVALID_INPUT", "reasons are invalid");
  const allowed = new Set(["HIDDEN", "LCP", "CLS", "INP", "LONG_TASK"]);
  const reasons = raw.reasons.map((reason) => { if (typeof reason !== "string" || !allowed.has(reason)) throw new CwvPipelineAuditError("INVALID_INPUT", "runtime reason is invalid"); return reason as "HIDDEN" | "LCP" | "CLS" | "INP" | "LONG_TASK"; });
  if (new Set(reasons).size !== reasons.length) throw new CwvPipelineAuditError("INVALID_INPUT", "runtime reasons must be unique");
  if ((raw.state === "NORMAL") !== (reasons.length === 0) || (raw.state === "PAUSED") !== (reasons.length === 1 && reasons[0] === "HIDDEN")) throw new CwvPipelineAuditError("INVALID_INPUT", "runtime state/reasons are inconsistent");
  if (raw.speculationSuspended !== (raw.state !== "NORMAL")) throw new CwvPipelineAuditError("INVALID_INPUT", "speculation suspension does not match runtime state");
  return Object.freeze({
    sampleId: raw.sampleId,
    occurredAt,
    routePath: raw.routePath,
    prebuildDigest: certification.prebuildDigest,
    edgePolicyDigest: certification.edgePolicyDigest,
    sourceRevision: certification.sourceRevision,
    visibility: raw.visibility,
    lcpMs,
    cls,
    inpMs,
    recentLongTaskMs,
    state: raw.state,
    reasons: Object.freeze(reasons),
    speculationSuspended: raw.speculationSuspended,
  });
}

export class SqliteCwvPipelineAuditStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, readonly certification: CwvBuildCertification, private readonly now: () => number = Date.now, private readonly maxEvidenceAgeMs = 300_000) {
    if (!databasePath) throw new CwvPipelineAuditError("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex33_control(mode TEXT NOT NULL,revision INTEGER NOT NULL,changed_at TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex33_runtime_evidence(
      sample_id TEXT PRIMARY KEY,
      evidence_digest TEXT NOT NULL,
      certification_digest TEXT NOT NULL,
      output_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );`);
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM cortex33_control").get() as { count: number | bigint };
    if (Number(row.count) === 0) this.db.prepare("INSERT INTO cortex33_control(mode,revision,changed_at) VALUES('KILLED',0,?)").run(new Date(this.now()).toISOString());
  }
  close(): void { this.db.close(); }
  control(): CwvAuditControlState {
    const row = this.db.prepare("SELECT mode,revision,changed_at FROM cortex33_control LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row || !(row.mode === "ACTIVE" || row.mode === "OBSERVE_ONLY" || row.mode === "KILLED") || !Number.isSafeInteger(row.revision)) throw new CwvPipelineAuditError("INTEGRITY_FAILURE", "CWV audit control is corrupt");
    return Object.freeze({ mode: row.mode, revision: row.revision as number, changedAt: canonicalUtc(row.changed_at, "control.changedAt") });
  }
  setMode(mode: CwvAuditMode, expectedRevision: number): CwvAuditControlState {
    if (!(mode === "ACTIVE" || mode === "OBSERVE_ONLY" || mode === "KILLED") || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CwvPipelineAuditError("INVALID_INPUT", "control update is invalid");
    const current = this.control();
    if (current.revision !== expectedRevision) throw new CwvPipelineAuditError("CONFLICT", "CWV audit control revision conflict");
    const changedAt = new Date(this.now()).toISOString();
    const result = this.db.prepare("UPDATE cortex33_control SET mode=?,revision=?,changed_at=? WHERE revision=?").run(mode, expectedRevision + 1, changedAt, expectedRevision);
    if (result.changes !== 1) throw new CwvPipelineAuditError("CONFLICT", "CWV audit control lost compare-and-set boundary");
    return this.control();
  }
  record(value: unknown): CwvRuntimeEvidenceRecord | null {
    const input = parseCwvRuntimeEvidence(value, this.certification, this.now(), this.maxEvidenceAgeMs);
    const control = this.control();
    if (control.mode === "KILLED") throw new CwvPipelineAuditError("MODE_BLOCKED", "CWV audit kill switch blocks runtime evidence");
    if (control.mode === "OBSERVE_ONLY") return null;
    const recordedAt = new Date(this.now()).toISOString();
    const base = { ...input, certificationDigest: this.certification.certificationDigest, outputDigest: this.certification.outputDigest };
    const evidenceDigest = digest(base);
    const existing = this.db.prepare("SELECT evidence_digest,payload_json,recorded_at FROM cortex33_runtime_evidence WHERE sample_id=?").get(input.sampleId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.evidence_digest !== evidenceDigest) throw new CwvPipelineAuditError("CONFLICT", "sampleId is already bound to different runtime evidence");
      return Object.freeze({ ...base, evidenceDigest, recordedAt: canonicalUtc(existing.recorded_at, "recordedAt") });
    }
    this.db.prepare("INSERT INTO cortex33_runtime_evidence(sample_id,evidence_digest,certification_digest,output_digest,payload_json,recorded_at) VALUES(?,?,?,?,?,?)").run(input.sampleId, evidenceDigest, this.certification.certificationDigest, this.certification.outputDigest, JSON.stringify(base), recordedAt);
    return Object.freeze({ ...base, evidenceDigest, recordedAt });
  }
  get(sampleId: string): CwvRuntimeEvidenceRecord | undefined {
    if (!ID.test(sampleId)) throw new CwvPipelineAuditError("INVALID_INPUT", "sampleId is malformed");
    const row = this.db.prepare("SELECT evidence_digest,payload_json,recorded_at FROM cortex33_runtime_evidence WHERE sample_id=?").get(sampleId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const base = JSON.parse(String(row.payload_json)) as Omit<CwvRuntimeEvidenceRecord, "evidenceDigest" | "recordedAt">;
    return Object.freeze({ ...base, evidenceDigest: sha256(row.evidence_digest, "stored evidenceDigest"), recordedAt: canonicalUtc(row.recorded_at, "recordedAt") });
  }
}
