import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HybridFinancialMetricStore, type FinancialSummary } from "./index.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type ReverseEtlMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export interface ReverseEtlSnapshot {
  readonly generatedAt: string;
  readonly summaries: readonly FinancialSummary[];
  readonly digest: `sha256:${string}`;
}

export interface ReverseEtlReceipt {
  readonly destinationId: string;
  readonly snapshotDigest: `sha256:${string}`;
  readonly remoteReceipt: string;
}

export interface ReverseEtlDestination {
  readonly destinationId: string;
  deliver(snapshot: ReverseEtlSnapshot): Promise<ReverseEtlReceipt>;
}

export interface GoogleSheetsDestinationConfig {
  readonly destinationId: string;
  readonly spreadsheetId: string;
  readonly range: string;
  readonly accessTokenProvider: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface HttpCrmDestinationConfig {
  readonly destinationId: string;
  readonly endpoint: URL;
  readonly bearerToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class Cortex38Error extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "REMOTE_ERROR" | "INVALID_RESPONSE" | "MODE_BLOCKED" | "CONFLICT", message: string) {
    super(message);
    this.name = "Cortex38Error";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function digest(value: unknown): `sha256:${string}` { return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function secret(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 24 || normalized.length > 8192 || /[\r\n\0]/u.test(normalized)) throw new Cortex38Error("INVALID_CONFIG", `${label} is invalid`);
  return normalized;
}
function timeout(value: number | undefined): number {
  const resolved = value ?? 15_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1000 || resolved > 120_000) throw new Cortex38Error("INVALID_CONFIG", "timeoutMs is invalid");
  return resolved;
}
function utc(value: string): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Cortex38Error("INVALID_INPUT", "generatedAt must be canonical UTC"); return value;
}
function id(value: string, label: string): string {
  if (!ID.test(value)) throw new Cortex38Error("INVALID_CONFIG", `${label} is malformed`); return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Cortex38Error("INVALID_RESPONSE", "destination response is oversized");
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Cortex38Error("INVALID_RESPONSE", "destination response is oversized"); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return total ? JSON.parse(new TextDecoder().decode(bytes)) as unknown : null; }
  catch { throw new Cortex38Error("INVALID_RESPONSE", "destination response is malformed JSON"); }
}

export function createReverseEtlSnapshot(store: HybridFinancialMetricStore, now: () => number = Date.now): ReverseEtlSnapshot {
  const generatedAt = new Date(now()).toISOString(); utc(generatedAt);
  const summaries = store.summaries();
  const body = { generatedAt, summaries };
  return Object.freeze({ ...body, summaries: Object.freeze([...summaries]), digest: digest(body) });
}

export class GoogleSheetsReverseEtlDestination implements ReverseEtlDestination {
  readonly destinationId: string;
  private readonly spreadsheetId: string;
  private readonly range: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: GoogleSheetsDestinationConfig) {
    this.destinationId = id(config.destinationId, "destinationId");
    if (!/^[A-Za-z0-9_-]{20,200}$/u.test(config.spreadsheetId)) throw new Cortex38Error("INVALID_CONFIG", "spreadsheetId is malformed");
    if (typeof config.range !== "string" || config.range.length < 1 || config.range.length > 256 || /[\r\n\0]/u.test(config.range)) throw new Cortex38Error("INVALID_CONFIG", "Sheets range is malformed");
    this.spreadsheetId = config.spreadsheetId; this.range = config.range; this.fetchImpl = config.fetchImpl ?? fetch; this.timeoutMs = timeout(config.timeoutMs);
  }

  async deliver(snapshot: ReverseEtlSnapshot): Promise<ReverseEtlReceipt> {
    const token = secret(await this.config.accessTokenProvider(), "Sheets access token");
    const values: (string | number)[][] = [["snapshot_digest", "generated_at", "currency", "revenue", "cost", "spend", "profit", "conversions", "events"]];
    for (const summary of snapshot.summaries) values.push([snapshot.digest, snapshot.generatedAt, summary.currency, summary.revenue, summary.cost, summary.spend, summary.profit, summary.conversions, summary.events]);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(this.range)}?valueInputOption=RAW`;
    let response: Response;
    try { response = await this.fetchImpl(url, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ range: this.range, majorDimension: "ROWS", values }) }); }
    catch (error) { throw new Cortex38Error("REMOTE_ERROR", error instanceof Error ? error.message : "Sheets transport failed"); }
    const body = await boundedJson(response) as Record<string, unknown> | null;
    if (!response.ok) throw new Cortex38Error("REMOTE_ERROR", `Sheets rejected update with HTTP ${response.status}`);
    const updatedRange = body && typeof body.updatedRange === "string" ? body.updatedRange : null;
    if (!updatedRange) throw new Cortex38Error("INVALID_RESPONSE", "Sheets response is missing updatedRange");
    return Object.freeze({ destinationId: this.destinationId, snapshotDigest: snapshot.digest, remoteReceipt: updatedRange });
  }
}

export class HttpCrmReverseEtlDestination implements ReverseEtlDestination {
  readonly destinationId: string;
  private readonly endpoint: URL;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: HttpCrmDestinationConfig) {
    this.destinationId = id(config.destinationId, "destinationId");
    if (config.endpoint.protocol !== "https:" || config.endpoint.username || config.endpoint.password || config.endpoint.hash) throw new Cortex38Error("INVALID_CONFIG", "CRM endpoint must be clean HTTPS");
    this.endpoint = new URL(config.endpoint); this.bearerToken = secret(config.bearerToken, "CRM bearer token"); this.fetchImpl = config.fetchImpl ?? fetch; this.timeoutMs = timeout(config.timeoutMs);
  }

  async deliver(snapshot: ReverseEtlSnapshot): Promise<ReverseEtlReceipt> {
    let response: Response;
    try { response = await this.fetchImpl(this.endpoint, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json", accept: "application/json", "idempotency-key": snapshot.digest }, body: JSON.stringify({ schemaVersion: 1, snapshot }) }); }
    catch (error) { throw new Cortex38Error("REMOTE_ERROR", error instanceof Error ? error.message : "CRM transport failed"); }
    const body = await boundedJson(response) as Record<string, unknown> | null;
    if (!response.ok) throw new Cortex38Error("REMOTE_ERROR", `CRM rejected snapshot with HTTP ${response.status}`);
    const receipt = body && typeof body.receiptId === "string" && ID.test(body.receiptId) ? body.receiptId : null;
    if (!receipt) throw new Cortex38Error("INVALID_RESPONSE", "CRM response is missing receiptId");
    return Object.freeze({ destinationId: this.destinationId, snapshotDigest: snapshot.digest, remoteReceipt: receipt });
  }
}

export class SqliteReverseEtlLedger {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex38_reverse_etl(
      destination_id TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      remote_receipt TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      PRIMARY KEY(destination_id,snapshot_digest)
    );`);
  }
  close(): void { this.db.close(); }
  has(destinationId: string, snapshotDigest: string): boolean {
    if (!ID.test(destinationId) || !SHA256.test(snapshotDigest)) throw new Cortex38Error("INVALID_INPUT", "reverse ETL ledger key is invalid");
    return Boolean(this.db.prepare("SELECT 1 FROM cortex38_reverse_etl WHERE destination_id=? AND snapshot_digest=?").get(destinationId, snapshotDigest));
  }
  commit(receipt: ReverseEtlReceipt): void {
    if (!ID.test(receipt.destinationId) || !SHA256.test(receipt.snapshotDigest) || !receipt.remoteReceipt) throw new Cortex38Error("INVALID_INPUT", "reverse ETL receipt is invalid");
    this.db.prepare("INSERT OR IGNORE INTO cortex38_reverse_etl(destination_id,snapshot_digest,remote_receipt,delivered_at) VALUES(?,?,?,?)").run(receipt.destinationId, receipt.snapshotDigest, receipt.remoteReceipt, new Date(this.now()).toISOString());
  }
}

export async function runReverseEtl(snapshot: ReverseEtlSnapshot, destinations: readonly ReverseEtlDestination[], ledger: SqliteReverseEtlLedger, readMode: () => ReverseEtlMode): Promise<readonly { destinationId: string; status: "SENT" | "UNCHANGED" | "OBSERVED" }[]> {
  if (!SHA256.test(snapshot.digest) || digest({ generatedAt: snapshot.generatedAt, summaries: snapshot.summaries }) !== snapshot.digest) throw new Cortex38Error("INVALID_INPUT", "snapshot digest mismatch");
  const results: { destinationId: string; status: "SENT" | "UNCHANGED" | "OBSERVED" }[] = [];
  for (const destination of destinations) {
    const mode = readMode();
    if (mode === "KILLED") throw new Cortex38Error("MODE_BLOCKED", "reverse ETL is killed");
    if (ledger.has(destination.destinationId, snapshot.digest)) { results.push({ destinationId: destination.destinationId, status: "UNCHANGED" }); continue; }
    if (mode === "OBSERVE_ONLY") { results.push({ destinationId: destination.destinationId, status: "OBSERVED" }); continue; }
    if (readMode() !== "ACTIVE") throw new Cortex38Error("MODE_BLOCKED", "reverse ETL mode changed before remote side effect");
    const receipt = await destination.deliver(snapshot);
    if (receipt.snapshotDigest !== snapshot.digest || receipt.destinationId !== destination.destinationId) throw new Cortex38Error("CONFLICT", "destination receipt identity mismatch");
    ledger.commit(receipt); results.push({ destinationId: destination.destinationId, status: "SENT" });
  }
  return Object.freeze(results);
}
