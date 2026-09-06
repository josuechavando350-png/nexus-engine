import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface CreativeVersionInput {
  readonly creativeId: string;
  readonly version: string;
  readonly assetDigests: readonly string[];
  readonly deploymentKeys: readonly string[];
  readonly activatedAt: string;
}

export interface CreativeVersionRecord extends CreativeVersionInput {
  readonly manifestDigest: `sha256:${string}`;
  readonly traceKey: string;
}

export interface SignedCreativeTrace {
  readonly traceKey: string;
  readonly manifestDigest: `sha256:${string}`;
  readonly signature: `sha256=${string}`;
}

export interface AggregatedMetricInput {
  readonly aggregationId: string;
  readonly metric: string;
  readonly value: number;
  readonly traceKeys: readonly string[];
}

export interface AggregatedMetricResolution {
  readonly aggregationId: string;
  readonly metric: string;
  readonly value: number;
  readonly resolution: "EXACT" | "AMBIGUOUS_SET" | "UNRESOLVED";
  readonly creativeIds: readonly string[];
  readonly manifestDigests: readonly string[];
}

export class Cortex16Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INVALID_SIGNATURE" | "INTEGRITY_FAILURE", message: string) {
    super(message);
    this.name = "Cortex16Error";
  }
}

function utc(value: unknown): string {
  if (typeof value !== "string") throw new Cortex16Error("INVALID_INPUT", "activatedAt must be canonical UTC");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Cortex16Error("INVALID_INPUT", "activatedAt must be canonical UTC");
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }

function parseCreative(value: unknown): CreativeVersionInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex16Error("INVALID_INPUT", "creative version must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "activatedAt,assetDigests,creativeId,deploymentKeys,version") throw new Cortex16Error("INVALID_INPUT", "creative contract contains missing or unsupported fields");
  if (typeof raw.creativeId !== "string" || !ID.test(raw.creativeId) || typeof raw.version !== "string" || !ID.test(raw.version)) throw new Cortex16Error("INVALID_INPUT", "creative identity is malformed");
  if (!Array.isArray(raw.assetDigests) || raw.assetDigests.length < 1 || raw.assetDigests.length > 128 || !raw.assetDigests.every((item) => typeof item === "string" && SHA256.test(item)) || new Set(raw.assetDigests).size !== raw.assetDigests.length) throw new Cortex16Error("INVALID_INPUT", "assetDigests must be unique SHA-256 digests");
  if (!Array.isArray(raw.deploymentKeys) || raw.deploymentKeys.length < 1 || raw.deploymentKeys.length > 128 || !raw.deploymentKeys.every((item) => typeof item === "string" && ID.test(item)) || new Set(raw.deploymentKeys).size !== raw.deploymentKeys.length) throw new Cortex16Error("INVALID_INPUT", "deploymentKeys are malformed or duplicated");
  return Object.freeze({ creativeId: raw.creativeId, version: raw.version, assetDigests: Object.freeze([...raw.assetDigests]), deploymentKeys: Object.freeze([...raw.deploymentKeys]), activatedAt: utc(raw.activatedAt) });
}

function traceSecret(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Cortex16Error("INVALID_INPUT", "trace signing secret is invalid");
  return value;
}

export class SqliteCreativeTraceRegistry {
  private readonly db: DatabaseSync;
  constructor(databasePath: string) {
    if (!databasePath) throw new Cortex16Error("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex16_creatives(
      creative_id TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      trace_key TEXT NOT NULL UNIQUE,
      manifest_json TEXT NOT NULL,
      PRIMARY KEY(creative_id,version)
    ); CREATE INDEX IF NOT EXISTS cortex16_trace_key ON cortex16_creatives(trace_key);`);
  }
  close(): void { this.db.close(); }

  register(value: unknown, beforeCommit?: () => void): CreativeVersionRecord {
    if (beforeCommit !== undefined && typeof beforeCommit !== "function") throw new Cortex16Error("INVALID_INPUT", "beforeCommit guard is invalid");
    const input = parseCreative(value);
    const manifestDigest = digest(input);
    const traceKey = `nxc16-${createHash("sha256").update(`${input.creativeId}\0${input.version}\0${manifestDigest}`, "utf8").digest("hex").slice(0, 24)}`;
    const existing = this.db.prepare("SELECT manifest_digest,trace_key,manifest_json FROM cortex16_creatives WHERE creative_id=? AND version=?").get(input.creativeId, input.version) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.manifest_digest !== manifestDigest) throw new Cortex16Error("CONFLICT", "creative version is already bound to different assets or deployments");
      return Object.freeze({ ...parseCreative(JSON.parse(String(existing.manifest_json)) as unknown), manifestDigest, traceKey: String(existing.trace_key) });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const raced = this.db.prepare("SELECT manifest_digest,trace_key,manifest_json FROM cortex16_creatives WHERE creative_id=? AND version=?").get(input.creativeId, input.version) as Record<string, unknown> | undefined;
      if (raced) {
        if (raced.manifest_digest !== manifestDigest) throw new Cortex16Error("CONFLICT", "creative version is already bound to different assets or deployments");
        this.db.exec("COMMIT");
        return Object.freeze({ ...parseCreative(JSON.parse(String(raced.manifest_json)) as unknown), manifestDigest, traceKey: String(raced.trace_key) });
      }
      beforeCommit?.();
      this.db.prepare("INSERT INTO cortex16_creatives(creative_id,version,manifest_digest,trace_key,manifest_json) VALUES(?,?,?,?,?)").run(input.creativeId, input.version, manifestDigest, traceKey, canonical(input));
      this.db.exec("COMMIT");
      return Object.freeze({ ...input, manifestDigest, traceKey });
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  getByTraceKey(traceKey: string): CreativeVersionRecord | undefined {
    if (!ID.test(traceKey)) throw new Cortex16Error("INVALID_INPUT", "traceKey is malformed");
    const row = this.db.prepare("SELECT manifest_digest,trace_key,manifest_json FROM cortex16_creatives WHERE trace_key=?").get(traceKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const input = parseCreative(JSON.parse(String(row.manifest_json)) as unknown);
    const manifestDigest = digest(input);
    if (manifestDigest !== row.manifest_digest) throw new Cortex16Error("INTEGRITY_FAILURE", "stored creative manifest digest mismatch");
    return Object.freeze({ ...input, manifestDigest, traceKey: String(row.trace_key) });
  }

  resolveAggregate(value: unknown): AggregatedMetricResolution {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex16Error("INVALID_INPUT", "aggregate row must be a plain object");
    const raw = value as Record<string, unknown>;
    if (Object.keys(raw).sort().join(",") !== "aggregationId,metric,traceKeys,value") throw new Cortex16Error("INVALID_INPUT", "aggregate contract contains missing or unsupported fields");
    if (typeof raw.aggregationId !== "string" || !ID.test(raw.aggregationId) || typeof raw.metric !== "string" || !ID.test(raw.metric) || typeof raw.value !== "number" || !Number.isFinite(raw.value)) throw new Cortex16Error("INVALID_INPUT", "aggregate identity or value is invalid");
    if (!Array.isArray(raw.traceKeys) || raw.traceKeys.length < 1 || raw.traceKeys.length > 256 || !raw.traceKeys.every((item) => typeof item === "string" && ID.test(item))) throw new Cortex16Error("INVALID_INPUT", "traceKeys are invalid");
    const records = [...new Set(raw.traceKeys)].map((key) => this.getByTraceKey(key)).filter((item): item is CreativeVersionRecord => Boolean(item));
    const creativeIds = [...new Set(records.map((item) => item.creativeId))].sort();
    const manifestDigests = [...new Set(records.map((item) => item.manifestDigest))].sort();
    return Object.freeze({ aggregationId: raw.aggregationId, metric: raw.metric, value: raw.value, resolution: creativeIds.length === 0 ? "UNRESOLVED" : creativeIds.length === 1 ? "EXACT" : "AMBIGUOUS_SET", creativeIds: Object.freeze(creativeIds), manifestDigests: Object.freeze(manifestDigests) });
  }
}

export function signCreativeTrace(record: CreativeVersionRecord, secret: string): SignedCreativeTrace {
  const signingSecret = traceSecret(secret);
  const signature = createHmac("sha256", signingSecret).update(`${record.traceKey}\0${record.manifestDigest}`, "utf8").digest("hex");
  return Object.freeze({ traceKey: record.traceKey, manifestDigest: record.manifestDigest, signature: `sha256=${signature}` });
}

export function verifyCreativeTrace(value: unknown, secret: string): { traceKey: string; manifestDigest: `sha256:${string}` } {
  const signingSecret = traceSecret(secret);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex16Error("INVALID_INPUT", "signed trace must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "manifestDigest,signature,traceKey" || typeof raw.traceKey !== "string" || !ID.test(raw.traceKey) || typeof raw.manifestDigest !== "string" || !SHA256.test(raw.manifestDigest) || typeof raw.signature !== "string" || !/^sha256=[0-9a-f]{64}$/u.test(raw.signature)) throw new Cortex16Error("INVALID_SIGNATURE", "signed creative trace is malformed");
  const expected = Buffer.from(createHmac("sha256", signingSecret).update(`${raw.traceKey}\0${raw.manifestDigest}`, "utf8").digest("hex"));
  const provided = Buffer.from(raw.signature.slice(7));
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new Cortex16Error("INVALID_SIGNATURE", "creative trace signature mismatch");
  return Object.freeze({ traceKey: raw.traceKey, manifestDigest: raw.manifestDigest as `sha256:${string}` });
}
