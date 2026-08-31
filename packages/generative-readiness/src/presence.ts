import {
  assess,
  canonicalJson,
  digestValue,
  validatePage,
  validateReadiness,
  type GenerativePage,
  type ReadinessStatus,
} from "./index.js";

export interface PresenceScope {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly brandId: string;
}

export type ExternalVisibilityState = "NOT_VERIFIED" | "UNAVAILABLE";

export interface GenerativePresenceReport {
  readonly formatVersion: "nexus-generative-presence-v1";
  readonly scope: PresenceScope;
  readonly pageDigest: string;
  readonly readinessDigest: string;
  readonly readinessStatus: ReadinessStatus;
  readonly externalVisibilityState: ExternalVisibilityState;
  readonly issueCodes: readonly string[];
  readonly observedAt: string;
  readonly nonClaim: "READINESS_NOT_PROVIDER_VISIBILITY_CITATION_RANKING_OR_TRAFFIC";
  readonly reportDigest: string;
}

function cleanIdentifier(label: string, value: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 200) throw new Error(`${label} must be non-empty and <= 200 characters`);
  if (!/^[\p{L}\p{N}._:@/-]+$/u.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

export function validatePresenceScope(input: PresenceScope): PresenceScope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("presence scope must be an object");
  const allowed = new Set(["tenantId", "organizationId", "brandId"]);
  for (const key of Object.keys(input as object)) if (!allowed.has(key)) throw new Error(`unknown presence scope field: ${key}`);
  return Object.freeze({
    tenantId: cleanIdentifier("tenantId", input.tenantId),
    organizationId: cleanIdentifier("organizationId", input.organizationId),
    brandId: cleanIdentifier("brandId", input.brandId),
  });
}

function canonicalObservedAt(value: string): string {
  if (typeof value !== "string") throw new Error("observedAt must be a string");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("observedAt must be a valid timestamp");
  const iso = new Date(time).toISOString();
  if (iso !== value) throw new Error("observedAt must be canonical ISO-8601 UTC");
  return iso;
}

export function assessGenerativePresence(
  scopeInput: PresenceScope,
  page: GenerativePage,
  observedAtInput: string,
  externalVisibilityState: ExternalVisibilityState = "NOT_VERIFIED",
): GenerativePresenceReport {
  const scope = validatePresenceScope(scopeInput);
  validatePage(page);
  if (externalVisibilityState !== "NOT_VERIFIED" && externalVisibilityState !== "UNAVAILABLE") throw new Error("invalid external visibility state");
  const observedAt = canonicalObservedAt(observedAtInput);
  const readiness = assess(page, observedAt);
  validateReadiness(page, readiness);
  const issueCodes = Object.freeze(readiness.issues.map((issue) => issue.code).sort());
  const core = {
    formatVersion: "nexus-generative-presence-v1" as const,
    scope,
    pageDigest: page.pageDigest,
    readinessDigest: readiness.readinessDigest,
    readinessStatus: readiness.status,
    externalVisibilityState,
    issueCodes,
    observedAt,
    nonClaim: "READINESS_NOT_PROVIDER_VISIBILITY_CITATION_RANKING_OR_TRAFFIC" as const,
  };
  return Object.freeze({ ...core, reportDigest: digestValue(core) });
}

export function verifyGenerativePresence(
  scope: PresenceScope,
  page: GenerativePage,
  report: GenerativePresenceReport,
): boolean {
  try {
    const rebuilt = assessGenerativePresence(scope, page, report.observedAt, report.externalVisibilityState);
    return canonicalJson(rebuilt) === canonicalJson(report);
  } catch {
    return false;
  }
}
