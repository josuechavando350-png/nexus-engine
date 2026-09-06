import { createHash } from "node:crypto";
import { canonicalJson, ontologyId, validateSchema, type OntologyScope, type SchemaVersion, type ValidatedSchema } from "@nexus/ontology";
import { OntologyTransactionError, type JsonValue, type ObjectRecord, type OntologyTransactionPort, type TransactionOperation } from "@nexus/ontology/transaction";

const STATE_TYPE = "cortex.programmatic_seo_state";
const RUN_TYPE = "cortex.programmatic_seo_run";
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_BODY = 100_000;
const MAX_BUNDLE_PAGES = 2_000;
const MAX_TOTAL_BODY_CHARACTERS = 20_000_000;

const STATE = Object.freeze({ siteId: "cortex.programmatic_seo.state.site_id", payload: "cortex.programmatic_seo.state.payload", digest: "cortex.programmatic_seo.state.digest", updatedAt: "cortex.programmatic_seo.state.updated_at" });
const RUN = Object.freeze({ runId: "cortex.programmatic_seo.run.run_id", siteId: "cortex.programmatic_seo.run.site_id", policyDigest: "cortex.programmatic_seo.run.policy_digest", status: "cortex.programmatic_seo.run.status", payload: "cortex.programmatic_seo.run.payload", digest: "cortex.programmatic_seo.run.digest", createdAt: "cortex.programmatic_seo.run.created_at", updatedAt: "cortex.programmatic_seo.run.updated_at" });

export type ProgrammaticSeoMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type ProgrammaticSeoRunStatus = "PREPARED" | "APPLIED" | "NOOP" | "FAILED" | "ROLLED_BACK";
export type ProgrammaticSeoReason = "KILL_SWITCH" | "SOURCE_STALE" | "IN_SYNC" | "OBSERVE_ONLY" | "BUNDLE_PENDING" | "BUNDLE_APPLIED" | "BUNDLE_RECOVERED" | "PUBLISH_CONFLICT" | "PUBLISH_FAILURE" | "ROLLBACK_PENDING" | "ROLLBACK_APPLIED";

export interface ProgrammaticSeoPageInput {
  readonly pageId: string;
  readonly routeSegments: readonly string[];
  readonly parentPageId: string | null;
  readonly locale: string;
  readonly title: string;
  readonly description: string;
  readonly heading: string;
  readonly bodyText: string;
  readonly distinctiveStatements: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly updatedAt: string;
  readonly indexable: boolean;
  readonly canonicalPath?: string | null;
}

export interface ProgrammaticSeoCatalogSnapshot {
  readonly sourceId: string;
  readonly siteId: string;
  readonly baseUrl: string;
  readonly observedAt: string;
  readonly pages: readonly ProgrammaticSeoPageInput[];
  readonly digest: string;
}

export interface CreateProgrammaticSeoPolicyInput {
  readonly policyId: string;
  readonly version: string;
  readonly maxCatalogAgeMs: number;
  readonly maxPages: number;
  readonly minDistinctiveStatements: number;
  readonly maxPairwiseShingleSimilarity: number;
  readonly maxRouteDepth: number;
  readonly maxWriteRetries?: number;
  readonly mode?: ProgrammaticSeoMode;
}
export interface ProgrammaticSeoPolicy extends Omit<Required<CreateProgrammaticSeoPolicyInput>, "maxWriteRetries" | "mode"> { readonly maxWriteRetries: number; readonly mode: ProgrammaticSeoMode; readonly digest: string; }

export interface CompiledProgrammaticSeoPage extends Omit<ProgrammaticSeoPageInput, "canonicalPath"> {
  readonly path: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly breadcrumbPageIds: readonly string[];
  readonly contentDigest: string;
}
export interface ProgrammaticSeoBundle {
  readonly schemaVersion: "cortex-programmatic-seo-bundle-v1";
  readonly siteId: string;
  readonly baseUrl: string;
  readonly sourceDigest: string;
  readonly policyDigest: string;
  readonly pages: readonly CompiledProgrammaticSeoPage[];
  readonly staticParams: readonly Readonly<{ slug: readonly string[] }>[];
  readonly sitemap: readonly Readonly<{ url: string; lastModified: string }>[];
  readonly robots: Readonly<{ userAgent: "*"; allow: "/"; disallow: readonly string[]; sitemap: string }>;
  readonly digest: string;
}
export interface ProgrammaticSeoBundleRef { readonly siteId: string; readonly bundleDigest: string; readonly artifactId: string; readonly digest: string; }
export interface PublishedProgrammaticSeoBundle { readonly siteId: string; readonly bundleRef: ProgrammaticSeoBundleRef; readonly revision: number; readonly digest: string; }
export type ProgrammaticSeoPublishAction = Readonly<{ kind: "REPLACE_BUNDLE"; siteId: string; expected: PublishedProgrammaticSeoBundle | null; desired: ProgrammaticSeoBundleRef | null }>;
export interface ProgrammaticSeoPublishReceipt { readonly snapshot: PublishedProgrammaticSeoBundle | null; readonly recoveredAlreadyApplied: boolean; readonly publisherVersion: string; }
export interface ProgrammaticSeoPublisher {
  stage(bundle: ProgrammaticSeoBundle): Promise<ProgrammaticSeoBundleRef>;
  load(ref: ProgrammaticSeoBundleRef): Promise<ProgrammaticSeoBundle>;
  read(siteId: string): Promise<PublishedProgrammaticSeoBundle | null>;
  apply(action: ProgrammaticSeoPublishAction): Promise<ProgrammaticSeoPublishReceipt>;
}
export interface ProgrammaticSeoCatalogProvider { getCatalog(siteId: string): Promise<ProgrammaticSeoCatalogSnapshot>; }
export interface ProgrammaticSeoRunInput { readonly runId: string; readonly siteId: string; readonly mode?: ProgrammaticSeoMode; }
export interface ProgrammaticSeoResult { readonly runId: string; readonly siteId: string; readonly status: ProgrammaticSeoRunStatus; readonly reason: ProgrammaticSeoReason; readonly mode: ProgrammaticSeoMode; readonly bundleDigest: string | null; readonly action: ProgrammaticSeoPublishAction | null; readonly receipt: ProgrammaticSeoPublishReceipt | null; readonly policyDigest: string; readonly digest: string; }
export interface ProgrammaticSeoTelemetryEvent { readonly runId: string; readonly siteId: string; readonly status: ProgrammaticSeoRunStatus; readonly reason: ProgrammaticSeoReason; readonly mode: ProgrammaticSeoMode; readonly effect: "NONE" | "APPLY" | "ROLLBACK"; }

export class ProgrammaticSeoError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "POLICY_VIOLATION" | "INTEGRITY_FAILURE" | "PERSISTENCE_FAILURE" | "CONFLICT" | "REMOTE_FAILURE", message: string) { super(message); this.name = "ProgrammaticSeoError"; }
}
export class ProgrammaticSeoPublisherError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "PUBLISH_CONFLICT" | "PUBLISH_FAILURE" | "AMBIGUOUS_PUBLISH_OUTCOME", message: string) { super(message); this.name = "ProgrammaticSeoPublisherError"; }
}

interface StatePayload { readonly policyDigest: string; readonly inFlightRunId: string | null; readonly lastPublishedDigest: string | null; readonly lastInverseAction: ProgrammaticSeoPublishAction | null; readonly lastMutationAt: string | null; readonly lastRollbackAt: string | null; }
interface StateRecord extends StatePayload { readonly id: string; readonly siteId: string; readonly digest: string; readonly updatedAt: string; readonly revision: number; }
interface RunPayload { readonly mode: ProgrammaticSeoMode; readonly reason: ProgrammaticSeoReason; readonly sourceDigest: string | null; readonly bundleDigest: string | null; readonly action: ProgrammaticSeoPublishAction | null; readonly receipt: ProgrammaticSeoPublishReceipt | null; readonly errorCode: string | null; }
interface RunRecord extends RunPayload { readonly id: string; readonly runId: string; readonly siteId: string; readonly policyDigest: string; readonly status: ProgrammaticSeoRunStatus; readonly digest: string; readonly createdAt: string; readonly updatedAt: string; readonly revision: number; }

const MODES: readonly ProgrammaticSeoMode[] = ["ACTIVE", "OBSERVE_ONLY", "KILLED"];
const STATUSES: readonly ProgrammaticSeoRunStatus[] = ["PREPARED", "APPLIED", "NOOP", "FAILED", "ROLLED_BACK"];
const REASONS: readonly ProgrammaticSeoReason[] = ["KILL_SWITCH", "SOURCE_STALE", "IN_SYNC", "OBSERVE_ONLY", "BUNDLE_PENDING", "BUNDLE_APPLIED", "BUNDLE_RECOVERED", "PUBLISH_CONFLICT", "PUBLISH_FAILURE", "ROLLBACK_PENDING", "ROLLBACK_APPLIED"];

function hash(namespace: string, value: unknown): string { return `sha256:${createHash("sha256").update(`${namespace}\n${canonicalJson(value)}`, "utf8").digest("hex")}`; }
function clean(value: string, field: string, max: number): string {
  if (typeof value !== "string") throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || [...normalized].length > max) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must contain 1..${max} characters`);
  return normalized;
}
function identifier(value: string, field: string): string { const normalized = value.trim(); if (!IDENTIFIER.test(normalized)) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} is malformed`); return normalized; }
function utc(value: string, field: string): string { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must be canonical UTC`); return value; }
function normalizeBaseUrl(value: string): string {
  let parsed: URL; try { parsed = new URL(value); } catch { throw new ProgrammaticSeoError("INVALID_INPUT", "baseUrl must be absolute"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ProgrammaticSeoError("INVALID_INPUT", "baseUrl must be clean HTTPS");
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") + "/"; return parsed.toString();
}
function positiveInt(value: number, field: string, max: number): number { if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must be 1..${max}`); return value; }
function ratio(value: number, field: string): number { if (!Number.isFinite(value) || value < 0 || value >= 1) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must be >=0 and <1`); return value; }
function segment(value: string, field: string): string { const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("en-US"); if (!SEGMENT.test(normalized)) throw new ProgrammaticSeoError("INVALID_INPUT", `${field} must be a normalized lowercase URL segment`); return normalized; }
function normalizePath(parts: readonly string[]): string { return parts.length === 0 ? "/" : `/${parts.join("/")}/`; }
function fold(value: string): string { return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim(); }
function tokens(value: string): readonly string[] { return Object.freeze((fold(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => [...token].length >= 2)); }
function shingles(value: string): ReadonlySet<string> {
  const values = tokens(value); const result = new Set<string>();
  if (values.length < 5) { if (values.length) result.add(values.join(" ")); return result; }
  for (let index = 0; index <= values.length - 5; index += 1) result.add(values.slice(index, index + 5).join(" ")); return result;
}
function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]; let intersection = 0;
  for (const item of small) if (large.has(item)) intersection += 1; return intersection / (left.size + right.size - intersection);
}
function isJson(value: unknown): value is JsonValue { if (value === null || typeof value === "string" || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (Array.isArray(value)) return value.every(isJson); return Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJson); }
function json(value: unknown, field: string): JsonValue { if (!isJson(value)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `${field} is not finite JSON`); return value; }
function object(value: JsonValue | undefined, field: string): Record<string, JsonValue> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `${field} must be object`); return value as Record<string, JsonValue>; }
function requiredString(record: ObjectRecord, key: string): string { const value = record.properties[key]; if (typeof value !== "string" || !value) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `record ${record.id} has invalid ${key}`); return value; }
function nullableString(value: JsonValue | undefined, field: string): string | null { if (value === undefined || value === null) return null; if (typeof value !== "string") throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `${field} must be string or null`); return value; }
function nullableDigest(value: JsonValue | undefined, field: string): string | null { const result = nullableString(value, field); if (result !== null && !SHA256.test(result)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `${field} must be sha256 or null`); return result; }
function property(id: string, name: string, valueKind: "STRING" | "JSON" | "DATETIME", immutable = false) { return { id, name, valueKind, cardinality: "REQUIRED", unique: false, immutable } as const; }
function schema(scope: OntologyScope): ValidatedSchema {
  const value: SchemaVersion = { version: "cortex-programmatic-seo-v1", scope, properties: [
    property(STATE.siteId, "ProgrammaticSeoStateSiteId", "STRING", true), property(STATE.payload, "ProgrammaticSeoStatePayload", "JSON"), property(STATE.digest, "ProgrammaticSeoStateDigest", "STRING"), property(STATE.updatedAt, "ProgrammaticSeoStateUpdatedAt", "DATETIME"),
    property(RUN.runId, "ProgrammaticSeoRunId", "STRING", true), property(RUN.siteId, "ProgrammaticSeoRunSiteId", "STRING", true), property(RUN.policyDigest, "ProgrammaticSeoRunPolicyDigest", "STRING", true), property(RUN.status, "ProgrammaticSeoRunStatus", "STRING"), property(RUN.payload, "ProgrammaticSeoRunPayload", "JSON"), property(RUN.digest, "ProgrammaticSeoRunDigest", "STRING"), property(RUN.createdAt, "ProgrammaticSeoRunCreatedAt", "DATETIME", true), property(RUN.updatedAt, "ProgrammaticSeoRunUpdatedAt", "DATETIME")
  ], interfaces: [], objects: [{ id: STATE_TYPE, name: "CortexProgrammaticSeoState", propertyIds: Object.values(STATE), interfaceIds: [] }, { id: RUN_TYPE, name: "CortexProgrammaticSeoRun", propertyIds: Object.values(RUN), interfaceIds: [] }], relationships: [], actions: [], functions: [], events: [] };
  return validateSchema(value);
}

export function createProgrammaticSeoPolicy(input: CreateProgrammaticSeoPolicyInput): ProgrammaticSeoPolicy {
  const policyId = identifier(input.policyId, "policyId"); const version = identifier(input.version, "version");
  const maxCatalogAgeMs = positiveInt(input.maxCatalogAgeMs, "maxCatalogAgeMs", 30 * 24 * 60 * 60 * 1000); const maxPages = positiveInt(input.maxPages, "maxPages", MAX_BUNDLE_PAGES);
  const minDistinctiveStatements = positiveInt(input.minDistinctiveStatements, "minDistinctiveStatements", 20); const maxPairwiseShingleSimilarity = ratio(input.maxPairwiseShingleSimilarity, "maxPairwiseShingleSimilarity");
  if (maxPairwiseShingleSimilarity < 0.5) throw new ProgrammaticSeoError("INVALID_INPUT", "maxPairwiseShingleSimilarity must be >= 0.5");
  const maxRouteDepth = positiveInt(input.maxRouteDepth, "maxRouteDepth", 16); const maxWriteRetries = input.maxWriteRetries ?? 3;
  if (!Number.isInteger(maxWriteRetries) || maxWriteRetries < 0 || maxWriteRetries > 10) throw new ProgrammaticSeoError("INVALID_INPUT", "maxWriteRetries must be 0..10");
  const mode = input.mode ?? "ACTIVE"; if (!MODES.includes(mode)) throw new ProgrammaticSeoError("INVALID_INPUT", "mode is invalid");
  const core = { policyId, version, maxCatalogAgeMs, maxPages, minDistinctiveStatements, maxPairwiseShingleSimilarity, maxRouteDepth, maxWriteRetries, mode };
  return Object.freeze({ ...core, digest: hash("cortex-programmatic-seo-policy-v1", core) });
}

function normalizeCatalogPage(value: ProgrammaticSeoPageInput, maxDepth: number): ProgrammaticSeoPageInput {
  const pageId = identifier(value.pageId, "pageId"); if (value.routeSegments.length > maxDepth) throw new ProgrammaticSeoError("POLICY_VIOLATION", `page ${pageId} exceeds max route depth`);
  const routeSegments = Object.freeze(value.routeSegments.map((item, index) => segment(item, `page ${pageId}.routeSegments[${index}]`))); const parentPageId = value.parentPageId === null ? null : identifier(value.parentPageId, `page ${pageId}.parentPageId`);
  const locale = clean(value.locale, `page ${pageId}.locale`, 64); const title = clean(value.title, `page ${pageId}.title`, 300); const description = clean(value.description, `page ${pageId}.description`, 2_000); const heading = clean(value.heading, `page ${pageId}.heading`, 1_000); const bodyText = clean(value.bodyText, `page ${pageId}.bodyText`, MAX_BODY);
  if (!fold(bodyText).includes(fold(heading))) throw new ProgrammaticSeoError("INVALID_INPUT", `page ${pageId} heading must be visible in bodyText`);
  const distinctiveStatements = Object.freeze(value.distinctiveStatements.map((item, index) => clean(item, `page ${pageId}.distinctiveStatements[${index}]`, 4_000)));
  for (const statement of distinctiveStatements) if (!fold(bodyText).includes(fold(statement))) throw new ProgrammaticSeoError("INVALID_INPUT", `page ${pageId} distinctive statement must be visible in bodyText`);
  if (new Set(distinctiveStatements.map(fold)).size !== distinctiveStatements.length) throw new ProgrammaticSeoError("INVALID_INPUT", `page ${pageId} distinctive statements must be unique`);
  const evidenceRefs = Object.freeze(value.evidenceRefs.map((item, index) => clean(item, `page ${pageId}.evidenceRefs[${index}]`, 1_000))); if (new Set(evidenceRefs).size !== evidenceRefs.length) throw new ProgrammaticSeoError("INVALID_INPUT", `page ${pageId} evidence refs must be unique`);
  if (Boolean(value.indexable) && evidenceRefs.length === 0) throw new ProgrammaticSeoError("POLICY_VIOLATION", `indexable page ${pageId} requires evidenceRefs`);
  const updatedAt = utc(value.updatedAt, `page ${pageId}.updatedAt`); const canonicalPath: string | null = value.canonicalPath ?? null;
  if (canonicalPath !== null) {
    if (!canonicalPath.startsWith("/") || !canonicalPath.endsWith("/") || canonicalPath.includes("?") || canonicalPath.includes("#")) throw new ProgrammaticSeoError("INVALID_INPUT", `page ${pageId}.canonicalPath must be a clean path ending in /`);
    const parts = canonicalPath === "/" ? [] : canonicalPath.slice(1, -1).split("/"); const normalized = normalizePath(parts.map((part, index) => segment(part, `page ${pageId}.canonicalPath[${index}]`)));
    if (normalized !== canonicalPath) throw new ProgrammaticSeoError("INVALID_INPUT", `page ${pageId}.canonicalPath must already be normalized`);
  }
  return Object.freeze({ pageId, routeSegments, parentPageId, locale, title, description, heading, bodyText, distinctiveStatements, evidenceRefs, updatedAt, indexable: Boolean(value.indexable), canonicalPath });
}

export function createProgrammaticSeoCatalogSnapshot(input: Omit<ProgrammaticSeoCatalogSnapshot, "digest">, maxRouteDepth = 16): ProgrammaticSeoCatalogSnapshot {
  const sourceId = identifier(input.sourceId, "sourceId"); const siteId = identifier(input.siteId, "siteId"); const baseUrl = normalizeBaseUrl(input.baseUrl); const observedAt = utc(input.observedAt, "observedAt");
  if (input.pages.length > MAX_BUNDLE_PAGES) throw new ProgrammaticSeoError("INVALID_INPUT", `catalog exceeds hard page limit of ${MAX_BUNDLE_PAGES}`);
  const pages = Object.freeze(input.pages.map((page) => normalizeCatalogPage(page, maxRouteDepth)).sort((a, b) => a.pageId.localeCompare(b.pageId, "en")));
  if (pages.reduce((total, page) => total + [...page.bodyText].length, 0) > MAX_TOTAL_BODY_CHARACTERS) throw new ProgrammaticSeoError("INVALID_INPUT", `catalog exceeds hard body budget of ${MAX_TOTAL_BODY_CHARACTERS} characters`);
  const observedMs = Date.parse(observedAt); if (pages.some((page) => Date.parse(page.updatedAt) > observedMs)) throw new ProgrammaticSeoError("INVALID_INPUT", "page updatedAt must not be later than catalog observedAt");
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length) throw new ProgrammaticSeoError("INVALID_INPUT", "pageIds must be unique"); if (new Set(pages.map((page) => normalizePath(page.routeSegments))).size !== pages.length) throw new ProgrammaticSeoError("INVALID_INPUT", "route paths must be unique");
  const core = { sourceId, siteId, baseUrl, observedAt, pages }; return Object.freeze({ ...core, digest: hash("cortex-programmatic-seo-catalog-v1", core) });
}
export function validateProgrammaticSeoCatalogSnapshot(value: ProgrammaticSeoCatalogSnapshot): void {
  const normalized = createProgrammaticSeoCatalogSnapshot({ sourceId: value.sourceId, siteId: value.siteId, baseUrl: value.baseUrl, observedAt: value.observedAt, pages: value.pages }); if (normalized.digest !== value.digest) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "catalog digest mismatch");
}

function buildBreadcrumb(page: ProgrammaticSeoPageInput, byId: ReadonlyMap<string, ProgrammaticSeoPageInput>): readonly string[] {
  const result: string[] = []; const visited = new Set<string>(); let cursor: ProgrammaticSeoPageInput | undefined = page;
  while (cursor) {
    if (visited.has(cursor.pageId)) throw new ProgrammaticSeoError("POLICY_VIOLATION", `parent cycle includes ${cursor.pageId}`); visited.add(cursor.pageId); result.unshift(cursor.pageId);
    if (cursor.parentPageId === null) break; const child = cursor; cursor = byId.get(cursor.parentPageId); if (!cursor) throw new ProgrammaticSeoError("POLICY_VIOLATION", `page ${page.pageId} references missing parent`);
    if (page.indexable && !cursor.indexable) throw new ProgrammaticSeoError("POLICY_VIOLATION", `indexable page ${page.pageId} has a non-indexable ancestor`);
    if (cursor.routeSegments.length >= child.routeSegments.length || !cursor.routeSegments.every((part, index) => child.routeSegments[index] === part)) throw new ProgrammaticSeoError("POLICY_VIOLATION", `page ${page.pageId} parent hierarchy does not match route hierarchy`);
  }
  if (page.routeSegments.length > 0 && result.length === 1) throw new ProgrammaticSeoError("POLICY_VIOLATION", `non-root page ${page.pageId} must belong to a browseable hierarchy`); return Object.freeze(result);
}

export function compileProgrammaticSeoBundle(catalog: ProgrammaticSeoCatalogSnapshot, policy: ProgrammaticSeoPolicy): ProgrammaticSeoBundle {
  validateProgrammaticSeoCatalogSnapshot(catalog); if (catalog.pages.length > policy.maxPages) throw new ProgrammaticSeoError("POLICY_VIOLATION", "catalog exceeds policy maxPages");
  for (const page of catalog.pages) if (page.routeSegments.length > policy.maxRouteDepth) throw new ProgrammaticSeoError("POLICY_VIOLATION", `page ${page.pageId} exceeds policy maxRouteDepth`);
  const byId = new Map(catalog.pages.map((page) => [page.pageId, page] as const)); const indexable = catalog.pages.filter((page) => page.indexable); const statementOwner = new Map<string, string>();
  for (const page of indexable) {
    if (page.distinctiveStatements.length < policy.minDistinctiveStatements) throw new ProgrammaticSeoError("POLICY_VIOLATION", `indexable page ${page.pageId} lacks distinctive statements`);
    for (const statement of page.distinctiveStatements) { const key = fold(statement); const owner = statementOwner.get(key); if (owner && owner !== page.pageId) throw new ProgrammaticSeoError("POLICY_VIOLATION", `distinctive statement is shared by ${owner} and ${page.pageId}`); statementOwner.set(key, page.pageId); }
  }
  const titles = indexable.map((page) => fold(page.title)); const descriptions = indexable.map((page) => fold(page.description));
  if (new Set(titles).size !== titles.length) throw new ProgrammaticSeoError("POLICY_VIOLATION", "indexable page titles must be unique"); if (new Set(descriptions).size !== descriptions.length) throw new ProgrammaticSeoError("POLICY_VIOLATION", "indexable page descriptions must be unique");
  const sets = indexable.map((page) => shingles(page.bodyText));
  for (let leftIndex = 0; leftIndex < indexable.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < indexable.length; rightIndex += 1) {
    const left = sets[leftIndex]!; const right = sets[rightIndex]!; const maxSize = Math.max(left.size, right.size); const minSize = Math.min(left.size, right.size);
    if (maxSize > 0 && minSize / maxSize <= policy.maxPairwiseShingleSimilarity) continue;
    if (jaccard(left, right) > policy.maxPairwiseShingleSimilarity) throw new ProgrammaticSeoError("POLICY_VIOLATION", `near-duplicate pages ${indexable[leftIndex]!.pageId} and ${indexable[rightIndex]!.pageId} exceed similarity threshold`);
  }
  const pages = Object.freeze(catalog.pages.map((page) => {
    const path = normalizePath(page.routeSegments); const canonicalPath = page.canonicalPath ?? path; if (page.indexable && canonicalPath !== path) throw new ProgrammaticSeoError("POLICY_VIOLATION", `indexable page ${page.pageId} must be self-canonical`);
    const url = new URL(path.slice(1), catalog.baseUrl).toString(); const canonicalUrl = new URL(canonicalPath.slice(1), catalog.baseUrl).toString(); const breadcrumbPageIds = buildBreadcrumb(page, byId);
    const contentCore = { title: page.title, description: page.description, heading: page.heading, bodyText: page.bodyText, distinctiveStatements: page.distinctiveStatements, evidenceRefs: page.evidenceRefs };
    return Object.freeze({ pageId: page.pageId, routeSegments: page.routeSegments, parentPageId: page.parentPageId, locale: page.locale, title: page.title, description: page.description, heading: page.heading, bodyText: page.bodyText, distinctiveStatements: page.distinctiveStatements, evidenceRefs: page.evidenceRefs, updatedAt: page.updatedAt, indexable: page.indexable, path, url, canonicalUrl, breadcrumbPageIds, contentDigest: hash("cortex-programmatic-seo-content-v1", contentCore) });
  }).sort((a, b) => a.path.localeCompare(b.path, "en")));
  if (!pages.some((page) => page.indexable)) throw new ProgrammaticSeoError("POLICY_VIOLATION", "catalog has no indexable pages");
  const staticParams = Object.freeze(pages.filter((page) => page.routeSegments.length > 0).map((page) => Object.freeze({ slug: page.routeSegments })));
  const sitemap = Object.freeze(pages.filter((page) => page.indexable).map((page) => Object.freeze({ url: page.canonicalUrl, lastModified: page.updatedAt })));
  const robots = Object.freeze({ userAgent: "*" as const, allow: "/" as const, disallow: Object.freeze([] as string[]), sitemap: new URL("sitemap.xml", catalog.baseUrl).toString() });
  const core = { schemaVersion: "cortex-programmatic-seo-bundle-v1" as const, siteId: catalog.siteId, baseUrl: catalog.baseUrl, sourceDigest: catalog.digest, policyDigest: policy.digest, pages, staticParams, sitemap, robots };
  return Object.freeze({ ...core, digest: hash("cortex-programmatic-seo-bundle-v1", core) });
}

export function validateProgrammaticSeoBundle(value: ProgrammaticSeoBundle): void {
  if (value.schemaVersion !== "cortex-programmatic-seo-bundle-v1" || identifier(value.siteId, "bundle.siteId") !== value.siteId || normalizeBaseUrl(value.baseUrl) !== value.baseUrl) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "bundle identity is invalid");
  if (!SHA256.test(value.sourceDigest) || !SHA256.test(value.policyDigest) || value.pages.length > MAX_BUNDLE_PAGES) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "bundle bounds/digests are invalid");
  if (value.pages.reduce((total, page) => total + [...page.bodyText].length, 0) > MAX_TOTAL_BODY_CHARACTERS) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "bundle exceeds hard body budget");
  if (new Set(value.pages.map((page) => page.pageId)).size !== value.pages.length || new Set(value.pages.map((page) => page.path)).size !== value.pages.length) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "bundle page identities must be unique");
  for (const page of value.pages) {
    if (page.path !== normalizePath(page.routeSegments) || page.url !== new URL(page.path.slice(1), value.baseUrl).toString()) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `bundle page ${page.pageId} route identity mismatch`);
    if (page.indexable && page.url !== page.canonicalUrl) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `indexable page ${page.pageId} is not self-canonical`);
    const expected = hash("cortex-programmatic-seo-content-v1", { title: page.title, description: page.description, heading: page.heading, bodyText: page.bodyText, distinctiveStatements: page.distinctiveStatements, evidenceRefs: page.evidenceRefs }); if (page.contentDigest !== expected) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `bundle page ${page.pageId} content digest mismatch`);
  }
  const ordered = [...value.pages].sort((a, b) => a.path.localeCompare(b.path, "en")).map((page) => page.pageId); if (canonicalJson(ordered) !== canonicalJson(value.pages.map((page) => page.pageId))) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "bundle pages are not deterministically ordered");
  const params = value.pages.filter((page) => page.routeSegments.length > 0).map((page) => ({ slug: page.routeSegments })); if (canonicalJson(params) !== canonicalJson(value.staticParams)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "static params mismatch");
  const sitemap = value.pages.filter((page) => page.indexable).map((page) => ({ url: page.canonicalUrl, lastModified: page.updatedAt })); if (canonicalJson(sitemap) !== canonicalJson(value.sitemap)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "sitemap mismatch");
  const robots = { userAgent: "*", allow: "/", disallow: [] as string[], sitemap: new URL("sitemap.xml", value.baseUrl).toString() }; if (canonicalJson(robots) !== canonicalJson(value.robots)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "robots artifact mismatch");
  const core = { schemaVersion: value.schemaVersion, siteId: value.siteId, baseUrl: value.baseUrl, sourceDigest: value.sourceDigest, policyDigest: value.policyDigest, pages: value.pages, staticParams: value.staticParams, sitemap: value.sitemap, robots: value.robots }; if (value.digest !== hash("cortex-programmatic-seo-bundle-v1", core)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "bundle digest mismatch");
}
export function createProgrammaticSeoBundleRef(siteIdInput: string, bundleDigest: string, artifactIdInput: string): ProgrammaticSeoBundleRef {
  const siteId = identifier(siteIdInput, "bundleRef.siteId"); if (!SHA256.test(bundleDigest)) throw new ProgrammaticSeoError("INVALID_INPUT", "bundleRef.bundleDigest must be sha256"); const artifactId = identifier(artifactIdInput, "bundleRef.artifactId"); const core = { siteId, bundleDigest, artifactId }; return Object.freeze({ ...core, digest: hash("cortex-programmatic-seo-bundle-ref-v1", core) });
}
export function validateProgrammaticSeoBundleRef(value: ProgrammaticSeoBundleRef): void { const expected = createProgrammaticSeoBundleRef(value.siteId, value.bundleDigest, value.artifactId); if (value.digest !== expected.digest) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "bundle reference digest mismatch"); }
export function createPublishedProgrammaticSeoBundle(bundleRef: ProgrammaticSeoBundleRef, revision: number): PublishedProgrammaticSeoBundle {
  validateProgrammaticSeoBundleRef(bundleRef); if (!Number.isSafeInteger(revision) || revision <= 0) throw new ProgrammaticSeoError("INVALID_INPUT", "published revision must be positive"); const core = { siteId: bundleRef.siteId, bundleRef, revision }; return Object.freeze({ ...core, digest: hash("cortex-programmatic-seo-published-v2", core) });
}
export function validatePublishedProgrammaticSeoBundle(value: PublishedProgrammaticSeoBundle): void {
  validateProgrammaticSeoBundleRef(value.bundleRef); if (value.siteId !== value.bundleRef.siteId || !Number.isSafeInteger(value.revision) || value.revision <= 0) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "published bundle identity invalid"); const core = { siteId: value.siteId, bundleRef: value.bundleRef, revision: value.revision }; if (value.digest !== hash("cortex-programmatic-seo-published-v2", core)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "published bundle digest mismatch");
}

export function toNextMetadata(page: CompiledProgrammaticSeoPage): Readonly<Record<string, unknown>> { return Object.freeze({ title: page.title, description: page.description, alternates: Object.freeze({ canonical: page.canonicalUrl }), robots: Object.freeze({ index: page.indexable, follow: true }) }); }
export function toNextStaticParams(bundle: ProgrammaticSeoBundle): readonly Readonly<{ slug: readonly string[] }>[] { return bundle.staticParams; }
export function toNextSitemap(bundle: ProgrammaticSeoBundle): readonly Readonly<{ url: string; lastModified: Date }>[] { return Object.freeze(bundle.sitemap.map((item) => Object.freeze({ url: item.url, lastModified: new Date(item.lastModified) }))); }
export function toNextRobots(bundle: ProgrammaticSeoBundle): Readonly<Record<string, unknown>> { return Object.freeze({ rules: Object.freeze({ userAgent: bundle.robots.userAgent, allow: bundle.robots.allow, disallow: bundle.robots.disallow }), sitemap: bundle.robots.sitemap }); }

function stateDigest(siteId: string, payload: StatePayload, updatedAt: string): string { return hash("cortex-programmatic-seo-state-record-v1", { siteId, payload, updatedAt }); }
function runDigest(runId: string, siteId: string, policyDigest: string, status: ProgrammaticSeoRunStatus, payload: RunPayload, createdAt: string, updatedAt: string): string { return hash("cortex-programmatic-seo-run-record-v1", { runId, siteId, policyDigest, status, payload, createdAt, updatedAt }); }
function stateProperties(siteId: string, payload: StatePayload, updatedAt: string): Record<string, JsonValue> { return { [STATE.siteId]: siteId, [STATE.payload]: json(payload, "state.payload"), [STATE.digest]: stateDigest(siteId, payload, updatedAt), [STATE.updatedAt]: updatedAt }; }
function runProperties(runId: string, siteId: string, policyDigest: string, status: ProgrammaticSeoRunStatus, payload: RunPayload, createdAt: string, updatedAt: string): Record<string, JsonValue> { return { [RUN.runId]: runId, [RUN.siteId]: siteId, [RUN.policyDigest]: policyDigest, [RUN.status]: status, [RUN.payload]: json(payload, "run.payload"), [RUN.digest]: runDigest(runId, siteId, policyDigest, status, payload, createdAt, updatedAt), [RUN.createdAt]: createdAt, [RUN.updatedAt]: updatedAt }; }
function parseStoredRef(value: JsonValue | undefined, field: string): ProgrammaticSeoBundleRef | null { if (value === null) return null; if (value === undefined) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `${field} missing`); object(value, field); const ref = value as unknown as ProgrammaticSeoBundleRef; try { validateProgrammaticSeoBundleRef(ref); } catch (error) { throw new ProgrammaticSeoError("INTEGRITY_FAILURE", error instanceof Error ? `${field}: ${error.message}` : `${field} invalid`); } return ref; }
function parseStoredPublished(value: JsonValue | undefined, field: string): PublishedProgrammaticSeoBundle | null { if (value === null) return null; if (value === undefined) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", `${field} missing`); object(value, field); const snapshot = value as unknown as PublishedProgrammaticSeoBundle; try { validatePublishedProgrammaticSeoBundle(snapshot); } catch (error) { throw new ProgrammaticSeoError("INTEGRITY_FAILURE", error instanceof Error ? `${field}: ${error.message}` : `${field} invalid`); } return snapshot; }
function parseAction(value: JsonValue | undefined): ProgrammaticSeoPublishAction | null {
  if (value === undefined || value === null) return null; const raw = object(value, "action"); if (raw.kind !== "REPLACE_BUNDLE" || typeof raw.siteId !== "string") throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "stored action malformed");
  const siteId = identifier(raw.siteId, "action.siteId"); const expected = parseStoredPublished(raw.expected, "action.expected"); const desired = parseStoredRef(raw.desired, "action.desired"); if (expected && expected.siteId !== siteId) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "action expected site mismatch"); if (desired && desired.siteId !== siteId) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "action desired site mismatch"); return Object.freeze({ kind: "REPLACE_BUNDLE", siteId, expected, desired });
}
function parseReceipt(value: JsonValue | undefined): ProgrammaticSeoPublishReceipt | null {
  if (value === undefined || value === null) return null; const raw = object(value, "receipt"); if (typeof raw.publisherVersion !== "string" || !raw.publisherVersion.trim() || typeof raw.recoveredAlreadyApplied !== "boolean") throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "stored receipt malformed"); return Object.freeze({ snapshot: parseStoredPublished(raw.snapshot, "receipt.snapshot"), recoveredAlreadyApplied: raw.recoveredAlreadyApplied, publisherVersion: raw.publisherVersion });
}
function parseState(record: ObjectRecord): StateRecord {
  if (record.typeId !== STATE_TYPE) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "state type mismatch"); const siteId = requiredString(record, STATE.siteId); const raw = object(record.properties[STATE.payload], "state.payload"); const policyDigest = nullableDigest(raw.policyDigest, "state.policyDigest"); if (!policyDigest) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "state policy digest invalid");
  const payload: StatePayload = { policyDigest, inFlightRunId: nullableString(raw.inFlightRunId, "state.inFlightRunId"), lastPublishedDigest: nullableDigest(raw.lastPublishedDigest, "state.lastPublishedDigest"), lastInverseAction: parseAction(raw.lastInverseAction), lastMutationAt: nullableString(raw.lastMutationAt, "state.lastMutationAt"), lastRollbackAt: nullableString(raw.lastRollbackAt, "state.lastRollbackAt") };
  const updatedAt = utc(requiredString(record, STATE.updatedAt), "state.updatedAt"); const digest = requiredString(record, STATE.digest); if (digest !== stateDigest(siteId, payload, updatedAt)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "state digest mismatch"); return Object.freeze({ id: record.id, siteId, ...payload, digest, updatedAt, revision: record.revision });
}
function parseRun(record: ObjectRecord): RunRecord {
  if (record.typeId !== RUN_TYPE) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "run type mismatch"); const runId = requiredString(record, RUN.runId); const siteId = requiredString(record, RUN.siteId); const policyDigest = requiredString(record, RUN.policyDigest); if (!SHA256.test(policyDigest)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "run policy digest invalid"); const status = requiredString(record, RUN.status) as ProgrammaticSeoRunStatus; if (!STATUSES.includes(status)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "run status invalid");
  const raw = object(record.properties[RUN.payload], "run.payload"); const mode = raw.mode as ProgrammaticSeoMode; const reason = raw.reason as ProgrammaticSeoReason; if (!MODES.includes(mode) || !REASONS.includes(reason)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "run enum invalid");
  const payload: RunPayload = { mode, reason, sourceDigest: nullableDigest(raw.sourceDigest, "run.sourceDigest"), bundleDigest: nullableDigest(raw.bundleDigest, "run.bundleDigest"), action: parseAction(raw.action), receipt: parseReceipt(raw.receipt), errorCode: nullableString(raw.errorCode, "run.errorCode") };
  const createdAt = utc(requiredString(record, RUN.createdAt), "run.createdAt"); const updatedAt = utc(requiredString(record, RUN.updatedAt), "run.updatedAt"); const digest = requiredString(record, RUN.digest); if (digest !== runDigest(runId, siteId, policyDigest, status, payload, createdAt, updatedAt)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "run digest mismatch"); return Object.freeze({ id: record.id, runId, siteId, policyDigest, status, ...payload, digest, createdAt, updatedAt, revision: record.revision });
}
function conflict(error: unknown): boolean { return error instanceof OntologyTransactionError && error.code === "CONFLICT"; }
function inverseAction(action: ProgrammaticSeoPublishAction, receipt: ProgrammaticSeoPublishReceipt): ProgrammaticSeoPublishAction { return Object.freeze({ kind: "REPLACE_BUNDLE", siteId: action.siteId, expected: receipt.snapshot, desired: action.expected?.bundleRef ?? null }); }
function validateReceipt(action: ProgrammaticSeoPublishAction, receipt: ProgrammaticSeoPublishReceipt): void {
  if (!receipt.publisherVersion.trim()) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "publisher version empty"); if (receipt.snapshot) validatePublishedProgrammaticSeoBundle(receipt.snapshot);
  if (action.desired === null) { if (receipt.snapshot !== null) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "publisher failed to remove bundle"); return; }
  if (!receipt.snapshot || receipt.snapshot.siteId !== action.siteId || receipt.snapshot.bundleRef.digest !== action.desired.digest) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "publisher failed to certify desired bundle reference");
}

export class ProgrammaticSeoEngine {
  readonly schema: ValidatedSchema;
  constructor(private readonly transactions: OntologyTransactionPort, readonly scope: OntologyScope, readonly policy: ProgrammaticSeoPolicy, private readonly catalog: ProgrammaticSeoCatalogProvider, private readonly publisher: ProgrammaticSeoPublisher, private readonly now: () => number = Date.now, private readonly onTelemetry?: (event: ProgrammaticSeoTelemetryEvent) => void, private readonly onTelemetryError?: (error: unknown, event: ProgrammaticSeoTelemetryEvent) => void) { this.schema = schema(scope); }
  private time(): { readonly ms: number; readonly iso: string } { const ms = this.now(); if (!Number.isFinite(ms)) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "engine clock invalid"); return Object.freeze({ ms, iso: new Date(ms).toISOString() }); }
  private stateId(siteId: string): string { return ontologyId("cortex-programmatic-seo-state-v1", { scope: this.scope, siteId }); }
  private runObjectId(runId: string, siteId: string): string { return ontologyId("cortex-programmatic-seo-run-v1", { scope: this.scope, runId, siteId }); }
  private readState(siteId: string): StateRecord | undefined { const raw = this.transactions.getObject(this.scope, this.stateId(siteId)); return raw ? parseState(raw) : undefined; }
  private readRun(runId: string, siteId: string): RunRecord | undefined { const raw = this.transactions.getObject(this.scope, this.runObjectId(runId, siteId)); return raw ? parseRun(raw) : undefined; }
  private result(run: RunRecord): ProgrammaticSeoResult { return Object.freeze({ runId: run.runId, siteId: run.siteId, status: run.status, reason: run.reason, mode: run.mode, bundleDigest: run.bundleDigest, action: run.action, receipt: run.receipt, policyDigest: run.policyDigest, digest: run.digest }); }
  private emit(run: RunRecord, effect: ProgrammaticSeoTelemetryEvent["effect"]): void { if (!this.onTelemetry) return; const event = Object.freeze({ runId: run.runId, siteId: run.siteId, status: run.status, reason: run.reason, mode: run.mode, effect }); try { this.onTelemetry(event); } catch (error) { try { this.onTelemetryError?.(error, event); } catch { /* telemetry must not change transaction semantics */ } } }
  private acquire(runId: string, siteId: string, payload: RunPayload, nowIso: string): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const existing = this.readRun(runId, siteId); if (existing) return existing; const state = this.readState(siteId);
      if (state?.inFlightRunId && state.inFlightRunId !== runId) { const current = this.readRun(state.inFlightRunId, siteId); if (!current) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "state references missing in-flight run"); return current; }
      const nextState: StatePayload = { policyDigest: this.policy.digest, inFlightRunId: runId, lastPublishedDigest: state?.lastPublishedDigest ?? null, lastInverseAction: state?.lastInverseAction ?? null, lastMutationAt: state?.lastMutationAt ?? null, lastRollbackAt: state?.lastRollbackAt ?? null };
      const operations: TransactionOperation[] = [{ kind: "CREATE_OBJECT", record: { id: this.runObjectId(runId, siteId), typeId: RUN_TYPE, scope: this.scope, properties: runProperties(runId, siteId, this.policy.digest, "PREPARED", payload, nowIso, nowIso) } }, state ? { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(siteId, nextState, nowIso) } : { kind: "CREATE_OBJECT", record: { id: this.stateId(siteId), typeId: STATE_TYPE, scope: this.scope, properties: stateProperties(siteId, nextState, nowIso) } }];
      try { this.transactions.transact(this.scope, this.schema, operations); const stored = this.readRun(runId, siteId); if (!stored) throw new ProgrammaticSeoError("PERSISTENCE_FAILURE", "prepared run unreadable"); return stored; } catch (error) { if (conflict(error) && attempt < this.policy.maxWriteRetries) continue; if (conflict(error)) throw new ProgrammaticSeoError("CONFLICT", "run preparation conflicted"); if (error instanceof ProgrammaticSeoError) throw error; throw new ProgrammaticSeoError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run preparation failed"); }
    }
    throw new ProgrammaticSeoError("CONFLICT", "run preparation exhausted retries");
  }
  private finalize(run: RunRecord, status: Exclude<ProgrammaticSeoRunStatus, "PREPARED">, payload: RunPayload, effect: ProgrammaticSeoTelemetryEvent["effect"], inverse: ProgrammaticSeoPublishAction | null): RunRecord {
    for (let attempt = 0; attempt <= this.policy.maxWriteRetries; attempt += 1) {
      const current = this.readRun(run.runId, run.siteId); const state = this.readState(run.siteId); if (!current || !state || state.inFlightRunId !== run.runId) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "run/state lock missing during finalize"); if (current.status !== "PREPARED") return current;
      const nowIso = this.time().iso; const nextState: StatePayload = { policyDigest: state.policyDigest, inFlightRunId: null, lastPublishedDigest: effect === "APPLY" ? payload.bundleDigest : effect === "ROLLBACK" ? payload.receipt?.snapshot?.bundleRef.bundleDigest ?? null : state.lastPublishedDigest, lastInverseAction: effect === "APPLY" ? inverse : effect === "ROLLBACK" ? null : state.lastInverseAction, lastMutationAt: effect === "NONE" ? state.lastMutationAt : nowIso, lastRollbackAt: effect === "ROLLBACK" ? nowIso : state.lastRollbackAt };
      try { this.transactions.transact(this.scope, this.schema, [{ kind: "UPDATE_OBJECT", id: current.id, expectedRevision: current.revision, properties: runProperties(current.runId, current.siteId, current.policyDigest, status, payload, current.createdAt, nowIso) }, { kind: "UPDATE_OBJECT", id: state.id, expectedRevision: state.revision, properties: stateProperties(state.siteId, nextState, nowIso) }]); const stored = this.readRun(run.runId, run.siteId); if (!stored) throw new ProgrammaticSeoError("PERSISTENCE_FAILURE", "finalized run unreadable"); this.emit(stored, effect); return stored; } catch (error) { if (conflict(error) && attempt < this.policy.maxWriteRetries) continue; if (conflict(error)) throw new ProgrammaticSeoError("CONFLICT", "run finalization conflicted"); if (error instanceof ProgrammaticSeoError) throw error; throw new ProgrammaticSeoError("PERSISTENCE_FAILURE", error instanceof Error ? error.message : "run finalization failed"); }
    }
    throw new ProgrammaticSeoError("CONFLICT", "run finalization exhausted retries");
  }
  private async execute(run: RunRecord, executionMode: ProgrammaticSeoMode): Promise<ProgrammaticSeoResult> {
    if (run.status !== "PREPARED") return this.result(run);
    if (!run.action || run.mode !== "ACTIVE") return this.result(this.finalize(run, "NOOP", { mode: run.mode, reason: run.reason, sourceDigest: run.sourceDigest, bundleDigest: run.bundleDigest, action: run.action, receipt: run.receipt, errorCode: run.errorCode }, "NONE", null));
    if (executionMode !== "ACTIVE") throw new ProgrammaticSeoError("POLICY_VIOLATION", `${executionMode} freezes prepared publish`);
    let receipt: ProgrammaticSeoPublishReceipt;
    try { receipt = await this.publisher.apply(run.action); validateReceipt(run.action, receipt); } catch (error) {
      if (error instanceof ProgrammaticSeoPublisherError && error.code === "AMBIGUOUS_PUBLISH_OUTCOME") throw new ProgrammaticSeoError("REMOTE_FAILURE", "bundle publish outcome ambiguous; run remains PREPARED");
      const reason: ProgrammaticSeoReason = error instanceof ProgrammaticSeoPublisherError && error.code === "PUBLISH_CONFLICT" ? "PUBLISH_CONFLICT" : "PUBLISH_FAILURE"; this.finalize(run, "FAILED", { mode: run.mode, reason, sourceDigest: run.sourceDigest, bundleDigest: run.bundleDigest, action: run.action, receipt: null, errorCode: error instanceof Error ? error.message : "unknown publish error" }, "NONE", null); throw new ProgrammaticSeoError("REMOTE_FAILURE", reason);
    }
    const rollback = run.reason === "ROLLBACK_PENDING"; const reason: ProgrammaticSeoReason = rollback ? "ROLLBACK_APPLIED" : receipt.recoveredAlreadyApplied ? "BUNDLE_RECOVERED" : "BUNDLE_APPLIED"; const payload: RunPayload = { mode: run.mode, reason, sourceDigest: run.sourceDigest, bundleDigest: receipt.snapshot?.bundleRef.bundleDigest ?? null, action: run.action, receipt, errorCode: null }; const inverse = rollback ? null : inverseAction(run.action, receipt); return this.result(this.finalize(run, rollback ? "ROLLED_BACK" : "APPLIED", payload, rollback ? "ROLLBACK" : "APPLY", inverse));
  }
  async build(input: ProgrammaticSeoRunInput): Promise<ProgrammaticSeoResult> {
    const runId = identifier(input.runId, "runId"); const siteId = identifier(input.siteId, "siteId"); const mode = input.mode ?? this.policy.mode; if (!MODES.includes(mode)) throw new ProgrammaticSeoError("INVALID_INPUT", "mode invalid");
    const existing = this.readRun(runId, siteId); if (existing) { if (existing.policyDigest !== this.policy.digest) throw new ProgrammaticSeoError("CONFLICT", "runId reused under a different policy"); return this.execute(existing, mode); }
    const state = this.readState(siteId); if (state?.inFlightRunId) { const inFlight = this.readRun(state.inFlightRunId, siteId); if (!inFlight) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "state references missing in-flight run"); if (inFlight.policyDigest !== this.policy.digest) throw new ProgrammaticSeoError("CONFLICT", "prepared run belongs to a different policy revision"); return this.execute(inFlight, mode); }
    if (mode === "KILLED") { const nowIso = this.time().iso; return this.execute(this.acquire(runId, siteId, { mode, reason: "KILL_SWITCH", sourceDigest: null, bundleDigest: null, action: null, receipt: null, errorCode: null }, nowIso), mode); }
    const source = await this.catalog.getCatalog(siteId); validateProgrammaticSeoCatalogSnapshot(source); if (source.siteId !== siteId) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "catalog siteId mismatch"); const now = this.time(); const observedMs = Date.parse(source.observedAt);
    if (observedMs > now.ms || now.ms - observedMs > this.policy.maxCatalogAgeMs) return this.execute(this.acquire(runId, siteId, { mode, reason: "SOURCE_STALE", sourceDigest: source.digest, bundleDigest: null, action: null, receipt: null, errorCode: null }, now.iso), mode);
    const bundle = compileProgrammaticSeoBundle(source, this.policy); const current = await this.publisher.read(siteId); if (current) { validatePublishedProgrammaticSeoBundle(current); if (current.siteId !== siteId) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "publisher current snapshot site mismatch"); }
    if (current?.bundleRef.bundleDigest === bundle.digest) return this.execute(this.acquire(runId, siteId, { mode, reason: "IN_SYNC", sourceDigest: source.digest, bundleDigest: bundle.digest, action: null, receipt: null, errorCode: null }, now.iso), mode);
    if (mode === "OBSERVE_ONLY") return this.execute(this.acquire(runId, siteId, { mode, reason: "OBSERVE_ONLY", sourceDigest: source.digest, bundleDigest: bundle.digest, action: null, receipt: null, errorCode: null }, now.iso), mode);
    let desired: ProgrammaticSeoBundleRef; try { desired = await this.publisher.stage(bundle); validateProgrammaticSeoBundleRef(desired); } catch (error) { throw new ProgrammaticSeoError("REMOTE_FAILURE", error instanceof Error ? `bundle staging failed: ${error.message}` : "bundle staging failed"); }
    if (desired.siteId !== siteId || desired.bundleDigest !== bundle.digest) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "publisher staged a mismatched bundle reference");
    const action: ProgrammaticSeoPublishAction = Object.freeze({ kind: "REPLACE_BUNDLE", siteId, expected: current, desired }); return this.execute(this.acquire(runId, siteId, { mode, reason: "BUNDLE_PENDING", sourceDigest: source.digest, bundleDigest: bundle.digest, action, receipt: null, errorCode: null }, now.iso), mode);
  }
  async rollbackLastMutation(input: Readonly<{ runId: string; siteId: string }>): Promise<ProgrammaticSeoResult> {
    const runId = identifier(input.runId, "runId");
    const siteId = identifier(input.siteId, "siteId");
    const existing = this.readRun(runId, siteId);
    if (existing) {
      if (existing.reason !== "ROLLBACK_PENDING" && existing.reason !== "ROLLBACK_APPLIED") throw new ProgrammaticSeoError("POLICY_VIOLATION", "rollback runId cannot reference a forward bundle mutation");
      return this.execute(existing, "ACTIVE");
    }
    const state = this.readState(siteId);
    if (!state?.lastInverseAction) throw new ProgrammaticSeoError("POLICY_VIOLATION", "no certified bundle mutation is available to roll back");
    if (state.inFlightRunId) {
      const inFlight = this.readRun(state.inFlightRunId, siteId);
      if (!inFlight) throw new ProgrammaticSeoError("INTEGRITY_FAILURE", "state references missing in-flight run");
      if (inFlight.reason !== "ROLLBACK_PENDING") throw new ProgrammaticSeoError("POLICY_VIOLATION", "rollback refuses to reconcile a prepared forward bundle mutation");
      return this.execute(inFlight, "ACTIVE");
    }
    const run = this.acquire(runId, siteId, { mode: "ACTIVE", reason: "ROLLBACK_PENDING", sourceDigest: null, bundleDigest: state.lastInverseAction.desired?.bundleDigest ?? null, action: state.lastInverseAction, receipt: null, errorCode: null }, this.time().iso);
    if (run.reason !== "ROLLBACK_PENDING") throw new ProgrammaticSeoError("POLICY_VIOLATION", "rollback acquisition returned non-rollback work");
    return this.execute(run, "ACTIVE");
  }
}
