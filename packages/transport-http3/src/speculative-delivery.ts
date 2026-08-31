import { createHash } from "node:crypto";

export type SpeculativeEvidenceState = "CONFIGURED" | "SUPPORTED" | "OBSERVED" | "NOT_VERIFIED" | "UNAVAILABLE";
export type SpeculationAction = "preload" | "prefetch" | "prerender";
export type SpeculationTargetKind = "navigation" | "subresource";
export type SpeculationEagerness = "immediate" | "eager" | "moderate" | "conservative";
export type CacheSafety = "CACHEABLE" | "NO_STORE" | "UNKNOWN";
export type ResourceAs = "style" | "script" | "font" | "image" | "fetch";
export type BrowserObservationAuthority = "BROWSER_RUNTIME" | "SYNTHETIC_TEST";

export interface SpeculationCandidate {
  id: string;
  target: string;
  kind: SpeculationTargetKind;
  action: SpeculationAction;
  as?: ResourceAs;
  estimatedBytes: number;
  priority: number;
  sideEffectFree: boolean;
  requiresAuthentication: boolean;
  cacheSafety: CacheSafety;
  crossOriginMode?: "NONE" | "ANONYMOUS";
  eagerness?: SpeculationEagerness;
}

export interface BrowserCapabilityObservation {
  authority: BrowserObservationAuthority;
  source: string;
  observedAt: string;
  browser: string;
  browserVersion: string;
  supports: {
    speculationRules: boolean | null;
    preload: boolean | null;
    prefetch: boolean | null;
  };
  events: readonly {
    action: SpeculationAction;
    url: string;
    outcome: "STARTED" | "COMPLETED" | "FAILED";
  }[];
}

export interface SpeculativeDeliveryContext {
  saveData: boolean | null;
  prefersReducedData: boolean | null;
  effectiveType: "slow-2g" | "2g" | "3g" | "4g" | null;
}

export interface SpeculativeDeliveryPolicy {
  maxInputCandidates: number;
  maxSelectedCandidates: number;
  maxTotalBytes: number;
  maxNavigationBytes: number;
  maxSingleCandidateBytes: number;
  sameOriginNavigationOnly: true;
  allowCrossOriginAnonymousPreload: boolean;
  defaultEagerness: SpeculationEagerness;
}

export interface SpeculativeDeliveryRequest {
  tenantId: string;
  scope: string;
  documentUrl: string;
  candidates: readonly SpeculationCandidate[];
  context?: Partial<SpeculativeDeliveryContext>;
  policy?: Partial<SpeculativeDeliveryPolicy>;
  browserObservation?: BrowserCapabilityObservation | null;
}

export interface NormalizedSpeculativeDeliveryRequest {
  tenantId: string;
  scope: string;
  documentUrl: string;
  candidates: readonly SpeculationCandidate[];
  context: SpeculativeDeliveryContext;
  policy: SpeculativeDeliveryPolicy;
  browserObservation: BrowserCapabilityObservation | null;
}

export interface SpeculationDecision {
  candidateId: string;
  action: SpeculationAction;
  target: string;
  selected: boolean;
  reason: string;
}

export interface CapabilityEvidence {
  capability: "PRELOAD" | "PREFETCH" | "PRERENDER" | "SPECULATION_RULES";
  state: SpeculativeEvidenceState;
  reason: string;
  source: string;
  observedAt: string | null;
  evidenceDigest: string;
}

export interface ResourceHintOutput {
  rel: "preload" | "prefetch";
  href: string;
  as?: ResourceAs;
  crossorigin?: "anonymous";
}

export interface SpeculationRuleEntry {
  source: "list";
  urls: readonly string[];
  eagerness: SpeculationEagerness;
}

export interface SpeculationRulesOutput {
  prefetch?: readonly SpeculationRuleEntry[];
  prerender?: readonly SpeculationRuleEntry[];
}

export interface SpeculativeDeliveryResult {
  request: NormalizedSpeculativeDeliveryRequest;
  requestDigest: string;
  decisions: readonly SpeculationDecision[];
  resourceHints: readonly ResourceHintOutput[];
  speculationRules: SpeculationRulesOutput;
  capabilityEvidence: readonly CapabilityEvidence[];
  selectedBytes: number;
  selectedNavigationBytes: number;
  planDigest: string;
}

export interface ExecutionControl {
  signal?: AbortSignal;
  deadlineEpochMs?: number;
  now?: () => number;
}

const DEFAULT_POLICY: SpeculativeDeliveryPolicy = Object.freeze({
  maxInputCandidates: 64,
  maxSelectedCandidates: 8,
  maxTotalBytes: 2 * 1024 * 1024,
  maxNavigationBytes: 1024 * 1024,
  maxSingleCandidateBytes: 8 * 1024 * 1024,
  sameOriginNavigationOnly: true,
  allowCrossOriginAnonymousPreload: true,
  defaultEagerness: "moderate",
});

const MAX_INPUT_CANDIDATES = 128;
const MAX_SELECTED_CANDIDATES = 32;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_URL_CHARS = 2_048;
const MAX_IDENTITY_CHARS = 256;
const MAX_OBSERVATION_EVENTS = 64;

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error("canonical JSON rejects cyclic object");
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical JSON requires plain object");
    seen.add(object);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(object).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`unsafe object key ${key}`);
      const item = object[key];
      if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      output[key] = canonicalize(item, seen);
    }
    seen.delete(object);
    return output;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalSpeculationJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function speculationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalSpeculationJson(value)).digest("hex");
}

function assertControl(control?: ExecutionControl): void {
  if (control?.signal?.aborted) throw new Error("SPECULATIVE_DELIVERY_CANCELLED");
  if (control?.deadlineEpochMs !== undefined) {
    if (!Number.isFinite(control.deadlineEpochMs)) throw new Error("deadlineEpochMs must be finite");
    const now = control.now ?? Date.now;
    if (now() > control.deadlineEpochMs) throw new Error("SPECULATIVE_DELIVERY_TIMEOUT");
  }
}

function assertSafeText(value: string, label: string, maxChars = MAX_IDENTITY_CHARS): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  if (trimmed.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  if (/^[\s]*(__proto__|prototype|constructor)[\s]*$/i.test(trimmed)) throw new Error(`${label} contains forbidden identity`);
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) throw new Error(`${label} contains control characters`);
  }
  return trimmed;
}

function assertBoundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function assertPriority(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("candidate priority must be between 0 and 1");
  return Object.is(value, -0) ? 0 : value;
}

function normalizeAbsoluteUrl(raw: string, base?: string): string {
  const safe = assertSafeText(raw, "URL", MAX_URL_CHARS);
  if (/[<>"'\\]/.test(safe)) throw new Error("URL contains unsafe serialization characters");
  let parsed: URL;
  try {
    parsed = base === undefined ? new URL(safe) : new URL(safe, base);
  } catch {
    throw new Error("URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("URL protocol must be http or https");
  if (parsed.username || parsed.password) throw new Error("credential-bearing URLs are forbidden");
  parsed.hash = "";
  if (parsed.toString().length > MAX_URL_CHARS) throw new Error(`normalized URL exceeds ${MAX_URL_CHARS} characters`);
  return parsed.toString();
}

function normalizeObservedAt(value: string): string {
  const safe = assertSafeText(value, "observedAt", 64);
  const timestamp = Date.parse(safe);
  if (!Number.isFinite(timestamp)) throw new Error("observedAt must be an ISO-compatible timestamp");
  return new Date(timestamp).toISOString();
}

function normalizePolicy(input?: Partial<SpeculativeDeliveryPolicy>): SpeculativeDeliveryPolicy {
  const merged = { ...DEFAULT_POLICY, ...(input ?? {}) };
  if (merged.sameOriginNavigationOnly !== true) throw new Error("sameOriginNavigationOnly cannot be disabled");
  const maxInputCandidates = assertBoundedInteger(merged.maxInputCandidates, "maxInputCandidates", 1, MAX_INPUT_CANDIDATES);
  const maxSelectedCandidates = assertBoundedInteger(merged.maxSelectedCandidates, "maxSelectedCandidates", 1, MAX_SELECTED_CANDIDATES);
  const maxTotalBytes = assertBoundedInteger(merged.maxTotalBytes, "maxTotalBytes", 1, MAX_TOTAL_BYTES);
  const maxNavigationBytes = assertBoundedInteger(merged.maxNavigationBytes, "maxNavigationBytes", 1, maxTotalBytes);
  const maxSingleCandidateBytes = assertBoundedInteger(merged.maxSingleCandidateBytes, "maxSingleCandidateBytes", 1, MAX_TOTAL_BYTES);
  return Object.freeze({
    maxInputCandidates,
    maxSelectedCandidates,
    maxTotalBytes,
    maxNavigationBytes,
    maxSingleCandidateBytes,
    sameOriginNavigationOnly: true,
    allowCrossOriginAnonymousPreload: Boolean(merged.allowCrossOriginAnonymousPreload),
    defaultEagerness: merged.defaultEagerness,
  });
}

function normalizeContext(input?: Partial<SpeculativeDeliveryContext>): SpeculativeDeliveryContext {
  const effectiveType = input?.effectiveType ?? null;
  if (effectiveType !== null && !["slow-2g", "2g", "3g", "4g"].includes(effectiveType)) throw new Error("unsupported effectiveType");
  return Object.freeze({
    saveData: input?.saveData ?? null,
    prefersReducedData: input?.prefersReducedData ?? null,
    effectiveType,
  });
}

function normalizeCandidate(candidate: SpeculationCandidate, documentUrl: string, policy: SpeculativeDeliveryPolicy): SpeculationCandidate {
  const id = assertSafeText(candidate.id, "candidate id", 128);
  const target = normalizeAbsoluteUrl(candidate.target, documentUrl);
  const estimatedBytes = assertBoundedInteger(candidate.estimatedBytes, "candidate estimatedBytes", 0, policy.maxSingleCandidateBytes);
  const priority = assertPriority(candidate.priority);
  if (candidate.action === "preload") {
    if (candidate.kind !== "subresource") throw new Error("preload candidates must be subresources");
    if (candidate.as === undefined) throw new Error("preload candidate requires as");
  } else {
    if (candidate.kind !== "navigation") throw new Error(`${candidate.action} candidates must be navigations`);
    if (candidate.as !== undefined) throw new Error(`${candidate.action} navigation must not declare as`);
  }
  return Object.freeze({
    id,
    target,
    kind: candidate.kind,
    action: candidate.action,
    ...(candidate.as ? { as: candidate.as } : {}),
    estimatedBytes,
    priority,
    sideEffectFree: candidate.sideEffectFree === true,
    requiresAuthentication: candidate.requiresAuthentication === true,
    cacheSafety: candidate.cacheSafety,
    ...(candidate.crossOriginMode ? { crossOriginMode: candidate.crossOriginMode } : {}),
    ...(candidate.eagerness ? { eagerness: candidate.eagerness } : {}),
  });
}

function normalizeBrowserObservation(observation: BrowserCapabilityObservation | null | undefined, documentUrl: string): BrowserCapabilityObservation | null {
  if (observation == null) return null;
  if (observation.events.length > MAX_OBSERVATION_EVENTS) throw new Error("too many browser observation events");
  const source = assertSafeText(observation.source, "browser observation source", 512);
  const browser = assertSafeText(observation.browser, "browser", 128);
  const browserVersion = assertSafeText(observation.browserVersion, "browserVersion", 128);
  const observedAt = normalizeObservedAt(observation.observedAt);
  const events = observation.events.map((event) => Object.freeze({
    action: event.action,
    url: normalizeAbsoluteUrl(event.url, documentUrl),
    outcome: event.outcome,
  })).sort((a, b) => canonicalSpeculationJson(a).localeCompare(canonicalSpeculationJson(b)));
  return Object.freeze({
    authority: observation.authority,
    source,
    observedAt,
    browser,
    browserVersion,
    supports: Object.freeze({
      speculationRules: observation.supports.speculationRules,
      preload: observation.supports.preload,
      prefetch: observation.supports.prefetch,
    }),
    events: Object.freeze(events),
  });
}

function normalizeRequest(request: SpeculativeDeliveryRequest): NormalizedSpeculativeDeliveryRequest {
  const tenantId = assertSafeText(request.tenantId, "tenantId", 128);
  const scope = assertSafeText(request.scope, "scope", 256);
  const documentUrl = normalizeAbsoluteUrl(request.documentUrl);
  const policy = normalizePolicy(request.policy);
  if (request.candidates.length > policy.maxInputCandidates) throw new Error("candidate input exceeds policy maxInputCandidates");
  const candidates = request.candidates.map((candidate) => normalizeCandidate(candidate, documentUrl, policy));
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new Error(`duplicate candidate id ${candidate.id}`);
    ids.add(candidate.id);
    const identity = `${candidate.action}\u0000${candidate.target}`;
    if (identities.has(identity)) throw new Error(`duplicate speculation candidate ${candidate.action} ${candidate.target}`);
    identities.add(identity);
  }
  candidates.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id) || a.target.localeCompare(b.target));
  return Object.freeze({
    tenantId,
    scope,
    documentUrl,
    candidates: Object.freeze(candidates),
    context: normalizeContext(request.context),
    policy,
    browserObservation: normalizeBrowserObservation(request.browserObservation, documentUrl),
  });
}

function rejectReason(candidate: SpeculationCandidate, request: NormalizedSpeculativeDeliveryRequest): string | null {
  const document = new URL(request.documentUrl);
  const target = new URL(candidate.target);
  const sameOrigin = document.origin === target.origin;
  const dataSaving = request.context.saveData === true || request.context.prefersReducedData === true;
  const constrainedNetwork = request.context.effectiveType === "slow-2g" || request.context.effectiveType === "2g";

  if (candidate.kind === "navigation") {
    if (!sameOrigin) return "CROSS_ORIGIN_NAVIGATION_BLOCKED";
    if (!candidate.sideEffectFree) return "SIDE_EFFECT_RISK_BLOCKED";
    if (candidate.requiresAuthentication) return "AUTHENTICATED_NAVIGATION_BLOCKED";
    if (dataSaving) return "REDUCED_DATA_BLOCKED";
    if (constrainedNetwork) return "CONSTRAINED_NETWORK_BLOCKED";
    if (candidate.cacheSafety === "NO_STORE" && candidate.action === "prerender") return "NO_STORE_PRERENDER_BLOCKED";
  } else {
    if (candidate.action === "prefetch" && !sameOrigin) return "CROSS_ORIGIN_PREFETCH_BLOCKED";
    if (candidate.action === "prefetch" && candidate.cacheSafety !== "CACHEABLE") return "UNSAFE_PREFETCH_CACHE_POLICY";
    if (candidate.action === "preload" && !sameOrigin) {
      if (!request.policy.allowCrossOriginAnonymousPreload || candidate.crossOriginMode !== "ANONYMOUS") return "CROSS_ORIGIN_PRELOAD_REQUIRES_ANONYMOUS_POLICY";
    }
  }
  return null;
}

function capabilityForAction(action: SpeculationAction): CapabilityEvidence["capability"] {
  return action === "preload" ? "PRELOAD" : action === "prefetch" ? "PREFETCH" : "PRERENDER";
}

function makeEvidence(input: Omit<CapabilityEvidence, "evidenceDigest">): CapabilityEvidence {
  return Object.freeze({ ...input, evidenceDigest: speculationDigest(input) });
}

function buildCapabilityEvidence(request: NormalizedSpeculativeDeliveryRequest, selected: readonly SpeculationCandidate[]): readonly CapabilityEvidence[] {
  const evidence: CapabilityEvidence[] = [];
  const configured = new Set<CapabilityEvidence["capability"]>();
  for (const candidate of selected) configured.add(capabilityForAction(candidate.action));
  if (selected.some((candidate) => candidate.kind === "navigation")) configured.add("SPECULATION_RULES");

  for (const capability of [...configured].sort()) {
    evidence.push(makeEvidence({
      capability,
      state: "CONFIGURED",
      reason: "emitted by deterministic NEXUS delivery plan",
      source: `nexus:${request.tenantId}:${request.scope}`,
      observedAt: null,
    }));
  }

  const observation = request.browserObservation;
  if (observation === null) {
    for (const capability of [...configured].sort()) {
      evidence.push(makeEvidence({
        capability,
        state: "NOT_VERIFIED",
        reason: "no browser runtime capability evidence supplied",
        source: "browser-runtime",
        observedAt: null,
      }));
    }
    return Object.freeze(evidence);
  }

  const supportFor = (capability: CapabilityEvidence["capability"]): boolean | null => {
    if (capability === "SPECULATION_RULES" || capability === "PRERENDER") return observation.supports.speculationRules;
    if (capability === "PRELOAD") return observation.supports.preload;
    return selected.some((candidate) => candidate.kind === "navigation" && candidate.action === "prefetch")
      ? observation.supports.speculationRules
      : observation.supports.prefetch;
  };

  for (const capability of [...configured].sort()) {
    const support = supportFor(capability);
    const state: SpeculativeEvidenceState = support === true ? "SUPPORTED" : support === false ? "UNAVAILABLE" : "NOT_VERIFIED";
    evidence.push(makeEvidence({
      capability,
      state,
      reason: support === true ? "browser runtime reports capability support" : support === false ? "browser runtime reports capability unavailable" : "browser capability observation is inconclusive",
      source: `${observation.browser}/${observation.browserVersion}:${observation.source}`,
      observedAt: observation.observedAt,
    }));
  }

  const selectedIdentity = new Set(selected.map((candidate) => `${candidate.action}\u0000${candidate.target}`));
  for (const event of observation.events) {
    if (!selectedIdentity.has(`${event.action}\u0000${event.url}`)) continue;
    const capability = capabilityForAction(event.action);
    evidence.push(makeEvidence({
      capability,
      state: observation.authority === "BROWSER_RUNTIME" ? "OBSERVED" : "NOT_VERIFIED",
      reason: observation.authority === "BROWSER_RUNTIME" ? `browser runtime event ${event.outcome}` : "synthetic event does not count as runtime observation",
      source: `${observation.browser}/${observation.browserVersion}:${observation.source}`,
      observedAt: observation.observedAt,
    }));
  }
  return Object.freeze(evidence.sort((a, b) => canonicalSpeculationJson(a).localeCompare(canonicalSpeculationJson(b))));
}

function createOutputs(selected: readonly SpeculationCandidate[], policy: SpeculativeDeliveryPolicy): {
  resourceHints: readonly ResourceHintOutput[];
  speculationRules: SpeculationRulesOutput;
} {
  const resourceHints: ResourceHintOutput[] = [];
  const prefetch: SpeculationRuleEntry[] = [];
  const prerender: SpeculationRuleEntry[] = [];

  for (const candidate of selected) {
    if (candidate.action === "preload") {
      resourceHints.push(Object.freeze({
        rel: "preload",
        href: candidate.target,
        as: candidate.as,
        ...(candidate.crossOriginMode === "ANONYMOUS" ? { crossorigin: "anonymous" as const } : {}),
      }));
    } else if (candidate.kind === "subresource") {
      resourceHints.push(Object.freeze({ rel: "prefetch", href: candidate.target }));
    } else {
      const entry = Object.freeze({
        source: "list" as const,
        urls: Object.freeze([candidate.target]),
        eagerness: candidate.eagerness ?? policy.defaultEagerness,
      });
      if (candidate.action === "prefetch") prefetch.push(entry);
      else prerender.push(entry);
    }
  }

  resourceHints.sort((a, b) => canonicalSpeculationJson(a).localeCompare(canonicalSpeculationJson(b)));
  prefetch.sort((a, b) => canonicalSpeculationJson(a).localeCompare(canonicalSpeculationJson(b)));
  prerender.sort((a, b) => canonicalSpeculationJson(a).localeCompare(canonicalSpeculationJson(b)));
  const speculationRules: SpeculationRulesOutput = Object.freeze({
    ...(prefetch.length > 0 ? { prefetch: Object.freeze(prefetch) } : {}),
    ...(prerender.length > 0 ? { prerender: Object.freeze(prerender) } : {}),
  });
  return { resourceHints: Object.freeze(resourceHints), speculationRules };
}

export function planSpeculativeDelivery(requestInput: SpeculativeDeliveryRequest, control?: ExecutionControl): SpeculativeDeliveryResult {
  assertControl(control);
  const request = normalizeRequest(requestInput);
  assertControl(control);
  const selected: SpeculationCandidate[] = [];
  const decisions: SpeculationDecision[] = [];
  let selectedBytes = 0;
  let selectedNavigationBytes = 0;

  for (const candidate of request.candidates) {
    assertControl(control);
    const rejected = rejectReason(candidate, request);
    if (rejected !== null) {
      decisions.push(Object.freeze({ candidateId: candidate.id, action: candidate.action, target: candidate.target, selected: false, reason: rejected }));
      continue;
    }
    if (selected.length >= request.policy.maxSelectedCandidates) {
      decisions.push(Object.freeze({ candidateId: candidate.id, action: candidate.action, target: candidate.target, selected: false, reason: "REQUEST_BUDGET_EXHAUSTED" }));
      continue;
    }
    if (selectedBytes + candidate.estimatedBytes > request.policy.maxTotalBytes) {
      decisions.push(Object.freeze({ candidateId: candidate.id, action: candidate.action, target: candidate.target, selected: false, reason: "BYTE_BUDGET_EXHAUSTED" }));
      continue;
    }
    if (candidate.kind === "navigation" && selectedNavigationBytes + candidate.estimatedBytes > request.policy.maxNavigationBytes) {
      decisions.push(Object.freeze({ candidateId: candidate.id, action: candidate.action, target: candidate.target, selected: false, reason: "NAVIGATION_BYTE_BUDGET_EXHAUSTED" }));
      continue;
    }
    selected.push(candidate);
    selectedBytes += candidate.estimatedBytes;
    if (candidate.kind === "navigation") selectedNavigationBytes += candidate.estimatedBytes;
    decisions.push(Object.freeze({ candidateId: candidate.id, action: candidate.action, target: candidate.target, selected: true, reason: "SELECTED" }));
  }

  const outputs = createOutputs(selected, request.policy);
  const requestDigest = speculationDigest(request);
  const core = {
    request,
    requestDigest,
    decisions: Object.freeze(decisions),
    resourceHints: outputs.resourceHints,
    speculationRules: outputs.speculationRules,
    capabilityEvidence: buildCapabilityEvidence(request, selected),
    selectedBytes,
    selectedNavigationBytes,
  };
  assertControl(control);
  return Object.freeze({ ...core, planDigest: speculationDigest(core) });
}

export function validateSpeculativeDeliveryResult(result: SpeculativeDeliveryResult): void {
  const replay = planSpeculativeDelivery(result.request);
  if (canonicalSpeculationJson(replay) !== canonicalSpeculationJson(result)) throw new Error("speculative delivery replay mismatch");
}

function htmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function serializeResourceHintTags(result: Pick<SpeculativeDeliveryResult, "resourceHints">): string {
  return result.resourceHints.map((hint) => {
    const attributes = [`rel=\"${hint.rel}\"`, `href=\"${htmlAttribute(hint.href)}\"`];
    if (hint.as) attributes.push(`as=\"${hint.as}\"`);
    if (hint.crossorigin) attributes.push(`crossorigin=\"${hint.crossorigin}\"`);
    return `<link ${attributes.join(" ")}>`;
  }).join("\n");
}

export function serializeSpeculationRulesScript(result: Pick<SpeculativeDeliveryResult, "speculationRules">): string {
  const json = canonicalSpeculationJson(result.speculationRules).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<script type=\"speculationrules\">${json}</script>`;
}

export function browserCapabilityDetectionSnippet(): string {
  return "(() => { const l=document.createElement('link'); const s=HTMLScriptElement.supports?.('speculationrules')===true; const r=l.relList; return {speculationRules:s,preload:r?.supports?.('preload')??null,prefetch:r?.supports?.('prefetch')??null}; })()";
}
