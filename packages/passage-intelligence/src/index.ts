import { createHash } from "node:crypto";

const MAX_PASSAGES = 250;
const MAX_EVIDENCE = 1000;
const MAX_TEXT = 50_000;
const AMBIGUOUS = /\b(esto|eso|aquello|lo anterior|lo mencionado|this|that|it|they|them|above|previous(?:ly)?)\b/giu;

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("non-plain object");
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`undefined at ${key}`);
      out[key] = canonical(item);
    }
    return out;
  }
  throw new Error(`unsupported canonical value ${typeof value}`);
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function clean(label: string, value: string, max = 500): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function uniqueIds(label: string, values: readonly { id: string }[]): void {
  const ids = values.map((value) => value.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
}

function tokens(text: string): string[] {
  return text.toLocaleLowerCase("en-US").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export interface PassageEvidence {
  id: string;
  source: string;
  description: string;
}

export interface PassageInput {
  id: string;
  heading: string;
  text: string;
  intent: string;
  entityNames?: readonly string[];
  claimIds?: readonly string[];
  evidenceIds?: readonly string[];
}

export interface Passage extends PassageInput {
  entityNames: readonly string[];
  claimIds: readonly string[];
  evidenceIds: readonly string[];
  passageDigest: string;
}

export interface PassagePageInput {
  url: string;
  indexable: boolean;
  crawlAllowed: boolean;
  passages: readonly PassageInput[];
  evidence?: readonly PassageEvidence[];
}

export interface PassagePage {
  url: string;
  indexable: boolean;
  crawlAllowed: boolean;
  passages: readonly Passage[];
  evidence: readonly PassageEvidence[];
  pageDigest: string;
}

export type PassageIssueCode =
  | "AMBIGUOUS_LOCAL_REFERENCE"
  | "HEADING_CONTENT_MISMATCH"
  | "WEAK_ANSWERABILITY"
  | "INSUFFICIENT_LOCAL_CONTEXT"
  | "CLAIM_WITHOUT_LOCAL_EVIDENCE"
  | "TOO_SHORT"
  | "TOO_LONG";

export interface PassageIssue {
  code: PassageIssueCode;
  detail: string;
}

export interface PassageAssessment {
  passageId: string;
  passageDigest: string;
  score: number;
  metrics: Readonly<{
    headingAlignment: number;
    answerability: number;
    contextSufficiency: number;
    evidenceLocality: number;
    segmentationFitness: number;
  }>;
  issues: readonly PassageIssue[];
  assessmentDigest: string;
}

export type PageStatus = "READY" | "NEEDS_WORK" | "BLOCKED";
export type RecommendationKind = "REHEADING" | "ADD_CONTEXT" | "ADD_EVIDENCE" | "SPLIT" | "EXPAND" | "DEDUPLICATE";

export interface PassageRecommendation {
  kind: RecommendationKind;
  passageIds: readonly string[];
  reason: string;
}

export interface PageAssessment {
  status: PageStatus;
  pageDigest: string;
  score: number;
  passages: readonly PassageAssessment[];
  duplicatePairs: readonly Readonly<{ left: string; right: string; similarity: number }>[];
  recommendations: readonly PassageRecommendation[];
  assessmentDigest: string;
  nonClaim: "INTERNAL_PASSAGE_DIAGNOSTIC_NOT_INDEXING_EVIDENCE";
}

export function createPassage(input: PassageInput): Passage {
  const core = {
    id: clean("passage id", input.id, 160),
    heading: clean("heading", input.heading, 300),
    text: clean("passage text", input.text, MAX_TEXT),
    intent: clean("passage intent", input.intent, 500),
    entityNames: Object.freeze([...(input.entityNames ?? [])].map((value) => clean("entity name", value, 300)).sort()),
    claimIds: Object.freeze([...(input.claimIds ?? [])].map((value) => clean("claim id", value, 160)).sort()),
    evidenceIds: Object.freeze([...(input.evidenceIds ?? [])].map((value) => clean("evidence id", value, 160)).sort()),
  };
  if (new Set(core.entityNames).size !== core.entityNames.length) throw new Error("duplicate entity names");
  if (new Set(core.claimIds).size !== core.claimIds.length) throw new Error("duplicate claim ids");
  if (new Set(core.evidenceIds).size !== core.evidenceIds.length) throw new Error("duplicate evidence ids");
  return Object.freeze({ ...core, passageDigest: digestValue(core) });
}

function safeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("page URL must be HTTP(S)");
  if (url.username || url.password) throw new Error("page URL must not contain credentials");
  url.hash = "";
  return url.toString();
}

export function createPage(input: PassagePageInput): PassagePage {
  if (input.passages.length > MAX_PASSAGES) throw new Error(`passages exceeds ${MAX_PASSAGES}`);
  const evidence = (input.evidence ?? []).map((item) => Object.freeze({
    id: clean("evidence id", item.id, 160),
    source: clean("evidence source", item.source, 2000),
    description: clean("evidence description", item.description, 2000),
  }));
  if (evidence.length > MAX_EVIDENCE) throw new Error(`evidence exceeds ${MAX_EVIDENCE}`);
  uniqueIds("evidence", evidence);
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const passages = input.passages.map(createPassage);
  uniqueIds("passages", passages);
  for (const passage of passages) {
    for (const evidenceId of passage.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`passage ${passage.id} references unknown evidence ${evidenceId}`);
    }
  }
  const core = {
    url: safeUrl(input.url),
    indexable: input.indexable === true,
    crawlAllowed: input.crawlAllowed === true,
    passages: Object.freeze(passages),
    evidence: Object.freeze(evidence),
  };
  return Object.freeze({ ...core, pageDigest: digestValue(core) });
}

export function validatePage(page: PassagePage): void {
  const rebuilt = createPage({
    url: page.url,
    indexable: page.indexable,
    crawlAllowed: page.crawlAllowed,
    passages: page.passages,
    evidence: page.evidence,
  });
  if (rebuilt.pageDigest !== page.pageDigest) throw new Error("page digest mismatch");
  if (rebuilt.passages.some((passage, index) => passage.passageDigest !== page.passages[index]?.passageDigest)) throw new Error("passage digest mismatch");
}

function ratioOfLocalEvidence(passage: Passage): number {
  if (passage.claimIds.length === 0) return 1;
  return passage.evidenceIds.length > 0 ? 1 : 0;
}

export function assessPassage(passage: Passage): PassageAssessment {
  if (createPassage(passage).passageDigest !== passage.passageDigest) throw new Error("passage digest mismatch");
  const headingTokens = tokens(passage.heading);
  const textTokens = tokens(passage.text);
  const intentTokens = tokens(passage.intent);
  const wordCount = textTokens.length;
  const headingAlignment = Math.min(1, jaccard([...headingTokens, ...intentTokens], textTokens) * 4);
  const sentenceCount = Math.max(1, (passage.text.match(/[.!?]+/g) ?? []).length);
  const answerability = Math.min(1, Math.max(0, (wordCount >= 45 ? 0.55 : wordCount / 82) + (sentenceCount >= 2 ? 0.25 : 0) + (headingAlignment >= 0.35 ? 0.2 : 0)));
  const ambiguousCount = (passage.text.match(AMBIGUOUS) ?? []).length;
  const entityCoverage = passage.entityNames.length === 0 ? 1 : passage.entityNames.filter((entity) => passage.text.toLocaleLowerCase().includes(entity.toLocaleLowerCase())).length / passage.entityNames.length;
  const contextSufficiency = Math.max(0, Math.min(1, entityCoverage - Math.min(0.8, ambiguousCount * 0.25)));
  const evidenceLocality = ratioOfLocalEvidence(passage);
  const segmentationFitness = wordCount < 35 ? wordCount / 35 : wordCount > 650 ? Math.max(0, 1 - (wordCount - 650) / 650) : 1;
  const metrics = Object.freeze({ headingAlignment, answerability, contextSufficiency, evidenceLocality, segmentationFitness });
  const issues: PassageIssue[] = [];
  if (ambiguousCount > 0) issues.push({ code: "AMBIGUOUS_LOCAL_REFERENCE", detail: "Passage contains references that may depend on context outside the section." });
  if (headingAlignment < 0.2) issues.push({ code: "HEADING_CONTENT_MISMATCH", detail: "Heading/intent terms have weak lexical overlap with the passage." });
  if (answerability < 0.6) issues.push({ code: "WEAK_ANSWERABILITY", detail: "Passage is unlikely to answer its stated intent on its own." });
  if (contextSufficiency < 0.6) issues.push({ code: "INSUFFICIENT_LOCAL_CONTEXT", detail: "Named entities or references are not sufficiently established inside the passage." });
  if (evidenceLocality < 1) issues.push({ code: "CLAIM_WITHOUT_LOCAL_EVIDENCE", detail: "Passage declares claims but carries no local evidence reference." });
  if (wordCount < 35) issues.push({ code: "TOO_SHORT", detail: `Passage has ${wordCount} words and may be a fragment rather than a useful section.` });
  if (wordCount > 650) issues.push({ code: "TOO_LONG", detail: `Passage has ${wordCount} words and should be reviewed for useful subdivision.` });
  const score = headingAlignment * 0.2 + answerability * 0.25 + contextSufficiency * 0.2 + evidenceLocality * 0.2 + segmentationFitness * 0.15;
  const core = { passageId: passage.id, passageDigest: passage.passageDigest, score, metrics, issues: Object.freeze(issues) };
  return Object.freeze({ ...core, assessmentDigest: digestValue(core) });
}

export function duplicatePassages(passages: readonly Passage[], threshold = 0.72): readonly Readonly<{ left: string; right: string; similarity: number }>[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("duplication threshold must be within [0,1]");
  if (passages.length > MAX_PASSAGES) throw new Error(`passages exceeds ${MAX_PASSAGES}`);
  const out: Array<{ left: string; right: string; similarity: number }> = [];
  for (let i = 0; i < passages.length; i += 1) {
    for (let j = i + 1; j < passages.length; j += 1) {
      const similarity = jaccard(tokens(passages[i]!.text), tokens(passages[j]!.text));
      if (similarity >= threshold) out.push({ left: passages[i]!.id, right: passages[j]!.id, similarity });
    }
  }
  return Object.freeze(out.sort((a, b) => `${a.left}:${a.right}`.localeCompare(`${b.left}:${b.right}`)));
}

function recommendationsFor(passages: readonly PassageAssessment[], duplicates: readonly { left: string; right: string }[]): readonly PassageRecommendation[] {
  const recommendations: PassageRecommendation[] = [];
  for (const assessment of passages) {
    const issueCodes = new Set(assessment.issues.map((issue) => issue.code));
    const id = assessment.passageId;
    if (issueCodes.has("HEADING_CONTENT_MISMATCH")) recommendations.push({ kind: "REHEADING", passageIds: [id], reason: "Align the heading with the section's actual user need and content." });
    if (issueCodes.has("AMBIGUOUS_LOCAL_REFERENCE") || issueCodes.has("INSUFFICIENT_LOCAL_CONTEXT")) recommendations.push({ kind: "ADD_CONTEXT", passageIds: [id], reason: "Make entities and referents explicit inside the section." });
    if (issueCodes.has("CLAIM_WITHOUT_LOCAL_EVIDENCE")) recommendations.push({ kind: "ADD_EVIDENCE", passageIds: [id], reason: "Bind important claims to evidence available within the section context." });
    if (issueCodes.has("TOO_LONG")) recommendations.push({ kind: "SPLIT", passageIds: [id], reason: "Review the section for a human-useful semantic subdivision; do not create doorway URLs." });
    if (issueCodes.has("TOO_SHORT")) recommendations.push({ kind: "EXPAND", passageIds: [id], reason: "Add enough local explanation to make the section independently useful." });
  }
  for (const pair of duplicates) recommendations.push({ kind: "DEDUPLICATE", passageIds: [pair.left, pair.right], reason: "Consolidate overlapping sections while preserving the clearest user-facing structure." });
  return Object.freeze(recommendations);
}

export function assessPage(page: PassagePage): PageAssessment {
  validatePage(page);
  const passages = Object.freeze(page.passages.map(assessPassage));
  const duplicatePairs = duplicatePassages(page.passages);
  const score = passages.length === 0 ? 0 : passages.reduce((sum, item) => sum + item.score, 0) / passages.length;
  const recommendations = recommendationsFor(passages, duplicatePairs);
  const status: PageStatus = !page.indexable || !page.crawlAllowed ? "BLOCKED" : score >= 0.72 && duplicatePairs.length === 0 ? "READY" : "NEEDS_WORK";
  const core = {
    status,
    pageDigest: page.pageDigest,
    score,
    passages,
    duplicatePairs,
    recommendations,
    nonClaim: "INTERNAL_PASSAGE_DIAGNOSTIC_NOT_INDEXING_EVIDENCE" as const,
  };
  return Object.freeze({ ...core, assessmentDigest: digestValue(core) });
}

export function validateAssessment(page: PassagePage, assessment: PageAssessment): void {
  const expected = assessPage(page);
  if (expected.assessmentDigest !== assessment.assessmentDigest) throw new Error("assessment replay mismatch");
  if (digestValue(expected) !== digestValue(assessment)) throw new Error("assessment content mismatch");
}
