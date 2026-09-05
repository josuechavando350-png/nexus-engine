import { createHash } from "node:crypto";
import {
  canonicalJson,
  ontologyId,
  validateSchema,
  type OntologyScope,
  type SchemaVersion,
  type ValidatedSchema,
} from "@nexus/ontology";
import {
  OntologyTransactionError,
  type JsonValue,
  type ObjectRecord,
  type OntologyTransactionPort,
  type TransactionOperation,
} from "@nexus/ontology/transaction";
import { GoogleAdsApiError } from "@nexus/ontology/cortex/bidding-supervisor/google-ads-rest";

const STATE_TYPE = "cortex.creative_sync_state";
const RUN_TYPE = "cortex.creative_sync_run";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const CUSTOMER_ID = /^\d{5,20}$/;
const AD_RESOURCE = /^customers\/(\d{5,20})\/ads\/(\d{1,20})$/;
const SCOPE_RESOURCE = {
  CUSTOMER: /^customers\/(\d{5,20})$/,
  CAMPAIGN: /^customers\/(\d{5,20})\/campaigns\/\d{1,20}$/,
  AD_GROUP: /^customers\/(\d{5,20})\/adGroups\/\d{1,20}$/,
  AD_GROUP_CRITERION: /^customers\/(\d{5,20})\/adGroupCriteria\/\d{1,20}~\d{1,20}$/,
} as const;

const STATE = Object.freeze({
  customerId: "cortex.creative.state.customer_id",
  payload: "cortex.creative.state.payload",
  digest: "cortex.creative.state.digest",
  updatedAt: "cortex.creative.state.updated_at",
});
const RUN = Object.freeze({
  runId: "cortex.creative.run.run_id",
  customerId: "cortex.creative.run.customer_id",
  policyDigest: "cortex.creative.run.policy_digest",
  status: "cortex.creative.run.status",
  payload: "cortex.creative.run.payload",
  digest: "cortex.creative.run.digest",
  createdAt: "cortex.creative.run.created_at",
  updatedAt: "cortex.creative.run.updated_at",
});

export type CreativeSyncMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type CreativeSyncRunStatus = "PREPARED" | "APPLIED" | "NOOP" | "FAILED" | "ROLLED_BACK";
export type CreativeSyncReason =
  | "KILL_SWITCH"
  | "SOURCE_STALE"
  | "IN_SYNC"
  | "ATTRIBUTE_LIMIT"
  | "ATTRIBUTE_TYPE_CONFLICT"
  | "RSA_NOT_FOUND"
  | "OBSERVE_ONLY"
  | "ACTION_APPLIED"
  | "ACTION_RECOVERED"
  | "REMOTE_CONFLICT"
  | "API_FAILURE"
  | "ROLLBACK_APPLIED";
export type CustomizerAttributeType = "TEXT" | "NUMBER" | "PRICE" | "PERCENT";
export type CustomizerScopeKind = "CUSTOMER" | "CAMPAIGN" | "AD_GROUP" | "AD_GROUP_CRITERION";
export type RsaPinnedField = "HEADLINE_1" | "HEADLINE_2" | "HEADLINE_3" | "DESCRIPTION_1" | "DESCRIPTION_2";

const MODES: readonly CreativeSyncMode[] = ["ACTIVE", "OBSERVE_ONLY", "KILLED"];
const STATUSES: readonly CreativeSyncRunStatus[] = ["PREPARED", "APPLIED", "NOOP", "FAILED", "ROLLED_BACK"];
const REASONS: readonly CreativeSyncReason[] = [
  "KILL_SWITCH", "SOURCE_STALE", "IN_SYNC", "ATTRIBUTE_LIMIT", "ATTRIBUTE_TYPE_CONFLICT", "RSA_NOT_FOUND",
  "OBSERVE_ONLY", "ACTION_APPLIED", "ACTION_RECOVERED", "REMOTE_CONFLICT", "API_FAILURE", "ROLLBACK_APPLIED",
];
const ATTRIBUTE_TYPES: readonly CustomizerAttributeType[] = ["TEXT", "NUMBER", "PRICE", "PERCENT"];
const SCOPE_KINDS: readonly CustomizerScopeKind[] = ["CUSTOMER", "CAMPAIGN", "AD_GROUP", "AD_GROUP_CRITERION"];
const PINNED_FIELDS: readonly RsaPinnedField[] = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3", "DESCRIPTION_1", "DESCRIPTION_2"];
const HEADLINE_PINS: readonly RsaPinnedField[] = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"];
const DESCRIPTION_PINS: readonly RsaPinnedField[] = ["DESCRIPTION_1", "DESCRIPTION_2"];

export interface CreativeTextAsset {
  readonly text: string;
  readonly pinnedField: RsaPinnedField | null;
}

export interface ResponsiveSearchAdContent {
  readonly headlines: readonly CreativeTextAsset[];
  readonly descriptions: readonly CreativeTextAsset[];
  readonly path1: string | null;
  readonly path2: string | null;
  readonly finalUrls: readonly string[];
  readonly finalMobileUrls: readonly string[];
}

export interface DesiredResponsiveSearchAd extends ResponsiveSearchAdContent {
  readonly resourceName: string;
}

export interface ResponsiveSearchAdSnapshot extends DesiredResponsiveSearchAd {
  readonly adId: string;
  readonly adGroupResourceName: string;
  readonly status: string;
}

export interface DesiredCustomizerAttribute {
  readonly name: string;
  readonly type: CustomizerAttributeType;
}

export interface CustomizerAttributeSnapshot extends DesiredCustomizerAttribute {
  readonly resourceName: string;
  readonly id: string;
  readonly status: "ENABLED";
}

export interface DesiredCustomizerValue {
  readonly attributeName: string;
  readonly type: CustomizerAttributeType;
  readonly scopeKind: CustomizerScopeKind;
  readonly scopeResourceName: string;
  readonly stringValue: string;
}

export interface CustomizerValueSnapshot {
  readonly resourceName: string;
  readonly attributeResourceName: string;
  readonly type: CustomizerAttributeType;
  readonly scopeKind: CustomizerScopeKind;
  readonly scopeResourceName: string;
  readonly stringValue: string;
  readonly status: "ENABLED";
}

export interface CreativeDesiredState {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly observedAt: string;
  readonly customizerAttributes: readonly DesiredCustomizerAttribute[];
  readonly customizerValues: readonly DesiredCustomizerValue[];
  readonly responsiveSearchAds: readonly DesiredResponsiveSearchAd[];
}

export interface CreativeDesiredStateProvider {
  getDesiredState(customerId: string): Promise<CreativeDesiredState>;
}

export type CreativeSyncAction =
  | { readonly kind: "CREATE_CUSTOMIZER_ATTRIBUTE"; readonly name: string; readonly type: CustomizerAttributeType }
  | { readonly kind: "REMOVE_CUSTOMIZER_ATTRIBUTE"; readonly resourceName: string; readonly name: string; readonly type: CustomizerAttributeType }
  | {
      readonly kind: "UPSERT_CUSTOMIZER_VALUE";
      readonly scopeKind: CustomizerScopeKind;
      readonly scopeResourceName: string;
      readonly attributeResourceName: string;
      readonly type: CustomizerAttributeType;
      readonly expected: CustomizerValueSnapshot | null;
      readonly desiredStringValue: string;
    }
  | {
      readonly kind: "REMOVE_CUSTOMIZER_VALUE";
      readonly scopeKind: CustomizerScopeKind;
      readonly scopeResourceName: string;
      readonly attributeResourceName: string;
      readonly expected: CustomizerValueSnapshot;
    }
  | {
      readonly kind: "UPDATE_RSA";
      readonly resourceName: string;
      readonly expected: ResponsiveSearchAdContent;
      readonly desired: ResponsiveSearchAdContent;
    };

export interface CreativeMutationReceipt {
  readonly requestId: string | null;
  readonly resourceName: string;
  readonly recoveredAlreadyApplied: boolean;
}

export interface GoogleAdsCreativeGateway {
  getCustomizerAttributes(customerId: string): Promise<readonly CustomizerAttributeSnapshot[]>;
  getCustomizerValue(
    customerId: string,
    lookup: Pick<DesiredCustomizerValue, "scopeKind" | "scopeResourceName"> & { readonly attributeResourceName: string },
  ): Promise<CustomizerValueSnapshot | null>;
  getResponsiveSearchAd(customerId: string, resourceName: string): Promise<ResponsiveSearchAdSnapshot | null>;
  applyMutation(customerId: string, action: CreativeSyncAction): Promise<CreativeMutationReceipt>;
}

export interface CreateCreativeSyncPolicyInput {
  readonly policyId: string;
  readonly version: string;
  readonly maxSourceAgeMs: number;
  readonly maxDesiredResponsiveSearchAds: number;
  readonly maxDesiredCustomizerValues: number;
  readonly maxWriteRetries?: number;
  readonly mode?: CreativeSyncMode;
}

export interface CreativeSyncPolicy extends Required<CreateCreativeSyncPolicyInput> {
  readonly digest: string;
}

export interface CreativeSyncRunInput {
  readonly runId: string;
  readonly customerId: string;
  readonly mode?: CreativeSyncMode;
}

export interface CreativeSyncRollbackInput {
  readonly runId: string;
  readonly customerId: string;
}

export interface CreativeSyncResult {
  readonly runId: string;
  readonly customerId: string;
  readonly status: CreativeSyncRunStatus;
  readonly mode: CreativeSyncMode;
  readonly reason: CreativeSyncReason;
  readonly sourceId: string | null;
  readonly sourceVersion: string | null;
  readonly sourceDigest: string | null;
  readonly action: CreativeSyncAction | null;
  readonly receipt: CreativeMutationReceipt | null;
  readonly policyDigest: string;
  readonly digest: string;
}

interface StatePayload {
  readonly policyDigest: string;
  readonly lastRunAt: string | null;
  readonly lastMutationAt: string | null;
  readonly inFlightRunId: string | null;
  readonly lastAppliedAction: CreativeSyncAction | null;
  readonly lastRollbackAction: CreativeSyncAction | null;
  readonly lastSourceVersion: string | null;
  readonly lastSourceDigest: string | null;
  readonly lastRollbackAt: string | null;
}

interface StateRecord extends StatePayload {
  readonly id: string;
  readonly customerId: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

interface RunPayload {
  readonly mode: CreativeSyncMode;
  readonly reason: CreativeSyncReason;
  readonly sourceId: string | null;
  readonly sourceVersion: string | null;
  readonly sourceDigest: string | null;
  readonly sourceObservedAt: string | null;
  readonly action: CreativeSyncAction | null;
  readonly receipt: CreativeMutationReceipt | null;
  readonly errorCode: string | null;
}

interface RunRecord extends RunPayload {
  readonly id: string;
  readonly runId: string;
  readonly customerId: string;
  readonly policyDigest: string;
  readonly status: CreativeSyncRunStatus;
  readonly digest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

type FinalizeEffect = "NONE" | "APPLY" | "ROLLBACK";

export class CreativeSyncError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "POLICY_VIOLATION" | "CONFLICT" | "INTEGRITY_FAILURE" | "PERSISTENCE_FAILURE" | "REMOTE_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "CreativeSyncError";
  }
}

function hash(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new CreativeSyncError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function customerId(value: string): string {
  const normalized = value.replaceAll("-", "").trim();
  if (!CUSTOMER_ID.test(normalized)) throw new CreativeSyncError("INVALID_INPUT", "customerId is malformed");
  return normalized;
}

function positiveInt(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new CreativeSyncError("INVALID_INPUT", `${field} must be a positive safe integer <= ${max}`);
  }
  return value;
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CreativeSyncError("INVALID_INPUT", `${field} must be canonical UTC`);
  }
  return value;
}

function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJson);
}

function json(value: unknown, field: string): JsonValue {
  if (!isJson(value)) throw new CreativeSyncError("INTEGRITY_FAILURE", `${field} is not finite JSON`);
  return value;
}

function object(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CreativeSyncError("INTEGRITY_FAILURE", `${field} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function requiredString(record: ObjectRecord, key: string): string {
  const value = record.properties[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CreativeSyncError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  }
  return value;
}

function nullableString(value: JsonValue | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CreativeSyncError("INTEGRITY_FAILURE", `${field} must be string or null`);
  return value;
}

function property(id: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME", immutable = false) {
  return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const;
}

function schema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = {
    version: "cortex-creative-sync-v2",
    scope,
    properties: [
      property(STATE.customerId, "CreativeSyncCustomerId", "STRING", true),
      property(STATE.payload, "CreativeSyncStatePayload", "JSON"),
      property(STATE.digest, "CreativeSyncStateDigest", "STRING"),
      property(STATE.updatedAt, "CreativeSyncStateUpdatedAt", "DATETIME"),
      property(RUN.runId, "CreativeSyncRunId", "STRING", true),
      property(RUN.customerId, "CreativeSyncRunCustomerId", "STRING", true),
      property(RUN.policyDigest, "CreativeSyncPolicyDigest", "STRING", true),
      property(RUN.status, "CreativeSyncRunStatus", "STRING"),
      property(RUN.payload, "CreativeSyncRunPayload", "JSON"),
      property(RUN.digest, "CreativeSyncRunDigest", "STRING"),
      property(RUN.createdAt, "CreativeSyncRunCreatedAt", "DATETIME", true),
      property(RUN.updatedAt, "CreativeSyncRunUpdatedAt", "DATETIME"),
    ],
    interfaces: [],
    objects: [
      { id: STATE_TYPE, name: "CortexCreativeSyncState", propertyIds: Object.values(STATE), interfaceIds: [] },
      { id: RUN_TYPE, name: "CortexCreativeSyncRun", propertyIds: Object.values(RUN), interfaceIds: [] },
    ],
    relationships: [], actions: [], functions: [], events: [],
  };
  return validateSchema(value);
}

export function createCreativeSyncPolicy(input: CreateCreativeSyncPolicyInput): CreativeSyncPolicy {
  const policyId = identifier(input.policyId, "policyId");
  const version = identifier(input.version, "version");
  const maxSourceAgeMs = positiveInt(input.maxSourceAgeMs, "maxSourceAgeMs", 30 * 24 * 60 * 60 * 1000);
  const maxDesiredResponsiveSearchAds = positiveInt(input.maxDesiredResponsiveSearchAds, "maxDesiredResponsiveSearchAds", 5_000);
  const maxDesiredCustomizerValues = positiveInt(input.maxDesiredCustomizerValues, "maxDesiredCustomizerValues", 20_000);
  const maxWriteRetries = input.maxWriteRetries ?? 3;
  if (!Number.isInteger(maxWriteRetries) || maxWriteRetries < 0 || maxWriteRetries > 10) {
    throw new CreativeSyncError("INVALID_INPUT", "maxWriteRetries must be 0..10");
  }
  const mode = input.mode ?? "ACTIVE";
  if (!MODES.includes(mode)) throw new CreativeSyncError("INVALID_INPUT", "mode is invalid");
  const core = { policyId, version, maxSourceAgeMs, maxDesiredResponsiveSearchAds, maxDesiredCustomizerValues, maxWriteRetries, mode };
  return Object.freeze({ ...core, digest: hash("cortex-creative-sync-policy-v2", core) });
}

function effectiveMode(policy: CreativeSyncMode, requested: CreativeSyncMode | undefined): CreativeSyncMode {
  const rank: Record<CreativeSyncMode, number> = { ACTIVE: 0, OBSERVE_ONLY: 1, KILLED: 2 };
  const candidate = requested ?? "ACTIVE";
  if (!MODES.includes(candidate)) throw new CreativeSyncError("INVALID_INPUT", "requested mode is invalid");
  return rank[candidate] > rank[policy] ? candidate : policy;
}

function validateResourceCustomer(resourceName: string, regex: RegExp, expectedCustomerId: string, field: string): string {
  const match = regex.exec(resourceName);
  if (!match?.[1] || match[1] !== expectedCustomerId) throw new CreativeSyncError("INVALID_INPUT", `${field} is malformed or belongs to another customer`);
  return resourceName;
}

function googleAdsCharacterCount(value: string): number {
  let count = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const doubleWidth =
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x2e80 && code <= 0x30ff) ||
      (code >= 0x31f0 && code <= 0x31ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000;
    count += doubleWidth ? 2 : 1;
  }
  return count;
}

function containsDynamicInsertion(value: string): boolean {
  return /\{[^{}]+\}/u.test(value);
}

function validateUrl(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length > 2_048) throw new CreativeSyncError("INVALID_INPUT", `${field} must be at most 2048 characters`);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new CreativeSyncError("INVALID_INPUT", `${field} must be an absolute HTTP(S) URL`);
  }
  return normalized;
}

function normalizeTextAsset(
  value: CreativeTextAsset,
  field: string,
  maxStaticCharacters: number,
  allowedPins: readonly RsaPinnedField[],
): CreativeTextAsset {
  const text = value.text.trim();
  if (!text) throw new CreativeSyncError("INVALID_INPUT", `${field}.text must not be empty`);
  if (!containsDynamicInsertion(text) && googleAdsCharacterCount(text) > maxStaticCharacters) {
    throw new CreativeSyncError("INVALID_INPUT", `${field}.text exceeds Google Ads ${maxStaticCharacters}-character static limit`);
  }
  if (value.pinnedField !== null && !allowedPins.includes(value.pinnedField)) {
    throw new CreativeSyncError("INVALID_INPUT", `${field}.pinnedField is invalid for this RSA asset section`);
  }
  return Object.freeze({ text, pinnedField: value.pinnedField });
}

function normalizeRsa(value: DesiredResponsiveSearchAd, expectedCustomerId: string): DesiredResponsiveSearchAd {
  const resourceName = validateResourceCustomer(value.resourceName, AD_RESOURCE, expectedCustomerId, "RSA resourceName");
  if (value.headlines.length < 3 || value.headlines.length > 15) throw new CreativeSyncError("INVALID_INPUT", "RSA headlines must contain 3..15 assets");
  if (value.descriptions.length < 2 || value.descriptions.length > 4) throw new CreativeSyncError("INVALID_INPUT", "RSA descriptions must contain 2..4 assets");
  if (value.finalUrls.length < 1 || value.finalUrls.length > 10) throw new CreativeSyncError("INVALID_INPUT", "RSA finalUrls must contain 1..10 URLs");
  if (value.finalMobileUrls.length > 10) throw new CreativeSyncError("INVALID_INPUT", "RSA finalMobileUrls must contain at most 10 URLs");
  const path1 = value.path1 === null ? null : value.path1.trim();
  const path2 = value.path2 === null ? null : value.path2.trim();
  if (path2 && !path1) throw new CreativeSyncError("INVALID_INPUT", "RSA path2 requires path1");
  if ((path1 && googleAdsCharacterCount(path1) > 15) || (path2 && googleAdsCharacterCount(path2) > 15)) {
    throw new CreativeSyncError("INVALID_INPUT", "RSA display paths must be at most 15 Google Ads characters each");
  }
  return Object.freeze({
    resourceName,
    headlines: Object.freeze(value.headlines.map((asset, index) => normalizeTextAsset(asset, `headlines[${index}]`, 30, HEADLINE_PINS))),
    descriptions: Object.freeze(value.descriptions.map((asset, index) => normalizeTextAsset(asset, `descriptions[${index}]`, 90, DESCRIPTION_PINS))),
    path1: path1 || null,
    path2: path2 || null,
    finalUrls: Object.freeze(value.finalUrls.map((url, index) => validateUrl(url, `finalUrls[${index}]`))),
    finalMobileUrls: Object.freeze(value.finalMobileUrls.map((url, index) => validateUrl(url, `finalMobileUrls[${index}]`))),
  });
}

function normalizeDesiredState(
  value: CreativeDesiredState,
  expectedCustomerId: string,
  policy: CreativeSyncPolicy,
): CreativeDesiredState & { readonly digest: string } {
  const sourceId = identifier(value.sourceId, "sourceId");
  const sourceVersion = identifier(value.sourceVersion, "sourceVersion");
  const observedAt = canonicalUtc(value.observedAt, "observedAt");
  if (value.customizerAttributes.length > 40) throw new CreativeSyncError("INVALID_INPUT", "desired customizer attributes exceed Google Ads enabled-attribute limit of 40");
  if (value.customizerValues.length > policy.maxDesiredCustomizerValues) throw new CreativeSyncError("INVALID_INPUT", "desired customizer values exceed policy limit");
  if (value.responsiveSearchAds.length > policy.maxDesiredResponsiveSearchAds) throw new CreativeSyncError("INVALID_INPUT", "desired RSAs exceed policy limit");

  const attributes = value.customizerAttributes.map((attribute) => {
    const name = attribute.name.trim();
    if (!name || name.length > 40) throw new CreativeSyncError("INVALID_INPUT", "customizer attribute names must contain 1..40 characters");
    if (!ATTRIBUTE_TYPES.includes(attribute.type)) throw new CreativeSyncError("INVALID_INPUT", `customizer attribute ${name} has invalid type`);
    return Object.freeze({ name, type: attribute.type });
  });
  const attributeMap = new Map<string, DesiredCustomizerAttribute>();
  for (const attribute of attributes) {
    const key = attribute.name.toLocaleLowerCase("en-US");
    if (attributeMap.has(key)) throw new CreativeSyncError("INVALID_INPUT", `duplicate customizer attribute ${attribute.name}`);
    attributeMap.set(key, attribute);
  }

  const customizerValues = value.customizerValues.map((item) => {
    const attributeName = item.attributeName.trim();
    const attribute = attributeMap.get(attributeName.toLocaleLowerCase("en-US"));
    if (!attribute) throw new CreativeSyncError("INVALID_INPUT", `customizer value references undeclared attribute ${attributeName}`);
    if (item.type !== attribute.type) throw new CreativeSyncError("INVALID_INPUT", `customizer value type does not match attribute ${attributeName}`);
    if (!SCOPE_KINDS.includes(item.scopeKind)) throw new CreativeSyncError("INVALID_INPUT", "customizer scopeKind is invalid");
    const scopeResourceName = validateResourceCustomer(item.scopeResourceName, SCOPE_RESOURCE[item.scopeKind], expectedCustomerId, "customizer scopeResourceName");
    const stringValue = item.stringValue.trim();
    if (!stringValue || stringValue.length > 500) throw new CreativeSyncError("INVALID_INPUT", "customizer stringValue must contain 1..500 characters");
    return Object.freeze({ attributeName, type: item.type, scopeKind: item.scopeKind, scopeResourceName, stringValue });
  });
  const valueKeys = new Set<string>();
  for (const item of customizerValues) {
    const key = `${item.scopeKind}\u0000${item.scopeResourceName}\u0000${item.attributeName.toLocaleLowerCase("en-US")}`;
    if (valueKeys.has(key)) throw new CreativeSyncError("INVALID_INPUT", "duplicate customizer value binding");
    valueKeys.add(key);
  }

  const responsiveSearchAds = value.responsiveSearchAds.map((rsa) => normalizeRsa(rsa, expectedCustomerId));
  const rsaKeys = new Set<string>();
  for (const rsa of responsiveSearchAds) {
    if (rsaKeys.has(rsa.resourceName)) throw new CreativeSyncError("INVALID_INPUT", `duplicate RSA ${rsa.resourceName}`);
    rsaKeys.add(rsa.resourceName);
  }

  const normalized = {
    sourceId,
    sourceVersion,
    observedAt,
    customizerAttributes: Object.freeze([...attributes].sort((a, b) => a.name.localeCompare(b.name))),
    customizerValues: Object.freeze([...customizerValues].sort((a, b) => `${a.scopeKind}/${a.scopeResourceName}/${a.attributeName}`.localeCompare(`${b.scopeKind}/${b.scopeResourceName}/${b.attributeName}`))),
    responsiveSearchAds: Object.freeze([...responsiveSearchAds].sort((a, b) => a.resourceName.localeCompare(b.resourceName))),
  };
  return Object.freeze({ ...normalized, digest: hash("cortex-creative-desired-state-v2", normalized) });
}

function rsaContent(value: ResponsiveSearchAdSnapshot | DesiredResponsiveSearchAd): ResponsiveSearchAdContent {
  return Object.freeze({
    headlines: value.headlines,
    descriptions: value.descriptions,
    path1: value.path1,
    path2: value.path2,
    finalUrls: value.finalUrls,
    finalMobileUrls: value.finalMobileUrls,
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function stateDigest(customer: string, payload: StatePayload, updatedAt: string): string {
  return hash("cortex-creative-sync-state-v2", { customer, payload, updatedAt });
}

function runDigest(
  runId: string,
  customer: string,
  policyDigest: string,
  status: CreativeSyncRunStatus,
  payload: RunPayload,
  createdAt: string,
  updatedAt: string,
): string {
  return hash("cortex-creative-sync-run-v2", { runId, customer, policyDigest, status, payload, createdAt, updatedAt });
}

function stateProperties(customer: string, payload: StatePayload, updatedAt: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [STATE.customerId]: customer,
    [STATE.payload]: json(payload, "state payload"),
    [STATE.digest]: stateDigest(customer, payload, updatedAt),
    [STATE.updatedAt]: updatedAt,
  });
}

function runProperties(
  runId: string,
  customer: string,
  policyDigest: string,
  status: CreativeSyncRunStatus,
  payload: RunPayload,
  createdAt: string,
  updatedAt: string,
): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [RUN.runId]: runId,
    [RUN.customerId]: customer,
    [RUN.policyDigest]: policyDigest,
    [RUN.status]: status,
    [RUN.payload]: json(payload, "run payload"),
    [RUN.digest]: runDigest(runId, customer, policyDigest, status, payload, createdAt, updatedAt),
    [RUN.createdAt]: createdAt,
    [RUN.updatedAt]: updatedAt,
  });
}

function parseTextAssets(value: JsonValue | undefined, field: string): readonly CreativeTextAsset[] {
  if (!Array.isArray(value)) throw new CreativeSyncError("INTEGRITY_FAILURE", `${field} must be an array`);
  return Object.freeze(value.map((entry, index) => {
    const raw = object(entry, `${field}[${index}]`);
    if (typeof raw.text !== "string") throw new CreativeSyncError("INTEGRITY_FAILURE", `${field}[${index}].text is invalid`);
    const pinnedField = raw.pinnedField === null ? null : raw.pinnedField;
    if (pinnedField !== null && (typeof pinnedField !== "string" || !PINNED_FIELDS.includes(pinnedField as RsaPinnedField))) {
      throw new CreativeSyncError("INTEGRITY_FAILURE", `${field}[${index}].pinnedField is invalid`);
    }
    return Object.freeze({ text: raw.text, pinnedField: pinnedField as RsaPinnedField | null });
  }));
}

function parseRsaContent(value: JsonValue | undefined, field: string): ResponsiveSearchAdContent {
  const raw = object(value, field);
  const strings = (entry: JsonValue | undefined, name: string) => {
    if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) throw new CreativeSyncError("INTEGRITY_FAILURE", `${name} must be a string array`);
    return Object.freeze(entry as string[]);
  };
  return Object.freeze({
    headlines: parseTextAssets(raw.headlines, `${field}.headlines`),
    descriptions: parseTextAssets(raw.descriptions, `${field}.descriptions`),
    path1: nullableString(raw.path1, `${field}.path1`),
    path2: nullableString(raw.path2, `${field}.path2`),
    finalUrls: strings(raw.finalUrls, `${field}.finalUrls`),
    finalMobileUrls: strings(raw.finalMobileUrls, `${field}.finalMobileUrls`),
  });
}

function parseCustomizerValueSnapshot(value: JsonValue | undefined, field: string): CustomizerValueSnapshot | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, field);
  if (
    typeof raw.resourceName !== "string" || typeof raw.attributeResourceName !== "string" ||
    typeof raw.type !== "string" || !ATTRIBUTE_TYPES.includes(raw.type as CustomizerAttributeType) ||
    typeof raw.scopeKind !== "string" || !SCOPE_KINDS.includes(raw.scopeKind as CustomizerScopeKind) ||
    typeof raw.scopeResourceName !== "string" || typeof raw.stringValue !== "string" || raw.status !== "ENABLED"
  ) throw new CreativeSyncError("INTEGRITY_FAILURE", `${field} is invalid`);
  return Object.freeze({
    resourceName: raw.resourceName,
    attributeResourceName: raw.attributeResourceName,
    type: raw.type as CustomizerAttributeType,
    scopeKind: raw.scopeKind as CustomizerScopeKind,
    scopeResourceName: raw.scopeResourceName,
    stringValue: raw.stringValue,
    status: "ENABLED",
  });
}

function parseAction(value: JsonValue | undefined): CreativeSyncAction | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "action");
  if (typeof raw.kind !== "string") throw new CreativeSyncError("INTEGRITY_FAILURE", "action.kind is invalid");
  if (raw.kind === "CREATE_CUSTOMIZER_ATTRIBUTE") {
    if (typeof raw.name !== "string" || typeof raw.type !== "string" || !ATTRIBUTE_TYPES.includes(raw.type as CustomizerAttributeType)) throw new CreativeSyncError("INTEGRITY_FAILURE", "create attribute action is invalid");
    return { kind: raw.kind, name: raw.name, type: raw.type as CustomizerAttributeType };
  }
  if (raw.kind === "REMOVE_CUSTOMIZER_ATTRIBUTE") {
    if (typeof raw.resourceName !== "string" || typeof raw.name !== "string" || typeof raw.type !== "string" || !ATTRIBUTE_TYPES.includes(raw.type as CustomizerAttributeType)) throw new CreativeSyncError("INTEGRITY_FAILURE", "remove attribute action is invalid");
    return { kind: raw.kind, resourceName: raw.resourceName, name: raw.name, type: raw.type as CustomizerAttributeType };
  }
  if (raw.kind === "UPDATE_RSA") {
    if (typeof raw.resourceName !== "string") throw new CreativeSyncError("INTEGRITY_FAILURE", "RSA action resource is invalid");
    return { kind: raw.kind, resourceName: raw.resourceName, expected: parseRsaContent(raw.expected, "action.expected"), desired: parseRsaContent(raw.desired, "action.desired") };
  }
  if (raw.kind === "UPSERT_CUSTOMIZER_VALUE" || raw.kind === "REMOVE_CUSTOMIZER_VALUE") {
    if (
      typeof raw.scopeKind !== "string" || !SCOPE_KINDS.includes(raw.scopeKind as CustomizerScopeKind) ||
      typeof raw.scopeResourceName !== "string" || typeof raw.attributeResourceName !== "string"
    ) throw new CreativeSyncError("INTEGRITY_FAILURE", "customizer value action identity is invalid");
    const expected = parseCustomizerValueSnapshot(raw.expected, "action.expected");
    if (raw.kind === "REMOVE_CUSTOMIZER_VALUE") {
      if (!expected) throw new CreativeSyncError("INTEGRITY_FAILURE", "remove customizer action requires expected value");
      return { kind: raw.kind, scopeKind: raw.scopeKind as CustomizerScopeKind, scopeResourceName: raw.scopeResourceName, attributeResourceName: raw.attributeResourceName, expected };
    }
    if (typeof raw.type !== "string" || !ATTRIBUTE_TYPES.includes(raw.type as CustomizerAttributeType) || typeof raw.desiredStringValue !== "string") throw new CreativeSyncError("INTEGRITY_FAILURE", "upsert customizer action is invalid");
    return { kind: raw.kind, scopeKind: raw.scopeKind as CustomizerScopeKind, scopeResourceName: raw.scopeResourceName, attributeResourceName: raw.attributeResourceName, type: raw.type as CustomizerAttributeType, expected, desiredStringValue: raw.desiredStringValue };
  }
  throw new CreativeSyncError("INTEGRITY_FAILURE", "action kind is invalid");
}

function parseReceipt(value: JsonValue | undefined): CreativeMutationReceipt | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "receipt");
  if (typeof raw.resourceName !== "string" || typeof raw.recoveredAlreadyApplied !== "boolean") throw new CreativeSyncError("INTEGRITY_FAILURE", "receipt is invalid");
  return Object.freeze({
    requestId: nullableString(raw.requestId, "receipt.requestId"),
    resourceName: raw.resourceName,
    recoveredAlreadyApplied: raw.recoveredAlreadyApplied,
  });
}

function parseState(record: ObjectRecord): StateRecord {
  if (record.typeId !== STATE_TYPE) throw new CreativeSyncError("INTEGRITY_FAILURE", "state record type is invalid");
  const customer = requiredString(record, STATE.customerId);
  const raw = object(record.properties[STATE.payload], "state payload");
  const policyDigest = nullableString(raw.policyDigest, "state.policyDigest");
  if (!policyDigest) throw new CreativeSyncError("INTEGRITY_FAILURE", "state policyDigest is missing");
  const payload: StatePayload = {
    policyDigest,
    lastRunAt: nullableString(raw.lastRunAt, "state.lastRunAt"),
    lastMutationAt: nullableString(raw.lastMutationAt, "state.lastMutationAt"),
    inFlightRunId: nullableString(raw.inFlightRunId, "state.inFlightRunId"),
    lastAppliedAction: parseAction(raw.lastAppliedAction),
    lastRollbackAction: parseAction(raw.lastRollbackAction),
    lastSourceVersion: nullableString(raw.lastSourceVersion, "state.lastSourceVersion"),
    lastSourceDigest: nullableString(raw.lastSourceDigest, "state.lastSourceDigest"),
    lastRollbackAt: nullableString(raw.lastRollbackAt, "state.lastRollbackAt"),
  };
  for (const timestamp of [payload.lastRunAt, payload.lastMutationAt, payload.lastRollbackAt]) if (timestamp) canonicalUtc(timestamp, "state timestamp");
  const updatedAt = canonicalUtc(requiredString(record, STATE.updatedAt), "state.updatedAt");
  const digest = requiredString(record, STATE.digest);
  if (digest !== stateDigest(customer, payload, updatedAt)) throw new CreativeSyncError("INTEGRITY_FAILURE", "state digest mismatch");
  return Object.freeze({ id: record.id, customerId: customer, ...payload, digest, updatedAt, revision: record.revision });
}

function parseRun(record: ObjectRecord): RunRecord {
  if (record.typeId !== RUN_TYPE) throw new CreativeSyncError("INTEGRITY_FAILURE", "run record type is invalid");
  const runId = requiredString(record, RUN.runId);
  const customer = requiredString(record, RUN.customerId);
  const policyDigest = requiredString(record, RUN.policyDigest);
  const status = requiredString(record, RUN.status) as CreativeSyncRunStatus;
  if (!STATUSES.includes(status)) throw new CreativeSyncError("INTEGRITY_FAILURE", "run status is invalid");
  const raw = object(record.properties[RUN.payload], "run payload");
  const mode = raw.mode as CreativeSyncMode;
  const reason = raw.reason as CreativeSyncReason;
  if (!MODES.includes(mode) || !REASONS.includes(reason)) throw new CreativeSyncError("INTEGRITY_FAILURE", "run payload enum is invalid");
  const payload: RunPayload = {
    mode,
    reason,
    sourceId: nullableString(raw.sourceId, "run.sourceId"),
    sourceVersion: nullableString(raw.sourceVersion, "run.sourceVersion"),
    sourceDigest: nullableString(raw.sourceDigest, "run.sourceDigest"),
    sourceObservedAt: nullableString(raw.sourceObservedAt, "run.sourceObservedAt"),
    action: parseAction(raw.action),
    receipt: parseReceipt(raw.receipt),
    errorCode: nullableString(raw.errorCode, "run.errorCode"),
  };
  if (payload.sourceObservedAt) canonicalUtc(payload.sourceObservedAt, "run.sourceObservedAt");
  const createdAt = canonicalUtc(requiredString(record, RUN.createdAt), "run.createdAt");
  const updatedAt = canonicalUtc(requiredString(record, RUN.updatedAt), "run.updatedAt");
  const digest = requiredString(record, RUN.digest);
  if (digest !== runDigest(runId, customer, policyDigest, status, payload, createdAt, updatedAt)) throw new CreativeSyncError("INTEGRITY_FAILURE", "run digest mismatch");
  return Object.freeze({ id: record.id, runId, customerId: customer, policyDigest, status, ...payload, digest, createdAt, updatedAt, revision: record.revision });
}

function runPayload(run: RunRecord): RunPayload {
  return {
    mode: run.mode, reason: run.reason, sourceId: run.sourceId, sourceVersion: run.sourceVersion,
    sourceDigest: run.sourceDigest, sourceObservedAt: run.sourceObservedAt, action: run.action,
    receipt: run.receipt, errorCode: run.errorCode,
  };
}

function conflict(error: unknown): boolean {
  return error instanceof OntologyTransactionError && error.code === "CONFLICT";
}

function rollbackActionForApplied(action: CreativeSyncAction, receipt: CreativeMutationReceipt): CreativeSyncAction {
  if (action.kind === "CREATE_CUSTOMIZER_ATTRIBUTE") {
    return { kind: "REMOVE_CUSTOMIZER_ATTRIBUTE", resourceName: receipt.resourceName, name: action.name, type: action.type };
  }
  if (action.kind === "REMOVE_CUSTOMIZER_ATTRIBUTE") {
    return { kind: "CREATE_CUSTOMIZER_ATTRIBUTE", name: action.name, type: action.type };
  }
  if (action.kind === "UPDATE_RSA") {
    return { kind: "UPDATE_RSA", resourceName: action.resourceName, expected: action.desired, desired: action.expected };
  }
  if (action.kind === "UPSERT_CUSTOMIZER_VALUE") {
    const currentExpected: CustomizerValueSnapshot = {
      resourceName: receipt.resourceName,
      attributeResourceName: action.attributeResourceName,
      type: action.type,
      scopeKind: action.scopeKind,
      scopeResourceName: action.scopeResourceName,
      stringValue: action.desiredStringValue,
      status: "ENABLED",
    };
    if (!action.expected) {
      return { kind: "REMOVE_CUSTOMIZER_VALUE", scopeKind: action.scopeKind, scopeResourceName: action.scopeResourceName, attributeResourceName: action.attributeResourceName, expected: currentExpected };
    }
    return {
      kind: "UPSERT_CUSTOMIZER_VALUE", scopeKind: action.scopeKind, scopeResourceName: action.scopeResourceName,
      attributeResourceName: action.attributeResourceName, type: action.expected.type, expected: currentExpected,
      desiredStringValue: action.expected.stringValue,
    };
  }
  return {
    kind: "UPSERT_CUSTOMIZER_VALUE", scopeKind: action.scopeKind, scopeResourceName: action.scopeResourceName,
    attributeResourceName: action.attributeResourceName, type: action.expected.type, expected: null,
    desiredStringValue: action.expected.stringValue,
  };
}

export class NearRealTimeCreativeSynchronizer {
  readonly schema: ValidatedSchema;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    readonly policy: CreativeSyncPolicy,
    private readonly googleAds: GoogleAdsCreativeGateway,
    private readonly desiredState: CreativeDesiredStateProvider,
    private readonly now: () => number = Date.now,
  ) {
    this.schema = schema(scope);
  }

  private time() {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new CreativeSyncError("INTEGRITY_FAILURE", "engine clock is invalid");
    return Object.freeze({ ms, iso: new Date(ms).toISOString() });
  }

  private stateId(customer: string): string {
    return ontologyId("cortex-creative-sync-state-v2", { scope: this.scope, customer });
  }

  private runId(runId: string, customer: string): string {
    return ontologyId("cortex-creative-sync-run-v2", { scope: this.scope, runId, customer });
  }

  private readState(customer: string): StateRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.stateId(customer));
    return raw ? parseState(raw) : undefined;
  }

  private readRun(runId: string, customer: string): RunRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.runId(runId, customer));
    return raw ? parseRun(raw) : undefined;
  }

  private result(run: RunRecord): CreativeSyncResult {
    return Object.freeze({
      runId: run.runId, customerId: run.customerId, status: run.status, mode: run.mode, reason: run.reason,
      sourceId: run.sourceId, sourceVersion: run.sourceVersion, sourceDigest: run.sourceDigest,
      action: run.action, receipt: run.receipt, policyDigest: run.policyDigest, digest: run.digest,
    });
  }

  private async plan(customer: string, desired: CreativeDesiredState & { readonly digest: string }): Promise<{ readonly reason: CreativeSyncReason; readonly action: CreativeSyncAction | null }> {
    const currentAttributes = desired.customizerAttributes.length > 0 || desired.customizerValues.length > 0
      ? await this.googleAds.getCustomizerAttributes(customer)
      : [];
    const attributeMap = new Map(currentAttributes.map((attribute) => [attribute.name.toLocaleLowerCase("en-US"), attribute]));

    for (const wanted of desired.customizerAttributes) {
      const existing = attributeMap.get(wanted.name.toLocaleLowerCase("en-US"));
      if (!existing) {
        if (currentAttributes.length >= 40) return { reason: "ATTRIBUTE_LIMIT", action: null };
        return { reason: "ACTION_APPLIED", action: { kind: "CREATE_CUSTOMIZER_ATTRIBUTE", name: wanted.name, type: wanted.type } };
      }
      if (existing.type !== wanted.type) return { reason: "ATTRIBUTE_TYPE_CONFLICT", action: null };
    }

    for (const wanted of desired.customizerValues) {
      const attribute = attributeMap.get(wanted.attributeName.toLocaleLowerCase("en-US"));
      if (!attribute) throw new CreativeSyncError("INTEGRITY_FAILURE", `declared customizer attribute ${wanted.attributeName} was not resolved after dependency planning`);
      const current = await this.googleAds.getCustomizerValue(customer, {
        scopeKind: wanted.scopeKind,
        scopeResourceName: wanted.scopeResourceName,
        attributeResourceName: attribute.resourceName,
      });
      if (current && current.type === wanted.type && current.stringValue === wanted.stringValue) continue;
      return {
        reason: "ACTION_APPLIED",
        action: {
          kind: "UPSERT_CUSTOMIZER_VALUE",
          scopeKind: wanted.scopeKind,
          scopeResourceName: wanted.scopeResourceName,
          attributeResourceName: attribute.resourceName,
          type: wanted.type,
          expected: current,
          desiredStringValue: wanted.stringValue,
        },
      };
    }

    for (const wanted of desired.responsiveSearchAds) {
      const current = await this.googleAds.getResponsiveSearchAd(customer, wanted.resourceName);
      if (!current) return { reason: "RSA_NOT_FOUND", action: null };
      const currentContent = rsaContent(current);
      const desiredContent = rsaContent(wanted);
      if (same(currentContent, desiredContent)) continue;
      return { reason: "ACTION_APPLIED", action: { kind: "UPDATE_RSA", resourceName: wanted.resourceName, expected: currentContent, desired: desiredContent } };
    }

    return { reason: "IN_SYNC", action: null };
  }

  private acquire(runId: string, customer: string, planned: RunPayload, nowIso: string): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const existing = this.readRun(runId, customer);
      if (existing) return existing;
      const state = this.readState(customer);
      if (state?.inFlightRunId && state.inFlightRunId !== runId) {
        const inFlight = this.readRun(state.inFlightRunId, customer);
        if (!inFlight) throw new CreativeSyncError("INTEGRITY_FAILURE", "state references missing in-flight run");
        return inFlight;
      }
      const nextState: StatePayload = {
        policyDigest: this.policy.digest,
        lastRunAt: state?.lastRunAt ?? null,
        lastMutationAt: state?.lastMutationAt ?? null,
        inFlightRunId: runId,
        lastAppliedAction: state?.lastAppliedAction ?? null,
        lastRollbackAction: state?.lastRollbackAction ?? null,
        lastSourceVersion: state?.lastSourceVersion ?? null,
        lastSourceDigest: state?.lastSourceDigest ?? null,
        lastRollbackAt: state?.lastRollbackAt ?? null,
      };
      const operations: TransactionOperation[] = [
        {
          kind: "CREATE_OBJECT",
          record: { id: this.runId(runId, customer), typeId: RUN_TYPE, scope: this.scope, properties: runProperties(runId, customer, this.policy.digest, "PREPARED", planned, nowIso, nowIso) },
        },
        state
          ? { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(customer, nextState, nowIso) }
          : { kind: "CREATE_OBJECT", record: { id: this.stateId(customer), typeId: STATE_TYPE, scope: this.scope, properties: stateProperties(customer, nextState, nowIso) } },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const stored = this.readRun(runId, customer);
        if (!stored) throw new CreativeSyncError("PERSISTENCE_FAILURE", "prepared run unreadable after commit");
        return stored;
      } catch (error) {
        if (conflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (conflict(error)) throw new CreativeSyncError("CONFLICT", "run preparation conflicted after retries");
        if (error instanceof CreativeSyncError) throw error;
        throw new CreativeSyncError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run preparation failed");
      }
    }
    throw new CreativeSyncError("CONFLICT", "run preparation exhausted retries");
  }

  private finalize(run: RunRecord, status: Exclude<CreativeSyncRunStatus, "PREPARED">, payload: RunPayload, nowIso: string, effect: FinalizeEffect): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const current = this.readRun(run.runId, run.customerId);
      if (!current) throw new CreativeSyncError("INTEGRITY_FAILURE", "run disappeared before finalize");
      if (current.status !== "PREPARED") return current;
      const state = this.readState(run.customerId);
      if (!state || state.inFlightRunId !== run.runId) throw new CreativeSyncError("INTEGRITY_FAILURE", "run no longer owns state lock");
      const appliedRollbackAction = effect === "APPLY" && payload.action && payload.receipt
        ? rollbackActionForApplied(payload.action, payload.receipt)
        : null;
      if (effect === "APPLY" && (!payload.action || !payload.receipt)) {
        throw new CreativeSyncError("INTEGRITY_FAILURE", "applied run must carry a certified action and receipt");
      }
      const nextState: StatePayload = {
        policyDigest: state.policyDigest,
        lastRunAt: nowIso,
        lastMutationAt: effect === "NONE" ? state.lastMutationAt : nowIso,
        inFlightRunId: null,
        lastAppliedAction: effect === "APPLY" && payload.action ? payload.action : effect === "ROLLBACK" ? null : state.lastAppliedAction,
        lastRollbackAction: effect === "APPLY" ? appliedRollbackAction : effect === "ROLLBACK" ? null : state.lastRollbackAction,
        lastSourceVersion: payload.sourceVersion ?? state.lastSourceVersion,
        lastSourceDigest: payload.sourceDigest ?? state.lastSourceDigest,
        lastRollbackAt: effect === "ROLLBACK" ? nowIso : state.lastRollbackAt,
      };
      try {
        this.transactions.transact(this.scope, this.schema, [
          {
            kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision,
            properties: runProperties(current.runId, current.customerId, current.policyDigest, status, payload, current.createdAt, nowIso),
          },
          { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(state.customerId, nextState, nowIso) },
        ]);
        const stored = this.readRun(run.runId, run.customerId);
        if (!stored) throw new CreativeSyncError("PERSISTENCE_FAILURE", "finalized run unreadable after commit");
        return stored;
      } catch (error) {
        if (conflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (conflict(error)) throw new CreativeSyncError("CONFLICT", "run finalize conflicted after retries");
        if (error instanceof CreativeSyncError) throw error;
        throw new CreativeSyncError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run finalize failed");
      }
    }
    throw new CreativeSyncError("CONFLICT", "run finalize exhausted retries");
  }

  private async execute(run: RunRecord, executionMode: CreativeSyncMode): Promise<CreativeSyncResult> {
    if (run.status !== "PREPARED") return this.result(run);
    if (!run.action || run.mode !== "ACTIVE") return this.result(this.finalize(run, "NOOP", runPayload(run), this.time().iso, "NONE"));
    if (executionMode !== "ACTIVE") throw new CreativeSyncError("POLICY_VIOLATION", `${executionMode} freezes the prepared mutation; ACTIVE recovery is required before a remote write`);
    const rollback = run.reason === "ROLLBACK_APPLIED";
    let receipt: CreativeMutationReceipt;
    try {
      receipt = await this.googleAds.applyMutation(run.customerId, run.action);
    } catch (error) {
      if (error instanceof GoogleAdsApiError && error.code === "AMBIGUOUS_MUTATION_OUTCOME") {
        throw new CreativeSyncError("REMOTE_FAILURE", "Google Ads mutation outcome is ambiguous; run remains PREPARED for deterministic preflight recovery");
      }
      const reason: CreativeSyncReason = error instanceof GoogleAdsApiError && error.code === "REMOTE_CONFLICT" ? "REMOTE_CONFLICT" : "API_FAILURE";
      const next: RunPayload = { ...runPayload(run), reason, receipt: null, errorCode: error instanceof GoogleAdsApiError ? error.code : "UNKNOWN_REMOTE_FAILURE" };
      this.finalize(run, "FAILED", next, this.time().iso, "NONE");
      throw new CreativeSyncError("REMOTE_FAILURE", `${reason}: Google Ads mutation was not certified as applied`);
    }
    const reason: CreativeSyncReason = rollback ? "ROLLBACK_APPLIED" : receipt.recoveredAlreadyApplied ? "ACTION_RECOVERED" : "ACTION_APPLIED";
    const next: RunPayload = { ...runPayload(run), reason, receipt, errorCode: null };
    return this.result(this.finalize(run, rollback ? "ROLLED_BACK" : "APPLIED", next, this.time().iso, rollback ? "ROLLBACK" : "APPLY"));
  }

  async synchronize(input: CreativeSyncRunInput): Promise<CreativeSyncResult> {
    const runId = identifier(input.runId, "runId");
    const customer = customerId(input.customerId);
    const mode = effectiveMode(this.policy.mode, input.mode);
    const existing = this.readRun(runId, customer);
    if (existing) return this.execute(existing, mode);
    const state = this.readState(customer);
    if (state?.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, customer);
      if (!inFlight) throw new CreativeSyncError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.execute(inFlight, mode);
    }
    const now = this.time();
    if (mode === "KILLED") {
      const payload: RunPayload = {
        mode, reason: "KILL_SWITCH", sourceId: null, sourceVersion: null, sourceDigest: null,
        sourceObservedAt: null, action: null, receipt: null, errorCode: null,
      };
      return this.execute(this.acquire(runId, customer, payload, now.iso), mode);
    }

    const desired = normalizeDesiredState(await this.desiredState.getDesiredState(customer), customer, this.policy);
    const age = now.ms - Date.parse(desired.observedAt);
    if (age < 0) throw new CreativeSyncError("INVALID_INPUT", "desired state cannot be observed in the future");
    let reason: CreativeSyncReason;
    let action: CreativeSyncAction | null;
    if (age > this.policy.maxSourceAgeMs) {
      reason = "SOURCE_STALE";
      action = null;
    } else {
      const planned = await this.plan(customer, desired);
      reason = planned.action && mode === "OBSERVE_ONLY" ? "OBSERVE_ONLY" : planned.reason;
      action = planned.action;
    }
    const payload: RunPayload = {
      mode, reason, sourceId: desired.sourceId, sourceVersion: desired.sourceVersion, sourceDigest: desired.digest,
      sourceObservedAt: desired.observedAt, action, receipt: null, errorCode: null,
    };
    return this.execute(this.acquire(runId, customer, payload, now.iso), mode);
  }

  async rollbackLastMutation(input: CreativeSyncRollbackInput): Promise<CreativeSyncResult> {
    const runId = identifier(input.runId, "runId");
    const customer = customerId(input.customerId);
    const existing = this.readRun(runId, customer);
    if (existing) return this.execute(existing, "ACTIVE");
    const state = this.readState(customer);
    if (!state?.lastAppliedAction || !state.lastRollbackAction) throw new CreativeSyncError("POLICY_VIOLATION", "no certified creative action is available for rollback");
    if (state.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, customer);
      if (!inFlight) throw new CreativeSyncError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.execute(inFlight, "ACTIVE");
    }
    const now = this.time();
    const payload: RunPayload = {
      mode: "ACTIVE", reason: "ROLLBACK_APPLIED", sourceId: null, sourceVersion: null, sourceDigest: null,
      sourceObservedAt: null, action: state.lastRollbackAction, receipt: null, errorCode: null,
    };
    return this.execute(this.acquire(runId, customer, payload, now.iso), "ACTIVE");
  }
}
