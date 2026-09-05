export type AdContextMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type AdContextChannel = "DIRECT_OR_UNKNOWN" | "PAID_SEARCH" | "PAID_SOCIAL";
export type AdContextReason =
  | "KILL_SWITCH"
  | "NO_AD_CONTEXT"
  | "EXACT_RULE_MATCH"
  | "PAID_SEARCH_SIGNAL"
  | "PAID_SOCIAL_SIGNAL"
  | "OBSERVE_ONLY_MATCH"
  | "MALFORMED_CONTEXT"
  | "AMBIGUOUS_CONTEXT";

export interface AdContextExactRuleInput {
  readonly ruleId: string;
  readonly experienceId: string;
  readonly source?: string;
  readonly medium?: string;
  readonly campaign?: string;
}

export interface AdContextExactRule {
  readonly ruleId: string;
  readonly experienceId: string;
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
}

export interface AdContextPolicyInput {
  readonly policyId: string;
  readonly mode: AdContextMode;
  readonly defaultExperienceId: string;
  readonly paidSearchExperienceId?: string;
  readonly paidSocialExperienceId?: string;
  readonly allowedExperienceIds: readonly string[];
  readonly exactRules?: readonly AdContextExactRuleInput[];
  readonly maxQueryBytes?: number;
  readonly maxValueLength?: number;
}

export interface AdContextPolicy {
  readonly policyId: string;
  readonly mode: AdContextMode;
  readonly defaultExperienceId: string;
  readonly paidSearchExperienceId: string | null;
  readonly paidSocialExperienceId: string | null;
  readonly allowedExperienceIds: readonly string[];
  readonly exactRules: readonly AdContextExactRule[];
  readonly maxQueryBytes: number;
  readonly maxValueLength: number;
}

export interface AdContextDecision {
  readonly policyId: string;
  readonly mode: AdContextMode;
  readonly channel: AdContextChannel;
  readonly experienceId: string;
  readonly wouldApplyExperienceId: string;
  readonly applied: boolean;
  readonly reason: AdContextReason;
  readonly ruleId: string | null;
  readonly contextPresent: boolean;
  readonly clickSignalPresent: boolean;
}

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_RULES = 64;
const DEFAULT_MAX_QUERY_BYTES = 4_096;
const DEFAULT_MAX_VALUE_LENGTH = 256;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const CLICK_KEYS = ["gclid", "gbraid", "wbraid", "msclkid", "fbclid", "ttclid"] as const;
const RECOGNIZED_KEYS = new Set<string>([...UTM_KEYS, ...CLICK_KEYS]);
const SEARCH_CLICK_KEYS = new Set<string>(["gclid", "gbraid", "wbraid", "msclkid"]);
const SOCIAL_CLICK_KEYS = new Set<string>(["fbclid", "ttclid"]);
const SEARCH_SOURCES = new Set(["google", "bing", "microsoft", "googleads", "google-ads"]);
const SOCIAL_SOURCES = new Set(["facebook", "instagram", "meta", "tiktok"]);
const PAID_SEARCH_MEDIA = new Set(["cpc", "ppc", "paidsearch", "paid-search", "paid_search"]);
const PAID_SOCIAL_MEDIA = new Set(["paid", "paidsocial", "paid-social", "paid_social", "cpc", "cpm"]);

interface ParsedAdContext {
  readonly malformed: boolean;
  readonly ambiguous: boolean;
  readonly contextPresent: boolean;
  readonly clickSignalPresent: boolean;
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
  readonly channel: AdContextChannel;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${field} must be ${min}..${max}`);
  return resolved;
}

function identifier(value: string, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${field} must be a bounded identifier`);
  return normalized;
}

function normalizedMatcher(value: string | undefined, field: string, maxValueLength: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > maxValueLength) throw new Error(`${field} must contain 1..${maxValueLength} characters`);
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw new Error(`${field} contains a control character`);
  }
  return normalized;
}

function ruleKey(rule: Pick<AdContextExactRule, "source" | "medium" | "campaign">): string {
  return `${rule.source ?? "*"}\u0000${rule.medium ?? "*"}\u0000${rule.campaign ?? "*"}`;
}

function matcherDimensionOverlaps(left: string | null, right: string | null): boolean {
  return left === null || right === null || left === right;
}

function rulesOverlap(left: AdContextExactRule, right: AdContextExactRule): boolean {
  return matcherDimensionOverlaps(left.source, right.source)
    && matcherDimensionOverlaps(left.medium, right.medium)
    && matcherDimensionOverlaps(left.campaign, right.campaign);
}

export function createAdContextPolicy(input: AdContextPolicyInput): AdContextPolicy {
  if (!input || typeof input !== "object") throw new Error("ad context policy is required");
  if (!(["ACTIVE", "OBSERVE_ONLY", "KILLED"] as const).includes(input.mode)) throw new Error("mode is invalid");
  const policyId = identifier(input.policyId, "policyId");
  const defaultExperienceId = identifier(input.defaultExperienceId, "defaultExperienceId");
  if (!Array.isArray(input.allowedExperienceIds) || input.allowedExperienceIds.length === 0 || input.allowedExperienceIds.length > 64) {
    throw new Error("allowedExperienceIds must contain 1..64 items");
  }
  const allowedExperienceIds = input.allowedExperienceIds.map((value) => identifier(value, "allowedExperienceId"));
  if (new Set(allowedExperienceIds).size !== allowedExperienceIds.length) throw new Error("allowedExperienceIds must be unique");
  const allowed = new Set(allowedExperienceIds);
  if (!allowed.has(defaultExperienceId)) throw new Error("defaultExperienceId must be allowlisted");

  const paidSearchExperienceId = input.paidSearchExperienceId === undefined ? null : identifier(input.paidSearchExperienceId, "paidSearchExperienceId");
  const paidSocialExperienceId = input.paidSocialExperienceId === undefined ? null : identifier(input.paidSocialExperienceId, "paidSocialExperienceId");
  if (paidSearchExperienceId && !allowed.has(paidSearchExperienceId)) throw new Error("paidSearchExperienceId must be allowlisted");
  if (paidSocialExperienceId && !allowed.has(paidSocialExperienceId)) throw new Error("paidSocialExperienceId must be allowlisted");

  const maxQueryBytes = boundedInteger(input.maxQueryBytes, DEFAULT_MAX_QUERY_BYTES, 256, 16_384, "maxQueryBytes");
  const maxValueLength = boundedInteger(input.maxValueLength, DEFAULT_MAX_VALUE_LENGTH, 16, 1_024, "maxValueLength");
  const ruleInputs = input.exactRules ?? [];
  if (!Array.isArray(ruleInputs) || ruleInputs.length > MAX_RULES) throw new Error(`exactRules must contain 0..${MAX_RULES} items`);
  const ruleIds = new Set<string>();
  const matcherKeys = new Set<string>();
  const exactRules = ruleInputs.map((rule, index): AdContextExactRule => {
    if (!rule || typeof rule !== "object") throw new Error(`exactRules[${index}] is invalid`);
    const ruleId = identifier(rule.ruleId, `exactRules[${index}].ruleId`);
    if (ruleIds.has(ruleId)) throw new Error(`duplicate ruleId ${ruleId}`);
    ruleIds.add(ruleId);
    const experienceId = identifier(rule.experienceId, `exactRules[${index}].experienceId`);
    if (!allowed.has(experienceId)) throw new Error(`exactRules[${index}].experienceId must be allowlisted`);
    const source = normalizedMatcher(rule.source, `exactRules[${index}].source`, maxValueLength);
    const medium = normalizedMatcher(rule.medium, `exactRules[${index}].medium`, maxValueLength);
    const campaign = normalizedMatcher(rule.campaign, `exactRules[${index}].campaign`, maxValueLength);
    if (source === null && medium === null && campaign === null) throw new Error(`exactRules[${index}] must declare at least one matcher`);
    const normalizedRule = Object.freeze({ ruleId, experienceId, source, medium, campaign });
    const key = ruleKey(normalizedRule);
    if (matcherKeys.has(key)) throw new Error(`duplicate exact-rule matcher at index ${index}`);
    matcherKeys.add(key);
    return normalizedRule;
  });

  for (let left = 0; left < exactRules.length; left += 1) {
    for (let right = left + 1; right < exactRules.length; right += 1) {
      const leftRule = exactRules[left]!;
      const rightRule = exactRules[right]!;
      if (rulesOverlap(leftRule, rightRule)) throw new Error(`exact rules ${leftRule.ruleId} and ${rightRule.ruleId} overlap`);
    }
  }

  return Object.freeze({
    policyId,
    mode: input.mode,
    defaultExperienceId,
    paidSearchExperienceId,
    paidSocialExperienceId,
    allowedExperienceIds: Object.freeze([...allowedExperienceIds]),
    exactRules: Object.freeze(exactRules),
    maxQueryBytes,
    maxValueLength,
  });
}

function safeValue(params: URLSearchParams, key: string, maxValueLength: number): { malformed: boolean; value: string | null } {
  const values = params.getAll(key);
  if (values.length === 0) return { malformed: false, value: null };
  if (values.length !== 1) return { malformed: true, value: null };
  const raw = values[0] ?? "";
  const normalized = raw.normalize("NFKC").trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > maxValueLength) return { malformed: true, value: null };
  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return { malformed: true, value: null };
  }
  return { malformed: false, value: normalized };
}

function parseAdContext(url: URL, policy: AdContextPolicy): ParsedAdContext {
  if (new TextEncoder().encode(url.search).byteLength > policy.maxQueryBytes) {
    return { malformed: true, ambiguous: false, contextPresent: true, clickSignalPresent: false, source: null, medium: null, campaign: null, channel: "DIRECT_OR_UNKNOWN" };
  }
  const params = url.searchParams;
  let contextPresent = false;
  for (const key of RECOGNIZED_KEYS) if (params.has(key)) contextPresent = true;
  if (!contextPresent) {
    return { malformed: false, ambiguous: false, contextPresent: false, clickSignalPresent: false, source: null, medium: null, campaign: null, channel: "DIRECT_OR_UNKNOWN" };
  }

  const source = safeValue(params, "utm_source", policy.maxValueLength);
  const medium = safeValue(params, "utm_medium", policy.maxValueLength);
  const campaign = safeValue(params, "utm_campaign", policy.maxValueLength);
  const content = safeValue(params, "utm_content", policy.maxValueLength);
  const term = safeValue(params, "utm_term", policy.maxValueLength);
  if (source.malformed || medium.malformed || campaign.malformed || content.malformed || term.malformed) {
    return { malformed: true, ambiguous: false, contextPresent: true, clickSignalPresent: false, source: null, medium: null, campaign: null, channel: "DIRECT_OR_UNKNOWN" };
  }

  const channels = new Set<AdContextChannel>();
  let clickSignalPresent = false;
  for (const key of CLICK_KEYS) {
    const click = safeValue(params, key, policy.maxValueLength);
    if (click.malformed) {
      return { malformed: true, ambiguous: false, contextPresent: true, clickSignalPresent, source: source.value, medium: medium.value, campaign: campaign.value, channel: "DIRECT_OR_UNKNOWN" };
    }
    if (click.value !== null) {
      clickSignalPresent = true;
      if (SEARCH_CLICK_KEYS.has(key)) channels.add("PAID_SEARCH");
      else if (SOCIAL_CLICK_KEYS.has(key)) channels.add("PAID_SOCIAL");
    }
  }

  if (source.value && medium.value) {
    if (SEARCH_SOURCES.has(source.value) && PAID_SEARCH_MEDIA.has(medium.value)) channels.add("PAID_SEARCH");
    if (SOCIAL_SOURCES.has(source.value) && PAID_SOCIAL_MEDIA.has(medium.value)) channels.add("PAID_SOCIAL");
  }
  if (channels.size > 1) {
    return { malformed: false, ambiguous: true, contextPresent: true, clickSignalPresent, source: source.value, medium: medium.value, campaign: campaign.value, channel: "DIRECT_OR_UNKNOWN" };
  }
  const channel = channels.values().next().value as AdContextChannel | undefined;
  return {
    malformed: false,
    ambiguous: false,
    contextPresent: true,
    clickSignalPresent,
    source: source.value,
    medium: medium.value,
    campaign: campaign.value,
    channel: channel ?? "DIRECT_OR_UNKNOWN",
  };
}

function matches(rule: AdContextExactRule, context: ParsedAdContext): boolean {
  if (rule.source !== null && rule.source !== context.source) return false;
  if (rule.medium !== null && rule.medium !== context.medium) return false;
  if (rule.campaign !== null && rule.campaign !== context.campaign) return false;
  return true;
}

function decision(
  policy: AdContextPolicy,
  parsed: ParsedAdContext,
  candidateExperienceId: string,
  candidateReason: Exclude<AdContextReason, "KILL_SWITCH" | "OBSERVE_ONLY_MATCH">,
  ruleId: string | null,
): AdContextDecision {
  if (policy.mode === "KILLED") {
    return Object.freeze({
      policyId: policy.policyId,
      mode: policy.mode,
      channel: "DIRECT_OR_UNKNOWN",
      experienceId: policy.defaultExperienceId,
      wouldApplyExperienceId: policy.defaultExperienceId,
      applied: false,
      reason: "KILL_SWITCH",
      ruleId: null,
      contextPresent: parsed.contextPresent,
      clickSignalPresent: parsed.clickSignalPresent,
    });
  }
  if (policy.mode === "OBSERVE_ONLY" && candidateExperienceId !== policy.defaultExperienceId) {
    return Object.freeze({
      policyId: policy.policyId,
      mode: policy.mode,
      channel: parsed.channel,
      experienceId: policy.defaultExperienceId,
      wouldApplyExperienceId: candidateExperienceId,
      applied: false,
      reason: "OBSERVE_ONLY_MATCH",
      ruleId,
      contextPresent: parsed.contextPresent,
      clickSignalPresent: parsed.clickSignalPresent,
    });
  }
  return Object.freeze({
    policyId: policy.policyId,
    mode: policy.mode,
    channel: parsed.channel,
    experienceId: candidateExperienceId,
    wouldApplyExperienceId: candidateExperienceId,
    applied: policy.mode === "ACTIVE" && candidateExperienceId !== policy.defaultExperienceId,
    reason: candidateReason,
    ruleId,
    contextPresent: parsed.contextPresent,
    clickSignalPresent: parsed.clickSignalPresent,
  });
}

export function evaluateAdContext(input: URL | string, policy: AdContextPolicy): AdContextDecision {
  const url = input instanceof URL ? input : new URL(input);
  const parsed = parseAdContext(url, policy);
  if (parsed.malformed) return decision(policy, parsed, policy.defaultExperienceId, "MALFORMED_CONTEXT", null);
  if (parsed.ambiguous) return decision(policy, parsed, policy.defaultExperienceId, "AMBIGUOUS_CONTEXT", null);

  const matchingRules = policy.exactRules.filter((candidate) => matches(candidate, parsed));
  if (matchingRules.length > 1) return decision(policy, parsed, policy.defaultExperienceId, "AMBIGUOUS_CONTEXT", null);
  const rule = matchingRules[0];
  if (rule) return decision(policy, parsed, rule.experienceId, "EXACT_RULE_MATCH", rule.ruleId);
  if (parsed.channel === "PAID_SEARCH" && policy.paidSearchExperienceId) {
    return decision(policy, parsed, policy.paidSearchExperienceId, "PAID_SEARCH_SIGNAL", null);
  }
  if (parsed.channel === "PAID_SOCIAL" && policy.paidSocialExperienceId) {
    return decision(policy, parsed, policy.paidSocialExperienceId, "PAID_SOCIAL_SIGNAL", null);
  }
  return decision(policy, parsed, policy.defaultExperienceId, "NO_AD_CONTEXT", null);
}
