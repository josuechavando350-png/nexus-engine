import { createHash } from "node:crypto";
import { canonicalJson, ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";
import type { CortexBanditMode } from "./index";

const CONTROL_TYPE = "cortex.bandit_runtime_control";
const EVENT_TYPE = "cortex.bandit_runtime_control_event";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MODES = new Set<CortexBanditMode>(["ACTIVE", "FALLBACK_ONLY", "KILLED"]);

const CONTROL = Object.freeze({ experimentId: "cortex.bandit.control.experiment_id", policyDigest: "cortex.bandit.control.policy_digest", mode: "cortex.bandit.control.mode", reason: "cortex.bandit.control.reason", changedAt: "cortex.bandit.control.changed_at", logicalRevision: "cortex.bandit.control.logical_revision", digest: "cortex.bandit.control.digest" });
const EVENT = Object.freeze({ experimentId: "cortex.bandit.control_event.experiment_id", policyDigest: "cortex.bandit.control_event.policy_digest", fromMode: "cortex.bandit.control_event.from_mode", toMode: "cortex.bandit.control_event.to_mode", reason: "cortex.bandit.control_event.reason", changedAt: "cortex.bandit.control_event.changed_at", targetRevision: "cortex.bandit.control_event.target_revision", digest: "cortex.bandit.control_event.digest" });

export interface CortexBanditRuntimeControlState { readonly experimentId: string; readonly policyDigest: string; readonly mode: CortexBanditMode; readonly reason: string; readonly changedAt: string | null; readonly revision: number; readonly digest: string }
export interface CortexBanditRuntimeControlEvent { readonly experimentId: string; readonly policyDigest: string; readonly fromMode: CortexBanditMode; readonly toMode: CortexBanditMode; readonly reason: string; readonly changedAt: string; readonly targetRevision: number; readonly digest: string }
export interface SetCortexBanditRuntimeControlInput { readonly expectedRevision: number; readonly mode: CortexBanditMode; readonly reason: string; readonly changedAt?: string }

export class CortexBanditRuntimeControlError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "CONFLICT" | "INTEGRITY_FAILURE" | "PERSISTENCE_FAILURE" | "POLICY_VIOLATION", message: string) { super(message); this.name = "CortexBanditRuntimeControlError"; }
}

function hash(namespace: string, value: unknown): string { return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`; }
function identifier(value: string, field: string): string { if (typeof value !== "string") throw new CortexBanditRuntimeControlError("INVALID_INPUT", `${field} must be a string`); const normalized = value.trim(); if (!IDENTIFIER.test(normalized)) throw new CortexBanditRuntimeControlError("INVALID_INPUT", `${field} is malformed`); return normalized; }
function policyDigest(value: string): string { if (typeof value !== "string" || !DIGEST.test(value)) throw new CortexBanditRuntimeControlError("INVALID_INPUT", "policyDigest is malformed"); return value; }
function mode(value: unknown, code: "INVALID_INPUT" | "INTEGRITY_FAILURE" = "INVALID_INPUT"): CortexBanditMode { if (typeof value !== "string" || !MODES.has(value as CortexBanditMode)) throw new CortexBanditRuntimeControlError(code, "bandit runtime mode is invalid"); return value as CortexBanditMode; }
function canonicalUtc(value: string, field: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE"): string { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new CortexBanditRuntimeControlError(code, `${field} must be canonical UTC`); return value; }
function reason(value: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE" = "INVALID_INPUT"): string { if (typeof value !== "string") throw new CortexBanditRuntimeControlError(code, "reason must be a string"); const normalized = value.normalize("NFKC").trim(); if (normalized.length < 3 || normalized.length > 256) throw new CortexBanditRuntimeControlError(code, "reason must contain 3..256 characters"); for (const character of normalized) { const point = character.codePointAt(0) ?? 0; if (point < 0x20 || point === 0x7f) throw new CortexBanditRuntimeControlError(code, "reason contains a control character"); } return normalized; }
function positiveRevision(value: number, field: string, code: "INVALID_INPUT" | "INTEGRITY_FAILURE"): number { if (!Number.isSafeInteger(value) || value < 1) throw new CortexBanditRuntimeControlError(code, `${field} must be a positive safe integer`); return value; }
function property(id: string, name: string, valueKind: "STRING" | "NUMBER" | "DATETIME", immutable = false) { return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const; }

function controlSchema(scope: OntologyScope): ValidatedSchema {
  const schema: SchemaVersion = {
    version: "cortex-bandit-runtime-control-v2",
    scope,
    properties: [
      property(CONTROL.experimentId, "BanditControlExperimentId", "STRING", true), property(CONTROL.policyDigest, "BanditControlPolicyDigest", "STRING"), property(CONTROL.mode, "BanditControlMode", "STRING"), property(CONTROL.reason, "BanditControlReason", "STRING"), property(CONTROL.changedAt, "BanditControlChangedAt", "DATETIME"), property(CONTROL.logicalRevision, "BanditControlLogicalRevision", "NUMBER"), property(CONTROL.digest, "BanditControlDigest", "STRING"),
      property(EVENT.experimentId, "BanditControlEventExperimentId", "STRING", true), property(EVENT.policyDigest, "BanditControlEventPolicyDigest", "STRING", true), property(EVENT.fromMode, "BanditControlEventFromMode", "STRING", true), property(EVENT.toMode, "BanditControlEventToMode", "STRING", true), property(EVENT.reason, "BanditControlEventReason", "STRING", true), property(EVENT.changedAt, "BanditControlEventChangedAt", "DATETIME", true), property(EVENT.targetRevision, "BanditControlEventTargetRevision", "NUMBER", true), property(EVENT.digest, "BanditControlEventDigest", "STRING", true),
    ], interfaces: [], objects: [{ id: CONTROL_TYPE, name: "CortexBanditRuntimeControl", propertyIds: Object.values(CONTROL), interfaceIds: [] }, { id: EVENT_TYPE, name: "CortexBanditRuntimeControlEvent", propertyIds: Object.values(EVENT), interfaceIds: [] }], relationships: [], actions: [], functions: [], events: [],
  };
  return validateSchema(schema);
}

function stringProperty(record: ObjectRecord, key: string): string { const value = record.properties[key]; if (typeof value !== "string") throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`); return value; }
function numberProperty(record: ObjectRecord, key: string): number { const value = record.properties[key]; if (typeof value !== "number" || !Number.isFinite(value)) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`); return value; }
function controlDigest(input: Omit<CortexBanditRuntimeControlState, "digest">): string { return hash("cortex-bandit-runtime-control-state-v2", input); }
function eventDigest(input: Omit<CortexBanditRuntimeControlEvent, "digest">): string { return hash("cortex-bandit-runtime-control-event-v2", input); }
function controlProperties(input: Omit<CortexBanditRuntimeControlState, "digest">): Readonly<Record<string, JsonValue>> { return Object.freeze({ [CONTROL.experimentId]: input.experimentId, [CONTROL.policyDigest]: input.policyDigest, [CONTROL.mode]: input.mode, [CONTROL.reason]: input.reason, [CONTROL.changedAt]: input.changedAt, [CONTROL.logicalRevision]: input.revision, [CONTROL.digest]: controlDigest(input) }); }
function eventProperties(input: Omit<CortexBanditRuntimeControlEvent, "digest">): Readonly<Record<string, JsonValue>> { return Object.freeze({ [EVENT.experimentId]: input.experimentId, [EVENT.policyDigest]: input.policyDigest, [EVENT.fromMode]: input.fromMode, [EVENT.toMode]: input.toMode, [EVENT.reason]: input.reason, [EVENT.changedAt]: input.changedAt, [EVENT.targetRevision]: input.targetRevision, [EVENT.digest]: eventDigest(input) }); }

function parseControl(record: ObjectRecord): CortexBanditRuntimeControlState {
  if (record.typeId !== CONTROL_TYPE) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", "control record has the wrong type");
  const core = { experimentId: identifier(stringProperty(record, CONTROL.experimentId), "stored experimentId"), policyDigest: policyDigest(stringProperty(record, CONTROL.policyDigest)), mode: mode(stringProperty(record, CONTROL.mode), "INTEGRITY_FAILURE"), reason: reason(stringProperty(record, CONTROL.reason), "INTEGRITY_FAILURE"), changedAt: canonicalUtc(stringProperty(record, CONTROL.changedAt), "stored changedAt", "INTEGRITY_FAILURE"), revision: positiveRevision(numberProperty(record, CONTROL.logicalRevision), "stored logicalRevision", "INTEGRITY_FAILURE") };
  if (core.revision !== record.revision) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", "control logical revision does not match transaction revision");
  const observed = stringProperty(record, CONTROL.digest); if (observed !== controlDigest(core)) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", "control digest mismatch"); return Object.freeze({ ...core, digest: observed });
}
function parseEvent(record: ObjectRecord): CortexBanditRuntimeControlEvent {
  if (record.typeId !== EVENT_TYPE) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", "control event has the wrong type");
  const core = { experimentId: identifier(stringProperty(record, EVENT.experimentId), "stored experimentId"), policyDigest: policyDigest(stringProperty(record, EVENT.policyDigest)), fromMode: mode(stringProperty(record, EVENT.fromMode), "INTEGRITY_FAILURE"), toMode: mode(stringProperty(record, EVENT.toMode), "INTEGRITY_FAILURE"), reason: reason(stringProperty(record, EVENT.reason), "INTEGRITY_FAILURE"), changedAt: canonicalUtc(stringProperty(record, EVENT.changedAt), "stored changedAt", "INTEGRITY_FAILURE"), targetRevision: positiveRevision(numberProperty(record, EVENT.targetRevision), "stored targetRevision", "INTEGRITY_FAILURE") };
  const observed = stringProperty(record, EVENT.digest); if (observed !== eventDigest(core)) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", "control event digest mismatch"); return Object.freeze({ ...core, digest: observed });
}
function rank(value: CortexBanditMode): number { return value === "ACTIVE" ? 0 : value === "FALLBACK_ONLY" ? 1 : 2; }
function restrictive(left: CortexBanditMode, right: CortexBanditMode): CortexBanditMode { return rank(left) >= rank(right) ? left : right; }
function isConflict(error: unknown): boolean { return error instanceof OntologyTransactionError && error.code === "CONFLICT"; }

export class CortexBanditRuntimeController {
  readonly schema: ValidatedSchema;
  readonly experimentId: string;
  readonly policyDigest: string;
  readonly configuredMode: CortexBanditMode;

  constructor(private readonly transactions: OntologyTransactionPort, readonly scope: OntologyScope, experimentIdValue: string, policyDigestValue: string, configuredModeValue: CortexBanditMode, private readonly now: () => number = Date.now) {
    this.experimentId = identifier(experimentIdValue, "experimentId"); this.policyDigest = policyDigest(policyDigestValue); this.configuredMode = mode(configuredModeValue); this.schema = controlSchema(scope);
  }
  private controlId(): string { return ontologyId("cortex-bandit-runtime-control-v2", { scope: this.scope, experimentId: this.experimentId }); }
  private eventId(targetRevision: number): string { return ontologyId("cortex-bandit-runtime-control-event-v2", { scope: this.scope, experimentId: this.experimentId, targetRevision }); }

  current(): CortexBanditRuntimeControlState {
    const raw = this.transactions.getObject(this.scope, this.controlId());
    if (!raw) { const core = { experimentId: this.experimentId, policyDigest: this.policyDigest, mode: this.configuredMode, reason: "configured runtime mode", changedAt: null, revision: 0 } as const; return Object.freeze({ ...core, digest: controlDigest(core) }); }
    const state = parseControl(raw); if (state.experimentId !== this.experimentId) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", "control experiment identity mismatch"); return state;
  }

  effectiveMode(): CortexBanditMode { return restrictive(this.current().mode, this.configuredMode); }

  set(input: SetCortexBanditRuntimeControlInput): CortexBanditRuntimeControlState {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new CortexBanditRuntimeControlError("INVALID_INPUT", "expectedRevision must be a non-negative safe integer");
    const nextMode = mode(input.mode); if (rank(nextMode) < rank(this.configuredMode)) throw new CortexBanditRuntimeControlError("POLICY_VIOLATION", "runtime control cannot weaken configured mode");
    const nextReason = reason(input.reason); const changedAt = input.changedAt === undefined ? new Date(this.now()).toISOString() : canonicalUtc(input.changedAt, "changedAt", "INVALID_INPUT"); const current = this.current();
    if (current.revision !== input.expectedRevision) throw new CortexBanditRuntimeControlError("CONFLICT", "runtime control revision changed");
    if (current.mode === nextMode && current.reason === nextReason && current.policyDigest === this.policyDigest) return current;
    const nextRevision = current.revision + 1;
    const nextCore = { experimentId: this.experimentId, policyDigest: this.policyDigest, mode: nextMode, reason: nextReason, changedAt, revision: nextRevision } as const;
    const eventCore = { experimentId: this.experimentId, policyDigest: this.policyDigest, fromMode: current.mode, toMode: nextMode, reason: nextReason, changedAt, targetRevision: nextRevision } as const;
    const operations: TransactionOperation[] = [current.revision === 0 ? { kind: "CREATE_OBJECT", record: { id: this.controlId(), typeId: CONTROL_TYPE, scope: this.scope, properties: controlProperties(nextCore) } } : { kind: "UPDATE_OBJECT", id: this.controlId(), expectedRevision: current.revision, properties: controlProperties(nextCore) }, { kind: "CREATE_OBJECT", record: { id: this.eventId(nextRevision), typeId: EVENT_TYPE, scope: this.scope, properties: eventProperties(eventCore) } }];
    try { this.transactions.transact(this.scope, this.schema, operations); }
    catch (error) { if (isConflict(error)) throw new CortexBanditRuntimeControlError("CONFLICT", "runtime control changed concurrently"); if (error instanceof CortexBanditRuntimeControlError) throw error; throw new CortexBanditRuntimeControlError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "runtime control persistence failed"); }
    return this.current();
  }

  history(limit = 32): readonly CortexBanditRuntimeControlEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new CortexBanditRuntimeControlError("INVALID_INPUT", "history limit must be 1..256"); const current = this.current(); if (current.revision === 0) return Object.freeze([]); const start = Math.max(1, current.revision - limit + 1); const events: CortexBanditRuntimeControlEvent[] = [];
    for (let revision = start; revision <= current.revision; revision += 1) { const raw = this.transactions.getObject(this.scope, this.eventId(revision)); if (!raw) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", `runtime control history event ${revision} is missing`); const event = parseEvent(raw); if (event.experimentId !== this.experimentId || event.targetRevision !== revision) throw new CortexBanditRuntimeControlError("INTEGRITY_FAILURE", `runtime control history event ${revision} identity mismatch`); events.push(event); }
    return Object.freeze(events);
  }
}
