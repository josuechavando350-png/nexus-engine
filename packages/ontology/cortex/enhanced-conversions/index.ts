import { createHash } from "node:crypto";
import { canonicalJson, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";
import { DataManagerApiError, type DataManagerConversionEvent, type DataManagerDestination, type DataManagerIngestReceipt } from "./data-manager-rest";

const OUTBOX_TYPE = "cortex.enhanced_conversion_outbox";
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,127})$/u;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const GCLID = /^\S{8,256}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const PHONE = /^\+[1-9]\d{7,14}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

const OUTBOX = Object.freeze({
  transactionId: "cortex.enhanced_conversion.transaction_id",
  status: "cortex.enhanced_conversion.status",
  payload: "cortex.enhanced_conversion.payload",
  digest: "cortex.enhanced_conversion.digest",
  externalRequestId: "cortex.enhanced_conversion.external_request_id",
  updatedAt: "cortex.enhanced_conversion.updated_at",
});

export type EnhancedConversionMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type EnhancedConversionStatus = "PREPARED" | "SENT" | "CANCELLED" | "AMBIGUOUS";

export interface EnhancedConversionInput {
  readonly transactionId: string;
  readonly eventTimestamp: string;
  readonly eventName: string;
  readonly eventSource: "WEB" | "APP" | "IN_STORE" | "PHONE" | "OTHER";
  readonly adUserDataConsent: "GRANTED" | "DENIED";
  readonly conversionValue?: number;
  readonly currency?: string;
  readonly gclid?: string;
  readonly emailAddresses?: readonly string[];
  readonly phoneNumbers?: readonly string[];
}

export interface EnhancedConversionRecord {
  readonly id: string;
  readonly transactionId: string;
  readonly status: EnhancedConversionStatus;
  readonly event: DataManagerConversionEvent;
  readonly digest: string;
  readonly externalRequestId: string | null;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface EnhancedConversionGateway {
  ingestConversion(destination: DataManagerDestination, event: DataManagerConversionEvent): Promise<DataManagerIngestReceipt>;
}

export interface EnhancedConversionTelemetry {
  readonly operation: "PREPARE" | "DISPATCH" | "ROLLBACK";
  readonly status: EnhancedConversionStatus | "OBSERVED" | "BLOCKED" | "FAILED";
  readonly transactionDigest: string;
  readonly errorCode: string | null;
}

export class EnhancedConversionError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONSENT_VIOLATION" | "CONFLICT" | "INTEGRITY_FAILURE" | "PERSISTENCE_FAILURE" | "REMOTE_FAILURE" | "AMBIGUOUS_OUTCOME" | "KILLED", message: string) {
    super(message);
    this.name = "EnhancedConversionError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalDigest(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function property(id: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME", immutable = false) {
  return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const;
}

function schema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = {
    version: "cortex-enhanced-conversions-v1",
    scope,
    properties: [
      property(OUTBOX.transactionId, "EnhancedConversionTransactionId", "STRING", true),
      property(OUTBOX.status, "EnhancedConversionStatus", "STRING"),
      property(OUTBOX.payload, "EnhancedConversionPayload", "JSON", true),
      property(OUTBOX.digest, "EnhancedConversionDigest", "STRING", true),
      property(OUTBOX.externalRequestId, "EnhancedConversionExternalRequestId", "STRING"),
      property(OUTBOX.updatedAt, "EnhancedConversionUpdatedAt", "DATETIME"),
    ],
    interfaces: [],
    objects: [{ id: OUTBOX_TYPE, name: "CortexEnhancedConversionOutbox", propertyIds: Object.values(OUTBOX), interfaceIds: [] }],
    relationships: [], actions: [], functions: [], events: [],
  };
  return validateSchema(value);
}

function exactInput(value: unknown): EnhancedConversionInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new EnhancedConversionError("INVALID_INPUT", "enhanced conversion input must be a plain object");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["transactionId", "eventTimestamp", "eventName", "eventSource", "adUserDataConsent", "conversionValue", "currency", "gclid", "emailAddresses", "phoneNumbers"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new EnhancedConversionError("INVALID_INPUT", `enhanced conversion input contains unsupported field ${key}`);
  if (typeof raw.transactionId !== "string" || !ID.test(raw.transactionId.trim())) throw new EnhancedConversionError("INVALID_INPUT", "transactionId is malformed");
  if (typeof raw.eventTimestamp !== "string") throw new EnhancedConversionError("INVALID_INPUT", "eventTimestamp must be a string");
  const timestamp = new Date(raw.eventTimestamp);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== raw.eventTimestamp) throw new EnhancedConversionError("INVALID_INPUT", "eventTimestamp must be canonical UTC");
  if (typeof raw.eventName !== "string" || !EVENT_NAME.test(raw.eventName)) throw new EnhancedConversionError("INVALID_INPUT", "eventName is malformed");
  if (!(raw.eventSource === "WEB" || raw.eventSource === "APP" || raw.eventSource === "IN_STORE" || raw.eventSource === "PHONE" || raw.eventSource === "OTHER")) throw new EnhancedConversionError("INVALID_INPUT", "eventSource is invalid");
  if (!(raw.adUserDataConsent === "GRANTED" || raw.adUserDataConsent === "DENIED")) throw new EnhancedConversionError("INVALID_INPUT", "adUserDataConsent is invalid");
  if (raw.conversionValue !== undefined && (typeof raw.conversionValue !== "number" || !Number.isFinite(raw.conversionValue) || raw.conversionValue < 0 || raw.conversionValue > 1_000_000_000)) throw new EnhancedConversionError("INVALID_INPUT", "conversionValue is invalid");
  if (raw.currency !== undefined && (typeof raw.currency !== "string" || !CURRENCY.test(raw.currency))) throw new EnhancedConversionError("INVALID_INPUT", "currency is invalid");
  if ((raw.conversionValue === undefined) !== (raw.currency === undefined)) throw new EnhancedConversionError("INVALID_INPUT", "conversionValue and currency must be provided together");
  if (raw.gclid !== undefined && (typeof raw.gclid !== "string" || !GCLID.test(raw.gclid))) throw new EnhancedConversionError("INVALID_INPUT", "gclid is malformed");
  const emails = raw.emailAddresses === undefined ? [] : raw.emailAddresses;
  const phones = raw.phoneNumbers === undefined ? [] : raw.phoneNumbers;
  if (!Array.isArray(emails) || !emails.every((item) => typeof item === "string") || emails.length > 10) throw new EnhancedConversionError("INVALID_INPUT", "emailAddresses must contain at most ten strings");
  if (!Array.isArray(phones) || !phones.every((item) => typeof item === "string") || phones.length > 10) throw new EnhancedConversionError("INVALID_INPUT", "phoneNumbers must contain at most ten strings");
  if (emails.length + phones.length > 10) throw new EnhancedConversionError("INVALID_INPUT", "at most ten user identifiers are allowed");
  if (raw.adUserDataConsent === "DENIED" && emails.length + phones.length > 0) throw new EnhancedConversionError("CONSENT_VIOLATION", "raw user identifiers are forbidden when ad user data consent is denied");
  if (!raw.gclid && emails.length + phones.length === 0) throw new EnhancedConversionError("INVALID_INPUT", "a gclid or consented user identifier is required");
  return raw as unknown as EnhancedConversionInput;
}

function normalizedEmail(value: string): string {
  const compact = value.replace(/\s+/gu, "").toLowerCase();
  const at = compact.lastIndexOf("@");
  if (at <= 0 || at === compact.length - 1 || compact.length > 254) throw new EnhancedConversionError("INVALID_INPUT", "email address is malformed");
  let local = compact.slice(0, at);
  const domain = compact.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,63}$/u.test(domain)) throw new EnhancedConversionError("INVALID_INPUT", "email domain is malformed");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.split("+", 1)[0]!.replaceAll(".", "");
  }
  if (!local || local.length > 64) throw new EnhancedConversionError("INVALID_INPUT", "email local part is malformed");
  return `${local}@${domain}`;
}

function normalizedPhone(value: string): string {
  const normalized = value.trim();
  if (!PHONE.test(normalized)) throw new EnhancedConversionError("INVALID_INPUT", "phone number must already be canonical E.164");
  return normalized;
}

function eventFromInput(input: EnhancedConversionInput): DataManagerConversionEvent {
  const emails = (input.emailAddresses ?? []).map((value) => ({ hashedEmail: sha256(normalizedEmail(value)) }));
  const phones = (input.phoneNumbers ?? []).map((value) => ({ hashedPhoneNumber: sha256(normalizedPhone(value)) }));
  const identifiers = input.adUserDataConsent === "GRANTED" ? [...emails, ...phones] : [];
  return Object.freeze({
    transactionId: input.transactionId.trim(),
    eventTimestamp: input.eventTimestamp,
    eventName: input.eventName,
    eventSource: input.eventSource,
    adUserDataConsent: input.adUserDataConsent,
    ...(input.conversionValue === undefined ? {} : { conversionValue: input.conversionValue, currency: input.currency }),
    ...(input.gclid === undefined ? {} : { gclid: input.gclid }),
    userIdentifiers: Object.freeze(identifiers),
  });
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function parseRecord(record: ObjectRecord): EnhancedConversionRecord {
  if (record.typeId !== OUTBOX_TYPE) throw new EnhancedConversionError("INTEGRITY_FAILURE", "outbox record has unexpected type");
  const transactionId = record.properties[OUTBOX.transactionId];
  const status = record.properties[OUTBOX.status];
  const payload = record.properties[OUTBOX.payload];
  const digest = record.properties[OUTBOX.digest];
  const externalRequestId = record.properties[OUTBOX.externalRequestId];
  const updatedAt = record.properties[OUTBOX.updatedAt];
  if (typeof transactionId !== "string" || !ID.test(transactionId)) throw new EnhancedConversionError("INTEGRITY_FAILURE", "stored transactionId is invalid");
  if (!(status === "PREPARED" || status === "SENT" || status === "CANCELLED" || status === "AMBIGUOUS")) throw new EnhancedConversionError("INTEGRITY_FAILURE", "stored status is invalid");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new EnhancedConversionError("INTEGRITY_FAILURE", "stored payload is invalid");
  if (typeof digest !== "string" || !SHA256.test(digest)) throw new EnhancedConversionError("INTEGRITY_FAILURE", "stored digest is invalid");
  if (typeof externalRequestId !== "string") throw new EnhancedConversionError("INTEGRITY_FAILURE", "stored externalRequestId is invalid");
  if (typeof updatedAt !== "string" || new Date(updatedAt).toISOString() !== updatedAt) throw new EnhancedConversionError("INTEGRITY_FAILURE", "stored updatedAt is invalid");
  const event = payload as unknown as DataManagerConversionEvent;
  if (canonicalDigest(event) !== digest) throw new EnhancedConversionError("INTEGRITY_FAILURE", "stored event digest mismatch");
  return Object.freeze({ id: record.id, transactionId, status, event, digest, externalRequestId: externalRequestId || null, updatedAt, revision: record.revision });
}

function mapPersistence(error: unknown): never {
  if (error instanceof OntologyTransactionError) {
    if (error.code === "CONFLICT" || error.code === "UNIQUE_CONSTRAINT") throw new EnhancedConversionError("CONFLICT", error.message);
    throw new EnhancedConversionError("PERSISTENCE_FAILURE", error.message);
  }
  throw error;
}

export class DurableEnhancedConversionsPipeline {
  private readonly validatedSchema: ValidatedSchema;
  constructor(
    private readonly transactions: OntologyTransactionPort,
    private readonly scope: OntologyScope,
    private readonly destination: DataManagerDestination,
    private readonly gateway: EnhancedConversionGateway,
    private readonly modeProvider: () => EnhancedConversionMode,
    private readonly now: () => number = Date.now,
    private readonly onTelemetry?: (event: EnhancedConversionTelemetry) => void,
  ) {
    this.validatedSchema = schema(scope);
  }

  private emit(event: EnhancedConversionTelemetry): void {
    try { this.onTelemetry?.(Object.freeze(event)); } catch { /* telemetry cannot alter conversion semantics */ }
  }

  private objectId(transactionId: string): string {
    return `cortex-enhanced-conversion:${sha256(transactionId).slice(0, 32)}`;
  }

  get(transactionId: string): EnhancedConversionRecord | undefined {
    const normalized = transactionId.trim();
    if (!ID.test(normalized)) throw new EnhancedConversionError("INVALID_INPUT", "transactionId is malformed");
    const record = this.transactions.getObject(this.scope, this.objectId(normalized));
    return record ? parseRecord(record) : undefined;
  }

  prepare(value: unknown): EnhancedConversionRecord {
    const input = exactInput(value);
    const event = eventFromInput(input);
    const digest = canonicalDigest(event);
    const transactionDigest = `sha256:${sha256(event.transactionId)}`;
    const id = this.objectId(event.transactionId);
    const existing = this.transactions.getObject(this.scope, id);
    if (existing) {
      const parsed = parseRecord(existing);
      if (parsed.digest !== digest) throw new EnhancedConversionError("CONFLICT", "transactionId is already bound to different conversion content");
      return parsed;
    }
    const updatedAt = new Date(this.now()).toISOString();
    const operation: TransactionOperation = {
      kind: "CREATE_OBJECT",
      record: {
        id,
        typeId: OUTBOX_TYPE,
        scope: this.scope,
        properties: {
          [OUTBOX.transactionId]: event.transactionId,
          [OUTBOX.status]: "PREPARED",
          [OUTBOX.payload]: asJson(event),
          [OUTBOX.digest]: digest,
          [OUTBOX.externalRequestId]: "",
          [OUTBOX.updatedAt]: updatedAt,
        },
      },
    };
    try { this.transactions.transact(this.scope, this.validatedSchema, [operation]); }
    catch (error) { mapPersistence(error); }
    const created = this.transactions.getObject(this.scope, id);
    if (!created) throw new EnhancedConversionError("PERSISTENCE_FAILURE", "prepared outbox record was not readable after commit");
    this.emit({ operation: "PREPARE", status: "PREPARED", transactionDigest, errorCode: null });
    return parseRecord(created);
  }

  async dispatch(transactionId: string): Promise<EnhancedConversionRecord> {
    const record = this.get(transactionId);
    if (!record) throw new EnhancedConversionError("INVALID_INPUT", "prepared conversion was not found");
    const transactionDigest = `sha256:${sha256(record.transactionId)}`;
    if (record.status === "SENT" || record.status === "CANCELLED") return record;
    if (record.status === "AMBIGUOUS") throw new EnhancedConversionError("AMBIGUOUS_OUTCOME", "ambiguous conversion cannot be retried automatically");
    const initialMode = this.modeProvider();
    if (initialMode !== "ACTIVE") {
      this.emit({ operation: "DISPATCH", status: initialMode === "OBSERVE_ONLY" ? "OBSERVED" : "BLOCKED", transactionDigest, errorCode: initialMode === "KILLED" ? "KILLED" : null });
      if (initialMode === "KILLED") throw new EnhancedConversionError("KILLED", "kill switch blocks conversion dispatch");
      return record;
    }

    const finalMode = this.modeProvider();
    if (finalMode !== "ACTIVE") {
      this.emit({ operation: "DISPATCH", status: finalMode === "OBSERVE_ONLY" ? "OBSERVED" : "BLOCKED", transactionDigest, errorCode: finalMode === "KILLED" ? "KILLED" : null });
      if (finalMode === "KILLED") throw new EnhancedConversionError("KILLED", "kill switch blocks conversion dispatch at side-effect boundary");
      return record;
    }

    let receipt: DataManagerIngestReceipt;
    try {
      receipt = await this.gateway.ingestConversion(this.destination, record.event);
    } catch (error) {
      if (error instanceof DataManagerApiError && (error.code === "AMBIGUOUS_OUTCOME" || error.code === "TIMEOUT")) {
        try {
          this.transactions.transact(this.scope, this.validatedSchema, [{ kind: "UPDATE_OBJECT", id: record.id, expectedRevision: record.revision, properties: { [OUTBOX.status]: "AMBIGUOUS", [OUTBOX.updatedAt]: new Date(this.now()).toISOString() } }]);
        } catch (persistenceError) { mapPersistence(persistenceError); }
        this.emit({ operation: "DISPATCH", status: "AMBIGUOUS", transactionDigest, errorCode: error.code });
        throw new EnhancedConversionError("AMBIGUOUS_OUTCOME", error.message);
      }
      this.emit({ operation: "DISPATCH", status: "FAILED", transactionDigest, errorCode: error instanceof DataManagerApiError ? error.code : "REMOTE_FAILURE" });
      throw new EnhancedConversionError("REMOTE_FAILURE", error instanceof Error ? error.message : "Data Manager ingestion failed");
    }

    try {
      this.transactions.transact(this.scope, this.validatedSchema, [{ kind: "UPDATE_OBJECT", id: record.id, expectedRevision: record.revision, properties: { [OUTBOX.status]: "SENT", [OUTBOX.externalRequestId]: receipt.requestId, [OUTBOX.updatedAt]: new Date(this.now()).toISOString() } }]);
    } catch (error) { mapPersistence(error); }
    const sent = this.transactions.getObject(this.scope, record.id);
    if (!sent) throw new EnhancedConversionError("PERSISTENCE_FAILURE", "sent outbox record disappeared after commit");
    this.emit({ operation: "DISPATCH", status: "SENT", transactionDigest, errorCode: null });
    return parseRecord(sent);
  }

  rollback(transactionId: string): EnhancedConversionRecord {
    const record = this.get(transactionId);
    if (!record) throw new EnhancedConversionError("INVALID_INPUT", "prepared conversion was not found");
    const transactionDigest = `sha256:${sha256(record.transactionId)}`;
    if (record.status === "CANCELLED") return record;
    if (record.status !== "PREPARED") throw new EnhancedConversionError("CONFLICT", `only PREPARED conversions can be rolled back; observed ${record.status}`);
    try {
      this.transactions.transact(this.scope, this.validatedSchema, [{ kind: "UPDATE_OBJECT", id: record.id, expectedRevision: record.revision, properties: { [OUTBOX.status]: "CANCELLED", [OUTBOX.updatedAt]: new Date(this.now()).toISOString() } }]);
    } catch (error) { mapPersistence(error); }
    const cancelled = this.transactions.getObject(this.scope, record.id);
    if (!cancelled) throw new EnhancedConversionError("PERSISTENCE_FAILURE", "cancelled outbox record disappeared after commit");
    this.emit({ operation: "ROLLBACK", status: "CANCELLED", transactionDigest, errorCode: null });
    return parseRecord(cancelled);
  }
}
