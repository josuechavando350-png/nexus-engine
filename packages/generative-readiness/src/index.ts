import { createHash } from "node:crypto";

export type EvidenceKind = "FIRST_PARTY_DATA" | "FIRST_HAND_EXPERIENCE" | "PRIMARY_SOURCE" | "EXTERNAL_REFERENCE";
export type ClaimKind = "FACT" | "EXPERIENCE" | "OPINION" | "OFFER";
export type ReadinessStatus = "READY" | "NEEDS_WORK" | "LIMITED" | "BLOCKED";
export type SnippetPolicy = "FULL" | "NONE" | Readonly<{ maxChars: number }>;

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  source: string;
}

export interface Claim {
  id: string;
  text: string;
  kind: ClaimKind;
  evidenceIds: readonly string[];
  volatile: boolean;
}

export interface EntityReference {
  id: string;
  name: string;
  type: string;
  description?: string;
  sameAs?: readonly string[];
}

export interface OriginalContribution {
  id: string;
  description: string;
  evidenceIds: readonly string[];
}

export interface Section {
  id: string;
  heading: string;
  text: string;
  claimIds: readonly string[];
  dataNoSnippet: boolean;
}

export interface MediaContext {
  url: string;
  context: string;
}

export interface GenerativePageInput {
  url: string;
  title: string;
  description: string;
  language: string;
  modifiedDate: string;
  indexable: boolean;
  crawlAllowed: boolean;
  snippet: SnippetPolicy;
  sections: readonly Section[];
  entities: readonly EntityReference[];
  evidence: readonly Evidence[];
  claims: readonly Claim[];
  questions: readonly string[];
  originalContributions: readonly OriginalContribution[];
  media: readonly MediaContext[];
}

export interface GenerativePage extends GenerativePageInput {
  pageDigest: string;
}

export interface ReadinessMetrics {
  evidenceCoverage: number;
  primaryEvidenceCoverage: number;
  entityClarity: number;
  originalContributionScore: number;
  questionCoverage: number;
  freshnessCoverage: number;
  mediaContext: number;
}

export interface ReadinessIssue {
  code: "SEARCH_INELIGIBLE" | "SNIPPET_DISABLED" | "SNIPPET_LIMITED" | "SECTION_SNIPPET_LIMITED" | "INSUFFICIENT_CLAIM_EVIDENCE" | "INSUFFICIENT_PRIMARY_EVIDENCE" | "WEAK_ENTITY_CLARITY" | "WEAK_ORIGINAL_CONTRIBUTION" | "LOW_QUESTION_COVERAGE" | "STALE_VOLATILE_CONTENT" | "WEAK_MEDIA_CONTEXT";
  detail: string;
}

export interface Readiness {
  status: ReadinessStatus;
  score: number;
  metrics: ReadinessMetrics;
  issues: readonly ReadinessIssue[];
  pageDigest: string;
  observedAt: string;
  readinessDigest: string;
}

const MAX_SECTIONS = 500;
const MAX_ENTITIES = 500;
const MAX_EVIDENCE = 1_000;
const MAX_CLAIMS = 1_000;
const MAX_QUESTIONS = 250;
const MAX_CONTRIBUTIONS = 250;
const MAX_MEDIA = 500;

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("canonical JSON rejects cyclic values");
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical JSON rejects non-plain objects");
    seen.add(object);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }
export function digestValue(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function cleanText(value: string, label: string, maxLength = 20_000): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${label} required`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function canonicalHttpUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${label} must be HTTP(S)`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  url.hash = "";
  return url.toString();
}

function canonicalTimestamp(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp/date`);
  return new Date(time).toISOString();
}

function assertBudget<T>(values: readonly T[], maximum: number, label: string): void {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  if (values.length > maximum) throw new Error(`${label} exceeds ${maximum}`);
}

function assertUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
}

function normalizeIds(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value) => cleanText(value, label, 200)).sort();
  assertUnique(normalized, label);
  return Object.freeze(normalized);
}

function normalizeSnippet(input: SnippetPolicy): SnippetPolicy {
  if (input === "FULL" || input === "NONE") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid snippet policy");
  if (!Number.isInteger(input.maxChars) || input.maxChars < 0 || input.maxChars > 1_000_000) throw new Error("maxChars must be an integer between 0 and 1000000");
  return Object.freeze({ maxChars: input.maxChars });
}

function normalizeInput(input: GenerativePageInput): GenerativePageInput {
  assertBudget(input.sections, MAX_SECTIONS, "sections");
  assertBudget(input.entities, MAX_ENTITIES, "entities");
  assertBudget(input.evidence, MAX_EVIDENCE, "evidence");
  assertBudget(input.claims, MAX_CLAIMS, "claims");
  assertBudget(input.questions, MAX_QUESTIONS, "questions");
  assertBudget(input.originalContributions, MAX_CONTRIBUTIONS, "originalContributions");
  assertBudget(input.media, MAX_MEDIA, "media");

  const evidence = input.evidence.map((item) => Object.freeze({
    id: cleanText(item.id, "evidence id", 200),
    kind: item.kind,
    source: cleanText(item.source, "evidence source", 2_000),
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (!evidence.every((item) => ["FIRST_PARTY_DATA", "FIRST_HAND_EXPERIENCE", "PRIMARY_SOURCE", "EXTERNAL_REFERENCE"].includes(item.kind))) throw new Error("invalid evidence kind");
  assertUnique(evidence.map((item) => item.id), "evidence");
  const evidenceIds = new Set(evidence.map((item) => item.id));

  const claims = input.claims.map((item) => Object.freeze({
    id: cleanText(item.id, "claim id", 200),
    text: cleanText(item.text, "claim text"),
    kind: item.kind,
    evidenceIds: normalizeIds(item.evidenceIds, "claim evidence ids"),
    volatile: item.volatile === true,
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (!claims.every((item) => ["FACT", "EXPERIENCE", "OPINION", "OFFER"].includes(item.kind))) throw new Error("invalid claim kind");
  assertUnique(claims.map((item) => item.id), "claims");
  for (const claim of claims) for (const evidenceId of claim.evidenceIds) if (!evidenceIds.has(evidenceId)) throw new Error(`claim ${claim.id} references unknown evidence ${evidenceId}`);
  const claimIds = new Set(claims.map((item) => item.id));

  const sections = input.sections.map((item) => Object.freeze({
    id: cleanText(item.id, "section id", 200),
    heading: cleanText(item.heading, "section heading", 1_000),
    text: cleanText(item.text, "section text"),
    claimIds: normalizeIds(item.claimIds, "section claim ids"),
    dataNoSnippet: item.dataNoSnippet === true,
  })).sort((a, b) => a.id.localeCompare(b.id));
  assertUnique(sections.map((item) => item.id), "sections");
  for (const section of sections) for (const claimId of section.claimIds) if (!claimIds.has(claimId)) throw new Error(`section ${section.id} references unknown claim ${claimId}`);

  const entities = input.entities.map((item) => Object.freeze({
    id: cleanText(item.id, "entity id", 200),
    name: cleanText(item.name, "entity name", 1_000),
    type: cleanText(item.type, "entity type", 200),
    ...(item.description === undefined ? {} : { description: cleanText(item.description, "entity description", 4_000) }),
    ...(item.sameAs === undefined ? {} : { sameAs: Object.freeze(item.sameAs.map((value) => canonicalHttpUrl(value, "entity sameAs")).sort()) }),
  })).sort((a, b) => a.id.localeCompare(b.id));
  assertUnique(entities.map((item) => item.id), "entities");

  const originalContributions = input.originalContributions.map((item) => Object.freeze({
    id: cleanText(item.id, "original contribution id", 200),
    description: cleanText(item.description, "original contribution description", 8_000),
    evidenceIds: normalizeIds(item.evidenceIds, "original contribution evidence ids"),
  })).sort((a, b) => a.id.localeCompare(b.id));
  assertUnique(originalContributions.map((item) => item.id), "originalContributions");
  for (const contribution of originalContributions) for (const evidenceId of contribution.evidenceIds) if (!evidenceIds.has(evidenceId)) throw new Error(`contribution ${contribution.id} references unknown evidence ${evidenceId}`);

  const questions = input.questions.map((item) => cleanText(item, "question", 2_000)).sort();
  if (new Set(questions).size !== questions.length) throw new Error("questions contains duplicates");

  const media = input.media.map((item) => Object.freeze({
    url: canonicalHttpUrl(item.url, "media URL"),
    context: cleanText(item.context, "media context", 4_000),
  })).sort((a, b) => a.url.localeCompare(b.url));

  return Object.freeze({
    url: canonicalHttpUrl(input.url, "page URL"),
    title: cleanText(input.title, "title", 2_000),
    description: cleanText(input.description, "description", 5_000),
    language: cleanText(input.language, "language", 100),
    modifiedDate: canonicalTimestamp(input.modifiedDate, "modifiedDate"),
    indexable: input.indexable === true,
    crawlAllowed: input.crawlAllowed === true,
    snippet: normalizeSnippet(input.snippet),
    sections: Object.freeze(sections),
    entities: Object.freeze(entities),
    evidence: Object.freeze(evidence),
    claims: Object.freeze(claims),
    questions: Object.freeze(questions),
    originalContributions: Object.freeze(originalContributions),
    media: Object.freeze(media),
  });
}

export function createPage(input: GenerativePageInput): GenerativePage {
  const core = normalizeInput(input);
  return Object.freeze({ ...core, pageDigest: digestValue(core) });
}

export function validatePage(page: GenerativePage): void {
  const rebuilt = createPage(page);
  if (page.pageDigest !== rebuilt.pageDigest) throw new Error("generative page digest mismatch");
  const { pageDigest: _leftDigest, ...left } = page;
  const { pageDigest: _rightDigest, ...right } = rebuilt;
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error("generative page is not canonical");
}

function ratio(numerator: number, denominator: number, emptyValue = 0): number {
  return denominator === 0 ? emptyValue : numerator / denominator;
}

function primaryEvidence(kind: EvidenceKind): boolean { return kind === "PRIMARY_SOURCE" || kind === "FIRST_PARTY_DATA" || kind === "FIRST_HAND_EXPERIENCE"; }

export function assess(page: GenerativePage, observedAt: string): Readiness {
  validatePage(page);
  const observedIso = canonicalTimestamp(observedAt, "observedAt");
  const observedTime = Date.parse(observedIso);
  const modifiedTime = Date.parse(page.modifiedDate);
  if (modifiedTime > observedTime + 5 * 60_000) throw new Error("modifiedDate cannot materially postdate observedAt");

  const evidenceById = new Map(page.evidence.map((item) => [item.id, item]));
  const assessableClaims = page.claims.filter((claim) => claim.kind !== "OPINION");
  const supportedClaims = assessableClaims.filter((claim) => claim.evidenceIds.some((id) => evidenceById.has(id)));
  const primarySupportedClaims = assessableClaims.filter((claim) => claim.evidenceIds.some((id) => {
    const evidence = evidenceById.get(id);
    return evidence ? primaryEvidence(evidence.kind) : false;
  }));
  const clearEntities = page.entities.filter((entity) => (entity.description?.length ?? 0) >= 20 || (entity.sameAs?.length ?? 0) > 0);
  const supportedContributions = page.originalContributions.filter((item) => item.description.length >= 40 && item.evidenceIds.length > 0);
  const volatileClaims = page.claims.filter((claim) => claim.volatile);
  const ageDays = Math.max(0, (observedTime - modifiedTime) / 86_400_000);
  const freshnessCoverage = volatileClaims.length === 0 ? 1 : ageDays <= 30 ? 1 : ageDays <= 90 ? 0.75 : ageDays <= 180 ? 0.5 : 0;
  const contextualMedia = page.media.filter((item) => item.context.length >= 20);

  const metrics: ReadinessMetrics = Object.freeze({
    evidenceCoverage: ratio(supportedClaims.length, assessableClaims.length),
    primaryEvidenceCoverage: ratio(primarySupportedClaims.length, assessableClaims.length),
    entityClarity: ratio(clearEntities.length, page.entities.length),
    originalContributionScore: Math.min(1, supportedContributions.length / 2),
    questionCoverage: Math.min(1, page.questions.filter((question) => question.length >= 8).length / 4),
    freshnessCoverage,
    mediaContext: ratio(contextualMedia.length, page.media.length, 1),
  });

  const score = metrics.evidenceCoverage * 0.22
    + metrics.primaryEvidenceCoverage * 0.13
    + metrics.entityClarity * 0.12
    + metrics.originalContributionScore * 0.20
    + metrics.questionCoverage * 0.10
    + metrics.freshnessCoverage * 0.13
    + metrics.mediaContext * 0.10;

  const issues: ReadinessIssue[] = [];
  if (!page.indexable || !page.crawlAllowed) issues.push({ code: "SEARCH_INELIGIBLE", detail: "Page is not both indexable and crawl-allowed." });
  if (page.snippet === "NONE") issues.push({ code: "SNIPPET_DISABLED", detail: "nosnippet prevents snippet eligibility required for supporting links in Google Search AI features." });
  if (typeof page.snippet === "object") issues.push({ code: "SNIPPET_LIMITED", detail: `max-snippet limits reusable snippet text to ${page.snippet.maxChars} characters.` });
  if (page.sections.some((section) => section.dataNoSnippet)) issues.push({ code: "SECTION_SNIPPET_LIMITED", detail: "One or more sections exclude text from snippets with data-nosnippet." });
  if (metrics.evidenceCoverage < 0.7) issues.push({ code: "INSUFFICIENT_CLAIM_EVIDENCE", detail: "Fewer than 70% of non-opinion claims are linked to declared evidence." });
  if (metrics.primaryEvidenceCoverage < 0.4) issues.push({ code: "INSUFFICIENT_PRIMARY_EVIDENCE", detail: "Fewer than 40% of non-opinion claims are linked to primary/first-party/first-hand evidence." });
  if (metrics.entityClarity < 0.6) issues.push({ code: "WEAK_ENTITY_CLARITY", detail: "Entity references lack enough descriptions or sameAs identifiers." });
  if (metrics.originalContributionScore < 0.5) issues.push({ code: "WEAK_ORIGINAL_CONTRIBUTION", detail: "Original contributions are insufficiently described and evidence-linked." });
  if (metrics.questionCoverage < 0.5) issues.push({ code: "LOW_QUESTION_COVERAGE", detail: "The page addresses too few explicit user questions for the diagnostic target." });
  if (metrics.freshnessCoverage < 0.5) issues.push({ code: "STALE_VOLATILE_CONTENT", detail: "Volatile claims are older than the configured 180-day diagnostic window." });
  if (metrics.mediaContext < 0.5) issues.push({ code: "WEAK_MEDIA_CONTEXT", detail: "Most media lacks sufficient textual context." });

  const blocked = !page.indexable || !page.crawlAllowed || page.snippet === "NONE";
  const qualityReady = score >= 0.75 && metrics.evidenceCoverage >= 0.7 && metrics.originalContributionScore >= 0.5;
  const limited = typeof page.snippet === "object" || page.sections.some((section) => section.dataNoSnippet);
  const status: ReadinessStatus = blocked ? "BLOCKED" : !qualityReady ? "NEEDS_WORK" : limited ? "LIMITED" : "READY";
  const core = { status, score, metrics, issues: Object.freeze(issues), pageDigest: page.pageDigest, observedAt: observedIso };
  return Object.freeze({ ...core, readinessDigest: digestValue(core) });
}

export function validateReadiness(page: GenerativePage, readiness: Readiness): void {
  const rebuilt = assess(page, readiness.observedAt);
  if (canonicalJson(rebuilt) !== canonicalJson(readiness)) throw new Error("readiness replay mismatch");
}

export function robotsSnippetControls(page: GenerativePage): readonly string[] {
  validatePage(page);
  if (page.snippet === "NONE") return Object.freeze(["nosnippet"]);
  if (typeof page.snippet === "object") return Object.freeze([`max-snippet:${page.snippet.maxChars}`]);
  return Object.freeze([]);
}

export function dataNoSnippetSectionIds(page: GenerativePage): readonly string[] {
  validatePage(page);
  return Object.freeze(page.sections.filter((section) => section.dataNoSnippet).map((section) => section.id));
}

export const GENERATIVE_READINESS_NON_CLAIMS = Object.freeze([
  "No special GEO markup or AI text file is required for Google AI Overviews or AI Mode.",
  "A readiness score is an internal NEXUS diagnostic and does not predict ranking, indexing, traffic, or AI citation.",
  "Search Console Web performance does not provide a dedicated per-citation AI Overview/AI Mode API dimension.",
]);
