import { createHash } from "node:crypto";
import { canonicalJson } from "../../../index.js";
import {
  projectSchemaOrg,
  verifyUnifiedSemanticGraph,
  type SchemaOrgEntity,
  type SchemaOrgProjectionRule,
  type UnifiedSemanticGraph,
} from "../../../semantic-graph.js";

export const GOOGLE_STRUCTURED_DATA_POLICY_VERSION = "nexus-google-structured-data-2026-09-08" as const;

export type GoogleRichResultFeature =
  | "ORGANIZATION"
  | "LOCAL_BUSINESS"
  | "PRODUCT_SNIPPET"
  | "EVENT"
  | "ARTICLE"
  | "BREADCRUMB";

export interface GroundedRichResultRule {
  readonly feature: GoogleRichResultFeature;
  readonly objectTypeId: string;
  readonly schemaType: string;
  readonly nodeIds: readonly string[];
  readonly propertyMap: Readonly<Record<string, string>>;
  readonly visibleSchemaProperties?: readonly string[];
}

export interface RenderedPageEvidence {
  readonly pageUrl: string;
  readonly finalUrl: string;
  readonly capturedAt: string;
  readonly source: "PLAYWRIGHT_RENDERED_DOM";
  readonly textContent: string;
}

export interface StructuredKnowledgeBuildInput {
  readonly graph: UnifiedSemanticGraph;
  readonly pageUrl: string;
  readonly pageEvidence: RenderedPageEvidence;
  readonly rules: readonly GroundedRichResultRule[];
}

export interface GroundedStructuredDataReceipt {
  readonly schemaVersion: 1;
  readonly strategy: 7;
  readonly publisherOrigin: string;
  readonly pageUrl: string;
  readonly graphDigest: string;
  readonly graphSchemaId: string;
  readonly graphAsOf: string;
  readonly groundedNodeDigests: readonly string[];
  readonly pageEvidenceDigest: `sha256:${string}`;
  readonly ruleDigest: `sha256:${string}`;
  readonly jsonLdDigest: `sha256:${string}`;
  readonly policyVersion: typeof GOOGLE_STRUCTURED_DATA_POLICY_VERSION;
  readonly generatedAt: string;
  readonly receiptDigest: `sha256:${string}`;
}

export interface GroundedStructuredDataArtifact {
  readonly status: "READY_FOR_RICH_RESULTS_TEST";
  readonly googleAppearanceGuaranteed: false;
  readonly pageUrl: string;
  readonly jsonLd: Readonly<{ "@context": "https://schema.org"; "@graph": readonly Readonly<Record<string, unknown>>[] }>;
  readonly serializedJsonLd: string;
  readonly receipt: GroundedStructuredDataReceipt;
}

export class StructuredKnowledgeError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "INTEGRITY_FAILURE"
      | "POLICY_REJECTED"
      | "PAGE_EVIDENCE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "StructuredKnowledgeError";
  }
}

const LOCAL_BUSINESS_TYPES = new Set([
  "LocalBusiness",
  "ProfessionalService",
  "LegalService",
  "Attorney",
  "Dentist",
  "MedicalBusiness",
  "FinancialService",
  "HomeAndConstructionBusiness",
  "HealthAndBeautyBusiness",
  "AutomotiveBusiness",
  "Restaurant",
  "Store",
  "LodgingBusiness",
]);
const ARTICLE_TYPES = new Set(["Article", "NewsArticle", "BlogPosting"]);
const SCHEMA_PROPERTY = /^[A-Za-z][A-Za-z0-9]*$/u;
const MAX_RULES = 50;
const MAX_NODE_IDS_PER_RULE = 50;
const MAX_PROPERTY_MAP = 100;
const MAX_VISIBLE_TEXT_BYTES = 512 * 1024;
const DEFAULT_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function canonicalUtc(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new StructuredKnowledgeError("INVALID_INPUT", `${field} must be canonical ISO-8601 UTC`);
  }
  return value;
}

function cleanString(value: unknown, field: string, max = 2048): string {
  if (typeof value !== "string") throw new StructuredKnowledgeError("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) throw new StructuredKnowledgeError("INVALID_INPUT", `${field} is empty or too long`);
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw new StructuredKnowledgeError("INVALID_INPUT", `${field} contains a control character`);
  }
  return normalized;
}

function canonicalPageUrl(value: string, expectedOrigin?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StructuredKnowledgeError("INVALID_INPUT", "pageUrl must be an absolute URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new StructuredKnowledgeError("INVALID_INPUT", "pageUrl must be canonical HTTPS without credentials, query, or fragment");
  }
  if (expectedOrigin !== undefined && url.origin !== expectedOrigin) {
    throw new StructuredKnowledgeError("POLICY_REJECTED", "pageUrl must use the verified publisher origin");
  }
  return url.href;
}

function normalizeVisibleText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function featureSchemaTypeAllowed(feature: GoogleRichResultFeature, schemaType: string): boolean {
  switch (feature) {
    case "ORGANIZATION": return schemaType === "Organization";
    case "LOCAL_BUSINESS": return LOCAL_BUSINESS_TYPES.has(schemaType);
    case "PRODUCT_SNIPPET": return schemaType === "Product";
    case "EVENT": return schemaType === "Event";
    case "ARTICLE": return ARTICLE_TYPES.has(schemaType);
    case "BREADCRUMB": return schemaType === "BreadcrumbList";
  }
}

function defaultVisibleProperties(feature: GoogleRichResultFeature): readonly string[] {
  switch (feature) {
    case "ORGANIZATION":
    case "LOCAL_BUSINESS":
    case "PRODUCT_SNIPPET":
    case "EVENT": return ["name"];
    case "ARTICLE": return ["headline"];
    case "BREADCRUMB": return [];
  }
}

function assertPlainObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} must be a plain object`);
  }
}

function requireProperty(entity: Readonly<Record<string, unknown>>, property: string, feature: GoogleRichResultFeature): void {
  if (!(property in entity) || entity[property] === null || entity[property] === "") {
    throw new StructuredKnowledgeError("POLICY_REJECTED", `${feature} requires grounded property ${property} under the Nexus policy`);
  }
}

function assertFirstPartyUrl(value: unknown, origin: string, field: string): void {
  if (typeof value !== "string") throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} must be a URL string`);
  let url: URL;
  try { url = new URL(value); } catch { throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} is not an absolute URL`); }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} must stay on the verified publisher origin`);
  }
}

function assertPostalAddress(value: unknown, field: string): void {
  assertPlainObject(value, field);
  if (value["@type"] !== "PostalAddress") throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} must be PostalAddress`);
  const hasAddressContent = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"]
    .some((property) => typeof value[property] === "string" && Boolean((value[property] as string).trim()));
  if (!hasAddressContent) throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} must contain a postal address field`);
}

function assertEventLocation(value: unknown): void {
  assertPlainObject(value, "Event.location");
  if (value["@type"] !== "Place") throw new StructuredKnowledgeError("POLICY_REJECTED", "Event.location must be Place");
  if (typeof value.name !== "string" || !value.name.trim()) throw new StructuredKnowledgeError("POLICY_REJECTED", "Event.location requires name");
  assertPostalAddress(value.address, "Event.location.address");
}

function assertTypedSchemaValue(value: unknown, allowedTypes: ReadonlySet<string>, field: string): void {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.length > 100) throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} is empty or too large`);
  for (const [index, item] of values.entries()) {
    assertPlainObject(item, `${field}[${index}]`);
    if (typeof item["@type"] !== "string" || !allowedTypes.has(item["@type"])) {
      throw new StructuredKnowledgeError("POLICY_REJECTED", `${field}[${index}] has an unsupported schema.org type`);
    }
  }
}

function assertProductEvidence(entity: Readonly<Record<string, unknown>>): void {
  let supported = false;
  if (entity.offers !== undefined) {
    assertTypedSchemaValue(entity.offers, new Set(["Offer", "AggregateOffer"]), "Product.offers");
    supported = true;
  }
  if (entity.review !== undefined) {
    assertTypedSchemaValue(entity.review, new Set(["Review"]), "Product.review");
    supported = true;
  }
  if (entity.aggregateRating !== undefined) {
    assertTypedSchemaValue(entity.aggregateRating, new Set(["AggregateRating"]), "Product.aggregateRating");
    supported = true;
  }
  if (!supported) throw new StructuredKnowledgeError("POLICY_REJECTED", "PRODUCT_SNIPPET requires grounded offers, review, or aggregateRating");
}

function assertBreadcrumb(entity: Readonly<Record<string, unknown>>, publisherOrigin: string): void {
  const items = entity.itemListElement;
  if (!Array.isArray(items) || items.length < 2 || items.length > 50) {
    throw new StructuredKnowledgeError("POLICY_REJECTED", "BREADCRUMB requires 2..50 itemListElement entries");
  }
  items.forEach((item, index) => {
    assertPlainObject(item, `itemListElement[${index}]`);
    if (item["@type"] !== "ListItem") throw new StructuredKnowledgeError("POLICY_REJECTED", `itemListElement[${index}] must be ListItem`);
    if (!Number.isInteger(item.position) || item.position !== index + 1) throw new StructuredKnowledgeError("POLICY_REJECTED", `itemListElement[${index}] position must be ${index + 1}`);
    if (typeof item.name !== "string" || !item.name.trim()) throw new StructuredKnowledgeError("POLICY_REJECTED", `itemListElement[${index}] requires name`);
    if (index < items.length - 1) {
      if (typeof item.item !== "string") throw new StructuredKnowledgeError("POLICY_REJECTED", `itemListElement[${index}] requires item URL`);
      assertFirstPartyUrl(item.item, publisherOrigin, `itemListElement[${index}].item`);
    } else if (item.item !== undefined) {
      assertFirstPartyUrl(item.item, publisherOrigin, `itemListElement[${index}].item`);
    }
  });
}

function assertFeaturePolicy(entity: Readonly<Record<string, unknown>>, feature: GoogleRichResultFeature, publisherOrigin: string): void {
  switch (feature) {
    case "ORGANIZATION":
      requireProperty(entity, "name", feature);
      requireProperty(entity, "url", feature);
      assertFirstPartyUrl(entity.url, publisherOrigin, "Organization.url");
      return;
    case "LOCAL_BUSINESS":
      requireProperty(entity, "name", feature);
      requireProperty(entity, "address", feature);
      assertPostalAddress(entity.address, "LocalBusiness.address");
      if ("aggregateRating" in entity || "review" in entity) {
        throw new StructuredKnowledgeError("POLICY_REJECTED", "LOCAL_BUSINESS self-rating/review markup is not emitted by strategy #7");
      }
      if (entity.url !== undefined) assertFirstPartyUrl(entity.url, publisherOrigin, "LocalBusiness.url");
      return;
    case "PRODUCT_SNIPPET":
      requireProperty(entity, "name", feature);
      assertProductEvidence(entity);
      if (entity.url !== undefined) assertFirstPartyUrl(entity.url, publisherOrigin, "Product.url");
      return;
    case "EVENT":
      requireProperty(entity, "name", feature);
      requireProperty(entity, "startDate", feature);
      requireProperty(entity, "location", feature);
      assertEventLocation(entity.location);
      return;
    case "ARTICLE":
      requireProperty(entity, "headline", feature);
      return;
    case "BREADCRUMB":
      assertBreadcrumb(entity, publisherOrigin);
      return;
  }
}

function visibleScalar(value: unknown, field: string): string {
  if (typeof value === "string") return normalizeVisibleText(value);
  if (typeof value === "number" || typeof value === "boolean") return normalizeVisibleText(String(value));
  throw new StructuredKnowledgeError("POLICY_REJECTED", `${field} must be a scalar to require rendered visibility`);
}

function assertRenderedVisibility(
  entity: Readonly<Record<string, unknown>>,
  feature: GoogleRichResultFeature,
  properties: readonly string[],
  visibleText: string,
): void {
  for (const property of properties) {
    requireProperty(entity, property, feature);
    const expected = visibleScalar(entity[property], `visible property ${property}`);
    if (!visibleText.includes(expected)) {
      throw new StructuredKnowledgeError("PAGE_EVIDENCE_MISMATCH", `rendered page does not visibly contain grounded property ${property}`);
    }
  }
}

function validateRules(graph: UnifiedSemanticGraph, rules: readonly GroundedRichResultRule[]): readonly GroundedRichResultRule[] {
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > MAX_RULES) {
    throw new StructuredKnowledgeError("INVALID_INPUT", `rules must contain 1..${MAX_RULES} entries`);
  }
  const ruleTypes = new Set<string>();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return Object.freeze(rules.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new StructuredKnowledgeError("INVALID_INPUT", `rules[${index}] must be an object`);
    const objectTypeId = cleanString(raw.objectTypeId, `rules[${index}].objectTypeId`, 200);
    const schemaType = cleanString(raw.schemaType, `rules[${index}].schemaType`, 100);
    if (!featureSchemaTypeAllowed(raw.feature, schemaType)) {
      throw new StructuredKnowledgeError("POLICY_REJECTED", `${raw.feature} does not allow schema type ${schemaType}`);
    }
    if (ruleTypes.has(objectTypeId)) throw new StructuredKnowledgeError("INVALID_INPUT", `duplicate projection rule for ${objectTypeId}`);
    ruleTypes.add(objectTypeId);
    if (!Array.isArray(raw.nodeIds) || raw.nodeIds.length < 1 || raw.nodeIds.length > MAX_NODE_IDS_PER_RULE) {
      throw new StructuredKnowledgeError("INVALID_INPUT", `rules[${index}].nodeIds must contain 1..${MAX_NODE_IDS_PER_RULE} ids`);
    }
    const nodeIdInput: readonly unknown[] = raw.nodeIds;
    const nodeIds: readonly string[] = Object.freeze([...new Set<string>(nodeIdInput.map((id: unknown, nodeIndex: number) => cleanString(id, `rules[${index}].nodeIds[${nodeIndex}]`, 300)))].sort());
    for (const nodeId of nodeIds) {
      const node = nodes.get(nodeId);
      if (!node) throw new StructuredKnowledgeError("INVALID_INPUT", `projection node ${nodeId} does not exist in the verified graph`);
      if (node.typeId !== objectTypeId) throw new StructuredKnowledgeError("POLICY_REJECTED", `projection node ${nodeId} is not of type ${objectTypeId}`);
    }
    if (!raw.propertyMap || typeof raw.propertyMap !== "object" || Array.isArray(raw.propertyMap)) {
      throw new StructuredKnowledgeError("INVALID_INPUT", `rules[${index}].propertyMap must be an object`);
    }
    const entries = Object.entries(raw.propertyMap);
    if (entries.length < 1 || entries.length > MAX_PROPERTY_MAP) throw new StructuredKnowledgeError("INVALID_INPUT", `rules[${index}].propertyMap must contain 1..${MAX_PROPERTY_MAP} entries`);
    const propertyMap: Record<string, string> = {};
    for (const [propertyIdRaw, schemaPropertyRaw] of entries) {
      const propertyId = cleanString(propertyIdRaw, `rules[${index}].propertyMap key`, 200);
      const schemaProperty = cleanString(schemaPropertyRaw, `rules[${index}].propertyMap.${propertyId}`, 100);
      if (!SCHEMA_PROPERTY.test(schemaProperty) || schemaProperty === "context" || schemaProperty === "type" || schemaProperty === "id") {
        throw new StructuredKnowledgeError("POLICY_REJECTED", `unsupported schema.org property ${schemaProperty}`);
      }
      propertyMap[propertyId] = schemaProperty;
    }
    const extraVisible = raw.visibleSchemaProperties ?? [];
    if (!Array.isArray(extraVisible) || extraVisible.length > 20) throw new StructuredKnowledgeError("INVALID_INPUT", `rules[${index}].visibleSchemaProperties is invalid`);
    const visibleSchemaProperties = Object.freeze([...new Set([
      ...defaultVisibleProperties(raw.feature),
      ...extraVisible.map((property, visibleIndex) => cleanString(property, `rules[${index}].visibleSchemaProperties[${visibleIndex}]`, 100)),
    ])].sort());
    for (const property of visibleSchemaProperties) {
      if (!SCHEMA_PROPERTY.test(property)) throw new StructuredKnowledgeError("INVALID_INPUT", `visible schema property ${property} is malformed`);
    }
    return Object.freeze({ feature: raw.feature, objectTypeId, schemaType, nodeIds, propertyMap: Object.freeze(propertyMap), visibleSchemaProperties });
  }));
}

function projectionEntityId(graph: UnifiedSemanticGraph, nodeId: string): string {
  return `urn:nexus:${graph.scope.tenantId}:${nodeId}`;
}

function publicEntityId(pageUrl: string, nodeId: string): string {
  const suffix = createHash("sha256").update(nodeId, "utf8").digest("hex").slice(0, 24);
  return `${pageUrl}#nexus-${suffix}`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function receiptDigest(receipt: Omit<GroundedStructuredDataReceipt, "receiptDigest">): `sha256:${string}` {
  return sha256(receipt);
}

export function verifyGroundedStructuredDataArtifact(artifact: GroundedStructuredDataArtifact): boolean {
  try {
    if (artifact.status !== "READY_FOR_RICH_RESULTS_TEST" || artifact.googleAppearanceGuaranteed !== false) return false;
    if (artifact.receipt.schemaVersion !== 1 || artifact.receipt.strategy !== 7 || artifact.receipt.policyVersion !== GOOGLE_STRUCTURED_DATA_POLICY_VERSION) return false;
    if (artifact.pageUrl !== artifact.receipt.pageUrl || artifact.receipt.groundedNodeDigests.length === 0) return false;
    const page = new URL(artifact.pageUrl);
    if (page.protocol !== "https:" || page.origin !== artifact.receipt.publisherOrigin) return false;
    if (sha256(artifact.jsonLd) !== artifact.receipt.jsonLdDigest) return false;
    if (safeJson(artifact.jsonLd) !== artifact.serializedJsonLd) return false;
    const { receiptDigest: supplied, ...body } = artifact.receipt;
    return receiptDigest(body) === supplied;
  } catch {
    return false;
  }
}

export class VerifiedStructuredKnowledgeEngine {
  private readonly publisherOrigin: string;
  private readonly now: () => number;
  private readonly maxEvidenceAgeMs: number;

  constructor(input: {
    readonly publisherWebsiteOrigin: string;
    readonly now?: () => number;
    readonly maxEvidenceAgeMs?: number;
  }) {
    let origin: URL;
    try { origin = new URL(input.publisherWebsiteOrigin); } catch { throw new StructuredKnowledgeError("INVALID_CONFIG", "publisherWebsiteOrigin must be a URL"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new StructuredKnowledgeError("INVALID_CONFIG", "publisherWebsiteOrigin must be an HTTPS origin");
    }
    this.publisherOrigin = origin.origin;
    this.now = input.now ?? Date.now;
    this.maxEvidenceAgeMs = input.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
    if (!Number.isSafeInteger(this.maxEvidenceAgeMs) || this.maxEvidenceAgeMs < 60_000 || this.maxEvidenceAgeMs > MAX_EVIDENCE_AGE_MS) {
      throw new StructuredKnowledgeError("INVALID_CONFIG", "maxEvidenceAgeMs must be between one minute and seven days");
    }
  }

  identity() {
    return Object.freeze({
      strategy: 7 as const,
      provider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS" as const,
      publisherWebsiteOrigin: this.publisherOrigin,
    });
  }

  build(input: StructuredKnowledgeBuildInput): GroundedStructuredDataArtifact {
    if (!input || typeof input !== "object") throw new StructuredKnowledgeError("INVALID_INPUT", "structured knowledge input is required");
    if (!verifyUnifiedSemanticGraph(input.graph)) throw new StructuredKnowledgeError("INTEGRITY_FAILURE", "semantic graph integrity verification failed");
    if (input.graph.evidenceState !== "OBSERVED_ONTOLOGY_STATE" || input.graph.nodes.length === 0) {
      throw new StructuredKnowledgeError("POLICY_REJECTED", "structured data requires observed ontology state");
    }
    const pageUrl = canonicalPageUrl(input.pageUrl, this.publisherOrigin);
    if (!input.pageEvidence || typeof input.pageEvidence !== "object" || input.pageEvidence.source !== "PLAYWRIGHT_RENDERED_DOM") {
      throw new StructuredKnowledgeError("PAGE_EVIDENCE_MISMATCH", "rendered Playwright page evidence is required");
    }
    if (canonicalPageUrl(input.pageEvidence.pageUrl, this.publisherOrigin) !== pageUrl || canonicalPageUrl(input.pageEvidence.finalUrl, this.publisherOrigin) !== pageUrl) {
      throw new StructuredKnowledgeError("PAGE_EVIDENCE_MISMATCH", "page evidence URL/final URL must equal the canonical pageUrl");
    }
    const capturedAt = canonicalUtc(input.pageEvidence.capturedAt, "pageEvidence.capturedAt");
    const capturedMs = Date.parse(capturedAt);
    if (Date.parse(input.graph.asOf) > capturedMs) {
      throw new StructuredKnowledgeError("PAGE_EVIDENCE_MISMATCH", "rendered page evidence must be at least as new as the semantic graph snapshot");
    }
    const now = this.now();
    if (!Number.isFinite(now) || capturedMs > now + MAX_FUTURE_SKEW_MS || now - capturedMs > this.maxEvidenceAgeMs) {
      throw new StructuredKnowledgeError("PAGE_EVIDENCE_MISMATCH", "page evidence is expired or from the future");
    }
    if (typeof input.pageEvidence.textContent !== "string" || textByteLength(input.pageEvidence.textContent) > MAX_VISIBLE_TEXT_BYTES) {
      throw new StructuredKnowledgeError("PAGE_EVIDENCE_MISMATCH", "page evidence text is missing or oversized");
    }
    const visibleText = normalizeVisibleText(input.pageEvidence.textContent);
    if (!visibleText) throw new StructuredKnowledgeError("PAGE_EVIDENCE_MISMATCH", "rendered page has no visible text");

    const rules = validateRules(input.graph, input.rules);
    const projectionRules: SchemaOrgProjectionRule[] = rules.map((rule) => ({
      objectTypeId: rule.objectTypeId,
      schemaType: rule.schemaType,
      propertyMap: rule.propertyMap,
    }));
    let projected: readonly SchemaOrgEntity[];
    try { projected = projectSchemaOrg(input.graph, projectionRules); }
    catch (error) { throw new StructuredKnowledgeError("INTEGRITY_FAILURE", `canonical schema.org projection failed: ${error instanceof Error ? error.message : "unknown error"}`); }
    const projectedById = new Map(projected.map((entity) => [entity["@id"], entity]));
    const graphNodeById = new Map(input.graph.nodes.map((node) => [node.id, node]));
    const groundedNodeDigests: string[] = [];
    const outputEntities: Readonly<Record<string, unknown>>[] = [];

    for (const rule of rules) {
      for (const nodeId of rule.nodeIds) {
        const projectedEntity = projectedById.get(projectionEntityId(input.graph, nodeId));
        const graphNode = graphNodeById.get(nodeId);
        if (!projectedEntity || !graphNode) throw new StructuredKnowledgeError("INTEGRITY_FAILURE", `canonical projection omitted selected node ${nodeId}`);
        const properties = Object.fromEntries(
          Object.entries(projectedEntity).filter(([key]) => key !== "@context" && key !== "@id" && key !== "@type"),
        );
        const entity = Object.freeze({ "@type": rule.schemaType, "@id": publicEntityId(pageUrl, nodeId), ...properties });
        assertFeaturePolicy(entity, rule.feature, this.publisherOrigin);
        assertRenderedVisibility(entity, rule.feature, rule.visibleSchemaProperties ?? [], visibleText);
        groundedNodeDigests.push(graphNode.digest);
        outputEntities.push(entity);
      }
    }

    if (outputEntities.length === 0) throw new StructuredKnowledgeError("POLICY_REJECTED", "no grounded structured data entity was selected");
    const jsonLd = Object.freeze({
      "@context": "https://schema.org" as const,
      "@graph": Object.freeze(outputEntities),
    });
    const serializedJsonLd = safeJson(jsonLd);
    const pageEvidenceDigest = sha256({
      pageUrl,
      finalUrl: pageUrl,
      capturedAt,
      source: input.pageEvidence.source,
      normalizedTextDigest: sha256(visibleText),
    });
    const ruleDigest = sha256(rules);
    const jsonLdDigest = sha256(jsonLd);
    const generatedAt = new Date(now).toISOString();
    const receiptBody = {
      schemaVersion: 1 as const,
      strategy: 7 as const,
      publisherOrigin: this.publisherOrigin,
      pageUrl,
      graphDigest: input.graph.digest,
      graphSchemaId: input.graph.schemaId,
      graphAsOf: input.graph.asOf,
      groundedNodeDigests: Object.freeze([...new Set(groundedNodeDigests)].sort()),
      pageEvidenceDigest,
      ruleDigest,
      jsonLdDigest,
      policyVersion: GOOGLE_STRUCTURED_DATA_POLICY_VERSION,
      generatedAt,
    };
    const receipt = Object.freeze({ ...receiptBody, receiptDigest: receiptDigest(receiptBody) });
    const artifact = Object.freeze({
      status: "READY_FOR_RICH_RESULTS_TEST" as const,
      googleAppearanceGuaranteed: false as const,
      pageUrl,
      jsonLd,
      serializedJsonLd,
      receipt,
    });
    if (!verifyGroundedStructuredDataArtifact(artifact)) throw new StructuredKnowledgeError("INTEGRITY_FAILURE", "structured data artifact self-verification failed");
    return artifact;
  }
}
