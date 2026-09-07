import { DatabaseSync } from "node:sqlite";
import {
  Cortex11Error,
  FetchWebhookRelayGateway,
  RelayGatewayError,
  observeRelayInput,
  parseRelayInput,
  type DurableWebhookRelay,
  type RelayGateway,
  type RelayInput,
  type RelayObservation,
  type RelayReceipt,
  type RelayRecord,
} from "./index";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

export type ConsentChannel = "WHATSAPP" | "SMS" | "OTHER";
export type ConsentRegistryStatus = "GRANTED" | "OPTED_OUT";

export interface ConsentRegistryRecord {
  readonly subjectKey: `sha256:${string}`;
  readonly channel: ConsentChannel;
  readonly status: ConsentRegistryStatus;
  readonly policyId: string;
  readonly revision: number;
  readonly changedAt: string;
}

export interface SetConsentRegistryInput {
  readonly subjectKey: string;
  readonly channel: ConsentChannel;
  readonly status: ConsentRegistryStatus;
  readonly policyId: string;
  readonly expectedRevision: number;
  readonly changedAt: string;
}

export interface RelayFailoverRoute {
  readonly endpoint: URL;
  readonly bearerToken: () => string;
  readonly signingSecret: () => string;
}

export interface ConsentRegistryFailoverGatewayOptions {
  readonly registry: DurableConsentRegistry;
  readonly routes: Readonly<Record<ConsentChannel, readonly RelayFailoverRoute[]>>;
  readonly timeoutMs?: number;
  readonly onOperationalEvent?: (event: Readonly<Record<string, unknown>>) => void;
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Cortex11Error("INVALID_INPUT", `${field} must be canonical UTC`);
  return value;
}

function subject(value: string): `sha256:${string}` {
  if (!SHA256.test(value)) throw new Cortex11Error("INVALID_INPUT", "consent subjectKey must be a sha256 digest");
  return value as `sha256:${string}`;
}

function policyId(value: string): string {
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new Cortex11Error("INVALID_INPUT", "consent policyId is malformed");
  return normalized;
}

function channelFromEvent(event: RelayInput): ConsentChannel {
  if (event.eventType.startsWith("whatsapp.")) return "WHATSAPP";
  if (event.eventType.startsWith("sms.")) return "SMS";
  if (event.eventType.startsWith("other.")) return "OTHER";
  throw new Cortex11Error("INVALID_INPUT", "eventType must declare whatsapp., sms., or other. channel prefix");
}

function subjectFromEvent(event: RelayInput, channel: ConsentChannel): `sha256:${string}` {
  if (event.userIdentifiers.length !== 1) throw new Cortex11Error("CONSENT_VIOLATION", "consent-registry relay requires exactly one hashed subject identifier");
  const identifier = event.userIdentifiers[0]!;
  if ((channel === "WHATSAPP" || channel === "SMS") && identifier.kind !== "PHONE_SHA256") {
    throw new Cortex11Error("CONSENT_VIOLATION", `${channel} requires one PHONE_SHA256 subject identifier`);
  }
  return subject(identifier.value);
}

export class DurableConsentRegistry {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (!databasePath) throw new Cortex11Error("INVALID_INPUT", "consent registry databasePath is required");
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex31_consent_registry (
      subject_key TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('WHATSAPP','SMS','OTHER')),
      status TEXT NOT NULL CHECK(status IN ('GRANTED','OPTED_OUT')),
      policy_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      PRIMARY KEY(subject_key, channel)
    );`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex31_consent_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      changed_at TEXT NOT NULL
    );`);
  }

  close(): void { this.db.close(); }

  read(subjectKey: string, channel: ConsentChannel): ConsentRegistryRecord | undefined {
    const normalized = subject(subjectKey);
    const row = this.db.prepare("SELECT subject_key,channel,status,policy_id,revision,changed_at FROM cortex31_consent_registry WHERE subject_key=? AND channel=?").get(normalized, channel) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return Object.freeze({
      subjectKey: subject(String(row.subject_key)),
      channel: row.channel as ConsentChannel,
      status: row.status as ConsentRegistryStatus,
      policyId: policyId(String(row.policy_id)),
      revision: Number(row.revision),
      changedAt: canonicalUtc(String(row.changed_at), "stored consent changedAt"),
    });
  }

  set(input: SetConsentRegistryInput): ConsentRegistryRecord {
    const subjectKey = subject(input.subjectKey);
    if (!(input.channel === "WHATSAPP" || input.channel === "SMS" || input.channel === "OTHER")) throw new Cortex11Error("INVALID_INPUT", "consent channel is invalid");
    if (!(input.status === "GRANTED" || input.status === "OPTED_OUT")) throw new Cortex11Error("INVALID_INPUT", "consent status is invalid");
    const nextPolicyId = policyId(input.policyId);
    const changedAt = canonicalUtc(input.changedAt, "consent changedAt");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Cortex11Error("INVALID_INPUT", "expectedRevision must be a non-negative integer");
    const current = this.read(subjectKey, input.channel);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.expectedRevision) throw new Cortex11Error("CONFLICT", `consent revision conflict: expected ${input.expectedRevision}, observed ${currentRevision}`);
    const revision = currentRevision + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (current) {
        const result = this.db.prepare("UPDATE cortex31_consent_registry SET status=?,policy_id=?,revision=?,changed_at=? WHERE subject_key=? AND channel=? AND revision=?").run(input.status, nextPolicyId, revision, changedAt, subjectKey, input.channel, currentRevision);
        if (result.changes !== 1) throw new Cortex11Error("CONFLICT", "consent update lost compare-and-set boundary");
      } else {
        this.db.prepare("INSERT INTO cortex31_consent_registry(subject_key,channel,status,policy_id,revision,changed_at) VALUES(?,?,?,?,?,?)").run(subjectKey, input.channel, input.status, nextPolicyId, revision, changedAt);
      }
      this.db.prepare("INSERT INTO cortex31_consent_history(subject_key,channel,status,policy_id,revision,changed_at) VALUES(?,?,?,?,?,?)").run(subjectKey, input.channel, input.status, nextPolicyId, revision, changedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
    return this.read(subjectKey, input.channel)!;
  }

  assertGranted(subjectKey: string, channel: ConsentChannel): ConsentRegistryRecord {
    const state = this.read(subjectKey, channel);
    if (!state || state.status !== "GRANTED") throw new Cortex11Error("CONSENT_VIOLATION", `${channel} consent is absent or opted out`);
    return state;
  }
}

export class ConsentGuardedWebhookRelay {
  constructor(private readonly base: DurableWebhookRelay, private readonly registry: DurableConsentRegistry) {}

  private governed(value: unknown): RelayInput {
    const event = parseRelayInput(value);
    const channel = channelFromEvent(event);
    const subjectKey = subjectFromEvent(event, channel);
    this.registry.assertGranted(subjectKey, channel);
    if (event.adUserDataConsent !== "GRANTED") throw new Cortex11Error("CONSENT_VIOLATION", "request-level consent may restrict but may not override the central registry");
    return event;
  }

  observe(value: unknown): RelayObservation { return observeRelayInput(this.governed(value)); }
  prepare(value: unknown): RelayRecord { return this.base.prepare(this.governed(value)); }
  dispatch(eventId: string): Promise<RelayRecord> { return this.base.dispatch(eventId); }
  rollback(eventId: string): RelayRecord { return this.base.rollback(eventId); }
  get(eventId: string): RelayRecord | undefined { return this.base.get(eventId); }
}

export class ConsentRegistryFailoverGateway implements RelayGateway {
  private readonly timeoutMs: number;

  constructor(private readonly options: ConsentRegistryFailoverGatewayOptions) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) throw new Cortex11Error("INVALID_INPUT", "failover gateway timeoutMs must be 100..30000");
    for (const channel of ["WHATSAPP", "SMS", "OTHER"] as const) {
      const routes = options.routes[channel];
      if (!Array.isArray(routes) || routes.length < 1 || routes.length > 4) throw new Cortex11Error("INVALID_INPUT", `${channel} must configure 1..4 relay routes`);
      for (const route of routes) {
        if (route.endpoint.protocol !== "https:" || route.endpoint.username || route.endpoint.password || route.endpoint.hash) throw new Cortex11Error("INVALID_INPUT", `${channel} route must be clean HTTPS`);
      }
    }
  }

  private emit(event: Readonly<Record<string, unknown>>): void {
    try { this.options.onOperationalEvent?.(event); } catch { /* observability is non-authoritative */ }
  }

  async send(event: RelayInput, digest: `sha256:${string}`): Promise<RelayReceipt> {
    const channel = channelFromEvent(event);
    const subjectKey = subjectFromEvent(event, channel);
    // Final opt-out boundary immediately before any outbound provider request.
    try {
      this.options.registry.assertGranted(subjectKey, channel);
    } catch (error) {
      if (error instanceof Cortex11Error && error.code === "CONSENT_VIOLATION") {
        throw new RelayGatewayError("REJECTED", error.message, 403);
      }
      throw error;
    }
    const routes = this.options.routes[channel];
    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index]!;
      try {
        const receipt = await new FetchWebhookRelayGateway(route.endpoint, route.bearerToken(), route.signingSecret(), this.timeoutMs).send(event, digest);
        this.emit({ operation: "DELIVERY", channel, routeIndex: index, outcome: "SENT" });
        return receipt;
      } catch (error) {
        if (error instanceof RelayGatewayError && error.code === "REJECTED" && error.httpStatus === 429 && index + 1 < routes.length) {
          this.emit({ operation: "FAILOVER", channel, routeIndex: index, outcome: "RATE_LIMITED_NOT_ACCEPTED" });
          continue;
        }
        this.emit({ operation: "DELIVERY", channel, routeIndex: index, outcome: error instanceof RelayGatewayError ? error.code : "FAILED" });
        throw error;
      }
    }
    throw new RelayGatewayError("REJECTED", "all configured relay routes deterministically rate-limited the event", 429);
  }
}
