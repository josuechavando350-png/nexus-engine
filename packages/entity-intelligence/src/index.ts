import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const MAX_SECTIONS = 500;
const MAX_EXPECTED = 500;
const MAX_ENTITIES = 1_000;
const MAX_MENTIONS_PER_ENTITY = 1_000;
const MAX_TEXT_BYTES = 2_000_000;
const MAX_TEXT_FIELD = 50_000;
const MAX_NAME = 1_000;
const MAX_ID = 200;
const MAX_URL = 4_096;
const MAX_TYPES = 100;
const MAX_KG_CANDIDATES = 25;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const EXTERNAL_AUTHORITY = "UNATTESTED_PROVIDER_RESPONSE" as const;
export const NON_CLAIM = "ENTITY_INTELLIGENCE_INTERNAL_DIAGNOSTIC_NOT_GOOGLE_RANKING_OR_AUTHORITY_EVIDENCE" as const;

export interface SectionInput {
  id: string;
  heading: string;
  text: string;
}

export interface ExpectedEntityInput {
  id: string;
  name: string;
  aliases?: readonly string[];
  schemaTypes?: readonly string[];
  minimumSalience?: number;
  minimumDistinctSections?: number;
  requireKnowledgeGraph?: boolean;
}

export interface ExpectedEntity {
  id: string;
  name: string;
  aliases: readonly string[];
  schemaTypes: readonly string[];
  minimumSalience: number;
  minimumDistinctSections: number;
  requireKnowledgeGraph: boolean;
}

export interface EntitySection {
  id: string;
  byteStart: number;
  byteEnd: number;
}

export interface EntityDocument {
  url: string;
  language: string | null;
  content: string;
  sections: readonly EntitySection[];
  expected: readonly ExpectedEntity[];
  digest: string;
}

export interface DetectedMention {
  content: string;
  beginOffset: number;
  sectionId: string | null;
}

export interface DetectedEntity {
  name: string;
  type: string;
  salience: number;
  mid: string | null;
  wikipediaUrl: string | null;
  mentions: readonly DetectedMention[];
  digest: string;
}

export interface AnalysisSnapshot {
  documentDigest: string;
  provider: "GOOGLE_CLOUD_NLP_V2";
  providerAuthority: typeof EXTERNAL_AUTHORITY;
  providerPayloadDigest: string;
  entities: readonly DetectedEntity[];
  digest: string;
}

export interface KgCandidate {
  cloudMid: string;
  googleKgMid: string | null;
  name: string;
  types: readonly string[];
  url: string | null;
  digest: string;
}

export type ResolutionStatus = "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
export type ResolutionSource = "NLP_MID_LOOKUP" | "KNOWLEDGE_GRAPH_SEARCH";

export interface ScoredKgCandidate {
  candidate: KgCandidate;
  score: number;
}

export interface EntityResolution {
  entityDigest: string;
  expectedId: string | null;
  status: ResolutionStatus;
  source: ResolutionSource;
  provider: "GOOGLE_ENTERPRISE_KG_V1";
  providerAuthority: typeof EXTERNAL_AUTHORITY;
  providerPayloadDigest: string;
  resolved: KgCandidate | null;
  candidates: readonly ScoredKgCandidate[];
  digest: string;
}

export interface EntityAssessmentResult {
  id: string;
  present: boolean;
  salience: number;
  sections: number;
  knowledgeGraphStatus: ResolutionStatus | "NOT_REQUIRED" | "MISSING";
  pass: boolean;
}

export interface EntityAssessment {
  status: "READY" | "NEEDS_WORK";
  documentDigest: string;
  snapshotDigest: string;
  results: readonly EntityAssessmentResult[];
  nonClaim: typeof NON_CLAIM;
  digest: string;
}

type JsonRecord = Record<string, unknown>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  return value as JsonRecord;
}

function assertAllowedKeys(record: JsonRecord, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (RESERVED_KEYS.has(key)) throw new Error(`${label} contains reserved key ${key}`);
    if (!set.has(key)) throw new Error(`${label} contains unknown key ${key}`);
  }
}

function canonicalize(value: unknown, seen = new WeakSet<object>(), path = "$" ): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const result = value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const record = asRecord(value, path);
    if (seen.has(value)) throw new Error(`cyclic value at ${path}`);
    seen.add(value);
    const out: JsonRecord = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      if (RESERVED_KEYS.has(key)) throw new Error(`reserved key ${key} at ${path}`);
      const item = record[key];
      if (item === undefined) throw new Error(`undefined at ${path}.${key}`);
      out[key] = canonicalize(item, seen, `${path}.${key}`);
    }
    seen.delete(value);
    return out;
  }
  throw new Error(`unsupported canonical value ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cleanString(label: string, value: unknown, max: number, collapse = true): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = collapse ? value.replace(/\s+/gu, " ").trim() : value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function cleanId(label: string, value: unknown): string {
  return cleanString(label, value, MAX_ID);
}

function cleanOptionalString(label: string, value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return cleanString(label, value, max);
}

function safeHttpUrl(label: string, value: unknown): string {
  const raw = cleanString(label, value, MAX_URL, false);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${label} must use HTTP(S)`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  parsed.hash = "";
  return parsed.toString();
}

function optionalHttpUrl(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return safeHttpUrl(label, value);
}

function cleanLanguage(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const language = cleanString("language", value, 35);
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(language)) throw new Error("language must be a bounded BCP47-like tag");
  return language;
}

function numberInRange(label: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be finite and in [${min}, ${max}]`);
  }
  return value;
}

function nonNegativeInteger(label: string, value: unknown, max: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > max) {
    throw new Error(`${label} must be an integer in [0, ${max}]`);
  }
  return value;
}

function normalizeExpected(value: unknown): ExpectedEntity {
  const record = asRecord(value, "expected entity");
  assertAllowedKeys(record, ["id", "name", "aliases", "schemaTypes", "minimumSalience", "minimumDistinctSections", "requireKnowledgeGraph"], "expected entity");
  const id = cleanId("expected.id", record.id);
  const name = cleanString("expected.name", record.name, MAX_NAME);
  const aliases = record.aliases === undefined ? [] : normalizeStringArray("expected.aliases", record.aliases, MAX_TYPES, MAX_NAME);
  const schemaTypes = record.schemaTypes === undefined ? [] : normalizeStringArray("expected.schemaTypes", record.schemaTypes, MAX_TYPES, MAX_NAME);
  const minimumSalience = record.minimumSalience === undefined ? 0.05 : numberInRange("expected.minimumSalience", record.minimumSalience, 0, 1);
  const minimumDistinctSections = record.minimumDistinctSections === undefined
    ? 1
    : nonNegativeInteger("expected.minimumDistinctSections", record.minimumDistinctSections, MAX_SECTIONS);
  const requireKnowledgeGraph = record.requireKnowledgeGraph === undefined ? false : Boolean(record.requireKnowledgeGraph);
  if (record.requireKnowledgeGraph !== undefined && typeof record.requireKnowledgeGraph !== "boolean") throw new Error("expected.requireKnowledgeGraph must be boolean");
  return { id, name, aliases, schemaTypes, minimumSalience, minimumDistinctSections, requireKnowledgeGraph };
}

function normalizeStringArray(label: string, value: unknown, maxItems: number, maxLength: number): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maxItems) throw new Error(`${label} exceeds ${maxItems} items`);
  const items = value.map((item, index) => cleanString(`${label}[${index}]`, item, maxLength));
  const unique = [...new Set(items)].sort((left, right) => left.localeCompare(right));
  if (unique.length !== items.length) throw new Error(`${label} contains duplicates`);
  return unique;
}

function documentCore(document: Omit<EntityDocument, "digest">): Omit<EntityDocument, "digest"> {
  return {
    url: document.url,
    language: document.language,
    content: document.content,
    sections: document.sections,
    expected: document.expected,
  };
}

export function createEntityDocument(
  url: string,
  language: string | null,
  sections: readonly SectionInput[],
  expected: readonly ExpectedEntityInput[],
): EntityDocument {
  if (!Array.isArray(sections) || sections.length === 0) throw new Error("document requires at least one section");
  if (sections.length > MAX_SECTIONS) throw new Error(`document exceeds ${MAX_SECTIONS} sections`);
  if (!Array.isArray(expected) || expected.length > MAX_EXPECTED) throw new Error(`expected entities exceed ${MAX_EXPECTED}`);

  let content = "";
  let offset = 0;
  const outputSections: EntitySection[] = [];
  const sectionIds = new Set<string>();
  for (const [index, section] of sections.entries()) {
    const record = asRecord(section, `section[${index}]`);
    assertAllowedKeys(record, ["id", "heading", "text"], `section[${index}]`);
    const id = cleanId(`section[${index}].id`, record.id);
    if (sectionIds.has(id)) throw new Error("duplicate section id");
    sectionIds.add(id);
    const heading = cleanString(`section[${index}].heading`, record.heading, MAX_NAME);
    const text = cleanString(`section[${index}].text`, record.text, MAX_TEXT_FIELD);
    const piece = `${heading}\n${text}\n`;
    const byteLength = Buffer.byteLength(piece, "utf8");
    const next = offset + byteLength;
    if (next > MAX_TEXT_BYTES) throw new Error(`document exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
    outputSections.push({ id, byteStart: offset, byteEnd: next });
    content += piece;
    offset = next;
  }

  const normalizedExpected = expected.map(normalizeExpected).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalizedExpected.map((item) => item.id)).size !== normalizedExpected.length) throw new Error("duplicate expected entity id");
  const core = {
    url: safeHttpUrl("document.url", url),
    language: cleanLanguage(language),
    content,
    sections: outputSections,
    expected: normalizedExpected,
  };
  return { ...core, digest: digest(core) };
}

export function validateEntityDocument(document: EntityDocument): void {
  const record = asRecord(document, "document");
  assertAllowedKeys(record, ["url", "language", "content", "sections", "expected", "digest"], "document");
  const url = safeHttpUrl("document.url", record.url);
  const language = cleanLanguage(record.language);
  if (typeof record.content !== "string" || !record.content) throw new Error("document.content must be non-empty string");
  const byteLength = Buffer.byteLength(record.content, "utf8");
  if (byteLength > MAX_TEXT_BYTES) throw new Error(`document exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
  if (!Array.isArray(record.sections) || record.sections.length === 0 || record.sections.length > MAX_SECTIONS) throw new Error("document.sections invalid");
  let cursor = 0;
  const sections = record.sections.map((value, index) => {
    const section = asRecord(value, `document.sections[${index}]`);
    assertAllowedKeys(section, ["id", "byteStart", "byteEnd"], `document.sections[${index}]`);
    const id = cleanId(`document.sections[${index}].id`, section.id);
    const byteStart = nonNegativeInteger("section.byteStart", section.byteStart, MAX_TEXT_BYTES);
    const byteEnd = nonNegativeInteger("section.byteEnd", section.byteEnd, MAX_TEXT_BYTES);
    if (byteStart !== cursor || byteEnd <= byteStart) throw new Error("document section byte ranges must be contiguous and non-empty");
    cursor = byteEnd;
    return { id, byteStart, byteEnd };
  });
  if (cursor !== byteLength) throw new Error("document section byte ranges do not cover exact content bytes");
  if (new Set(sections.map((section) => section.id)).size !== sections.length) throw new Error("duplicate section id");
  if (!Array.isArray(record.expected) || record.expected.length > MAX_EXPECTED) throw new Error("document.expected invalid");
  const expected = record.expected.map(normalizeExpected).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(expected.map((item) => item.id)).size !== expected.length) throw new Error("duplicate expected entity id");
  if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.digest)) throw new Error("document digest must be sha256 hex");
  const core = { url, language, content: record.content, sections, expected };
  if (digest(core) !== record.digest) throw new Error("document digest mismatch");
  if (canonicalJson(core) !== canonicalJson(documentCore(document))) throw new Error("document is not canonical");
}

function sectionForOffset(document: EntityDocument, beginOffset: number): string | null {
  const section = document.sections.find((item) => beginOffset >= item.byteStart && beginOffset < item.byteEnd);
  return section?.id ?? null;
}

function sanitizeProviderPayload(value: unknown, maxBytes = 2_000_000): unknown {
  const canonical = canonicalize(value);
  const encoded = Buffer.byteLength(JSON.stringify(canonical), "utf8");
  if (encoded > maxBytes) throw new Error(`provider payload exceeds ${maxBytes} bytes`);
  return canonical;
}

function normalizeProviderEntity(document: EntityDocument, value: unknown, index: number): DetectedEntity {
  const record = asRecord(value, `provider.entities[${index}]`);
  const metadata = record.metadata === undefined || record.metadata === null ? {} : asRecord(record.metadata, `provider.entities[${index}].metadata`);
  const mentionsValue = record.mentions === undefined ? [] : record.mentions;
  if (!Array.isArray(mentionsValue) || mentionsValue.length > MAX_MENTIONS_PER_ENTITY) throw new Error("provider entity mentions invalid");
  const mentions = mentionsValue.map((mentionValue, mentionIndex) => {
    const mention = asRecord(mentionValue, `provider.entities[${index}].mentions[${mentionIndex}]`);
    const text = asRecord(mention.text, `provider.entities[${index}].mentions[${mentionIndex}].text`);
    const content = cleanString("mention.content", text.content, MAX_TEXT_FIELD);
    const beginOffset = nonNegativeInteger("mention.beginOffset", text.beginOffset, MAX_TEXT_BYTES);
    if (beginOffset >= Buffer.byteLength(document.content, "utf8")) throw new Error("mention beginOffset outside document bytes");
    return { content, beginOffset, sectionId: sectionForOffset(document, beginOffset) };
  }).sort((left, right) => left.beginOffset - right.beginOffset || left.content.localeCompare(right.content));

  const core = {
    name: cleanString("entity.name", record.name, MAX_NAME),
    type: cleanOptionalString("entity.type", record.type, MAX_NAME) ?? "UNKNOWN",
    salience: numberInRange("entity.salience", record.salience ?? 0, 0, 1),
    mid: cleanOptionalString("entity.mid", metadata.mid, MAX_NAME),
    wikipediaUrl: optionalHttpUrl("entity.wikipediaUrl", metadata.wikipedia_url),
    mentions,
  };
  return { ...core, digest: digest(core) };
}

export function parseCloudNaturalLanguageSnapshot(document: EntityDocument, payload: unknown): AnalysisSnapshot {
  validateEntityDocument(document);
  const sanitized = sanitizeProviderPayload(payload);
  const record = asRecord(sanitized, "Cloud NLP payload");
  const entitiesValue = record.entities === undefined ? [] : record.entities;
  if (!Array.isArray(entitiesValue) || entitiesValue.length > MAX_ENTITIES) throw new Error(`Cloud NLP entities exceed ${MAX_ENTITIES}`);
  const entities = entitiesValue
    .map((entity, index) => normalizeProviderEntity(document, entity, index))
    .sort((left, right) => right.salience - left.salience || left.name.localeCompare(right.name) || left.digest.localeCompare(right.digest));
  const core = {
    documentDigest: document.digest,
    provider: "GOOGLE_CLOUD_NLP_V2" as const,
    providerAuthority: EXTERNAL_AUTHORITY,
    providerPayloadDigest: digest(sanitized),
    entities,
  };
  return { ...core, digest: digest(core) };
}

function normalizeStoredDetectedEntity(document: EntityDocument, value: unknown, index: number): DetectedEntity {
  const record = asRecord(value, `snapshot.entities[${index}]`);
  assertAllowedKeys(record, ["name", "type", "salience", "mid", "wikipediaUrl", "mentions", "digest"], `snapshot.entities[${index}]`);
  if (!Array.isArray(record.mentions) || record.mentions.length > MAX_MENTIONS_PER_ENTITY) throw new Error("snapshot mentions invalid");
  const mentions = record.mentions.map((item, mentionIndex) => {
    const mention = asRecord(item, `snapshot.entities[${index}].mentions[${mentionIndex}]`);
    assertAllowedKeys(mention, ["content", "beginOffset", "sectionId"], "snapshot mention");
    const content = cleanString("mention.content", mention.content, MAX_TEXT_FIELD);
    const beginOffset = nonNegativeInteger("mention.beginOffset", mention.beginOffset, MAX_TEXT_BYTES);
    const expectedSection = sectionForOffset(document, beginOffset);
    const sectionId = mention.sectionId === null ? null : cleanId("mention.sectionId", mention.sectionId);
    if (sectionId !== expectedSection) throw new Error("snapshot mention section binding mismatch");
    return { content, beginOffset, sectionId };
  }).sort((left, right) => left.beginOffset - right.beginOffset || left.content.localeCompare(right.content));
  const core = {
    name: cleanString("entity.name", record.name, MAX_NAME),
    type: cleanString("entity.type", record.type, MAX_NAME),
    salience: numberInRange("entity.salience", record.salience, 0, 1),
    mid: cleanOptionalString("entity.mid", record.mid, MAX_NAME),
    wikipediaUrl: optionalHttpUrl("entity.wikipediaUrl", record.wikipediaUrl),
    mentions,
  };
  if (typeof record.digest !== "string" || digest(core) !== record.digest) throw new Error("entity digest mismatch");
  return { ...core, digest: record.digest };
}

export function validateAnalysisSnapshot(document: EntityDocument, snapshot: AnalysisSnapshot): void {
  validateEntityDocument(document);
  const record = asRecord(snapshot, "snapshot");
  assertAllowedKeys(record, ["documentDigest", "provider", "providerAuthority", "providerPayloadDigest", "entities", "digest"], "snapshot");
  if (record.documentDigest !== document.digest) throw new Error("snapshot document binding mismatch");
  if (record.provider !== "GOOGLE_CLOUD_NLP_V2") throw new Error("snapshot provider mismatch");
  if (record.providerAuthority !== EXTERNAL_AUTHORITY) throw new Error("snapshot provider authority marker mismatch");
  if (typeof record.providerPayloadDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.providerPayloadDigest)) throw new Error("snapshot provider payload digest invalid");
  if (!Array.isArray(record.entities) || record.entities.length > MAX_ENTITIES) throw new Error("snapshot entities invalid");
  const entities = record.entities.map((item, index) => normalizeStoredDetectedEntity(document, item, index));
  const sorted = [...entities].sort((left, right) => right.salience - left.salience || left.name.localeCompare(right.name) || left.digest.localeCompare(right.digest));
  if (canonicalJson(sorted) !== canonicalJson(record.entities)) throw new Error("snapshot entities are not canonical");
  const core = {
    documentDigest: document.digest,
    provider: "GOOGLE_CLOUD_NLP_V2" as const,
    providerAuthority: EXTERNAL_AUTHORITY,
    providerPayloadDigest: record.providerPayloadDigest,
    entities: sorted,
  };
  if (typeof record.digest !== "string" || digest(core) !== record.digest) throw new Error("snapshot digest mismatch");
}

function normalizeName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function expectedForDetected(document: EntityDocument, entity: DetectedEntity): ExpectedEntity | null {
  return document.expected.find((expected) => [expected.name, ...expected.aliases].some((alias) => normalizeName(alias) === normalizeName(entity.name))) ?? null;
}

function normalizeKgCandidate(value: unknown, index: number): KgCandidate {
  const record = asRecord(value, `KG candidate[${index}]`);
  assertAllowedKeys(record, ["cloudMid", "googleKgMid", "name", "types", "url", "digest"], `KG candidate[${index}]`);
  const core = {
    cloudMid: cleanString("candidate.cloudMid", record.cloudMid, MAX_NAME),
    googleKgMid: cleanOptionalString("candidate.googleKgMid", record.googleKgMid, MAX_NAME),
    name: cleanString("candidate.name", record.name, MAX_NAME),
    types: normalizeStringArray("candidate.types", record.types, MAX_TYPES, MAX_NAME),
    url: optionalHttpUrl("candidate.url", record.url),
  };
  if (typeof record.digest !== "string" || digest(core) !== record.digest) throw new Error("KG candidate digest mismatch");
  return { ...core, digest: record.digest };
}

function candidateFromProvider(value: unknown): KgCandidate {
  const record = asRecord(value, "KG provider result");
  const identifiersValue = record.identifier === undefined ? [] : record.identifier;
  if (!Array.isArray(identifiersValue) || identifiersValue.length > MAX_TYPES) throw new Error("KG identifiers invalid");
  let googleKgMid: string | null = null;
  for (const identifierValue of identifiersValue) {
    const identifier = asRecord(identifierValue, "KG identifier");
    if (identifier.propertyID === "googleKgMID") googleKgMid = cleanOptionalString("googleKgMID", identifier.value, MAX_NAME);
  }
  const typeValue = record["@type"];
  const types = Array.isArray(typeValue)
    ? normalizeStringArray("candidate.types", typeValue, MAX_TYPES, MAX_NAME)
    : typeValue === undefined || typeValue === null
      ? []
      : [cleanString("candidate.type", typeValue, MAX_NAME)];
  const core = {
    cloudMid: cleanString("candidate.cloudMid", record["@id"], MAX_NAME),
    googleKgMid,
    name: cleanString("candidate.name", record.name, MAX_NAME),
    types,
    url: optionalHttpUrl("candidate.url", record.url),
  };
  return { ...core, digest: digest(core) };
}

export function parseKnowledgeGraphCandidates(payload: unknown): readonly KgCandidate[] {
  const sanitized = sanitizeProviderPayload(payload);
  const record = asRecord(sanitized, "KG payload");
  const items = record.itemListElement === undefined ? [] : record.itemListElement;
  if (!Array.isArray(items) || items.length > MAX_KG_CANDIDATES) throw new Error(`KG candidates exceed ${MAX_KG_CANDIDATES}`);
  const candidates: KgCandidate[] = [];
  for (const itemValue of items) {
    const item = asRecord(itemValue, "KG item");
    if (item.result === undefined || item.result === null) continue;
    candidates.push(candidateFromProvider(item.result));
  }
  return candidates.sort((left, right) => left.cloudMid.localeCompare(right.cloudMid) || left.digest.localeCompare(right.digest));
}

function scoreCandidate(expected: ExpectedEntity | null, entity: DetectedEntity, candidate: KgCandidate): number {
  const names = expected ? [expected.name, ...expected.aliases] : [];
  const nameMatch = normalizeName(candidate.name) === normalizeName(entity.name)
    || names.some((name) => normalizeName(name) === normalizeName(candidate.name));
  const typeMatch = expected?.schemaTypes.some((type) => candidate.types.includes(type)) ?? false;
  return (nameMatch ? 0.7 : 0) + (typeMatch ? 0.3 : 0);
}

function buildResolution(
  document: EntityDocument,
  entity: DetectedEntity,
  source: ResolutionSource,
  candidates: readonly KgCandidate[],
  providerPayloadDigest: string,
): EntityResolution {
  const expected = expectedForDetected(document, entity);
  let status: ResolutionStatus;
  let scored: ScoredKgCandidate[];
  let resolved: KgCandidate | null;
  if (source === "NLP_MID_LOOKUP") {
    scored = candidates.map((candidate) => ({ candidate, score: candidate.googleKgMid === entity.mid || candidate.cloudMid === entity.mid ? 1 : 0 }));
    const exact = scored.find((item) => item.score === 1)?.candidate ?? null;
    status = exact ? "RESOLVED" : "UNRESOLVED";
    resolved = exact;
  } else {
    scored = candidates
      .map((candidate) => ({ candidate, score: scoreCandidate(expected, entity, candidate) }))
      .sort((left, right) => right.score - left.score || left.candidate.cloudMid.localeCompare(right.candidate.cloudMid));
    const top = scored[0];
    const second = scored[1];
    status = !top || top.score < 0.8
      ? "UNRESOLVED"
      : second && second.score >= 0.8 && top.score - second.score < 0.1
        ? "AMBIGUOUS"
        : "RESOLVED";
    resolved = status === "RESOLVED" ? top!.candidate : null;
  }
  const core = {
    entityDigest: entity.digest,
    expectedId: expected?.id ?? null,
    status,
    source,
    provider: "GOOGLE_ENTERPRISE_KG_V1" as const,
    providerAuthority: EXTERNAL_AUTHORITY,
    providerPayloadDigest,
    resolved,
    candidates: scored,
  };
  return { ...core, digest: digest(core) };
}

export function resolveFromKnowledgeGraphPayload(
  document: EntityDocument,
  entity: DetectedEntity,
  source: ResolutionSource,
  payload: unknown,
): EntityResolution {
  validateEntityDocument(document);
  const candidate = normalizeStoredDetectedEntity(document, entity, 0);
  const sanitized = sanitizeProviderPayload(payload);
  const candidates = parseKnowledgeGraphCandidates(sanitized);
  if (source === "NLP_MID_LOOKUP" && !candidate.mid) throw new Error("MID lookup requires detected entity MID");
  return buildResolution(document, candidate, source, candidates, digest(sanitized));
}

export function validateEntityResolution(document: EntityDocument, entity: DetectedEntity, resolution: EntityResolution): void {
  validateEntityDocument(document);
  const candidate = normalizeStoredDetectedEntity(document, entity, 0);
  const record = asRecord(resolution, "resolution");
  assertAllowedKeys(record, ["entityDigest", "expectedId", "status", "source", "provider", "providerAuthority", "providerPayloadDigest", "resolved", "candidates", "digest"], "resolution");
  if (record.entityDigest !== candidate.digest) throw new Error("resolution entity binding mismatch");
  if (record.provider !== "GOOGLE_ENTERPRISE_KG_V1" || record.providerAuthority !== EXTERNAL_AUTHORITY) throw new Error("resolution provider binding mismatch");
  if (record.source !== "NLP_MID_LOOKUP" && record.source !== "KNOWLEDGE_GRAPH_SEARCH") throw new Error("resolution source invalid");
  if (typeof record.providerPayloadDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.providerPayloadDigest)) throw new Error("resolution provider payload digest invalid");
  if (!Array.isArray(record.candidates) || record.candidates.length > MAX_KG_CANDIDATES) throw new Error("resolution candidates invalid");
  const candidates = record.candidates.map((value, index) => {
    const scored = asRecord(value, `resolution.candidates[${index}]`);
    assertAllowedKeys(scored, ["candidate", "score"], "scored candidate");
    return {
      candidate: normalizeKgCandidate(scored.candidate, index),
      score: numberInRange("candidate.score", scored.score, 0, 1),
    };
  });
  const expected = buildResolution(document, candidate, record.source, candidates.map((item) => item.candidate), record.providerPayloadDigest);
  if (canonicalJson(expected) !== canonicalJson(resolution)) throw new Error("resolution replay mismatch");
}

function boundedTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be an integer in [100, ${MAX_TIMEOUT_MS}]`);
  return timeout;
}

async function fetchJson(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} ${response.status}`);
    return await response.json() as unknown;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label} timeout`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class CloudNaturalLanguageClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async analyze(document: EntityDocument): Promise<AnalysisSnapshot> {
    validateEntityDocument(document);
    const accessToken = cleanString("access token", await this.token(), 16_384, false);
    const payload = await fetchJson(
      this.fetchImpl,
      "https://language.googleapis.com/v2/documents:analyzeEntities",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          document: {
            type: "PLAIN_TEXT",
            content: document.content,
            ...(document.language ? { languageCode: document.language } : {}),
          },
          encodingType: "UTF8",
        }),
      },
      boundedTimeoutMs(this.timeoutMs),
      "Cloud NLP",
    );
    return parseCloudNaturalLanguageSnapshot(document, payload);
  }
}

function safeProjectId(value: string): string {
  const projectId = cleanString("projectId", value, 128);
  if (!/^[a-z0-9][a-z0-9-]{4,62}[a-z0-9]$/u.test(projectId)) throw new Error("projectId format invalid");
  return projectId;
}

export class KnowledgeGraphClient {
  private readonly projectId: string;

  constructor(
    projectId: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.projectId = safeProjectId(projectId);
  }

  private async request(op: "Search" | "Lookup", params: URLSearchParams): Promise<unknown> {
    const accessToken = cleanString("access token", await this.token(), 16_384, false);
    const url = `https://enterpriseknowledgegraph.googleapis.com/v1/projects/${this.projectId}/locations/global/cloudKnowledgeGraphEntities:${op}?${params.toString()}`;
    return fetchJson(
      this.fetchImpl,
      url,
      { headers: { authorization: `Bearer ${accessToken}` } },
      boundedTimeoutMs(this.timeoutMs),
      "Knowledge Graph",
    );
  }

  async lookupPayload(mid: string, language?: string): Promise<unknown> {
    const params = new URLSearchParams();
    params.append("ids", cleanString("MID", mid, MAX_NAME));
    if (language) params.append("languages", cleanLanguage(language) ?? "");
    return this.request("Lookup", params);
  }

  async searchPayload(query: string, types: readonly string[] = [], language?: string): Promise<unknown> {
    const params = new URLSearchParams({ query: cleanString("KG query", query, MAX_NAME), limit: "5" });
    for (const type of normalizeStringArray("KG types", types, MAX_TYPES, MAX_NAME)) params.append("types", type);
    if (language) params.append("languages", cleanLanguage(language) ?? "");
    return this.request("Search", params);
  }

  async resolve(document: EntityDocument, entity: DetectedEntity): Promise<EntityResolution> {
    validateEntityDocument(document);
    const candidate = normalizeStoredDetectedEntity(document, entity, 0);
    const expected = expectedForDetected(document, candidate);
    if (candidate.mid) {
      const payload = await this.lookupPayload(candidate.mid, document.language ?? undefined);
      return resolveFromKnowledgeGraphPayload(document, candidate, "NLP_MID_LOOKUP", payload);
    }
    const payload = await this.searchPayload(candidate.name, expected?.schemaTypes ?? [], document.language ?? undefined);
    return resolveFromKnowledgeGraphPayload(document, candidate, "KNOWLEDGE_GRAPH_SEARCH", payload);
  }
}

export function assessEntities(
  document: EntityDocument,
  snapshot: AnalysisSnapshot,
  resolutions: readonly EntityResolution[],
): EntityAssessment {
  validateEntityDocument(document);
  validateAnalysisSnapshot(document, snapshot);
  if (!Array.isArray(resolutions) || resolutions.length > MAX_ENTITIES) throw new Error("resolutions invalid");
  const entityByDigest = new Map(snapshot.entities.map((entity) => [entity.digest, entity] as const));
  const resolutionByDigest = new Map<string, EntityResolution>();
  for (const resolution of resolutions) {
    const entityDigest = asRecord(resolution, "resolution").entityDigest;
    if (typeof entityDigest !== "string") throw new Error("resolution entityDigest invalid");
    const entity = entityByDigest.get(entityDigest);
    if (!entity) throw new Error("resolution references entity outside snapshot");
    if (resolutionByDigest.has(entityDigest)) throw new Error("duplicate resolution for entity");
    validateEntityResolution(document, entity, resolution);
    resolutionByDigest.set(entityDigest, resolution);
  }

  const results = document.expected.map((expected) => {
    const entity = snapshot.entities.find((item) => [expected.name, ...expected.aliases].some((alias) => normalizeName(alias) === normalizeName(item.name)));
    const sections = new Set(entity?.mentions.map((mention) => mention.sectionId).filter((id): id is string => id !== null));
    const resolution = entity ? resolutionByDigest.get(entity.digest) : undefined;
    const knowledgeGraphStatus: EntityAssessmentResult["knowledgeGraphStatus"] = expected.requireKnowledgeGraph
      ? resolution?.status ?? "MISSING"
      : "NOT_REQUIRED";
    const pass = Boolean(entity)
      && (entity?.salience ?? 0) >= expected.minimumSalience
      && sections.size >= expected.minimumDistinctSections
      && (!expected.requireKnowledgeGraph || knowledgeGraphStatus === "RESOLVED");
    return {
      id: expected.id,
      present: Boolean(entity),
      salience: entity?.salience ?? 0,
      sections: sections.size,
      knowledgeGraphStatus,
      pass,
    };
  });
  const core = {
    status: (results.every((result) => result.pass) ? "READY" : "NEEDS_WORK") as "READY" | "NEEDS_WORK",
    documentDigest: document.digest,
    snapshotDigest: snapshot.digest,
    results,
    nonClaim: NON_CLAIM,
  };
  return { ...core, digest: digest(core) };
}

export function validateEntityAssessment(
  document: EntityDocument,
  snapshot: AnalysisSnapshot,
  resolutions: readonly EntityResolution[],
  assessment: EntityAssessment,
): void {
  const expected = assessEntities(document, snapshot, resolutions);
  if (canonicalJson(expected) !== canonicalJson(assessment)) throw new Error("entity assessment replay mismatch");
}
