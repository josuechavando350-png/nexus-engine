import { createHash } from "node:crypto";

const NUMERIC_ID = /^\d{1,20}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_KEYWORD_CHARACTERS = 80;
const MAX_KEYWORD_WORDS = 10;

export type SearchTermTargetingStatus = "NONE" | "ADDED" | "EXCLUDED" | "ADDED_EXCLUDED" | "UNKNOWN" | "UNSPECIFIED";
export type SearchTermMatchType = "BROAD" | "PHRASE" | "EXACT" | "NEAR_EXACT" | "NEAR_PHRASE" | "AI_MAX" | "PERFORMANCE_MAX" | "UNKNOWN" | "UNSPECIFIED";

export interface SearchTermObservation {
  readonly campaignId: string;
  readonly adGroupId: string;
  readonly searchTerm: string;
  readonly targetingStatus: SearchTermTargetingStatus;
  readonly searchTermMatchType: SearchTermMatchType;
  readonly impressions: number;
  readonly clicks: number;
  readonly conversions: number;
  readonly conversionValue: number;
  readonly costMicros: number;
}

export interface ExactMatchSelectionPolicy {
  readonly startDate: string;
  readonly endDate: string;
  readonly minimumClicks: number;
  readonly minimumConversions: number;
  readonly minimumConversionRate: number;
  readonly maximumCostPerConversionMicros?: number | null;
  readonly minimumConversionValuePerCost?: number | null;
  readonly maximumCandidates: number;
}

interface ResolvedExactMatchSelectionPolicy {
  readonly startDate: string;
  readonly endDate: string;
  readonly minimumClicks: number;
  readonly minimumConversions: number;
  readonly minimumConversionRate: number;
  readonly maximumCostPerConversionMicros: number | null;
  readonly minimumConversionValuePerCost: number | null;
  readonly maximumCandidates: number;
}

export interface ExactMatchCandidate {
  readonly campaignId: string;
  readonly sourceAdGroupId: string;
  readonly searchTerm: string;
  readonly normalizedSearchTerm: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly conversions: number;
  readonly conversionValue: number;
  readonly costMicros: number;
  readonly conversionRate: number;
  readonly costPerConversionMicros: number;
  readonly conversionValuePerCost: number;
  readonly observedMatchTypes: readonly SearchTermMatchType[];
  readonly fingerprint: string;
}

export type ExactMatchRejectionReason =
  | "ALREADY_TARGETED_OR_EXCLUDED"
  | "KEYWORD_LIMIT_EXCEEDED"
  | "BELOW_MINIMUM_CLICKS"
  | "BELOW_MINIMUM_CONVERSIONS"
  | "BELOW_MINIMUM_CONVERSION_RATE"
  | "ABOVE_MAXIMUM_COST_PER_CONVERSION"
  | "BELOW_MINIMUM_CONVERSION_VALUE_PER_COST"
  | "RUN_CAP_REACHED";

export interface RejectedExactMatchCandidate {
  readonly campaignId: string;
  readonly searchTerm: string;
  readonly normalizedSearchTerm: string;
  readonly reasons: readonly ExactMatchRejectionReason[];
}

export interface ExactMatchSelectionResult {
  readonly selected: readonly ExactMatchCandidate[];
  readonly rejected: readonly RejectedExactMatchCandidate[];
}

export class ExactMatchSynthesizerError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "INVALID_POLICY",
    message: string,
  ) {
    super(message);
    this.name = "ExactMatchSynthesizerError";
  }
}

function numericId(value: string, label: string): string {
  const normalized = value.trim();
  if (!NUMERIC_ID.test(normalized)) throw new ExactMatchSynthesizerError("INVALID_INPUT", `${label} is malformed`);
  return normalized;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new ExactMatchSynthesizerError("INVALID_INPUT", `${label} must be finite and non-negative`);
  return value;
}

function safeIntegerNonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ExactMatchSynthesizerError("INVALID_INPUT", `${label} must be a non-negative safe integer`);
  return value;
}

function canonicalDate(value: string, label: string): string {
  if (!DATE.test(value)) throw new ExactMatchSynthesizerError("INVALID_POLICY", `${label} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ExactMatchSynthesizerError("INVALID_POLICY", `${label} is not a real calendar date`);
  return value;
}

export function normalizeSearchTerm(value: string): string {
  if (typeof value !== "string") throw new ExactMatchSynthesizerError("INVALID_INPUT", "searchTerm must be a string");
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new ExactMatchSynthesizerError("INVALID_INPUT", "searchTerm is empty or contains control characters");
  return normalized;
}

export function keywordFitsGoogleLimits(value: string): boolean {
  const normalized = normalizeSearchTerm(value);
  const words = normalized.split(" ");
  return normalized.length <= MAX_KEYWORD_CHARACTERS && words.length <= MAX_KEYWORD_WORDS;
}

function validateStatus(value: SearchTermTargetingStatus): SearchTermTargetingStatus {
  if (!(value === "NONE" || value === "ADDED" || value === "EXCLUDED" || value === "ADDED_EXCLUDED" || value === "UNKNOWN" || value === "UNSPECIFIED")) {
    throw new ExactMatchSynthesizerError("INVALID_INPUT", "targetingStatus is unsupported");
  }
  return value;
}

function validateMatchType(value: SearchTermMatchType): SearchTermMatchType {
  if (!(value === "BROAD" || value === "PHRASE" || value === "EXACT" || value === "NEAR_EXACT" || value === "NEAR_PHRASE" || value === "AI_MAX" || value === "PERFORMANCE_MAX" || value === "UNKNOWN" || value === "UNSPECIFIED")) {
    throw new ExactMatchSynthesizerError("INVALID_INPUT", "searchTermMatchType is unsupported");
  }
  return value;
}

function validateObservation(value: SearchTermObservation): Readonly<SearchTermObservation> {
  if (!value || typeof value !== "object") throw new ExactMatchSynthesizerError("INVALID_INPUT", "search term observation is required");
  if (typeof value.searchTerm !== "string") throw new ExactMatchSynthesizerError("INVALID_INPUT", "searchTerm must be a string");
  const searchTerm = value.searchTerm.normalize("NFKC").replace(/\s+/gu, " ").trim();
  normalizeSearchTerm(searchTerm);
  return Object.freeze({
    campaignId: numericId(value.campaignId, "campaignId"),
    adGroupId: numericId(value.adGroupId, "adGroupId"),
    searchTerm,
    targetingStatus: validateStatus(value.targetingStatus),
    searchTermMatchType: validateMatchType(value.searchTermMatchType),
    impressions: safeIntegerNonNegative(value.impressions, "impressions"),
    clicks: safeIntegerNonNegative(value.clicks, "clicks"),
    conversions: finiteNonNegative(value.conversions, "conversions"),
    conversionValue: finiteNonNegative(value.conversionValue, "conversionValue"),
    costMicros: safeIntegerNonNegative(value.costMicros, "costMicros"),
  });
}

function validatePolicy(value: ExactMatchSelectionPolicy): ResolvedExactMatchSelectionPolicy {
  if (!value || typeof value !== "object") throw new ExactMatchSynthesizerError("INVALID_POLICY", "selection policy is required");
  const startDate = canonicalDate(value.startDate, "startDate");
  const endDate = canonicalDate(value.endDate, "endDate");
  if (startDate > endDate) throw new ExactMatchSynthesizerError("INVALID_POLICY", "startDate must not be after endDate");
  if (!Number.isSafeInteger(value.minimumClicks) || value.minimumClicks < 1 || value.minimumClicks > 1_000_000_000) throw new ExactMatchSynthesizerError("INVALID_POLICY", "minimumClicks must be a positive safe integer");
  if (!Number.isFinite(value.minimumConversions) || value.minimumConversions < 0 || value.minimumConversions > 1_000_000_000) throw new ExactMatchSynthesizerError("INVALID_POLICY", "minimumConversions is invalid");
  if (!Number.isFinite(value.minimumConversionRate) || value.minimumConversionRate < 0 || value.minimumConversionRate > 1) throw new ExactMatchSynthesizerError("INVALID_POLICY", "minimumConversionRate must be from 0 to 1");
  const maximumCostPerConversionMicros = value.maximumCostPerConversionMicros ?? null;
  if (maximumCostPerConversionMicros !== null && (!Number.isSafeInteger(maximumCostPerConversionMicros) || maximumCostPerConversionMicros <= 0)) throw new ExactMatchSynthesizerError("INVALID_POLICY", "maximumCostPerConversionMicros must be a positive safe integer or null");
  const minimumConversionValuePerCost = value.minimumConversionValuePerCost ?? null;
  if (minimumConversionValuePerCost !== null && (!Number.isFinite(minimumConversionValuePerCost) || minimumConversionValuePerCost < 0)) throw new ExactMatchSynthesizerError("INVALID_POLICY", "minimumConversionValuePerCost must be finite and non-negative or null");
  if (!Number.isSafeInteger(value.maximumCandidates) || value.maximumCandidates < 1 || value.maximumCandidates > 100) throw new ExactMatchSynthesizerError("INVALID_POLICY", "maximumCandidates must be an integer from 1 to 100");
  return Object.freeze({
    startDate,
    endDate,
    minimumClicks: value.minimumClicks,
    minimumConversions: value.minimumConversions,
    minimumConversionRate: value.minimumConversionRate,
    maximumCostPerConversionMicros,
    minimumConversionValuePerCost,
    maximumCandidates: value.maximumCandidates,
  });
}

interface Aggregate {
  campaignId: string;
  searchTerm: string;
  normalizedSearchTerm: string;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  costMicros: number;
  observedMatchTypes: Set<SearchTermMatchType>;
  targetingStatuses: Set<SearchTermTargetingStatus>;
  sourceRows: Array<{ adGroupId: string; clicks: number; conversions: number }>;
}

function addSafeInteger(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new ExactMatchSynthesizerError("INVALID_INPUT", `${label} aggregate exceeded safe integer range`);
  return result;
}

function fingerprint(campaignId: string, normalizedSearchTerm: string): string {
  return createHash("sha256").update(`${campaignId}\n${normalizedSearchTerm}`, "utf8").digest("hex");
}

function scoreCandidate(aggregate: Aggregate): ExactMatchCandidate {
  const conversionRate = aggregate.clicks > 0 ? aggregate.conversions / aggregate.clicks : 0;
  const costPerConversionMicros = aggregate.conversions > 0 ? aggregate.costMicros / aggregate.conversions : Number.POSITIVE_INFINITY;
  const costCurrency = aggregate.costMicros / 1_000_000;
  const conversionValuePerCost = costCurrency > 0 ? aggregate.conversionValue / costCurrency : aggregate.conversionValue > 0 ? Number.POSITIVE_INFINITY : 0;
  const sourceAdGroupId = [...aggregate.sourceRows]
    .sort((a, b) => b.conversions - a.conversions || b.clicks - a.clicks || a.adGroupId.localeCompare(b.adGroupId, "en"))[0]!.adGroupId;
  return Object.freeze({
    campaignId: aggregate.campaignId,
    sourceAdGroupId,
    searchTerm: aggregate.searchTerm,
    normalizedSearchTerm: aggregate.normalizedSearchTerm,
    impressions: aggregate.impressions,
    clicks: aggregate.clicks,
    conversions: aggregate.conversions,
    conversionValue: aggregate.conversionValue,
    costMicros: aggregate.costMicros,
    conversionRate,
    costPerConversionMicros,
    conversionValuePerCost,
    observedMatchTypes: Object.freeze([...aggregate.observedMatchTypes].sort()),
    fingerprint: fingerprint(aggregate.campaignId, aggregate.normalizedSearchTerm),
  });
}

export function selectExactMatchCandidates(
  observationsInput: readonly SearchTermObservation[],
  policyInput: ExactMatchSelectionPolicy,
): ExactMatchSelectionResult {
  if (!Array.isArray(observationsInput) || observationsInput.length > 100_000) throw new ExactMatchSynthesizerError("INVALID_INPUT", "observations must be an array with at most 100000 rows");
  const policy = validatePolicy(policyInput);
  const aggregates = new Map<string, Aggregate>();

  for (const observationInput of observationsInput) {
    const observation = validateObservation(observationInput);
    const normalizedSearchTerm = normalizeSearchTerm(observation.searchTerm);
    const key = `${observation.campaignId}\u0000${normalizedSearchTerm}`;
    const aggregate = aggregates.get(key) ?? {
      campaignId: observation.campaignId,
      searchTerm: observation.searchTerm,
      normalizedSearchTerm,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversionValue: 0,
      costMicros: 0,
      observedMatchTypes: new Set<SearchTermMatchType>(),
      targetingStatuses: new Set<SearchTermTargetingStatus>(),
      sourceRows: [],
    };
    aggregate.impressions = addSafeInteger(aggregate.impressions, observation.impressions, "impressions");
    aggregate.clicks = addSafeInteger(aggregate.clicks, observation.clicks, "clicks");
    aggregate.conversions += observation.conversions;
    aggregate.conversionValue += observation.conversionValue;
    if (!Number.isFinite(aggregate.conversions) || !Number.isFinite(aggregate.conversionValue)) throw new ExactMatchSynthesizerError("INVALID_INPUT", "aggregated conversion metrics are not finite");
    aggregate.costMicros = addSafeInteger(aggregate.costMicros, observation.costMicros, "costMicros");
    aggregate.observedMatchTypes.add(observation.searchTermMatchType);
    aggregate.targetingStatuses.add(observation.targetingStatus);
    aggregate.sourceRows.push({ adGroupId: observation.adGroupId, clicks: observation.clicks, conversions: observation.conversions });
    aggregates.set(key, aggregate);
  }

  const passing: ExactMatchCandidate[] = [];
  const rejected: RejectedExactMatchCandidate[] = [];

  for (const aggregate of aggregates.values()) {
    const candidate = scoreCandidate(aggregate);
    const reasons: ExactMatchRejectionReason[] = [];
    if ([...aggregate.targetingStatuses].some((status) => status !== "NONE")) reasons.push("ALREADY_TARGETED_OR_EXCLUDED");
    if (!keywordFitsGoogleLimits(candidate.searchTerm)) reasons.push("KEYWORD_LIMIT_EXCEEDED");
    if (candidate.clicks < policy.minimumClicks) reasons.push("BELOW_MINIMUM_CLICKS");
    if (candidate.conversions < policy.minimumConversions) reasons.push("BELOW_MINIMUM_CONVERSIONS");
    if (candidate.conversionRate < policy.minimumConversionRate) reasons.push("BELOW_MINIMUM_CONVERSION_RATE");
    if (policy.maximumCostPerConversionMicros !== null && candidate.costPerConversionMicros > policy.maximumCostPerConversionMicros) reasons.push("ABOVE_MAXIMUM_COST_PER_CONVERSION");
    if (policy.minimumConversionValuePerCost !== null && candidate.conversionValuePerCost < policy.minimumConversionValuePerCost) reasons.push("BELOW_MINIMUM_CONVERSION_VALUE_PER_COST");
    if (reasons.length) {
      rejected.push(Object.freeze({ campaignId: candidate.campaignId, searchTerm: candidate.searchTerm, normalizedSearchTerm: candidate.normalizedSearchTerm, reasons: Object.freeze(reasons) }));
    } else {
      passing.push(candidate);
    }
  }

  passing.sort((a, b) => b.conversions - a.conversions || b.conversionRate - a.conversionRate || b.clicks - a.clicks || a.normalizedSearchTerm.localeCompare(b.normalizedSearchTerm, "en"));
  const selected = passing.slice(0, policy.maximumCandidates);
  for (const candidate of passing.slice(policy.maximumCandidates)) {
    rejected.push(Object.freeze({ campaignId: candidate.campaignId, searchTerm: candidate.searchTerm, normalizedSearchTerm: candidate.normalizedSearchTerm, reasons: Object.freeze(["RUN_CAP_REACHED"] as const) }));
  }

  rejected.sort((a, b) => a.campaignId.localeCompare(b.campaignId, "en") || a.normalizedSearchTerm.localeCompare(b.normalizedSearchTerm, "en"));
  return Object.freeze({ selected: Object.freeze(selected), rejected: Object.freeze(rejected) });
}
