import { createHash } from "node:crypto";
import { canonicalJson, ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";
import {
  BehavioralSignalError,
  createBehavioralSignalPolicy,
  type BehavioralSignalEventInput,
  type BehavioralSignalIngestResult,
  type BehavioralSignalPolicy,
  type BehavioralSignalPrivacyConfig,
  type CreateBehavioralSignalPolicyInput,
} from "./index";
import {
  type BehavioralMicroInteractionInput,
  type BehavioralMicroInteractionResult,
} from "./browser-micro-signals";
import { CortexBehavioralSignalSuite } from "./suite";

const CONTROL_TYPE = "cortex.behavioral_signal_runtime_control";
const CONTROL = Object.freeze({
  payload: "cortex.behavioral_signal.runtime_control.payload",
  digest: "cortex.behavioral_signal.runtime_control.digest",
  updatedAt: "cortex.behavioral_signal.runtime_control.updated_at",
});
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_PAYLOAD_KEYS = new Set(["active", "previous", "generation"]);
const POLICY_KEYS = new Set([
  "policyId",
  "version",
  "pseudonymizationKeyId",
  "allowedSurfaceIds",
  "allowedElementIds",
  "maxEventAgeMs",
  "maxFutureSkewMs",
  "maxSessionDurationMs",
  "maxEventsPerSession",
  "maxEngagementMsPerEvent",
  "maxWriteRetries",
  "mode",
  "digest",
]);

interface ControlPayload {
  readonly active: BehavioralSignalPolicy;
  readonly previous: BehavioralSignalPolicy | null;
  readonly generation: number;
}

interface ControlRecord extends ControlPayload {
  readonly id: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface BehavioralSignalControlState {
  readonly active: BehavioralSignalPolicy;
  readonly previous: BehavioralSignalPolicy | null;
  readonly generation: number;
  readonly digest: string;
  readonly updatedAt: string;
}

export type BehavioralSignalRuntimeTelemetryEvent =
  | {
      readonly category: "INGEST";
      readonly channel: "BASE" | "MICRO";
      readonly outcome: "RECORDED" | "DUPLICATE" | "OBSERVED" | "NOOP" | "ERROR";
      readonly reason: string;
      readonly siteId: string;
      readonly kind: string | null;
      readonly policyDigest: string;
    }
  | {
      readonly category: "CONTROL";
      readonly action: "BOOTSTRAP" | "ACTIVATE" | "ROLLBACK" | "KILL";
      readonly activePolicyDigest: string;
      readonly previousPolicyDigest: string | null;
      readonly generation: number;
      readonly controlDigest: string;
    };

export interface BehavioralSignalRuntimeOptions {
  readonly onTelemetry?: (event: BehavioralSignalRuntimeTelemetryEvent) => void;
  readonly onTelemetryError?: (error: unknown, event: BehavioralSignalRuntimeTelemetryEvent) => void;
}

function hash(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} contains unsupported field ${key}`);
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJson);
}

function json(value: unknown, field: string): JsonValue {
  if (!isJson(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} is not finite JSON`);
  return value;
}

function object(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} must be object`);
  return value as Record<string, JsonValue>;
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} must be canonical UTC`);
  return value;
}

function property(id: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME") {
  return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable: false } as const;
}

function controlSchema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = {
    version: "cortex-behavioral-signal-runtime-control-v1",
    scope,
    properties: [
      property(CONTROL.payload, "BehavioralSignalRuntimeControlPayload", "JSON"),
      property(CONTROL.digest, "BehavioralSignalRuntimeControlDigest", "STRING"),
      property(CONTROL.updatedAt, "BehavioralSignalRuntimeControlUpdatedAt", "DATETIME"),
    ],
    interfaces: [],
    objects: [{ id: CONTROL_TYPE, name: "CortexBehavioralSignalRuntimeControl", propertyIds: Object.values(CONTROL), interfaceIds: [] }],
    relationships: [],
    actions: [],
    functions: [],
    events: [],
  };
  return validateSchema(value);
}

function policyCore(policy: BehavioralSignalPolicy): CreateBehavioralSignalPolicyInput {
  return {
    policyId: policy.policyId,
    version: policy.version,
    pseudonymizationKeyId: policy.pseudonymizationKeyId,
    allowedSurfaceIds: [...policy.allowedSurfaceIds],
    allowedElementIds: [...policy.allowedElementIds],
    maxEventAgeMs: policy.maxEventAgeMs,
    maxFutureSkewMs: policy.maxFutureSkewMs,
    maxSessionDurationMs: policy.maxSessionDurationMs,
    maxEventsPerSession: policy.maxEventsPerSession,
    maxEngagementMsPerEvent: policy.maxEngagementMsPerEvent,
    maxWriteRetries: policy.maxWriteRetries,
    mode: policy.mode,
  };
}

function verifiedPolicy(policy: BehavioralSignalPolicy): BehavioralSignalPolicy {
  const rebuilt = createBehavioralSignalPolicy(policyCore(policy));
  if (rebuilt.digest !== policy.digest) throw new BehavioralSignalError("INTEGRITY_FAILURE", "behavioral policy digest mismatch");
  return rebuilt;
}

function policyJson(policy: BehavioralSignalPolicy): JsonValue {
  return json({ ...policyCore(policy), digest: policy.digest }, "runtime.policy");
}

function parsePolicy(value: JsonValue, field: string): BehavioralSignalPolicy {
  const raw = object(value, field);
  exactKeys(raw as unknown as Record<string, unknown>, POLICY_KEYS, field);
  if (typeof raw.digest !== "string" || !SHA256.test(raw.digest)) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.digest invalid`);
  const { digest, ...core } = raw;
  let rebuilt: BehavioralSignalPolicy;
  try {
    rebuilt = createBehavioralSignalPolicy(core as unknown as CreateBehavioralSignalPolicyInput);
  } catch (error) {
    if (error instanceof BehavioralSignalError) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field} invalid: ${error.message}`);
    throw error;
  }
  if (rebuilt.digest !== digest) throw new BehavioralSignalError("INTEGRITY_FAILURE", `${field}.digest mismatch`);
  return rebuilt;
}

function controlPayloadJson(payload: ControlPayload): JsonValue {
  return json({ active: policyJson(payload.active), previous: payload.previous ? policyJson(payload.previous) : null, generation: payload.generation }, "runtime.control.payload");
}

function controlDigest(payload: ControlPayload, updatedAt: string): string {
  return hash("cortex-behavioral-signal-runtime-control-v1", { payload: controlPayloadJson(payload), updatedAt });
}

function controlProperties(payload: ControlPayload, updatedAt: string): Record<string, JsonValue> {
  return { [CONTROL.payload]: controlPayloadJson(payload), [CONTROL.digest]: controlDigest(payload, updatedAt), [CONTROL.updatedAt]: updatedAt };
}

function parseControl(record: ObjectRecord): ControlRecord {
  if (record.typeId !== CONTROL_TYPE) throw new BehavioralSignalError("INTEGRITY_FAILURE", "behavioral runtime control type mismatch");
  exactKeys(record.properties as unknown as Record<string, unknown>, new Set(Object.values(CONTROL)), "runtime.control.record");
  const raw = object(record.properties[CONTROL.payload], "runtime.control.payload");
  exactKeys(raw as unknown as Record<string, unknown>, CONTROL_PAYLOAD_KEYS, "runtime.control.payload");
  const active = parsePolicy(raw.active!, "runtime.control.active");
  const previous = raw.previous === null ? null : parsePolicy(raw.previous!, "runtime.control.previous");
  if (typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation <= 0) throw new BehavioralSignalError("INTEGRITY_FAILURE", "runtime.control.generation invalid");
  const payload: ControlPayload = { active, previous, generation: raw.generation };
  const updatedAtValue = record.properties[CONTROL.updatedAt];
  if (typeof updatedAtValue !== "string") throw new BehavioralSignalError("INTEGRITY_FAILURE", "runtime.control.updatedAt invalid");
  const updatedAt = canonicalUtc(updatedAtValue, "runtime.control.updatedAt");
  const digestValue = record.properties[CONTROL.digest];
  if (typeof digestValue !== "string" || !SHA256.test(digestValue)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "runtime.control.digest invalid");
  if (digestValue !== controlDigest(payload, updatedAt)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "runtime.control.digest mismatch");
  return Object.freeze({ id: record.id, ...payload, digest: digestValue, updatedAt, revision: record.revision });
}

function snapshot(record: ControlRecord): BehavioralSignalControlState {
  return Object.freeze({ active: record.active, previous: record.previous, generation: record.generation, digest: record.digest, updatedAt: record.updatedAt });
}

function transactionConflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

export class CortexBehavioralSignalRuntime {
  readonly schema: ValidatedSchema;
  private readonly controlId: string;
  private readonly onTelemetry?: (event: BehavioralSignalRuntimeTelemetryEvent) => void;
  private readonly onTelemetryError?: (error: unknown, event: BehavioralSignalRuntimeTelemetryEvent) => void;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    initialPolicy: BehavioralSignalPolicy,
    private readonly privacy: BehavioralSignalPrivacyConfig,
    private readonly now: () => number = Date.now,
    options: BehavioralSignalRuntimeOptions = {},
  ) {
    this.schema = controlSchema(scope);
    this.controlId = ontologyId("cortex-behavioral-signal-runtime-control-v1", { scope });
    this.onTelemetry = options.onTelemetry;
    this.onTelemetryError = options.onTelemetryError;
    this.ensureControl(verifiedPolicy(initialPolicy));
  }

  private clock(): string {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "behavioral runtime clock invalid");
    return new Date(ms).toISOString();
  }

  private emit(event: BehavioralSignalRuntimeTelemetryEvent): void {
    if (!this.onTelemetry) return;
    try { this.onTelemetry(event); }
    catch (error) {
      try { this.onTelemetryError?.(error, event); }
      catch { /* observability failures must never change semantic results */ }
    }
  }

  private emitControl(action: "BOOTSTRAP" | "ACTIVATE" | "ROLLBACK" | "KILL", record: ControlRecord): void {
    this.emit(Object.freeze({ category: "CONTROL", action, activePolicyDigest: record.active.digest, previousPolicyDigest: record.previous?.digest ?? null, generation: record.generation, controlDigest: record.digest }));
  }

  private readControl(): ControlRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.controlId);
    return raw ? parseControl(raw) : undefined;
  }

  private requireControl(): ControlRecord {
    const record = this.readControl();
    if (!record) throw new BehavioralSignalError("INTEGRITY_FAILURE", "behavioral runtime control is missing");
    return record;
  }

  private ensureControl(initialPolicy: BehavioralSignalPolicy): void {
    if (this.readControl()) return;
    const updatedAt = this.clock();
    const payload: ControlPayload = Object.freeze({ active: initialPolicy, previous: null, generation: 1 });
    const operation: TransactionOperation = { kind: "CREATE_OBJECT", record: { id: this.controlId, typeId: CONTROL_TYPE, scope: this.scope, properties: controlProperties(payload, updatedAt) } };
    try {
      this.transactions.transact(this.scope, this.schema, [operation]);
      this.emitControl("BOOTSTRAP", this.requireControl());
    } catch (error) {
      if (transactionConflict(error)) { this.requireControl(); return; }
      if (error instanceof BehavioralSignalError) throw error;
      throw new BehavioralSignalError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "behavioral runtime bootstrap failed");
    }
  }

  private replaceActive(nextPolicyInput: BehavioralSignalPolicy, expectedActiveDigest: string, action: "ACTIVATE" | "KILL"): BehavioralSignalControlState {
    const nextPolicy = verifiedPolicy(nextPolicyInput);
    const current = this.requireControl();
    if (current.active.digest !== expectedActiveDigest) throw new BehavioralSignalError("CONFLICT", "active behavioral policy changed before control update");
    if (current.active.digest === nextPolicy.digest) return snapshot(current);
    if (!Number.isSafeInteger(current.generation + 1)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "behavioral control generation overflow");
    const payload: ControlPayload = Object.freeze({ active: nextPolicy, previous: current.active, generation: current.generation + 1 });
    const operation: TransactionOperation = { kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties: controlProperties(payload, this.clock()) };
    try {
      this.transactions.transact(this.scope, this.schema, [operation]);
      const stored = this.requireControl();
      this.emitControl(action, stored);
      return snapshot(stored);
    } catch (error) {
      if (transactionConflict(error)) throw new BehavioralSignalError("CONFLICT", "behavioral runtime control update conflicted");
      if (error instanceof BehavioralSignalError) throw error;
      throw new BehavioralSignalError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "behavioral runtime control update failed");
    }
  }

  controlState(): BehavioralSignalControlState { return snapshot(this.requireControl()); }

  activatePolicy(nextPolicy: BehavioralSignalPolicy, expectedActiveDigest: string): BehavioralSignalControlState {
    return this.replaceActive(nextPolicy, expectedActiveDigest, "ACTIVATE");
  }

  kill(expectedActiveDigest: string): BehavioralSignalControlState {
    const current = this.requireControl();
    if (current.active.digest !== expectedActiveDigest) throw new BehavioralSignalError("CONFLICT", "active behavioral policy changed before kill");
    if (current.active.mode === "KILLED") return snapshot(current);
    return this.replaceActive(createBehavioralSignalPolicy({ ...policyCore(current.active), mode: "KILLED" }), expectedActiveDigest, "KILL");
  }

  rollbackPolicy(expectedActiveDigest: string): BehavioralSignalControlState {
    const current = this.requireControl();
    if (current.active.digest !== expectedActiveDigest) throw new BehavioralSignalError("CONFLICT", "active behavioral policy changed before rollback");
    if (!current.previous) throw new BehavioralSignalError("POLICY_VIOLATION", "no previous behavioral policy is available for rollback");
    if (!Number.isSafeInteger(current.generation + 1)) throw new BehavioralSignalError("INTEGRITY_FAILURE", "behavioral control generation overflow");
    const payload: ControlPayload = Object.freeze({ active: current.previous, previous: current.active, generation: current.generation + 1 });
    const operation: TransactionOperation = { kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties: controlProperties(payload, this.clock()) };
    try {
      this.transactions.transact(this.scope, this.schema, [operation]);
      const stored = this.requireControl();
      this.emitControl("ROLLBACK", stored);
      return snapshot(stored);
    } catch (error) {
      if (transactionConflict(error)) throw new BehavioralSignalError("CONFLICT", "behavioral runtime rollback conflicted");
      if (error instanceof BehavioralSignalError) throw error;
      throw new BehavioralSignalError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "behavioral runtime rollback failed");
    }
  }

  private suite(policy: BehavioralSignalPolicy): CortexBehavioralSignalSuite {
    return new CortexBehavioralSignalSuite(this.transactions, this.scope, policy, this.privacy, this.now);
  }

  ingest(input: BehavioralSignalEventInput): BehavioralSignalIngestResult {
    const policy = this.requireControl().active;
    try {
      const result = this.suite(policy).ingest(input);
      this.emit(Object.freeze({ category: "INGEST", channel: "BASE", outcome: result.status, reason: result.reason, siteId: result.siteId, kind: input.kind, policyDigest: result.policyDigest }));
      return result;
    } catch (error) {
      this.emit(Object.freeze({ category: "INGEST", channel: "BASE", outcome: "ERROR", reason: error instanceof BehavioralSignalError ? error.code : "UNKNOWN", siteId: "redacted-on-error", kind: null, policyDigest: policy.digest }));
      throw error;
    }
  }

  ingestMicroInteraction(input: BehavioralMicroInteractionInput): BehavioralMicroInteractionResult {
    const policy = this.requireControl().active;
    try {
      const result = this.suite(policy).ingestMicroInteraction(input);
      this.emit(Object.freeze({ category: "INGEST", channel: "MICRO", outcome: result.status, reason: result.reason, siteId: result.siteId, kind: input.kind, policyDigest: result.policyDigest }));
      return result;
    } catch (error) {
      this.emit(Object.freeze({ category: "INGEST", channel: "MICRO", outcome: "ERROR", reason: error instanceof BehavioralSignalError ? error.code : "UNKNOWN", siteId: "redacted-on-error", kind: null, policyDigest: policy.digest }));
      throw error;
    }
  }
}
