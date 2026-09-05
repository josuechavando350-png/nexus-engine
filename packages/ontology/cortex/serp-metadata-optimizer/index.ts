import { createHash } from "node:crypto";
import { canonicalJson, ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";

const STATE_TYPE = "cortex.serp_metadata_state";
const RUN_TYPE = "cortex.serp_metadata_run";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VISIBLE_TEXT = 200_000;
const MAX_SUMMARIES = 24;

const STATE = Object.freeze({
  siteUrl: "cortex.serp.state.site_url",
  pageId: "cortex.serp.state.page_id",
  payload: "cortex.serp.state.payload",
  digest: "cortex.serp.state.digest",
  updatedAt: "cortex.serp.state.updated_at",
});
const RUN = Object.freeze({
  runId: "cortex.serp.run.run_id",
  siteUrl: "cortex.serp.run.site_url",
  pageId: "cortex.serp.run.page_id",
  policyDigest: "cortex.serp.run.policy_digest",
  status: "cortex.serp.run.status",
  payload: "cortex.serp.run.payload",
  digest: "cortex.serp.run.digest",
  createdAt: "cortex.serp.run.created_at",
  updatedAt: "cortex.serp.run.updated_at",
});

export type SerpMetadataMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type SerpMetadataRunStatus = "PREPARED" | "APPLIED" | "NOOP" | "FAILED" | "ROLLED_BACK";
export type SerpMetadataReason =
  | "KILL_SWITCH"
  | "COOLDOWN"
  | "SOURCE_STALE"
  | "PAGE_NOT_FOUND"
  | "PAGE_NOT_INDEXABLE"
  | "NON_CANONICAL_PAGE"
  | "INSUFFICIENT_DATA"
  | "NO_CTR_OPPORTUNITY"
  | "IN_SYNC"
  | "OBSERVE_ONLY"
  | "ACTION_APPLIED"
  | "ACTION_RECOVERED"
  | "PUBLISH_CONFLICT"
  | "PUBLISH_FAILURE"
  | "ROLLBACK_APPLIED";

const MODES: readonly SerpMetadataMode[] = ["ACTIVE", "OBSERVE_ONLY", "KILLED"];
const STATUSES: readonly SerpMetadataRunStatus[] = ["PREPARED", "APPLIED", "NOOP", "FAILED", "ROLLED_BACK"];
const REASONS: readonly SerpMetadataReason[] = [
  "KILL_SWITCH", "COOLDOWN", "SOURCE_STALE", "PAGE_NOT_FOUND", "PAGE_NOT_INDEXABLE", "NON_CANONICAL_PAGE",
  "INSUFFICIENT_DATA", "NO_CTR_OPPORTUNITY", "IN_SYNC", "OBSERVE_ONLY", "ACTION_APPLIED", "ACTION_RECOVERED",
  "PUBLISH_CONFLICT", "PUBLISH_FAILURE", "ROLLBACK_APPLIED",
];

export interface SeoMetadataValue {
  readonly title: string;
  readonly metaDescription: string | null;
}

export interface SeoPageSnapshot {
  readonly pageId: string;
  readonly url: string;
  readonly locale: string;
  readonly siteName: string;
  readonly indexable: boolean;
  readonly canonicalUrl: string | null;
  readonly currentMetadata: SeoMetadataValue;
  readonly primaryHeading: string;
  readonly visibleText: string;
  readonly summaryCandidates: readonly string[];
}

export interface PageInventorySnapshot {
  readonly sourceId: string;
  readonly siteUrl: string;
  readonly observedAt: string;
  readonly pages: readonly SeoPageSnapshot[];
  readonly digest: string;
}

export interface PageInventoryProvider {
  getInventory(siteUrl: string): Promise<PageInventorySnapshot>;
}

export interface SearchPerformanceRow {
  readonly pageUrl: string;
  readonly query: string | null;
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  readonly position: number;
}

export interface SearchPerformanceSnapshot {
  readonly sourceId: string;
  readonly siteUrl: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly dataState: "FINAL";
  readonly coverage: "TOP_ROWS_BOUNDED";
  readonly truncated: boolean;
  readonly observedAt: string;
  readonly pageRows: readonly SearchPerformanceRow[];
  readonly targetQueryRows: readonly SearchPerformanceRow[];
  readonly digest: string;
}

export interface SearchPerformanceProvider {
  getPerformance(input: Readonly<{ siteUrl: string; pageUrl: string; startDate: string; endDate: string; maxRows: number }>): Promise<SearchPerformanceSnapshot>;
}

export interface PublishedMetadataSnapshot {
  readonly pageId: string;
  readonly pageUrl: string;
  readonly metadata: SeoMetadataValue;
  readonly revision: number;
  readonly digest: string;
}

export type MetadataPublishAction =
  | {
      readonly kind: "UPSERT_METADATA_OVERRIDE";
      readonly siteUrl: string;
      readonly pageId: string;
      readonly pageUrl: string;
      readonly expected: PublishedMetadataSnapshot | null;
      readonly desired: SeoMetadataValue;
    }
  | {
      readonly kind: "REMOVE_METADATA_OVERRIDE";
      readonly siteUrl: string;
      readonly pageId: string;
      readonly pageUrl: string;
      readonly expected: PublishedMetadataSnapshot;
    };

export interface MetadataPublishReceipt {
  readonly snapshot: PublishedMetadataSnapshot | null;
  readonly recoveredAlreadyApplied: boolean;
  readonly publisherVersion: string;
}

export interface MetadataPublisher {
  read(siteUrl: string, pageId: string, pageUrl: string): Promise<PublishedMetadataSnapshot | null>;
  apply(action: MetadataPublishAction): Promise<MetadataPublishReceipt>;
}

export class MetadataPublisherError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "PUBLISH_CONFLICT" | "PUBLISH_FAILURE" | "AMBIGUOUS_PUBLISH_OUTCOME",
    message: string,
  ) {
    super(message);
    this.name = "MetadataPublisherError";
  }
}

export interface CreateSerpMetadataPolicyInput {
  readonly policyId: string;
  readonly version: string;
  readonly maxInventoryAgeMs: number;
  readonly maxPerformanceAgeMs: number;
  readonly cooldownMs: number;
  readonly maxWindowDays: number;
  readonly minImpressions: number;
  readonly minExpectedClicksGain: number;
  readonly minPeerPages: number;
  readonly peerPositionTolerance: number;
  readonly minDescriptionQueryCoverageDelta: number;
  readonly maxGeneratedTitleCharacters: number;
  readonly maxGeneratedDescriptionCharacters: number;
  readonly maxInventoryPages: number;
  readonly maxSearchRows: number;
  readonly maxWriteRetries?: number;
  readonly mode?: SerpMetadataMode;
}

export interface SerpMetadataPolicy extends Omit<Required<CreateSerpMetadataPolicyInput>, "mode" | "maxWriteRetries"> {
  readonly maxWriteRetries: number;
  readonly mode: SerpMetadataMode;
  readonly digest: string;
}

export interface SerpOpportunityEvidence {
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
  readonly averagePosition: number;
  readonly peerCtr: number;
  readonly peerPages: number;
  readonly expectedClicksGain: number;
  readonly queryRowsConsidered: number;
  readonly selectedDescriptionCoverage: number;
  readonly queryEvidenceDigest: string;
  readonly sourceCoverage: "TOP_ROWS_BOUNDED";
  readonly sourceTruncated: boolean;
  readonly nonClaim: "OBSERVATIONAL_CTR_OPPORTUNITY_NOT_CAUSAL_RANKING_OR_SERP_GUARANTEE";
}

export interface SerpMetadataRunInput {
  readonly runId: string;
  readonly siteUrl: string;
  readonly pageId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly mode?: SerpMetadataMode;
}

export interface SerpMetadataRollbackInput {
  readonly runId: string;
  readonly siteUrl: string;
  readonly pageId: string;
}

export interface SerpMetadataResult {
  readonly runId: string;
  readonly siteUrl: string;
  readonly pageId: string;
  readonly status: SerpMetadataRunStatus;
  readonly mode: SerpMetadataMode;
  readonly reason: SerpMetadataReason;
  readonly inventoryDigest: string | null;
  readonly performanceDigest: string | null;
  readonly evidence: SerpOpportunityEvidence | null;
  readonly action: MetadataPublishAction | null;
  readonly receipt: MetadataPublishReceipt | null;
  readonly policyDigest: string;
  readonly digest: string;
}

export interface SerpMetadataTelemetryEvent {
  readonly runId: string;
  readonly siteUrl: string;
  readonly pageId: string;
  readonly status: SerpMetadataRunStatus;
  readonly reason: SerpMetadataReason;
  readonly mode: SerpMetadataMode;
  readonly effect: "NONE" | "APPLY" | "ROLLBACK";
}

interface StatePayload {
  readonly policyDigest: string;
  readonly lastRunAt: string | null;
  readonly lastMutationAt: string | null;
  readonly inFlightRunId: string | null;
  readonly lastInverseAction: MetadataPublishAction | null;
  readonly lastRollbackAt: string | null;
}

interface StateRecord extends StatePayload {
  readonly id: string;
  readonly siteUrl: string;
  readonly pageId: string;
  readonly digest: string;
  readonly updatedAt: string;
  readonly revision: number;
}

interface RunPayload {
  readonly mode: SerpMetadataMode;
  readonly reason: SerpMetadataReason;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly inventoryDigest: string | null;
  readonly performanceDigest: string | null;
  readonly evidence: SerpOpportunityEvidence | null;
  readonly action: MetadataPublishAction | null;
  readonly receipt: MetadataPublishReceipt | null;
  readonly errorCode: string | null;
}

interface RunRecord extends RunPayload {
  readonly id: string;
  readonly runId: string;
  readonly siteUrl: string;
  readonly pageId: string;
  readonly policyDigest: string;
  readonly status: SerpMetadataRunStatus;
  readonly digest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

type FinalizeEffect = "NONE" | "APPLY" | "ROLLBACK";

export class SerpMetadataOptimizerError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "POLICY_VIOLATION" | "CONFLICT" | "INTEGRITY_FAILURE" | "PERSISTENCE_FAILURE" | "REMOTE_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "SerpMetadataOptimizerError";
  }
}

function hash(namespace: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`;
}

function id(value: string, field: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function clean(value: string, field: string, max: number): string {
  if (typeof value !== "string") throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || [...normalized].length > max) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must contain 1..${max} characters`);
  return normalized;
}

function cleanNullable(value: string | null, field: string, max: number): string | null {
  return value === null ? null : clean(value, field, max);
}

function utc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be canonical UTC`);
  return value;
}

function date(value: string, field: string): string {
  if (!DATE.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be YYYY-MM-DD`);
  return value;
}

function dateSpanDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (end < start) throw new SerpMetadataOptimizerError("INVALID_INPUT", "endDate must not precede startDate");
  return Math.floor((end - start) / 86_400_000) + 1;
}

function normalizedUrl(value: string, field: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be an absolute URL`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must use HTTP(S)`);
  if (parsed.username || parsed.password) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must not contain credentials`);
  parsed.hash = "";
  return parsed.toString();
}

function siteProperty(value: string): string {
  const normalized = value.trim();
  if (/^sc-domain:[A-Za-z0-9.-]+$/u.test(normalized)) return normalized.toLocaleLowerCase("en-US");
  return normalizedUrl(normalized, "siteUrl");
}

function belongsToProperty(siteUrl: string, pageUrl: string): boolean {
  const page = new URL(pageUrl);
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLocaleLowerCase("en-US");
    const host = page.hostname.toLocaleLowerCase("en-US");
    return host === domain || host.endsWith(`.${domain}`);
  }
  const prefix = new URL(siteUrl);
  return prefix.origin === page.origin && page.toString().startsWith(prefix.toString());
}

function positiveInt(value: number, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be a positive safe integer <= ${max}`);
  return value;
}

function positiveNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be finite and positive`);
  return value;
}

function ratio(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be between 0 and 1`);
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
  if (!isJson(value)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `${field} is not finite JSON`);
  return value;
}

function object(value: JsonValue | undefined, field: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `${field} must be an object`);
  return value as Record<string, JsonValue>;
}

function nullableString(value: JsonValue | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `${field} must be string or null`);
  return value;
}

function requiredString(record: ObjectRecord, key: string): string {
  const value = record.properties[key];
  if (typeof value !== "string" || !value) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`);
  return value;
}

function property(idValue: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME", immutable = false) {
  return { id: idValue, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const;
}

function schema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = {
    version: "cortex-serp-metadata-v1",
    scope,
    properties: [
      property(STATE.siteUrl, "SerpStateSiteUrl", "STRING", true),
      property(STATE.pageId, "SerpStatePageId", "STRING", true),
      property(STATE.payload, "SerpStatePayload", "JSON"),
      property(STATE.digest, "SerpStateDigest", "STRING"),
      property(STATE.updatedAt, "SerpStateUpdatedAt", "DATETIME"),
      property(RUN.runId, "SerpRunId", "STRING", true),
      property(RUN.siteUrl, "SerpRunSiteUrl", "STRING", true),
      property(RUN.pageId, "SerpRunPageId", "STRING", true),
      property(RUN.policyDigest, "SerpRunPolicyDigest", "STRING", true),
      property(RUN.status, "SerpRunStatus", "STRING"),
      property(RUN.payload, "SerpRunPayload", "JSON"),
      property(RUN.digest, "SerpRunDigest", "STRING"),
      property(RUN.createdAt, "SerpRunCreatedAt", "DATETIME", true),
      property(RUN.updatedAt, "SerpRunUpdatedAt", "DATETIME"),
    ],
    interfaces: [],
    objects: [
      { id: STATE_TYPE, name: "CortexSerpMetadataState", propertyIds: Object.values(STATE), interfaceIds: [] },
      { id: RUN_TYPE, name: "CortexSerpMetadataRun", propertyIds: Object.values(RUN), interfaceIds: [] },
    ],
    relationships: [], actions: [], functions: [], events: [],
  };
  return validateSchema(value);
}

export function createSerpMetadataPolicy(input: CreateSerpMetadataPolicyInput): SerpMetadataPolicy {
  const policyId = id(input.policyId, "policyId");
  const version = id(input.version, "version");
  const maxInventoryAgeMs = positiveInt(input.maxInventoryAgeMs, "maxInventoryAgeMs", 30 * 24 * 60 * 60 * 1000);
  const maxPerformanceAgeMs = positiveInt(input.maxPerformanceAgeMs, "maxPerformanceAgeMs", 30 * 24 * 60 * 60 * 1000);
  const cooldownMs = positiveInt(input.cooldownMs, "cooldownMs", 90 * 24 * 60 * 60 * 1000);
  const maxWindowDays = positiveInt(input.maxWindowDays, "maxWindowDays", 180);
  const minImpressions = positiveInt(input.minImpressions, "minImpressions");
  const minExpectedClicksGain = positiveNumber(input.minExpectedClicksGain, "minExpectedClicksGain");
  const minPeerPages = positiveInt(input.minPeerPages, "minPeerPages", 500);
  const peerPositionTolerance = positiveNumber(input.peerPositionTolerance, "peerPositionTolerance");
  if (peerPositionTolerance > 10) throw new SerpMetadataOptimizerError("INVALID_INPUT", "peerPositionTolerance must be <= 10");
  const minDescriptionQueryCoverageDelta = ratio(input.minDescriptionQueryCoverageDelta, "minDescriptionQueryCoverageDelta");
  const maxGeneratedTitleCharacters = positiveInt(input.maxGeneratedTitleCharacters, "maxGeneratedTitleCharacters", 300);
  const maxGeneratedDescriptionCharacters = positiveInt(input.maxGeneratedDescriptionCharacters, "maxGeneratedDescriptionCharacters", 2_000);
  const maxInventoryPages = positiveInt(input.maxInventoryPages, "maxInventoryPages", 20_000);
  const maxSearchRows = positiveInt(input.maxSearchRows, "maxSearchRows", 250_000);
  const maxWriteRetries = input.maxWriteRetries ?? 3;
  if (!Number.isInteger(maxWriteRetries) || maxWriteRetries < 0 || maxWriteRetries > 10) throw new SerpMetadataOptimizerError("INVALID_INPUT", "maxWriteRetries must be 0..10");
  const mode = input.mode ?? "ACTIVE";
  if (!MODES.includes(mode)) throw new SerpMetadataOptimizerError("INVALID_INPUT", "mode is invalid");
  const core = {
    policyId, version, maxInventoryAgeMs, maxPerformanceAgeMs, cooldownMs, maxWindowDays, minImpressions, minExpectedClicksGain,
    minPeerPages, peerPositionTolerance, minDescriptionQueryCoverageDelta, maxGeneratedTitleCharacters,
    maxGeneratedDescriptionCharacters, maxInventoryPages, maxSearchRows, maxWriteRetries, mode,
  };
  return Object.freeze({ ...core, digest: hash("cortex-serp-metadata-policy-v1", core) });
}

function normalizeMetadata(value: SeoMetadataValue, field: string): SeoMetadataValue {
  return Object.freeze({
    title: clean(value.title, `${field}.title`, 2_000),
    metaDescription: cleanNullable(value.metaDescription, `${field}.metaDescription`, 4_000),
  });
}

function normalizedText(value: string): string { return value.normalize("NFKC").replace(/\s+/gu, " ").trim(); }
function folded(value: string): string { return normalizedText(value).toLocaleLowerCase("en-US"); }
function tokens(value: string): readonly string[] {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US");
  return Object.freeze((normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => [...token].length >= 3));
}
function containsVisible(visibleText: string, candidate: string): boolean { return folded(visibleText).includes(folded(candidate)); }

function normalizePage(value: SeoPageSnapshot, siteUrl: string): SeoPageSnapshot {
  const pageId = id(value.pageId, "pageId");
  const url = normalizedUrl(value.url, `page ${pageId}.url`);
  if (!belongsToProperty(siteUrl, url)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `page ${pageId} is outside Search Console property`);
  const locale = clean(value.locale, `page ${pageId}.locale`, 64);
  const siteName = clean(value.siteName, `page ${pageId}.siteName`, 200);
  const canonicalUrl = value.canonicalUrl === null ? null : normalizedUrl(value.canonicalUrl, `page ${pageId}.canonicalUrl`);
  const currentMetadata = normalizeMetadata(value.currentMetadata, `page ${pageId}.currentMetadata`);
  const primaryHeading = clean(value.primaryHeading, `page ${pageId}.primaryHeading`, 1_000);
  const visibleText = clean(value.visibleText, `page ${pageId}.visibleText`, MAX_VISIBLE_TEXT);
  if (!containsVisible(visibleText, primaryHeading)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `page ${pageId} primaryHeading must be visible content`);
  if (value.summaryCandidates.length > MAX_SUMMARIES) throw new SerpMetadataOptimizerError("INVALID_INPUT", `page ${pageId} has too many summary candidates`);
  const summaryCandidates = Object.freeze(value.summaryCandidates.map((summary, index) => {
    const normalized = clean(summary, `page ${pageId}.summaryCandidates[${index}]`, 2_000);
    if (!containsVisible(visibleText, normalized)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `page ${pageId} summary candidate is not visible content`);
    return normalized;
  }));
  if (new Set(summaryCandidates.map(folded)).size !== summaryCandidates.length) throw new SerpMetadataOptimizerError("INVALID_INPUT", `page ${pageId} summary candidates must be unique`);
  return Object.freeze({ pageId, url, locale, siteName, indexable: Boolean(value.indexable), canonicalUrl, currentMetadata, primaryHeading, visibleText, summaryCandidates });
}

export function createPageInventorySnapshot(input: Omit<PageInventorySnapshot, "digest">): PageInventorySnapshot {
  const sourceId = id(input.sourceId, "inventory.sourceId");
  const siteUrl = siteProperty(input.siteUrl);
  const observedAt = utc(input.observedAt, "inventory.observedAt");
  if (input.pages.length > 20_000) throw new SerpMetadataOptimizerError("INVALID_INPUT", "inventory exceeds hard page limit");
  const pages = Object.freeze(input.pages.map((page) => normalizePage(page, siteUrl)).sort((a, b) => a.pageId.localeCompare(b.pageId, "en")));
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length) throw new SerpMetadataOptimizerError("INVALID_INPUT", "inventory pageIds must be unique");
  if (new Set(pages.map((page) => page.url)).size !== pages.length) throw new SerpMetadataOptimizerError("INVALID_INPUT", "inventory URLs must be unique");
  const core = { sourceId, siteUrl, observedAt, pages };
  return Object.freeze({ ...core, digest: hash("cortex-serp-page-inventory-v1", core) });
}

export function validatePageInventorySnapshot(snapshot: PageInventorySnapshot): void {
  const rebuilt = createPageInventorySnapshot({ sourceId: snapshot.sourceId, siteUrl: snapshot.siteUrl, observedAt: snapshot.observedAt, pages: snapshot.pages });
  if (rebuilt.digest !== snapshot.digest || canonicalJson(rebuilt) !== canonicalJson(snapshot)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "page inventory replay mismatch");
}

function performanceRow(value: SearchPerformanceRow, siteUrl: string, expectQuery: boolean): SearchPerformanceRow {
  const pageUrl = normalizedUrl(value.pageUrl, "performance.pageUrl");
  if (!belongsToProperty(siteUrl, pageUrl)) throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance row is outside Search Console property");
  const query = expectQuery ? clean(value.query ?? "", "performance.query", 4_096) : null;
  if (!Number.isFinite(value.clicks) || value.clicks < 0) throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance clicks must be non-negative");
  if (!Number.isFinite(value.impressions) || value.impressions < 0) throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance impressions must be non-negative");
  if (!Number.isFinite(value.ctr) || value.ctr < 0 || value.ctr > 1) throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance ctr must be 0..1");
  if (!Number.isFinite(value.position) || value.position <= 0) throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance position must be positive");
  return Object.freeze({ pageUrl, query, clicks: value.clicks, impressions: value.impressions, ctr: value.ctr, position: value.position });
}

export function createSearchPerformanceSnapshot(input: Omit<SearchPerformanceSnapshot, "digest">): SearchPerformanceSnapshot {
  const sourceId = id(input.sourceId, "performance.sourceId");
  const siteUrl = siteProperty(input.siteUrl);
  const startDate = date(input.startDate, "performance.startDate");
  const endDate = date(input.endDate, "performance.endDate");
  dateSpanDays(startDate, endDate);
  if (input.dataState !== "FINAL" || input.coverage !== "TOP_ROWS_BOUNDED") throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance snapshot must be finalized bounded Search Console data");
  const observedAt = utc(input.observedAt, "performance.observedAt");
  const pageRows = Object.freeze(input.pageRows.map((row) => performanceRow(row, siteUrl, false)).sort((a, b) => a.pageUrl.localeCompare(b.pageUrl, "en")));
  const targetQueryRows = Object.freeze(input.targetQueryRows.map((row) => performanceRow(row, siteUrl, true)).sort((a, b) => (b.impressions - a.impressions) || (a.query ?? "").localeCompare(b.query ?? "", "en")));
  if (new Set(pageRows.map((row) => row.pageUrl)).size !== pageRows.length) throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance page rows must be unique by URL");
  const queryKeys = targetQueryRows.map((row) => `${row.pageUrl}\u0000${row.query}`);
  if (new Set(queryKeys).size !== queryKeys.length) throw new SerpMetadataOptimizerError("INVALID_INPUT", "performance query rows must be unique by page/query");
  const core = { sourceId, siteUrl, startDate, endDate, dataState: "FINAL" as const, coverage: "TOP_ROWS_BOUNDED" as const, truncated: Boolean(input.truncated), observedAt, pageRows, targetQueryRows };
  return Object.freeze({ ...core, digest: hash("cortex-serp-search-performance-v1", core) });
}

export function validateSearchPerformanceSnapshot(snapshot: SearchPerformanceSnapshot): void {
  const rebuilt = createSearchPerformanceSnapshot({
    sourceId: snapshot.sourceId, siteUrl: snapshot.siteUrl, startDate: snapshot.startDate, endDate: snapshot.endDate,
    dataState: snapshot.dataState, coverage: snapshot.coverage, truncated: snapshot.truncated, observedAt: snapshot.observedAt,
    pageRows: snapshot.pageRows, targetQueryRows: snapshot.targetQueryRows,
  });
  if (rebuilt.digest !== snapshot.digest || canonicalJson(rebuilt) !== canonicalJson(snapshot)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "Search Console snapshot replay mismatch");
}

function effectiveMode(policy: SerpMetadataMode, requested: SerpMetadataMode | undefined): SerpMetadataMode {
  const rank: Record<SerpMetadataMode, number> = { ACTIVE: 0, OBSERVE_ONLY: 1, KILLED: 2 };
  const candidate = requested ?? "ACTIVE";
  if (!MODES.includes(candidate)) throw new SerpMetadataOptimizerError("INVALID_INPUT", "requested mode is invalid");
  return rank[candidate] > rank[policy] ? candidate : policy;
}

function metadataDigest(pageId: string, pageUrl: string, metadata: SeoMetadataValue, revision: number): string {
  return hash("cortex-serp-published-metadata-v1", { pageId, pageUrl, metadata, revision });
}

export function createPublishedMetadataSnapshot(input: Omit<PublishedMetadataSnapshot, "digest">): PublishedMetadataSnapshot {
  const pageId = id(input.pageId, "published.pageId");
  const pageUrl = normalizedUrl(input.pageUrl, "published.pageUrl");
  const metadata = normalizeMetadata(input.metadata, "published.metadata");
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) throw new SerpMetadataOptimizerError("INVALID_INPUT", "published revision must be positive");
  return Object.freeze({ pageId, pageUrl, metadata, revision: input.revision, digest: metadataDigest(pageId, pageUrl, metadata, input.revision) });
}

export function validatePublishedMetadataSnapshot(snapshot: PublishedMetadataSnapshot): void {
  const rebuilt = createPublishedMetadataSnapshot({ pageId: snapshot.pageId, pageUrl: snapshot.pageUrl, metadata: snapshot.metadata, revision: snapshot.revision });
  if (rebuilt.digest !== snapshot.digest || canonicalJson(rebuilt) !== canonicalJson(snapshot)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "published metadata replay mismatch");
}

function stateDigest(siteUrl: string, pageId: string, payload: StatePayload, updatedAt: string): string {
  return hash("cortex-serp-state-v1", { siteUrl, pageId, payload, updatedAt });
}
function runDigest(runId: string, siteUrl: string, pageId: string, policyDigest: string, status: SerpMetadataRunStatus, payload: RunPayload, createdAt: string, updatedAt: string): string {
  return hash("cortex-serp-run-v1", { runId, siteUrl, pageId, policyDigest, status, payload, createdAt, updatedAt });
}
function stateProperties(siteUrl: string, pageId: string, payload: StatePayload, updatedAt: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({ [STATE.siteUrl]: siteUrl, [STATE.pageId]: pageId, [STATE.payload]: json(payload, "state payload"), [STATE.digest]: stateDigest(siteUrl, pageId, payload, updatedAt), [STATE.updatedAt]: updatedAt });
}
function runProperties(runId: string, siteUrl: string, pageId: string, policyDigest: string, status: SerpMetadataRunStatus, payload: RunPayload, createdAt: string, updatedAt: string): Readonly<Record<string, JsonValue>> {
  return Object.freeze({
    [RUN.runId]: runId, [RUN.siteUrl]: siteUrl, [RUN.pageId]: pageId, [RUN.policyDigest]: policyDigest, [RUN.status]: status,
    [RUN.payload]: json(payload, "run payload"), [RUN.digest]: runDigest(runId, siteUrl, pageId, policyDigest, status, payload, createdAt, updatedAt),
    [RUN.createdAt]: createdAt, [RUN.updatedAt]: updatedAt,
  });
}

function parseMetadata(value: JsonValue | undefined, field: string): SeoMetadataValue {
  const raw = object(value, field);
  if (typeof raw.title !== "string" || (raw.metaDescription !== null && typeof raw.metaDescription !== "string")) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `${field} is invalid`);
  return Object.freeze({ title: raw.title, metaDescription: raw.metaDescription as string | null });
}

function parsePublished(value: JsonValue | undefined, field: string): PublishedMetadataSnapshot | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, field);
  if (typeof raw.pageId !== "string" || typeof raw.pageUrl !== "string" || typeof raw.revision !== "number" || typeof raw.digest !== "string") throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `${field} is invalid`);
  const snapshot: PublishedMetadataSnapshot = Object.freeze({ pageId: raw.pageId, pageUrl: raw.pageUrl, metadata: parseMetadata(raw.metadata, `${field}.metadata`), revision: raw.revision, digest: raw.digest });
  validatePublishedMetadataSnapshot(snapshot);
  return snapshot;
}

function parseAction(value: JsonValue | undefined): MetadataPublishAction | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "action");
  if (raw.kind !== "UPSERT_METADATA_OVERRIDE" && raw.kind !== "REMOVE_METADATA_OVERRIDE") throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "action.kind is invalid");
  if (typeof raw.siteUrl !== "string" || typeof raw.pageId !== "string" || typeof raw.pageUrl !== "string") throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "action identity is invalid");
  const expected = parsePublished(raw.expected, "action.expected");
  if (raw.kind === "REMOVE_METADATA_OVERRIDE") {
    if (!expected) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "remove action requires expected snapshot");
    return Object.freeze({ kind: raw.kind, siteUrl: raw.siteUrl, pageId: raw.pageId, pageUrl: raw.pageUrl, expected });
  }
  return Object.freeze({ kind: raw.kind, siteUrl: raw.siteUrl, pageId: raw.pageId, pageUrl: raw.pageUrl, expected, desired: parseMetadata(raw.desired, "action.desired") });
}

function parseReceipt(value: JsonValue | undefined): MetadataPublishReceipt | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "receipt");
  if (typeof raw.recoveredAlreadyApplied !== "boolean" || typeof raw.publisherVersion !== "string" || !raw.publisherVersion) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "receipt is invalid");
  return Object.freeze({ snapshot: parsePublished(raw.snapshot, "receipt.snapshot"), recoveredAlreadyApplied: raw.recoveredAlreadyApplied, publisherVersion: raw.publisherVersion });
}

function parseEvidence(value: JsonValue | undefined): SerpOpportunityEvidence | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, "evidence");
  const numeric = ["impressions", "clicks", "ctr", "averagePosition", "peerCtr", "peerPages", "expectedClicksGain", "queryRowsConsidered", "selectedDescriptionCoverage"] as const;
  for (const key of numeric) if (typeof raw[key] !== "number" || !Number.isFinite(raw[key] as number)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `evidence.${key} is invalid`);
  if ((raw.impressions as number) < 0 || (raw.clicks as number) < 0 || (raw.ctr as number) < 0 || (raw.ctr as number) > 1 || (raw.averagePosition as number) <= 0 || (raw.peerCtr as number) < 0 || (raw.peerCtr as number) > 1 || (raw.peerPages as number) < 0 || (raw.expectedClicksGain as number) < 0 || (raw.queryRowsConsidered as number) < 0 || (raw.selectedDescriptionCoverage as number) < 0 || (raw.selectedDescriptionCoverage as number) > 1) {
    throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "evidence numeric range is invalid");
  }
  if (typeof raw.queryEvidenceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(raw.queryEvidenceDigest)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "evidence query digest is invalid");
  if (raw.sourceCoverage !== "TOP_ROWS_BOUNDED" || typeof raw.sourceTruncated !== "boolean" || raw.nonClaim !== "OBSERVATIONAL_CTR_OPPORTUNITY_NOT_CAUSAL_RANKING_OR_SERP_GUARANTEE") throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "evidence source identity is invalid");
  return Object.freeze(raw as unknown as SerpOpportunityEvidence);
}

function parseState(record: ObjectRecord): StateRecord {
  if (record.typeId !== STATE_TYPE) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "state type is invalid");
  const siteUrl = requiredString(record, STATE.siteUrl);
  const pageId = requiredString(record, STATE.pageId);
  const raw = object(record.properties[STATE.payload], "state payload");
  const policyDigest = nullableString(raw.policyDigest, "state.policyDigest");
  if (!policyDigest) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "state policy digest missing");
  const payload: StatePayload = {
    policyDigest,
    lastRunAt: nullableString(raw.lastRunAt, "state.lastRunAt"),
    lastMutationAt: nullableString(raw.lastMutationAt, "state.lastMutationAt"),
    inFlightRunId: nullableString(raw.inFlightRunId, "state.inFlightRunId"),
    lastInverseAction: parseAction(raw.lastInverseAction),
    lastRollbackAt: nullableString(raw.lastRollbackAt, "state.lastRollbackAt"),
  };
  for (const timestamp of [payload.lastRunAt, payload.lastMutationAt, payload.lastRollbackAt]) if (timestamp) utc(timestamp, "state timestamp");
  const updatedAt = utc(requiredString(record, STATE.updatedAt), "state.updatedAt");
  const digest = requiredString(record, STATE.digest);
  if (digest !== stateDigest(siteUrl, pageId, payload, updatedAt)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "state digest mismatch");
  return Object.freeze({ id: record.id, siteUrl, pageId, ...payload, digest, updatedAt, revision: record.revision });
}

function parseRun(record: ObjectRecord): RunRecord {
  if (record.typeId !== RUN_TYPE) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "run type is invalid");
  const runId = requiredString(record, RUN.runId);
  const siteUrl = requiredString(record, RUN.siteUrl);
  const pageId = requiredString(record, RUN.pageId);
  const policyDigest = requiredString(record, RUN.policyDigest);
  const status = requiredString(record, RUN.status) as SerpMetadataRunStatus;
  if (!STATUSES.includes(status)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "run status is invalid");
  const raw = object(record.properties[RUN.payload], "run payload");
  const mode = raw.mode as SerpMetadataMode;
  const reason = raw.reason as SerpMetadataReason;
  if (!MODES.includes(mode) || !REASONS.includes(reason)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "run enum is invalid");
  const payload: RunPayload = {
    mode, reason,
    startDate: nullableString(raw.startDate, "run.startDate"),
    endDate: nullableString(raw.endDate, "run.endDate"),
    inventoryDigest: nullableString(raw.inventoryDigest, "run.inventoryDigest"),
    performanceDigest: nullableString(raw.performanceDigest, "run.performanceDigest"),
    evidence: parseEvidence(raw.evidence),
    action: parseAction(raw.action),
    receipt: parseReceipt(raw.receipt),
    errorCode: nullableString(raw.errorCode, "run.errorCode"),
  };
  if (payload.startDate) date(payload.startDate, "run.startDate");
  if (payload.endDate) date(payload.endDate, "run.endDate");
  const createdAt = utc(requiredString(record, RUN.createdAt), "run.createdAt");
  const updatedAt = utc(requiredString(record, RUN.updatedAt), "run.updatedAt");
  const digest = requiredString(record, RUN.digest);
  if (digest !== runDigest(runId, siteUrl, pageId, policyDigest, status, payload, createdAt, updatedAt)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "run digest mismatch");
  return Object.freeze({ id: record.id, runId, siteUrl, pageId, policyDigest, status, ...payload, digest, createdAt, updatedAt, revision: record.revision });
}

function runPayload(run: RunRecord): RunPayload {
  return { mode: run.mode, reason: run.reason, startDate: run.startDate, endDate: run.endDate, inventoryDigest: run.inventoryDigest, performanceDigest: run.performanceDigest, evidence: run.evidence, action: run.action, receipt: run.receipt, errorCode: run.errorCode };
}
function conflict(error: unknown): boolean { return error instanceof OntologyTransactionError && error.code === "CONFLICT"; }
function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

function repeatedToken(title: string): boolean {
  const counts = new Map<string, number>();
  for (const token of tokens(title)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return [...counts.values()].some((count) => count > 2);
}
function titleContainsHeading(title: string, heading: string): boolean {
  const titleSet = new Set(tokens(title));
  const headingTokens = tokens(heading);
  return headingTokens.length > 0 && headingTokens.every((token) => titleSet.has(token));
}
function weightedQueryCoverage(candidate: string, rows: readonly SearchPerformanceRow[]): number {
  const candidateTokens = new Set(tokens(candidate));
  let weighted = 0;
  let total = 0;
  for (const row of rows) {
    const queryTokens = tokens(row.query ?? "");
    if (queryTokens.length === 0 || row.impressions <= 0) continue;
    const matched = queryTokens.filter((token) => candidateTokens.has(token)).length / queryTokens.length;
    weighted += matched * row.impressions;
    total += row.impressions;
  }
  return total > 0 ? weighted / total : 0;
}

function deriveCandidate(page: SeoPageSnapshot, inventory: PageInventorySnapshot, current: SeoMetadataValue, queries: readonly SearchPerformanceRow[], policy: SerpMetadataPolicy): { readonly metadata: SeoMetadataValue; readonly descriptionCoverage: number } {
  const otherTitles = new Set(inventory.pages.filter((item) => item.pageId !== page.pageId).map((item) => folded(item.currentMetadata.title)));
  const currentTitleDuplicate = otherTitles.has(folded(current.title));
  let title = current.title;
  if (currentTitleDuplicate || !titleContainsHeading(current.title, page.primaryHeading)) {
    const candidates = [
      !folded(page.primaryHeading).includes(folded(page.siteName)) ? `${page.primaryHeading} | ${page.siteName}` : page.primaryHeading,
      page.primaryHeading,
    ];
    const candidate = candidates.find((entry) => [...entry].length <= policy.maxGeneratedTitleCharacters && !otherTitles.has(folded(entry)) && !repeatedToken(entry));
    if (candidate) title = candidate;
  }

  const otherDescriptions = new Set(inventory.pages.filter((item) => item.pageId !== page.pageId).map((item) => item.currentMetadata.metaDescription).filter((item): item is string => item !== null).map(folded));
  const currentDescriptionDuplicate = current.metaDescription !== null && otherDescriptions.has(folded(current.metaDescription));
  const currentCoverage = current.metaDescription ? weightedQueryCoverage(current.metaDescription, queries) : 0;
  const ranked = page.summaryCandidates
    .filter((entry) => [...entry].length <= policy.maxGeneratedDescriptionCharacters && !otherDescriptions.has(folded(entry)))
    .map((entry) => ({ entry, score: weightedQueryCoverage(entry, queries) }))
    .sort((a, b) => b.score - a.score || [...a.entry].length - [...b.entry].length || a.entry.localeCompare(b.entry, "en"));
  const best = ranked[0];
  let metaDescription = current.metaDescription;
  let descriptionCoverage = currentCoverage;
  if (best && (metaDescription === null || currentDescriptionDuplicate || best.score >= currentCoverage + policy.minDescriptionQueryCoverageDelta)) {
    metaDescription = best.entry;
    descriptionCoverage = best.score;
  }
  return Object.freeze({ metadata: Object.freeze({ title, metaDescription }), descriptionCoverage });
}

function inverseAction(action: MetadataPublishAction, resulting: PublishedMetadataSnapshot | null): MetadataPublishAction {
  if (action.kind === "REMOVE_METADATA_OVERRIDE") {
    return Object.freeze({ kind: "UPSERT_METADATA_OVERRIDE", siteUrl: action.siteUrl, pageId: action.pageId, pageUrl: action.pageUrl, expected: null, desired: action.expected.metadata });
  }
  if (!resulting) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "upsert publish receipt omitted resulting snapshot");
  if (action.expected === null) return Object.freeze({ kind: "REMOVE_METADATA_OVERRIDE", siteUrl: action.siteUrl, pageId: action.pageId, pageUrl: action.pageUrl, expected: resulting });
  return Object.freeze({ kind: "UPSERT_METADATA_OVERRIDE", siteUrl: action.siteUrl, pageId: action.pageId, pageUrl: action.pageUrl, expected: resulting, desired: action.expected.metadata });
}

function validateReceipt(action: MetadataPublishAction, receipt: MetadataPublishReceipt): void {
  if (!receipt.publisherVersion.trim()) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "publisher receipt version is empty");
  if (receipt.snapshot) {
    validatePublishedMetadataSnapshot(receipt.snapshot);
    if (receipt.snapshot.pageId !== action.pageId || receipt.snapshot.pageUrl !== action.pageUrl) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "publisher receipt identity mismatch");
  }
  if (action.kind === "UPSERT_METADATA_OVERRIDE") {
    if (!receipt.snapshot || !same(receipt.snapshot.metadata, action.desired)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "publisher did not certify desired metadata");
  } else if (receipt.snapshot !== null) {
    throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "publisher did not certify metadata removal");
  }
}

export class SerpMetadataOptimizer {
  readonly schema: ValidatedSchema;

  constructor(
    private readonly transactions: OntologyTransactionPort,
    readonly scope: OntologyScope,
    readonly policy: SerpMetadataPolicy,
    private readonly inventory: PageInventoryProvider,
    private readonly performance: SearchPerformanceProvider,
    private readonly publisher: MetadataPublisher,
    private readonly now: () => number = Date.now,
    private readonly onTelemetry?: (event: SerpMetadataTelemetryEvent) => void,
    private readonly onTelemetryError?: (error: unknown, event: SerpMetadataTelemetryEvent) => void,
  ) {
    this.schema = schema(scope);
  }

  private time(): { readonly ms: number; readonly iso: string } {
    const ms = this.now();
    if (!Number.isFinite(ms)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "engine clock is invalid");
    return Object.freeze({ ms, iso: new Date(ms).toISOString() });
  }
  private stateId(siteUrl: string, pageId: string): string { return ontologyId("cortex-serp-state-v1", { scope: this.scope, siteUrl, pageId }); }
  private runObjectId(runId: string, siteUrl: string, pageId: string): string { return ontologyId("cortex-serp-run-v1", { scope: this.scope, runId, siteUrl, pageId }); }
  private readState(siteUrl: string, pageId: string): StateRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.stateId(siteUrl, pageId));
    return raw ? parseState(raw) : undefined;
  }
  private readRun(runId: string, siteUrl: string, pageId: string): RunRecord | undefined {
    const raw = this.transactions.getObject(this.scope, this.runObjectId(runId, siteUrl, pageId));
    return raw ? parseRun(raw) : undefined;
  }
  private result(run: RunRecord): SerpMetadataResult {
    return Object.freeze({
      runId: run.runId, siteUrl: run.siteUrl, pageId: run.pageId, status: run.status, mode: run.mode, reason: run.reason,
      inventoryDigest: run.inventoryDigest, performanceDigest: run.performanceDigest, evidence: run.evidence, action: run.action,
      receipt: run.receipt, policyDigest: run.policyDigest, digest: run.digest,
    });
  }
  private emit(run: RunRecord, effect: FinalizeEffect): void {
    if (!this.onTelemetry) return;
    const event: SerpMetadataTelemetryEvent = Object.freeze({ runId: run.runId, siteUrl: run.siteUrl, pageId: run.pageId, status: run.status, reason: run.reason, mode: run.mode, effect });
    try { this.onTelemetry(event); } catch (error) { try { this.onTelemetryError?.(error, event); } catch { /* telemetry must not alter transaction semantics */ } }
  }

  private acquire(runId: string, siteUrl: string, pageId: string, payload: RunPayload, nowIso: string): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const existing = this.readRun(runId, siteUrl, pageId);
      if (existing) return existing;
      const state = this.readState(siteUrl, pageId);
      if (state?.inFlightRunId && state.inFlightRunId !== runId) {
        const inFlight = this.readRun(state.inFlightRunId, siteUrl, pageId);
        if (!inFlight) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "state references missing in-flight run");
        return inFlight;
      }
      const nextState: StatePayload = {
        policyDigest: this.policy.digest,
        lastRunAt: state?.lastRunAt ?? null,
        lastMutationAt: state?.lastMutationAt ?? null,
        inFlightRunId: runId,
        lastInverseAction: state?.lastInverseAction ?? null,
        lastRollbackAt: state?.lastRollbackAt ?? null,
      };
      const operations: TransactionOperation[] = [
        { kind: "CREATE_OBJECT", record: { id: this.runObjectId(runId, siteUrl, pageId), typeId: RUN_TYPE, scope: this.scope, properties: runProperties(runId, siteUrl, pageId, this.policy.digest, "PREPARED", payload, nowIso, nowIso) } },
        state
          ? { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(siteUrl, pageId, nextState, nowIso) }
          : { kind: "CREATE_OBJECT", record: { id: this.stateId(siteUrl, pageId), typeId: STATE_TYPE, scope: this.scope, properties: stateProperties(siteUrl, pageId, nextState, nowIso) } },
      ];
      try {
        this.transactions.transact(this.scope, this.schema, operations);
        const stored = this.readRun(runId, siteUrl, pageId);
        if (!stored) throw new SerpMetadataOptimizerError("PERSISTENCE_FAILURE", "prepared run unreadable after commit");
        return stored;
      } catch (error) {
        if (conflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (conflict(error)) throw new SerpMetadataOptimizerError("CONFLICT", "run preparation conflicted after retries");
        if (error instanceof SerpMetadataOptimizerError) throw error;
        throw new SerpMetadataOptimizerError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run preparation failed");
      }
    }
    throw new SerpMetadataOptimizerError("CONFLICT", "run preparation exhausted retries");
  }

  private finalize(run: RunRecord, status: Exclude<SerpMetadataRunStatus, "PREPARED">, payload: RunPayload, nowIso: string, effect: FinalizeEffect, inverse: MetadataPublishAction | null): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const current = this.readRun(run.runId, run.siteUrl, run.pageId);
      if (!current) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "run disappeared before finalize");
      if (current.status !== "PREPARED") return current;
      const state = this.readState(run.siteUrl, run.pageId);
      if (!state || state.inFlightRunId !== run.runId) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "run no longer owns state lock");
      const nextState: StatePayload = {
        policyDigest: state.policyDigest,
        lastRunAt: nowIso,
        lastMutationAt: effect === "NONE" ? state.lastMutationAt : nowIso,
        inFlightRunId: null,
        lastInverseAction: effect === "APPLY" ? inverse : effect === "ROLLBACK" ? null : state.lastInverseAction,
        lastRollbackAt: effect === "ROLLBACK" ? nowIso : state.lastRollbackAt,
      };
      try {
        this.transactions.transact(this.scope, this.schema, [
          { kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties: runProperties(current.runId, current.siteUrl, current.pageId, current.policyDigest, status, payload, current.createdAt, nowIso) },
          { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(state.siteUrl, state.pageId, nextState, nowIso) },
        ]);
        const stored = this.readRun(run.runId, run.siteUrl, run.pageId);
        if (!stored) throw new SerpMetadataOptimizerError("PERSISTENCE_FAILURE", "finalized run unreadable after commit");
        this.emit(stored, effect);
        return stored;
      } catch (error) {
        if (conflict(error) && attempt < this.policy.maxWriteRetries) continue;
        if (conflict(error)) throw new SerpMetadataOptimizerError("CONFLICT", "run finalization conflicted after retries");
        if (error instanceof SerpMetadataOptimizerError) throw error;
        throw new SerpMetadataOptimizerError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run finalization failed");
      }
    }
    throw new SerpMetadataOptimizerError("CONFLICT", "run finalization exhausted retries");
  }

  private async execute(run: RunRecord, executionMode: SerpMetadataMode): Promise<SerpMetadataResult> {
    if (run.status !== "PREPARED") return this.result(run);
    if (!run.action || run.mode !== "ACTIVE") return this.result(this.finalize(run, "NOOP", runPayload(run), this.time().iso, "NONE", null));
    if (executionMode !== "ACTIVE") throw new SerpMetadataOptimizerError("POLICY_VIOLATION", `${executionMode} freezes the prepared publish; ACTIVE recovery is required before a write`);
    const rollback = run.reason === "ROLLBACK_APPLIED";
    let receipt: MetadataPublishReceipt;
    try {
      receipt = await this.publisher.apply(run.action);
      validateReceipt(run.action, receipt);
    } catch (error) {
      if (error instanceof MetadataPublisherError && error.code === "AMBIGUOUS_PUBLISH_OUTCOME") throw new SerpMetadataOptimizerError("REMOTE_FAILURE", "metadata publish outcome is ambiguous; run remains PREPARED for preflight recovery");
      if (error instanceof SerpMetadataOptimizerError && error.code === "INTEGRITY_FAILURE") throw error;
      const reason: SerpMetadataReason = error instanceof MetadataPublisherError && error.code === "PUBLISH_CONFLICT" ? "PUBLISH_CONFLICT" : "PUBLISH_FAILURE";
      const next: RunPayload = { ...runPayload(run), reason, receipt: null, errorCode: error instanceof MetadataPublisherError ? error.code : "UNKNOWN_PUBLISH_FAILURE" };
      this.finalize(run, "FAILED", next, this.time().iso, "NONE", null);
      throw new SerpMetadataOptimizerError("REMOTE_FAILURE", `${reason}: metadata publisher did not certify the change`);
    }
    const reason: SerpMetadataReason = rollback ? "ROLLBACK_APPLIED" : receipt.recoveredAlreadyApplied ? "ACTION_RECOVERED" : "ACTION_APPLIED";
    const next: RunPayload = { ...runPayload(run), reason, receipt, errorCode: null };
    const inverse = rollback ? null : inverseAction(run.action, receipt.snapshot);
    return this.result(this.finalize(run, rollback ? "ROLLED_BACK" : "APPLIED", next, this.time().iso, rollback ? "ROLLBACK" : "APPLY", inverse));
  }

  async optimize(input: SerpMetadataRunInput): Promise<SerpMetadataResult> {
    const runId = id(input.runId, "runId");
    const siteUrl = siteProperty(input.siteUrl);
    const pageId = id(input.pageId, "pageId");
    const startDate = date(input.startDate, "startDate");
    const endDate = date(input.endDate, "endDate");
    if (dateSpanDays(startDate, endDate) > this.policy.maxWindowDays) throw new SerpMetadataOptimizerError("INVALID_INPUT", "Search Console window exceeds policy maxWindowDays");
    const mode = effectiveMode(this.policy.mode, input.mode);
    const existing = this.readRun(runId, siteUrl, pageId);
    if (existing) {
      if (existing.startDate !== startDate || existing.endDate !== endDate) throw new SerpMetadataOptimizerError("CONFLICT", "runId was reused with a different Search Console window");
      return this.execute(existing, mode);
    }
    const state = this.readState(siteUrl, pageId);
    if (state?.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, siteUrl, pageId);
      if (!inFlight) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.execute(inFlight, mode);
    }
    const now = this.time();
    if (mode === "KILLED") {
      const payload: RunPayload = { mode, reason: "KILL_SWITCH", startDate, endDate, inventoryDigest: null, performanceDigest: null, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }
    if (state?.lastMutationAt && now.ms - Date.parse(state.lastMutationAt) < this.policy.cooldownMs) {
      const payload: RunPayload = { mode, reason: "COOLDOWN", startDate, endDate, inventoryDigest: null, performanceDigest: null, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }

    const inventory = await this.inventory.getInventory(siteUrl);
    validatePageInventorySnapshot(inventory);
    if (inventory.siteUrl !== siteUrl) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "inventory property mismatch");
    if (inventory.pages.length > this.policy.maxInventoryPages) throw new SerpMetadataOptimizerError("POLICY_VIOLATION", "inventory exceeds policy page limit");
    const inventoryAge = now.ms - Date.parse(inventory.observedAt);
    if (inventoryAge < 0) throw new SerpMetadataOptimizerError("INVALID_INPUT", "inventory cannot be observed in the future");
    const page = inventory.pages.find((item) => item.pageId === pageId);
    if (inventoryAge > this.policy.maxInventoryAgeMs) {
      const payload: RunPayload = { mode, reason: "SOURCE_STALE", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: null, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }
    if (!page) {
      const payload: RunPayload = { mode, reason: "PAGE_NOT_FOUND", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: null, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }
    if (!page.indexable) {
      const payload: RunPayload = { mode, reason: "PAGE_NOT_INDEXABLE", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: null, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }
    if (page.canonicalUrl === null || page.canonicalUrl !== page.url) {
      const payload: RunPayload = { mode, reason: "NON_CANONICAL_PAGE", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: null, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }

    const performance = await this.performance.getPerformance({ siteUrl, pageUrl: page.url, startDate, endDate, maxRows: this.policy.maxSearchRows });
    validateSearchPerformanceSnapshot(performance);
    if (performance.siteUrl !== siteUrl || performance.startDate !== startDate || performance.endDate !== endDate) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "Search Console snapshot identity mismatch");
    if (performance.pageRows.length + performance.targetQueryRows.length > this.policy.maxSearchRows) throw new SerpMetadataOptimizerError("POLICY_VIOLATION", "Search Console snapshot exceeds policy row limit");
    if (performance.targetQueryRows.some((row) => row.pageUrl !== page.url)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "Search Console query rows include another page");
    const performanceAge = now.ms - Date.parse(performance.observedAt);
    if (performanceAge < 0) throw new SerpMetadataOptimizerError("INVALID_INPUT", "Search Console snapshot cannot be observed in the future");
    if (performanceAge > this.policy.maxPerformanceAgeMs) {
      const payload: RunPayload = { mode, reason: "SOURCE_STALE", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: performance.digest, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }

    const target = performance.pageRows.find((row) => row.pageUrl === page.url);
    if (!target || target.impressions < this.policy.minImpressions) {
      const payload: RunPayload = { mode, reason: "INSUFFICIENT_DATA", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: performance.digest, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }
    const peers = performance.pageRows.filter((row) => row.pageUrl !== page.url && row.impressions > 0 && Math.abs(row.position - target.position) <= this.policy.peerPositionTolerance);
    if (peers.length < this.policy.minPeerPages) {
      const payload: RunPayload = { mode, reason: "INSUFFICIENT_DATA", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: performance.digest, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }
    const peerImpressions = peers.reduce((sum, row) => sum + row.impressions, 0);
    const peerClicks = peers.reduce((sum, row) => sum + row.clicks, 0);
    const peerCtr = peerImpressions > 0 ? peerClicks / peerImpressions : 0;
    const expectedClicksGain = Math.max(0, peerCtr - target.ctr) * target.impressions;
    if (expectedClicksGain < this.policy.minExpectedClicksGain) {
      const payload: RunPayload = { mode, reason: "NO_CTR_OPPORTUNITY", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: performance.digest, evidence: null, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }

    const published = await this.publisher.read(siteUrl, pageId, page.url);
    if (published) {
      validatePublishedMetadataSnapshot(published);
      if (published.pageId !== pageId || published.pageUrl !== page.url) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "publisher read identity mismatch");
    }
    const current = published?.metadata ?? page.currentMetadata;
    const candidate = deriveCandidate(page, inventory, current, performance.targetQueryRows, this.policy);
    const queryEvidenceDigest = hash("cortex-serp-query-evidence-v1", performance.targetQueryRows.map((row) => ({ query: row.query, impressions: row.impressions, clicks: row.clicks, position: row.position })));
    const evidence: SerpOpportunityEvidence = Object.freeze({
      impressions: target.impressions,
      clicks: target.clicks,
      ctr: target.ctr,
      averagePosition: target.position,
      peerCtr,
      peerPages: peers.length,
      expectedClicksGain,
      queryRowsConsidered: performance.targetQueryRows.length,
      selectedDescriptionCoverage: candidate.descriptionCoverage,
      queryEvidenceDigest,
      sourceCoverage: performance.coverage,
      sourceTruncated: performance.truncated,
      nonClaim: "OBSERVATIONAL_CTR_OPPORTUNITY_NOT_CAUSAL_RANKING_OR_SERP_GUARANTEE",
    });
    if (same(candidate.metadata, current)) {
      const payload: RunPayload = { mode, reason: "IN_SYNC", startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: performance.digest, evidence, action: null, receipt: null, errorCode: null };
      return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
    }
    const action: MetadataPublishAction = Object.freeze({ kind: "UPSERT_METADATA_OVERRIDE", siteUrl, pageId, pageUrl: page.url, expected: published, desired: candidate.metadata });
    const reason: SerpMetadataReason = mode === "OBSERVE_ONLY" ? "OBSERVE_ONLY" : "ACTION_APPLIED";
    const payload: RunPayload = { mode, reason, startDate, endDate, inventoryDigest: inventory.digest, performanceDigest: performance.digest, evidence, action, receipt: null, errorCode: null };
    return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), mode);
  }

  async rollbackLastMutation(input: SerpMetadataRollbackInput): Promise<SerpMetadataResult> {
    const runId = id(input.runId, "runId");
    const siteUrl = siteProperty(input.siteUrl);
    const pageId = id(input.pageId, "pageId");
    const existing = this.readRun(runId, siteUrl, pageId);
    if (existing) return this.execute(existing, "ACTIVE");
    const state = this.readState(siteUrl, pageId);
    if (!state?.lastInverseAction) throw new SerpMetadataOptimizerError("POLICY_VIOLATION", "no certified metadata mutation is available for rollback");
    if (state.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, siteUrl, pageId);
      if (!inFlight) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "state references missing in-flight run");
      return this.execute(inFlight, "ACTIVE");
    }
    const now = this.time();
    const payload: RunPayload = {
      mode: "ACTIVE", reason: "ROLLBACK_APPLIED", startDate: null, endDate: null, inventoryDigest: null, performanceDigest: null,
      evidence: null, action: state.lastInverseAction, receipt: null, errorCode: null,
    };
    return this.execute(this.acquire(runId, siteUrl, pageId, payload, now.iso), "ACTIVE");
  }
}
