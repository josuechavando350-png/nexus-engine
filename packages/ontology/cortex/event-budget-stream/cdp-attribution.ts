import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { arbitrateBudget, type BudgetArbitrationResult } from "./index.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface CdpIdentityConsent {
  readonly consentDecisionId: string;
  readonly status: "GRANTED" | "REVOKED";
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface CdpIdentityRecord {
  readonly identityKey: `sha256:${string}`;
  readonly consentDecisionId: string;
  readonly status: "GRANTED" | "REVOKED";
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface CrossChannelEventIdentity {
  readonly sourceSystem: string;
  readonly sourceEventId: string;
  readonly identityKey: `sha256:${string}`;
}

export interface AttributionJourney {
  readonly journeyId: string;
  readonly channels: readonly string[];
  readonly converted: boolean;
  readonly conversionValue: number;
}

export interface ChannelAttributionEvidence {
  readonly channel: string;
  readonly markovCredit: number;
  readonly shapleyCredit: number;
  readonly incrementalLift: number;
  readonly incrementalityConfidence: number;
  readonly identityCoverage: number;
  readonly dataAgeMinutes: number;
  readonly currentSpend: number;
  readonly minSpend: number;
  readonly maxSpend: number;
}

export interface GovernedAttributionPolicy {
  readonly minJourneys: number;
  readonly minConvertedJourneys: number;
  readonly minIdentityCoverage: number;
  readonly minIncrementalityConfidence: number;
  readonly maxDataAgeMinutes: number;
  readonly minAttributionAgreement: number;
  readonly maxShiftFraction: number;
}

export class Cortex37Error extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "CONSENT_REQUIRED" | "CONFLICT" | "INSUFFICIENT_EVIDENCE", message: string) {
    super(message);
    this.name = "Cortex37Error";
  }
}

function secret(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Cortex37Error("INVALID_CONFIG", "identity secret is invalid");
  return value;
}
function utc(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Cortex37Error("INVALID_INPUT", `${label} must be canonical UTC`);
  return value;
}
function ratio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Cortex37Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}
function finite(value: number, label: string, min = 0, max = 1e15): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Cortex37Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}
function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Cortex37Error("INVALID_INPUT", `${label} is out of range`);
  return value;
}
function identityKey(firstPartyKey: string, hmacSecret: string): `sha256:${string}` {
  if (typeof firstPartyKey !== "string" || firstPartyKey.length < 8 || firstPartyKey.length > 512 || /[\r\n\0]/u.test(firstPartyKey)) throw new Cortex37Error("INVALID_INPUT", "firstPartyKey is malformed");
  return `sha256:${createHmac("sha256", secret(hmacSecret)).update(`cortex37-identity\0${firstPartyKey}`, "utf8").digest("hex")}`;
}

export class SqliteConsentedCdpIdentityStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string, private readonly hmacSecret: string, private readonly now: () => number = Date.now) {
    if (!databasePath) throw new Cortex37Error("INVALID_CONFIG", "databasePath is required");
    secret(hmacSecret);
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS cortex37_cdp_identity(
      identity_key TEXT PRIMARY KEY,
      consent_decision_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('GRANTED','REVOKED')),
      observed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cortex37_cross_channel_dedupe(
      dedupe_key TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL,
      source_system TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL
    );`);
  }
  close(): void { this.db.close(); }

  upsert(firstPartyKey: string, consent: CdpIdentityConsent): CdpIdentityRecord {
    if (!ID.test(consent.consentDecisionId) || !(consent.status === "GRANTED" || consent.status === "REVOKED")) throw new Cortex37Error("INVALID_INPUT", "consent decision is invalid");
    const observedAt = utc(consent.observedAt, "observedAt"); const expiresAt = utc(consent.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= Date.parse(observedAt)) throw new Cortex37Error("INVALID_INPUT", "consent expiry must follow observation");
    const key = identityKey(firstPartyKey, this.hmacSecret); const current = this.get(key);
    if (current && Date.parse(observedAt) < Date.parse(current.observedAt)) throw new Cortex37Error("CONFLICT", "consent decision cannot regress in time");
    const updatedAt = new Date(this.now()).toISOString();
    this.db.prepare(`INSERT INTO cortex37_cdp_identity(identity_key,consent_decision_id,status,observed_at,expires_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(identity_key) DO UPDATE SET consent_decision_id=excluded.consent_decision_id,status=excluded.status,observed_at=excluded.observed_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(key, consent.consentDecisionId, consent.status, observedAt, expiresAt, updatedAt);
    return this.get(key)!;
  }

  resolve(firstPartyKey: string): CdpIdentityRecord {
    const key = identityKey(firstPartyKey, this.hmacSecret); const record = this.get(key);
    if (!record || record.status !== "GRANTED" || Date.parse(record.expiresAt) <= this.now()) throw new Cortex37Error("CONSENT_REQUIRED", "first-party identity has no current granted consent");
    return record;
  }

  registerSourceEvent(identity: CdpIdentityRecord, sourceSystem: string, sourceEventId: string): { dedupeKey: `sha256:${string}`; duplicate: boolean } {
    if (identity.status !== "GRANTED" || !SHA256.test(identity.identityKey) || !ID.test(sourceSystem) || !ID.test(sourceEventId)) throw new Cortex37Error("INVALID_INPUT", "cross-channel event identity is invalid");
    const dedupeKey = `sha256:${createHmac("sha256", this.hmacSecret).update(`${identity.identityKey}\0${sourceSystem}\0${sourceEventId}`, "utf8").digest("hex")}` as const;
    const existing = this.db.prepare("SELECT identity_key,source_system,source_event_id FROM cortex37_cross_channel_dedupe WHERE dedupe_key=?").get(dedupeKey) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.identity_key !== identity.identityKey || existing.source_system !== sourceSystem || existing.source_event_id !== sourceEventId) throw new Cortex37Error("CONFLICT", "dedupe key is bound to different source identity");
      return Object.freeze({ dedupeKey, duplicate: true });
    }
    this.db.prepare("INSERT INTO cortex37_cross_channel_dedupe(dedupe_key,identity_key,source_system,source_event_id,first_seen_at) VALUES(?,?,?,?,?)").run(dedupeKey, identity.identityKey, sourceSystem, sourceEventId, new Date(this.now()).toISOString());
    return Object.freeze({ dedupeKey, duplicate: false });
  }

  private get(key: string): CdpIdentityRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cortex37_cdp_identity WHERE identity_key=?").get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record: CdpIdentityRecord = { identityKey: String(row.identity_key) as `sha256:${string}`, consentDecisionId: String(row.consent_decision_id), status: row.status === "GRANTED" ? "GRANTED" : "REVOKED", observedAt: String(row.observed_at), expiresAt: String(row.expires_at), updatedAt: String(row.updated_at) };
    if (!SHA256.test(record.identityKey) || !ID.test(record.consentDecisionId)) throw new Cortex37Error("CONFLICT", "stored CDP identity is corrupt");
    utc(record.observedAt, "stored observedAt"); utc(record.expiresAt, "stored expiresAt"); utc(record.updatedAt, "stored updatedAt");
    return Object.freeze(record);
  }
}

function uniqueChannels(journeys: readonly AttributionJourney[]): readonly string[] {
  return Object.freeze([...new Set(journeys.flatMap((journey) => journey.channels))].sort());
}
function parseJourneys(journeys: readonly AttributionJourney[]): readonly AttributionJourney[] {
  if (!Array.isArray(journeys) || journeys.length < 1 || journeys.length > 1_000_000) throw new Cortex37Error("INVALID_INPUT", "journeys are invalid");
  const seen = new Set<string>();
  return Object.freeze(journeys.map((journey) => {
    if (!ID.test(journey.journeyId) || seen.has(journey.journeyId) || !Array.isArray(journey.channels) || journey.channels.length < 1 || journey.channels.length > 64 || !journey.channels.every((channel) => ID.test(channel))) throw new Cortex37Error("INVALID_INPUT", "journey is malformed or duplicated");
    seen.add(journey.journeyId); finite(journey.conversionValue, "conversionValue");
    return Object.freeze({ ...journey, channels: Object.freeze([...journey.channels]) });
  }));
}

export function computeMarkovRemovalCredits(input: readonly AttributionJourney[]): Readonly<Record<string, number>> {
  const journeys = parseJourneys(input); const channels = uniqueChannels(journeys);
  const baseValue = journeys.filter((j) => j.converted).reduce((sum, j) => sum + j.conversionValue, 0);
  const raw: Record<string, number> = {};
  for (const channel of channels) {
    let removedValue = 0;
    for (const journey of journeys) if (journey.converted && !journey.channels.includes(channel)) removedValue += journey.conversionValue;
    raw[channel] = Math.max(0, baseValue - removedValue);
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return Object.freeze(Object.fromEntries(channels.map((channel) => [channel, total > 0 ? raw[channel]! / total : 0])));
}

export function computeShapleyCredits(input: readonly AttributionJourney[]): Readonly<Record<string, number>> {
  const journeys = parseJourneys(input); const channels = uniqueChannels(journeys);
  if (channels.length > 12) throw new Cortex37Error("INVALID_INPUT", "exact Shapley attribution is limited to 12 channels");
  const valueOf = (set: ReadonlySet<string>): number => journeys.filter((j) => j.converted && j.channels.every((channel) => set.has(channel))).reduce((sum, j) => sum + j.conversionValue, 0);
  const factorial = (n: number): number => { let out = 1; for (let i = 2; i <= n; i += 1) out *= i; return out; };
  const n = channels.length; const denominator = factorial(n); const result: Record<string, number> = {};
  for (const channel of channels) {
    const others = channels.filter((item) => item !== channel); let phi = 0;
    for (let mask = 0; mask < 2 ** others.length; mask += 1) {
      const subset = new Set<string>();
      for (let i = 0; i < others.length; i += 1) if ((mask & (1 << i)) !== 0) subset.add(others[i]!);
      const without = valueOf(subset); const withChannel = new Set(subset); withChannel.add(channel);
      const weight = factorial(subset.size) * factorial(n - subset.size - 1) / denominator;
      phi += weight * (valueOf(withChannel) - without);
    }
    result[channel] = Math.max(0, phi);
  }
  const total = Object.values(result).reduce((sum, value) => sum + value, 0);
  return Object.freeze(Object.fromEntries(channels.map((channel) => [channel, total > 0 ? result[channel]! / total : 0])));
}

export function governBudgetWithAttribution(totalBudget: number, evidence: readonly ChannelAttributionEvidence[], journeys: readonly AttributionJourney[], policy: GovernedAttributionPolicy): BudgetArbitrationResult {
  finite(totalBudget, "totalBudget"); integer(policy.minJourneys, "minJourneys", 1, 1_000_000); integer(policy.minConvertedJourneys, "minConvertedJourneys", 1, 1_000_000);
  ratio(policy.minIdentityCoverage, "minIdentityCoverage"); ratio(policy.minIncrementalityConfidence, "minIncrementalityConfidence"); finite(policy.maxDataAgeMinutes, "maxDataAgeMinutes"); ratio(policy.minAttributionAgreement, "minAttributionAgreement"); ratio(policy.maxShiftFraction, "maxShiftFraction");
  const parsedJourneys = parseJourneys(journeys); const converted = parsedJourneys.filter((j) => j.converted).length;
  if (parsedJourneys.length < policy.minJourneys || converted < policy.minConvertedJourneys) throw new Cortex37Error("INSUFFICIENT_EVIDENCE", "journey sample is below policy minimum");
  const markov = computeMarkovRemovalCredits(parsedJourneys); const shapley = computeShapleyCredits(parsedJourneys);
  const channels = uniqueChannels(parsedJourneys);
  if (evidence.length !== channels.length) throw new Cortex37Error("INSUFFICIENT_EVIDENCE", "channel evidence does not cover all attributed channels");
  const byChannel = new Map(evidence.map((item) => [item.channel, item] as const));
  const budgetChannels = channels.map((channel) => {
    const item = byChannel.get(channel); if (!item) throw new Cortex37Error("INSUFFICIENT_EVIDENCE", `missing evidence for ${channel}`);
    ratio(item.identityCoverage, "identityCoverage"); ratio(item.incrementalityConfidence, "incrementalityConfidence"); finite(item.dataAgeMinutes, "dataAgeMinutes");
    if (item.identityCoverage < policy.minIdentityCoverage || item.incrementalityConfidence < policy.minIncrementalityConfidence || item.dataAgeMinutes > policy.maxDataAgeMinutes) throw new Cortex37Error("INSUFFICIENT_EVIDENCE", `channel ${channel} fails evidence gates`);
    const m = markov[channel] ?? 0; const s = shapley[channel] ?? 0; const agreement = 1 - Math.abs(m - s);
    if (agreement < policy.minAttributionAgreement) throw new Cortex37Error("INSUFFICIENT_EVIDENCE", `channel ${channel} attribution models disagree beyond policy`);
    const marginalReturn = ((m + s) / 2) * item.incrementalLift;
    return Object.freeze({ channel, currentSpend: item.currentSpend, minSpend: item.minSpend, maxSpend: item.maxSpend, marginalReturn, confidence: Math.min(item.incrementalityConfidence, item.identityCoverage, agreement), dataAgeMinutes: item.dataAgeMinutes });
  });
  return arbitrateBudget({ totalBudget, maxShiftFraction: policy.maxShiftFraction, minConfidence: Math.min(policy.minIdentityCoverage, policy.minIncrementalityConfidence, policy.minAttributionAgreement), maxDataAgeMinutes: policy.maxDataAgeMinutes, channels: budgetChannels });
}
