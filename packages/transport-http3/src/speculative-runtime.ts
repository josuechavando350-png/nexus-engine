import {
  browserCapabilityDetectionSnippet,
  canonicalSpeculationJson,
  planSpeculativeDelivery as planValidatedInput,
  serializeResourceHintTags,
  serializeSpeculationRulesScript,
  speculationDigest,
  validateSpeculativeDeliveryResult,
  type BrowserCapabilityObservation,
  type CacheSafety,
  type ExecutionControl,
  type ResourceAs,
  type SpeculationAction,
  type SpeculationCandidate,
  type SpeculationEagerness,
  type SpeculationTargetKind,
  type SpeculativeDeliveryContext,
  type SpeculativeDeliveryPolicy,
  type SpeculativeDeliveryRequest,
  type SpeculativeDeliveryResult,
} from "./speculative-delivery.js";

export type {
  BrowserCapabilityObservation,
  CacheSafety,
  CapabilityEvidence,
  ExecutionControl,
  NormalizedSpeculativeDeliveryRequest,
  ResourceAs,
  ResourceHintOutput,
  SpeculationAction,
  SpeculationCandidate,
  SpeculationDecision,
  SpeculationEagerness,
  SpeculationRuleEntry,
  SpeculationRulesOutput,
  SpeculationTargetKind,
  SpeculativeDeliveryContext,
  SpeculativeDeliveryPolicy,
  SpeculativeDeliveryRequest,
  SpeculativeDeliveryResult,
  SpeculativeEvidenceState,
} from "./speculative-delivery.js";

export {
  browserCapabilityDetectionSnippet,
  canonicalSpeculationJson,
  serializeResourceHintTags,
  serializeSpeculationRulesScript,
  speculationDigest,
  validateSpeculativeDeliveryResult,
};

const ACTIONS = new Set<SpeculationAction>(["preload", "prefetch", "prerender"]);
const KINDS = new Set<SpeculationTargetKind>(["navigation", "subresource"]);
const AS_VALUES = new Set<ResourceAs>(["style", "script", "font", "image", "fetch"]);
const CACHE_VALUES = new Set<CacheSafety>(["CACHEABLE", "NO_STORE", "UNKNOWN"]);
const EAGERNESS_VALUES = new Set<SpeculationEagerness>(["immediate", "eager", "moderate", "conservative"]);
const EFFECTIVE_TYPES = new Set(["slow-2g", "2g", "3g", "4g"] as const);
const AUTHORITIES = new Set<BrowserCapabilityObservation["authority"]>(["BROWSER_RUNTIME", "SYNTHETIC_TEST"]);
const EVENT_OUTCOMES = new Set<BrowserCapabilityObservation["events"][number]["outcome"]>(["STARTED", "COMPLETED", "FAILED"]);
const CROSS_ORIGIN_MODES = new Set(["NONE", "ANONYMOUS"] as const);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_RUNTIME_CANDIDATES = 128;
const MAX_RUNTIME_EVENTS = 64;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const output = value as Record<string, unknown>;
  for (const key of Object.keys(output)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains forbidden key ${key}`);
  }
  return output;
}

function exactKeys(object: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!accepted.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  }
}

function requiredString(object: Record<string, unknown>, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value;
}

function optionalBoolean(object: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label}.${key} must be a boolean`);
  return value;
}

function nullableBoolean(object: Record<string, unknown>, key: string, label: string): boolean | null {
  const value = object[key];
  if (value !== null && typeof value !== "boolean") throw new Error(`${label}.${key} must be boolean or null`);
  return value as boolean | null;
}

function requiredBoolean(object: Record<string, unknown>, key: string, label: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new Error(`${label}.${key} must be a boolean`);
  return value;
}

function requiredNumber(object: Record<string, unknown>, key: string, label: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}.${key} must be a finite number`);
  return value;
}

function optionalNumber(object: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}.${key} must be a finite number`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !values.has(value as T)) throw new Error(`${label} has unsupported value`);
  return value as T;
}

function parseCandidate(value: unknown, index: number): SpeculationCandidate {
  const label = `candidates[${index}]`;
  const input = record(value, label);
  exactKeys(input, label, ["id", "target", "kind", "action", "as", "estimatedBytes", "priority", "sideEffectFree", "requiresAuthentication", "cacheSafety", "crossOriginMode", "eagerness"]);
  const action = enumValue(input.action, ACTIONS, `${label}.action`);
  const kind = enumValue(input.kind, KINDS, `${label}.kind`);
  const as = input.as === undefined ? undefined : enumValue(input.as, AS_VALUES, `${label}.as`);
  const cacheSafety = enumValue(input.cacheSafety, CACHE_VALUES, `${label}.cacheSafety`);
  const crossOriginMode = input.crossOriginMode === undefined
    ? undefined
    : enumValue(input.crossOriginMode, CROSS_ORIGIN_MODES, `${label}.crossOriginMode`);
  const eagerness = input.eagerness === undefined ? undefined : enumValue(input.eagerness, EAGERNESS_VALUES, `${label}.eagerness`);

  if (action === "preload" && kind !== "subresource") throw new Error(`${label} preload must target a subresource`);
  if (action !== "preload" && kind !== "navigation") throw new Error(`${label} ${action} must target a navigation`);
  if (action === "preload" && as === undefined) throw new Error(`${label} preload requires as`);
  if (action !== "preload" && as !== undefined) throw new Error(`${label} navigation speculation must not declare as`);

  return {
    id: requiredString(input, "id", label),
    target: requiredString(input, "target", label),
    kind,
    action,
    ...(as === undefined ? {} : { as }),
    estimatedBytes: requiredNumber(input, "estimatedBytes", label),
    priority: requiredNumber(input, "priority", label),
    sideEffectFree: requiredBoolean(input, "sideEffectFree", label),
    requiresAuthentication: requiredBoolean(input, "requiresAuthentication", label),
    cacheSafety,
    ...(crossOriginMode === undefined ? {} : { crossOriginMode }),
    ...(eagerness === undefined ? {} : { eagerness }),
  };
}

function parseContext(value: unknown): Partial<SpeculativeDeliveryContext> {
  const input = record(value, "context");
  exactKeys(input, "context", ["saveData", "prefersReducedData", "effectiveType"]);
  const output: Partial<SpeculativeDeliveryContext> = {};
  if (Object.hasOwn(input, "saveData")) output.saveData = nullableBoolean(input, "saveData", "context");
  if (Object.hasOwn(input, "prefersReducedData")) output.prefersReducedData = nullableBoolean(input, "prefersReducedData", "context");
  if (Object.hasOwn(input, "effectiveType")) {
    const candidate = input.effectiveType;
    output.effectiveType = candidate === null ? null : enumValue(candidate, EFFECTIVE_TYPES, "context.effectiveType");
  }
  return output;
}

function parsePolicy(value: unknown): Partial<SpeculativeDeliveryPolicy> {
  const input = record(value, "policy");
  exactKeys(input, "policy", ["maxInputCandidates", "maxSelectedCandidates", "maxTotalBytes", "maxNavigationBytes", "maxSingleCandidateBytes", "sameOriginNavigationOnly", "allowCrossOriginAnonymousPreload", "defaultEagerness"]);
  const output: Partial<SpeculativeDeliveryPolicy> = {};
  for (const key of ["maxInputCandidates", "maxSelectedCandidates", "maxTotalBytes", "maxNavigationBytes", "maxSingleCandidateBytes"] as const) {
    const number = optionalNumber(input, key, "policy");
    if (number !== undefined) output[key] = number;
  }
  const sameOrigin = optionalBoolean(input, "sameOriginNavigationOnly", "policy");
  if (sameOrigin !== undefined) output.sameOriginNavigationOnly = sameOrigin as true;
  const crossOrigin = optionalBoolean(input, "allowCrossOriginAnonymousPreload", "policy");
  if (crossOrigin !== undefined) output.allowCrossOriginAnonymousPreload = crossOrigin;
  if (input.defaultEagerness !== undefined) output.defaultEagerness = enumValue(input.defaultEagerness, EAGERNESS_VALUES, "policy.defaultEagerness");
  return output;
}

function parseBrowserObservation(value: unknown): BrowserCapabilityObservation {
  const input = record(value, "browserObservation");
  exactKeys(input, "browserObservation", ["authority", "source", "observedAt", "browser", "browserVersion", "supports", "events"]);
  const supports = record(input.supports, "browserObservation.supports");
  exactKeys(supports, "browserObservation.supports", ["speculationRules", "preload", "prefetch"]);
  const events = input.events;
  if (!Array.isArray(events)) throw new Error("browserObservation.events must be an array");
  if (events.length > MAX_RUNTIME_EVENTS) throw new Error(`browserObservation.events exceeds ${MAX_RUNTIME_EVENTS} entries`);
  const authority = enumValue(input.authority, AUTHORITIES, "browserObservation.authority");
  if (authority === "BROWSER_RUNTIME") throw new Error("untrusted request cannot assert BROWSER_RUNTIME authority");

  return {
    authority,
    source: requiredString(input, "source", "browserObservation"),
    observedAt: requiredString(input, "observedAt", "browserObservation"),
    browser: requiredString(input, "browser", "browserObservation"),
    browserVersion: requiredString(input, "browserVersion", "browserObservation"),
    supports: {
      speculationRules: nullableBoolean(supports, "speculationRules", "browserObservation.supports"),
      preload: nullableBoolean(supports, "preload", "browserObservation.supports"),
      prefetch: nullableBoolean(supports, "prefetch", "browserObservation.supports"),
    },
    events: events.map((event, index) => {
      const label = `browserObservation.events[${index}]`;
      const item = record(event, label);
      exactKeys(item, label, ["action", "url", "outcome"]);
      return {
        action: enumValue(item.action, ACTIONS, `${label}.action`),
        url: requiredString(item, "url", label),
        outcome: enumValue(item.outcome, EVENT_OUTCOMES, `${label}.outcome`),
      };
    }),
  };
}

export function parseSpeculativeDeliveryRequest(value: unknown): SpeculativeDeliveryRequest {
  const input = record(value, "speculative delivery request");
  exactKeys(input, "speculative delivery request", ["tenantId", "scope", "documentUrl", "candidates", "context", "policy", "browserObservation"]);
  if (!Array.isArray(input.candidates)) throw new Error("candidates must be an array");
  if (input.candidates.length > MAX_RUNTIME_CANDIDATES) throw new Error(`candidate input exceeds ${MAX_RUNTIME_CANDIDATES} entries`);

  const request: SpeculativeDeliveryRequest = {
    tenantId: requiredString(input, "tenantId", "speculative delivery request"),
    scope: requiredString(input, "scope", "speculative delivery request"),
    documentUrl: requiredString(input, "documentUrl", "speculative delivery request"),
    candidates: input.candidates.map(parseCandidate),
  };
  if (input.context !== undefined) request.context = parseContext(input.context);
  if (input.policy !== undefined) request.policy = parsePolicy(input.policy);
  if (input.browserObservation !== undefined) request.browserObservation = input.browserObservation === null ? null : parseBrowserObservation(input.browserObservation);
  return request;
}

export function planSpeculativeDelivery(value: unknown, control?: ExecutionControl): SpeculativeDeliveryResult {
  return planValidatedInput(parseSpeculativeDeliveryRequest(value), control);
}
