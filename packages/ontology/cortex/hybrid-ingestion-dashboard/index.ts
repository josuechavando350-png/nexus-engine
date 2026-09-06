import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SqliteDurableEventStream, type DurableEventRecord } from "../event-budget-stream/index";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

export interface FinancialMetricInput {
  readonly source: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly currency: string;
  readonly revenue: number;
  readonly cost: number;
  readonly spend: number;
  readonly conversions: number;
}

export interface FinancialSummary {
  readonly currency: string;
  readonly revenue: number;
  readonly cost: number;
  readonly spend: number;
  readonly profit: number;
  readonly conversions: number;
  readonly events: number;
}

export interface ExternalMetricPage {
  readonly items: readonly FinancialMetricInput[];
  readonly nextCursor: string | null;
}

export interface ExternalMetricSource {
  readonly sourceId: string;
  poll(cursor: string | null): Promise<ExternalMetricPage>;
}

export interface SourceHealth {
  readonly source: string;
  readonly cursor: string | null;
  readonly lastPolledAt: string | null;
  readonly status: "OK" | "NEVER_POLLED";
}

export class Cortex18Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "PROVIDER_ERROR" | "GRAPHQL_ERROR", message: string) {
    super(message);
    this.name = "Cortex18Error";
  }
}

function finite(value: unknown, label: string, min = 0, max = 1e15): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Cortex18Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}

function utc(value: unknown): string {
  if (typeof value !== "string") throw new Cortex18Error("INVALID_INPUT", "occurredAt must be canonical UTC");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Cortex18Error("INVALID_INPUT", "occurredAt must be canonical UTC");
  return value;
}

function parseMetric(value: unknown): FinancialMetricInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex18Error("INVALID_INPUT", "financial metric must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "conversions,cost,currency,eventId,occurredAt,revenue,source,spend") throw new Cortex18Error("INVALID_INPUT", "financial metric contract contains missing or unsupported fields");
  if (typeof raw.source !== "string" || !ID.test(raw.source) || typeof raw.eventId !== "string" || !ID.test(raw.eventId)) throw new Cortex18Error("INVALID_INPUT", "metric source or eventId is malformed");
  if (typeof raw.currency !== "string" || !CURRENCY.test(raw.currency)) throw new Cortex18Error("INVALID_INPUT", "currency is malformed");
  const conversions = finite(raw.conversions, "conversions", 0, 1e12);
  if (!Number.isInteger(conversions)) throw new Cortex18Error("INVALID_INPUT", "conversions must be an integer");
  return Object.freeze({ source: raw.source, eventId: raw.eventId, occurredAt: utc(raw.occurredAt), currency: raw.currency, revenue: finite(raw.revenue, "revenue"), cost: finite(raw.cost, "cost"), spend: finite(raw.spend, "spend"), conversions });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function digest(value: unknown): string { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }
function round(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }

export class HttpIncrementalMetricSource implements ExternalMetricSource {
  constructor(public readonly sourceId: string, private readonly endpoint: URL, private readonly bearerToken: string, private readonly timeoutMs = 10_000) {
    if (!ID.test(sourceId) || endpoint.protocol !== "https:" || !bearerToken || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Cortex18Error("INVALID_INPUT", "external metric source configuration is invalid");
  }
  async poll(cursor: string | null): Promise<ExternalMetricPage> {
    if (cursor !== null && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 1_024)) throw new Cortex18Error("INVALID_INPUT", "cursor is invalid");
    const url = new URL(this.endpoint);
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.bearerToken}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Cortex18Error("PROVIDER_ERROR", `external metric source returned HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "items,nextCursor" || !Array.isArray(body.items) || body.items.length > 1_000 || !(body.nextCursor === null || typeof body.nextCursor === "string")) throw new Cortex18Error("PROVIDER_ERROR", "external metric page contract is invalid");
    const items = body.items.map(parseMetric);
    if (items.some((item) => item.source !== this.sourceId)) throw new Cortex18Error("PROVIDER_ERROR", "external source returned an unexpected source identity");
    return Object.freeze({ items: Object.freeze(items), nextCursor: body.nextCursor as string | null });
  }
}

export class HybridFinancialMetricStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new Cortex18Error("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex18_metrics(
      source TEXT NOT NULL,event_id TEXT NOT NULL,occurred_at TEXT NOT NULL,currency TEXT NOT NULL,
      revenue REAL NOT NULL,cost REAL NOT NULL,spend REAL NOT NULL,conversions INTEGER NOT NULL,digest TEXT NOT NULL,
      PRIMARY KEY(source,event_id)
    ); CREATE TABLE IF NOT EXISTS cortex18_cursors(
      source TEXT PRIMARY KEY,cursor TEXT,last_polled_at TEXT
    );`);
  }
  close(): void { this.db.close(); }

  ingest(value: unknown): boolean {
    const metric = parseMetric(value);
    const metricDigest = digest(metric);
    const existing = this.db.prepare("SELECT digest FROM cortex18_metrics WHERE source=? AND event_id=?").get(metric.source, metric.eventId) as { digest?: unknown } | undefined;
    if (existing) {
      if (existing.digest !== metricDigest) throw new Cortex18Error("CONFLICT", "metric eventId is already bound to different content");
      return false;
    }
    this.db.prepare("INSERT INTO cortex18_metrics(source,event_id,occurred_at,currency,revenue,cost,spend,conversions,digest) VALUES(?,?,?,?,?,?,?,?,?)").run(metric.source, metric.eventId, metric.occurredAt, metric.currency, metric.revenue, metric.cost, metric.spend, metric.conversions, metricDigest);
    return true;
  }

  ingestOwnStream(stream: SqliteDurableEventStream, streamName: string, consumerId: string, limit = 500): { consumed: number; inserted: number; offset: number } {
    const after = stream.readOffset(consumerId, streamName);
    const events = stream.read(streamName, after, limit);
    let inserted = 0; let offset = after;
    for (const event of events) {
      const metric = this.metricFromOwnEvent(event);
      if (this.ingest(metric)) inserted += 1;
      stream.commitOffset(consumerId, streamName, event.sequence);
      offset = event.sequence;
    }
    return Object.freeze({ consumed: events.length, inserted, offset });
  }

  async pollExternal(source: ExternalMetricSource): Promise<{ received: number; inserted: number; nextCursor: string | null }> {
    const current = this.sourceHealth(source.sourceId).cursor;
    const page = await source.poll(current);
    let inserted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of page.items) if (this.ingest(item)) inserted += 1;
      const lastPolledAt = new Date(this.now()).toISOString();
      this.db.prepare("INSERT INTO cortex18_cursors(source,cursor,last_polled_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,last_polled_at=excluded.last_polled_at").run(source.sourceId, page.nextCursor, lastPolledAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return Object.freeze({ received: page.items.length, inserted, nextCursor: page.nextCursor });
  }

  summaries(): readonly FinancialSummary[] {
    const rows = this.db.prepare("SELECT currency,SUM(revenue) revenue,SUM(cost) cost,SUM(spend) spend,SUM(conversions) conversions,COUNT(*) events FROM cortex18_metrics GROUP BY currency ORDER BY currency").all() as Record<string, unknown>[];
    return Object.freeze(rows.map((row) => {
      const revenue = Number(row.revenue); const cost = Number(row.cost); const spend = Number(row.spend);
      return Object.freeze({ currency: String(row.currency), revenue: round(revenue), cost: round(cost), spend: round(spend), profit: round(revenue - cost - spend), conversions: Number(row.conversions), events: Number(row.events) });
    }));
  }

  sourceHealth(source: string): SourceHealth {
    if (!ID.test(source)) throw new Cortex18Error("INVALID_INPUT", "source is malformed");
    const row = this.db.prepare("SELECT cursor,last_polled_at FROM cortex18_cursors WHERE source=?").get(source) as Record<string, unknown> | undefined;
    return Object.freeze({ source, cursor: row?.cursor === null || row?.cursor === undefined ? null : String(row.cursor), lastPolledAt: row?.last_polled_at ? String(row.last_polled_at) : null, status: row ? "OK" : "NEVER_POLLED" });
  }

  private metricFromOwnEvent(event: DurableEventRecord): FinancialMetricInput {
    const payload = parseMetric(event.payload);
    if (payload.eventId !== event.eventId) throw new Cortex18Error("CONFLICT", "own-stream eventId does not match metric eventId");
    return payload;
  }
}

export function executeDashboardGraphql(store: HybridFinancialMetricStore, query: string, knownSources: readonly string[]): { data: Record<string, unknown> } {
  if (typeof query !== "string" || query.length < 1 || query.length > 20_000) throw new Cortex18Error("GRAPHQL_ERROR", "GraphQL query is invalid");
  const normalized = query.replace(/#[^\n\r]*/gu, " ").replace(/[\s,]+/gu, " ").trim();
  if (!/^query(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\{/u.test(normalized) || !normalized.endsWith("}")) throw new Cortex18Error("GRAPHQL_ERROR", "only GraphQL query operations are supported");
  const allowedTokens = new Set(["query", "Dashboard", "financialSummary", "currency", "revenue", "cost", "spend", "profit", "conversions", "events", "sourceHealth", "source", "cursor", "lastPolledAt", "status"]);
  const names = normalized.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [];
  for (const name of names) if (!allowedTokens.has(name)) throw new Cortex18Error("GRAPHQL_ERROR", `unsupported GraphQL field ${name}`);
  const data: Record<string, unknown> = {};
  if (/\bfinancialSummary\b/u.test(normalized)) data.financialSummary = store.summaries();
  if (/\bsourceHealth\b/u.test(normalized)) data.sourceHealth = [...new Set(knownSources)].sort().map((source) => store.sourceHealth(source));
  if (Object.keys(data).length === 0) throw new Cortex18Error("GRAPHQL_ERROR", "query requests no supported root fields");
  return { data };
}
