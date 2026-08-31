import { canonicalJson, digest } from "./index";
import {
  capturePublicPage,
  validateCompetitiveScope,
  validatePublicPageObservation,
  type CompetitiveScope,
  type PublicPageObservation,
} from "./competitive-intelligence";

const MAX_SOURCES = 50;
const MAX_TERMS = 100;
const MAX_ID = 200;
const MAX_LABEL = 500;

export type ReputationScope = CompetitiveScope;
export interface ReputationSource {
  readonly id: string;
  readonly label: string;
  readonly observation: PublicPageObservation;
}
export interface ReputationSignal {
  readonly term: string;
  readonly sourceCount: number;
  readonly sourceIds: readonly string[];
}
export interface ReputationReport {
  readonly formatVersion: "nexus-reputation-shield-v1";
  readonly scope: ReputationScope;
  readonly subjectId: string;
  readonly sourceIds: readonly string[];
  readonly evidenceState: "OBSERVED_PUBLIC_HTTP" | "SYNTHETIC";
  readonly nonClaim: "PUBLIC_PAGE_TERM_SIGNAL_NOT_SENTIMENT_RATING_REVIEW_AUTHENTICITY_OR_BUSINESS_OUTCOME";
  readonly monitoredTerms: readonly string[];
  readonly signals: readonly ReputationSignal[];
  readonly sourceDigests: readonly string[];
  readonly reportDigest: string;
}

function clean(label: string, value: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be non-empty and <= ${max} characters`);
  return normalized;
}

function normalizeTerm(value: string): string {
  const normalized = clean("monitored term", value, 80)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9_-]{1,79}$/u.test(normalized)) {
    throw new Error("monitored terms must be single normalized tokens of 2 to 80 characters");
  }
  return normalized;
}

export function normalizeMonitoredTerms(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TERMS) {
    throw new Error(`monitoredTerms must contain 1 to ${MAX_TERMS} terms`);
  }
  const terms = input.map(normalizeTerm);
  if (new Set(terms).size !== terms.length) throw new Error("monitoredTerms must be unique after normalization");
  return Object.freeze([...terms].sort((a, b) => a.localeCompare(b, "en")));
}

export function analyzeReputationShield(
  scopeInput: ReputationScope,
  subjectIdInput: string,
  sources: readonly ReputationSource[],
  monitoredTermsInput: readonly string[],
): ReputationReport {
  const scope = validateCompetitiveScope(scopeInput);
  const subjectId = clean("subjectId", subjectIdInput, MAX_ID);
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > MAX_SOURCES) {
    throw new Error(`sources must contain 1 to ${MAX_SOURCES} observations`);
  }
  const monitoredTerms = normalizeMonitoredTerms(monitoredTermsInput);
  const ids = sources.map((source, index) => clean(`sources[${index}].id`, source.id, MAX_ID));
  if (new Set(ids).size !== ids.length) throw new Error("reputation source ids must be unique");

  sources.forEach((source, index) => {
    clean(`sources[${index}].label`, source.label, MAX_LABEL);
    validatePublicPageObservation(source.observation);
    if (canonicalJson(source.observation.scope) !== canonicalJson(scope)) throw new Error("reputation observation scope mismatch");
  });
  const authorities = new Set(sources.map((source) => source.observation.authority));
  if (authorities.size !== 1) throw new Error("mixed reputation observation authorities are forbidden");

  const signals = Object.freeze(monitoredTerms.map((term) => {
    const sourceIds = sources
      .filter((source) => source.observation.visibleTerms.includes(term))
      .map((source) => source.id)
      .sort((a, b) => a.localeCompare(b, "en"));
    return Object.freeze({ term, sourceCount: sourceIds.length, sourceIds: Object.freeze(sourceIds) });
  }).filter((signal) => signal.sourceCount > 0)
    .sort((a, b) => b.sourceCount - a.sourceCount || a.term.localeCompare(b.term, "en")));

  const core = {
    formatVersion: "nexus-reputation-shield-v1" as const,
    scope,
    subjectId,
    sourceIds: Object.freeze([...ids].sort((a, b) => a.localeCompare(b, "en"))),
    evidenceState: sources[0]!.observation.authority === "PUBLIC_HTTP_CAPTURE" ? "OBSERVED_PUBLIC_HTTP" as const : "SYNTHETIC" as const,
    nonClaim: "PUBLIC_PAGE_TERM_SIGNAL_NOT_SENTIMENT_RATING_REVIEW_AUTHENTICITY_OR_BUSINESS_OUTCOME" as const,
    monitoredTerms,
    signals,
    sourceDigests: Object.freeze(sources.map((source) => source.observation.observationDigest).sort((a, b) => a.localeCompare(b, "en"))),
  };
  return Object.freeze({ ...core, reportDigest: digest(core) });
}

export function verifyReputationShield(
  scope: ReputationScope,
  subjectId: string,
  sources: readonly ReputationSource[],
  monitoredTerms: readonly string[],
  report: ReputationReport,
): boolean {
  try {
    return canonicalJson(analyzeReputationShield(scope, subjectId, sources, monitoredTerms)) === canonicalJson(report);
  } catch {
    return false;
  }
}

export { capturePublicPage };
