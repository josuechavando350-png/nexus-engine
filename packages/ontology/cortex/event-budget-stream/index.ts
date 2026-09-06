import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;

export type JsonScalar = null | boolean | number | string;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface DurableEventInput {
  readonly stream: string;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly payload: JsonValue;
}

export interface DurableEventRecord extends DurableEventInput {
  readonly sequence: number;
  readonly digest: `sha256:${string}`;
  readonly createdAt: string;
}

export interface BudgetChannelEvidence {
  readonly channel: string;
  readonly currentSpend: number;
  readonly minSpend: number;
  readonly maxSpend: number;
  readonly marginalReturn: number;
  readonly confidence: number;
  readonly dataAgeMinutes: number;
}

export interface BudgetArbitrationInput {
  readonly totalBudget: number;
  readonly maxShiftFraction: number;
  readonly minConfidence: number;
  readonly maxDataAgeMinutes: number;
  readonly channels: readonly BudgetChannelEvidence[];
}

export interface BudgetAllocation {
  readonly channel: string;
  readonly previousSpend: number;
  readonly nextSpend: number;
  readonly delta: number;
  readonly marginalReturn: number;
}

export interface BudgetArbitrationResult {
  readonly decision: "REALLOCATE" | "HOLD";
  readonly reason: "EVIDENCE_OK" | "INSUFFICIENT_EVIDENCE" | "NO_FEASIBLE_REALLOCATION";
  readonly totalBudget: number;
  readonly allocations: readonly BudgetAllocation[];
}

export class Cortex17Error extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "OFFSET_REGRESSION" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "Cortex17Error";
  }
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Cortex17Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function eventDigest(input: DurableEventInput): `sha256:${string}` {
  const content = canonical({ stream: input.stream, eventId: input.eventId, occurredAt: input.occurredAt, payload: input.payload });
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Cortex17Error("INVALID_INPUT", `${label} must be a canonical UTC timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Cortex17Error("INVALID_INPUT", `${label} must be a canonical UTC timestamp`);
  return value;
}

function assertJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > 16) throw new Cortex17Error("INVALID_INPUT", "payload nesting is too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Cortex17Error("INVALID_INPUT", "payload contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Cortex17Error("INVALID_INPUT", "payload array is too large");
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex17Error("INVALID_INPUT", "payload must be JSON-compatible");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1_000) throw new Cortex17Error("INVALID_INPUT", "payload object is too large");
  for (const [key, item] of entries) {
    if (!key || key.length > 128) throw new Cortex17Error("INVALID_INPUT", "payload key is invalid");
    assertJson(item, depth + 1);
  }
}

function parseEvent(value: unknown): DurableEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex17Error("INVALID_INPUT", "event must be a plain object");
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "eventId,occurredAt,payload,stream") throw new Cortex17Error("INVALID_INPUT", "event contract contains missing or unsupported fields");
  if (typeof raw.stream !== "string" || !NAME.test(raw.stream)) throw new Cortex17Error("INVALID_INPUT", "stream is malformed");
  if (typeof raw.eventId !== "string" || !EVENT_ID.test(raw.eventId)) throw new Cortex17Error("INVALID_INPUT", "eventId is malformed");
  const occurredAt = parseTimestamp(raw.occurredAt, "occurredAt");
  assertJson(raw.payload);
  return Object.freeze({ stream: raw.stream, eventId: raw.eventId, occurredAt, payload: raw.payload });
}

export class SqliteDurableEventStream {
  private readonly db: DatabaseSync;

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new Cortex17Error("INVALID_INPUT", "databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cortex17_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(stream, event_id)
      );
      CREATE INDEX IF NOT EXISTS cortex17_events_stream_sequence ON cortex17_events(stream, sequence);
      CREATE TABLE IF NOT EXISTS cortex17_offsets (
        consumer_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(consumer_id, stream)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  append(value: unknown): DurableEventRecord {
    const input = parseEvent(value);
    const digest = eventDigest(input);
    const existing = this.db.prepare("SELECT * FROM cortex17_events WHERE stream = ? AND event_id = ?").get(input.stream, input.eventId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.digest !== digest) throw new Cortex17Error("CONFLICT", "eventId is already bound to different content");
      return this.rowToEvent(existing);
    }
    const createdAt = new Date(this.now()).toISOString();
    try {
      this.db.prepare("INSERT INTO cortex17_events(stream,event_id,occurred_at,payload_json,digest,created_at) VALUES(?,?,?,?,?,?)").run(
        input.stream,
        input.eventId,
        input.occurredAt,
        canonical(input.payload),
        digest,
        createdAt,
      );
    } catch (error) {
      const raced = this.db.prepare("SELECT * FROM cortex17_events WHERE stream = ? AND event_id = ?").get(input.stream, input.eventId) as Record<string, unknown> | undefined;
      if (!raced) throw error;
      if (raced.digest !== digest) throw new Cortex17Error("CONFLICT", "eventId is already bound to different content");
      return this.rowToEvent(raced);
    }
    const row = this.db.prepare("SELECT * FROM cortex17_events WHERE stream = ? AND event_id = ?").get(input.stream, input.eventId) as Record<string, unknown> | undefined;
    if (!row) throw new Cortex17Error("NOT_FOUND", "event was not readable after commit");
    return this.rowToEvent(row);
  }

  read(stream: string, afterSequence = 0, limit = 100): readonly DurableEventRecord[] {
    if (!NAME.test(stream)) throw new Cortex17Error("INVALID_INPUT", "stream is malformed");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Cortex17Error("INVALID_INPUT", "afterSequence is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Cortex17Error("INVALID_INPUT", "limit is invalid");
    const rows = this.db.prepare("SELECT * FROM cortex17_events WHERE stream = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?").all(stream, afterSequence, limit) as Record<string, unknown>[];
    return Object.freeze(rows.map((row) => this.rowToEvent(row)));
  }

  readOffset(consumerId: string, stream: string): number {
    if (!NAME.test(consumerId) || !NAME.test(stream)) throw new Cortex17Error("INVALID_INPUT", "consumerId or stream is malformed");
    const row = this.db.prepare("SELECT sequence FROM cortex17_offsets WHERE consumer_id = ? AND stream = ?").get(consumerId, stream) as { sequence?: unknown } | undefined;
    return typeof row?.sequence === "number" ? row.sequence : 0;
  }

  commitOffset(consumerId: string, stream: string, sequence: number): number {
    if (!NAME.test(consumerId) || !NAME.test(stream) || !Number.isSafeInteger(sequence) || sequence < 0) throw new Cortex17Error("INVALID_INPUT", "offset input is malformed");
    const current = this.readOffset(consumerId, stream);
    if (sequence < current) throw new Cortex17Error("OFFSET_REGRESSION", "consumer offsets cannot move backwards");
    if (sequence > 0) {
      const event = this.db.prepare("SELECT 1 AS ok FROM cortex17_events WHERE stream = ? AND sequence = ?").get(stream, sequence) as { ok?: unknown } | undefined;
      if (!event) throw new Cortex17Error("NOT_FOUND", "offset sequence does not belong to the stream");
    }
    const updatedAt = new Date(this.now()).toISOString();
    this.db.prepare(`
      INSERT INTO cortex17_offsets(consumer_id,stream,sequence,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(consumer_id,stream) DO UPDATE SET sequence=excluded.sequence,updated_at=excluded.updated_at
      WHERE excluded.sequence >= cortex17_offsets.sequence
    `).run(consumerId, stream, sequence, updatedAt);
    return this.readOffset(consumerId, stream);
  }

  private rowToEvent(row: Record<string, unknown>): DurableEventRecord {
    const sequence = Number(row.sequence);
    const stream = String(row.stream);
    const eventId = String(row.event_id);
    const occurredAt = String(row.occurred_at);
    const payload = JSON.parse(String(row.payload_json)) as JsonValue;
    const digest = String(row.digest) as `sha256:${string}`;
    const createdAt = String(row.created_at);
    return Object.freeze({ sequence, stream, eventId, occurredAt, payload, digest, createdAt });
  }
}

function parseBudgetInput(value: unknown): BudgetArbitrationInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex17Error("INVALID_INPUT", "budget input must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "channels,maxDataAgeMinutes,maxShiftFraction,minConfidence,totalBudget") throw new Cortex17Error("INVALID_INPUT", "budget contract contains missing or unsupported fields");
  const totalBudget = finite(raw.totalBudget, "totalBudget", 0, 1_000_000_000_000);
  const maxShiftFraction = finite(raw.maxShiftFraction, "maxShiftFraction", 0, 1);
  const minConfidence = finite(raw.minConfidence, "minConfidence", 0, 1);
  const maxDataAgeMinutes = finite(raw.maxDataAgeMinutes, "maxDataAgeMinutes", 0, 525_600);
  if (!Array.isArray(raw.channels) || raw.channels.length < 2 || raw.channels.length > 64) throw new Cortex17Error("INVALID_INPUT", "channels must contain between 2 and 64 entries");
  const seen = new Set<string>();
  const channels = raw.channels.map((item): BudgetChannelEvidence => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw new Cortex17Error("INVALID_INPUT", "channel evidence must be a plain object");
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "channel,confidence,currentSpend,dataAgeMinutes,marginalReturn,maxSpend,minSpend") throw new Cortex17Error("INVALID_INPUT", "channel evidence contract contains missing or unsupported fields");
    if (typeof entry.channel !== "string" || !NAME.test(entry.channel) || seen.has(entry.channel)) throw new Cortex17Error("INVALID_INPUT", "channel is malformed or duplicated");
    seen.add(entry.channel);
    const currentSpend = finite(entry.currentSpend, "currentSpend", 0, totalBudget);
    const minSpend = finite(entry.minSpend, "minSpend", 0, totalBudget);
    const maxSpend = finite(entry.maxSpend, "maxSpend", 0, totalBudget);
    if (minSpend > maxSpend || currentSpend < minSpend || currentSpend > maxSpend) throw new Cortex17Error("INVALID_INPUT", "channel spend bounds are inconsistent");
    return Object.freeze({
      channel: entry.channel,
      currentSpend,
      minSpend,
      maxSpend,
      marginalReturn: finite(entry.marginalReturn, "marginalReturn", -1_000_000, 1_000_000),
      confidence: finite(entry.confidence, "confidence", 0, 1),
      dataAgeMinutes: finite(entry.dataAgeMinutes, "dataAgeMinutes", 0, 525_600),
    });
  });
  const currentTotal = channels.reduce((sum, channel) => sum + channel.currentSpend, 0);
  if (Math.abs(currentTotal - totalBudget) > 0.01) throw new Cortex17Error("INVALID_INPUT", "current channel spend must equal totalBudget");
  if (channels.reduce((sum, channel) => sum + channel.minSpend, 0) - totalBudget > 0.01 || totalBudget - channels.reduce((sum, channel) => sum + channel.maxSpend, 0) > 0.01) throw new Cortex17Error("INVALID_INPUT", "budget is infeasible under channel bounds");
  return Object.freeze({ totalBudget, maxShiftFraction, minConfidence, maxDataAgeMinutes, channels: Object.freeze(channels) });
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function arbitrateBudget(value: unknown): BudgetArbitrationResult {
  const input = parseBudgetInput(value);
  const stale = input.channels.some((channel) => channel.confidence < input.minConfidence || channel.dataAgeMinutes > input.maxDataAgeMinutes);
  if (stale) {
    return Object.freeze({
      decision: "HOLD",
      reason: "INSUFFICIENT_EVIDENCE",
      totalBudget: input.totalBudget,
      allocations: Object.freeze(input.channels.map((channel) => Object.freeze({ channel: channel.channel, previousSpend: channel.currentSpend, nextSpend: channel.currentSpend, delta: 0, marginalReturn: channel.marginalReturn }))),
    });
  }

  const lower = new Map<string, number>();
  const upper = new Map<string, number>();
  for (const channel of input.channels) {
    const shift = channel.currentSpend * input.maxShiftFraction;
    lower.set(channel.channel, Math.max(channel.minSpend, channel.currentSpend - shift));
    upper.set(channel.channel, Math.min(channel.maxSpend, channel.currentSpend + shift));
  }
  const minTotal = [...lower.values()].reduce((sum, amount) => sum + amount, 0);
  const maxTotal = [...upper.values()].reduce((sum, amount) => sum + amount, 0);
  if (minTotal - input.totalBudget > 0.01 || input.totalBudget - maxTotal > 0.01) {
    return Object.freeze({
      decision: "HOLD",
      reason: "NO_FEASIBLE_REALLOCATION",
      totalBudget: input.totalBudget,
      allocations: Object.freeze(input.channels.map((channel) => Object.freeze({ channel: channel.channel, previousSpend: channel.currentSpend, nextSpend: channel.currentSpend, delta: 0, marginalReturn: channel.marginalReturn }))),
    });
  }

  const next = new Map<string, number>([...lower.entries()]);
  let remaining = input.totalBudget - minTotal;
  const ranked = [...input.channels].sort((a, b) => b.marginalReturn - a.marginalReturn || a.channel.localeCompare(b.channel));
  for (const channel of ranked) {
    if (remaining <= 1e-9) break;
    const room = (upper.get(channel.channel) ?? 0) - (next.get(channel.channel) ?? 0);
    const add = Math.min(room, remaining);
    next.set(channel.channel, (next.get(channel.channel) ?? 0) + add);
    remaining -= add;
  }
  if (remaining > 0.01) throw new Cortex17Error("INVALID_INPUT", "allocation failed to satisfy total budget");

  const allocations = input.channels.map((channel) => {
    const nextSpend = roundMoney(next.get(channel.channel) ?? channel.currentSpend);
    return Object.freeze({ channel: channel.channel, previousSpend: channel.currentSpend, nextSpend, delta: roundMoney(nextSpend - channel.currentSpend), marginalReturn: channel.marginalReturn });
  });
  const changed = allocations.some((item) => Math.abs(item.delta) >= 0.01);
  return Object.freeze({ decision: changed ? "REALLOCATE" : "HOLD", reason: changed ? "EVIDENCE_OK" : "NO_FEASIBLE_REALLOCATION", totalBudget: input.totalBudget, allocations: Object.freeze(allocations) });
}
