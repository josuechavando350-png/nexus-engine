import type { GroundedStructuredDataArtifact } from "../07-recomendacion-de-dios/index.js";

export type GoogleIndexingEligibility = "JOB_POSTING" | "LIVESTREAM_BROADCAST_EVENT";

export interface SchemaDtsGraphShape {
  readonly "@context": "https://schema.org";
  readonly "@graph": readonly Readonly<Record<string, unknown>>[];
}

export interface SemanticInjectionResult {
  readonly html: string;
  readonly pageUrl: string;
  readonly receiptDigest: string;
  readonly indexingEligibility: readonly GoogleIndexingEligibility[];
  readonly typeContract: "SCHEMA_DTS_GRAPH_COMPATIBLE";
}

export class SemanticInterleaverError extends Error {
  constructor(
    public readonly code: "INVALID_CONFIG" | "INVALID_INPUT" | "IDENTITY_MISMATCH" | "ARTIFACT_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "SemanticInterleaverError";
  }
}

function origin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SemanticInterleaverError("INVALID_CONFIG", "operatorWebsiteOrigin must be an absolute URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) {
    throw new SemanticInterleaverError("INVALID_CONFIG", "operatorWebsiteOrigin must be a bare HTTPS origin");
  }
  return url.origin;
}

function typeNames(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  return [];
}

function containsType(value: unknown, target: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsType(entry, target));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeNames(record["@type"]).includes(target)) return true;
  return Object.values(record).some((entry) => containsType(entry, target));
}

function videoObjectContainsBroadcastEvent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(videoObjectContainsBroadcastEvent);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeNames(record["@type"]).includes("VideoObject")) {
    for (const [key, nested] of Object.entries(record)) {
      if (key === "@type" || key === "@id") continue;
      if (containsType(nested, "BroadcastEvent")) return true;
    }
  }
  return Object.values(record).some(videoObjectContainsBroadcastEvent);
}

export function detectGoogleIndexingEligibility(graph: SchemaDtsGraphShape): readonly GoogleIndexingEligibility[] {
  const eligible: GoogleIndexingEligibility[] = [];
  if (containsType(graph, "JobPosting")) eligible.push("JOB_POSTING");
  if (videoObjectContainsBroadcastEvent(graph)) eligible.push("LIVESTREAM_BROADCAST_EVENT");
  return Object.freeze(eligible);
}

/**
 * Runtime structural gate corresponding to the shape consumed by schema-dts' `Graph`.
 * `schema-dts` itself is a TypeScript definition library rather than a runtime validator;
 * applications can additionally assign this return value to `Graph` at compile time.
 */
export function assertSchemaDtsGraphShape(value: unknown): asserts value is SchemaDtsGraphShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SemanticInterleaverError("ARTIFACT_REJECTED", "JSON-LD graph must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["@context"] !== "https://schema.org" || !Array.isArray(record["@graph"]) || record["@graph"].length === 0) {
    throw new SemanticInterleaverError("ARTIFACT_REJECTED", "JSON-LD must contain a non-empty https://schema.org graph");
  }
  for (const node of record["@graph"]) {
    if (!node || typeof node !== "object" || Array.isArray(node) || Object.getPrototypeOf(node) !== Object.prototype) {
      throw new SemanticInterleaverError("ARTIFACT_REJECTED", "every JSON-LD graph node must be a plain object");
    }
  }
}

function scriptSafeJson(value: SchemaDtsGraphShape): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

const NEXUS_SCRIPT = /<script\b[^>]*\bdata-nexus-semantic=(?:"v1"|'v1')[^>]*>[\s\S]*?<\/script\s*>/giu;

export class EntityGraphInterleaver {
  private readonly operatorWebsiteOrigin: string;

  constructor(operatorWebsiteOrigin: string) {
    this.operatorWebsiteOrigin = origin(operatorWebsiteOrigin);
  }

  identity() {
    return Object.freeze({
      strategy: 13 as const,
      provider: "SCHEMA_DTS_ENTITY_GRAPH_INTERLEAVER" as const,
      upstreamProvider: "VERIFIED_SEMANTIC_GRAPH_RICH_RESULTS" as const,
      operatorWebsiteOrigin: this.operatorWebsiteOrigin,
    });
  }

  inject(htmlInput: string, artifact: GroundedStructuredDataArtifact): SemanticInjectionResult {
    if (typeof htmlInput !== "string" || htmlInput.length === 0 || htmlInput.length > 2 * 1024 * 1024) {
      throw new SemanticInterleaverError("INVALID_INPUT", "HTML must be non-empty and at most 2 MiB");
    }
    if (
      !artifact ||
      artifact.status !== "READY_FOR_RICH_RESULTS_TEST" ||
      artifact.googleAppearanceGuaranteed !== false ||
      typeof artifact.pageUrl !== "string" ||
      typeof artifact.receipt?.receiptDigest !== "string"
    ) {
      throw new SemanticInterleaverError("ARTIFACT_REJECTED", "structured-data artifact was not certified by #7");
    }
    const pageUrl = new URL(artifact.pageUrl);
    if (pageUrl.protocol !== "https:" || pageUrl.origin !== this.operatorWebsiteOrigin) {
      throw new SemanticInterleaverError("IDENTITY_MISMATCH", "#13 page origin must match the canonical operator origin");
    }
    assertSchemaDtsGraphShape(artifact.jsonLd);

    const script = `<script type="application/ld+json" data-nexus-semantic="v1">${scriptSafeJson(artifact.jsonLd)}</script>`;
    let html = htmlInput.replace(NEXUS_SCRIPT, "");
    const closeHead = /<\/head\s*>/iu;
    const closeBody = /<\/body\s*>/iu;
    if (closeHead.test(html)) html = html.replace(closeHead, `${script}</head>`);
    else if (closeBody.test(html)) html = html.replace(closeBody, `${script}</body>`);
    else throw new SemanticInterleaverError("INVALID_INPUT", "HTML must contain a closing head or body element");

    return Object.freeze({
      html,
      pageUrl: pageUrl.href,
      receiptDigest: artifact.receipt.receiptDigest,
      indexingEligibility: detectGoogleIndexingEligibility(artifact.jsonLd),
      typeContract: "SCHEMA_DTS_GRAPH_COMPATIBLE" as const,
    });
  }
}
