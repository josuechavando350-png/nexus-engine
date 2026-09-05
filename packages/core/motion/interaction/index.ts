export type InteractionIntentSignal = "pointerenter" | "pointerdown" | "touchstart" | "focus";
export type InteractionPrerenderMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type InteractionPrerenderAction = "PRERENDER" | "PREFETCH" | "NONE";
export type InteractionPrerenderReason =
  | "SELECTED"
  | "OBSERVE_ONLY"
  | "KILL_SWITCH"
  | "REDUCED_DATA"
  | "REDUCED_MOTION"
  | "HOVER_UNAVAILABLE"
  | "UNSUPPORTED_TARGET"
  | "CROSS_ORIGIN"
  | "QUERY_NOT_ALLOWED"
  | "TARGET_NOT_ALLOWLISTED"
  | "BUDGET_EXHAUSTED"
  | "DUPLICATE";

export interface InteractionPrerenderPolicyInput {
  readonly mode: InteractionPrerenderMode;
  readonly allowedPaths: readonly string[];
  readonly maxPreparedTargets?: number;
  readonly allowQuery?: boolean;
}

export interface InteractionPrerenderPolicy {
  readonly mode: InteractionPrerenderMode;
  readonly allowedPaths: readonly string[];
  readonly maxPreparedTargets: number;
  readonly allowQuery: boolean;
}

export interface InteractionPrerenderContext {
  readonly documentUrl: string;
  readonly targetUrl: string;
  readonly signal: InteractionIntentSignal;
  readonly saveData: boolean;
  readonly prefersReducedData: boolean;
  readonly prefersReducedMotion: boolean;
  readonly hoverCapable: boolean;
  readonly speculationRulesSupported: boolean;
  readonly alreadyPrepared: boolean;
  readonly preparedCount: number;
}

export interface InteractionPrerenderDecision {
  readonly signal: InteractionIntentSignal;
  readonly action: InteractionPrerenderAction;
  readonly reason: InteractionPrerenderReason;
  readonly target: string | null;
  readonly wouldPrepare: boolean;
}

export interface InteractionPrerenderEnvironment {
  readonly document: Document;
  readonly locationHref: string;
  readonly saveData: () => boolean;
  readonly reducedData: () => boolean;
  readonly reducedMotion: () => boolean;
  readonly hoverCapable: () => boolean;
  readonly speculationRulesSupported: () => boolean;
  readonly appendSpeculationRules: (target: string) => void;
  readonly appendPrefetch: (target: string) => void;
}

export interface InteractionPrerendererOptions {
  readonly policy: InteractionPrerenderPolicy;
  readonly selector?: string;
  readonly environment?: InteractionPrerenderEnvironment;
  readonly onDecision?: (decision: InteractionPrerenderDecision) => void;
}

export interface InteractionPrerenderer {
  start(): void;
  stop(): void;
  preparedTargets(): readonly string[];
}

const PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/u;
const SIGNALS = new Set<InteractionIntentSignal>(["pointerenter", "pointerdown", "touchstart", "focus"]);

function normalizePath(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!PATH.test(trimmed)) throw new Error(`${label} must be an absolute same-origin path without query or fragment`);
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function createInteractionPrerenderPolicy(input: InteractionPrerenderPolicyInput): InteractionPrerenderPolicy {
  if (!input || typeof input !== "object") throw new Error("interaction prerender policy is required");
  if (!(input.mode === "ACTIVE" || input.mode === "OBSERVE_ONLY" || input.mode === "KILLED")) throw new Error("interaction prerender mode is invalid");
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length === 0 || input.allowedPaths.length > 64) throw new Error("allowedPaths must contain 1..64 items");
  const allowedPaths = input.allowedPaths.map((path, index) => normalizePath(path, `allowedPaths[${index}]`));
  if (new Set(allowedPaths).size !== allowedPaths.length) throw new Error("allowedPaths must be unique");
  const maxPreparedTargets = input.maxPreparedTargets ?? 4;
  if (!Number.isSafeInteger(maxPreparedTargets) || maxPreparedTargets < 1 || maxPreparedTargets > 16) throw new Error("maxPreparedTargets must be 1..16");
  return Object.freeze({
    mode: input.mode,
    allowedPaths: Object.freeze([...allowedPaths]),
    maxPreparedTargets,
    allowQuery: input.allowQuery === true,
  });
}

function result(signal: InteractionIntentSignal, action: InteractionPrerenderAction, reason: InteractionPrerenderReason, target: string | null, wouldPrepare = false): InteractionPrerenderDecision {
  return Object.freeze({ signal, action, reason, target, wouldPrepare });
}

export function decideInteractionPrerender(context: InteractionPrerenderContext, policy: InteractionPrerenderPolicy): InteractionPrerenderDecision {
  if (!SIGNALS.has(context.signal)) throw new Error("unsupported interaction intent signal");
  if (policy.mode === "KILLED") return result(context.signal, "NONE", "KILL_SWITCH", null);
  if (context.saveData || context.prefersReducedData) return result(context.signal, "NONE", "REDUCED_DATA", null);
  if (context.prefersReducedMotion) return result(context.signal, "NONE", "REDUCED_MOTION", null);
  if (context.signal === "pointerenter" && !context.hoverCapable) return result(context.signal, "NONE", "HOVER_UNAVAILABLE", null);
  if (context.alreadyPrepared) return result(context.signal, "NONE", "DUPLICATE", null);
  if (context.preparedCount >= policy.maxPreparedTargets) return result(context.signal, "NONE", "BUDGET_EXHAUSTED", null);

  let documentUrl: URL;
  let targetUrl: URL;
  try {
    documentUrl = new URL(context.documentUrl);
    targetUrl = new URL(context.targetUrl, documentUrl);
  } catch {
    return result(context.signal, "NONE", "UNSUPPORTED_TARGET", null);
  }
  if (!(targetUrl.protocol === "https:" || targetUrl.protocol === "http:")) return result(context.signal, "NONE", "UNSUPPORTED_TARGET", null);
  if (targetUrl.origin !== documentUrl.origin) return result(context.signal, "NONE", "CROSS_ORIGIN", null);
  if (!policy.allowQuery && targetUrl.search.length > 0) return result(context.signal, "NONE", "QUERY_NOT_ALLOWED", null);
  targetUrl.hash = "";
  const normalized = normalizePath(targetUrl.pathname, "target pathname");
  if (!policy.allowedPaths.includes(normalized)) return result(context.signal, "NONE", "TARGET_NOT_ALLOWLISTED", null);
  targetUrl.pathname = normalized;
  const target = targetUrl.toString();
  const action: InteractionPrerenderAction = context.speculationRulesSupported ? "PRERENDER" : "PREFETCH";
  if (policy.mode === "OBSERVE_ONLY") return result(context.signal, action, "OBSERVE_ONLY", target, true);
  return result(context.signal, action, "SELECTED", target, true);
}

function browserEnvironment(): InteractionPrerenderEnvironment {
  if (typeof document === "undefined" || typeof window === "undefined") throw new Error("interaction prerenderer requires a browser environment");
  const media = (query: string) => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  return {
    document,
    locationHref: window.location.href,
    saveData: () => Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData),
    reducedData: () => media("(prefers-reduced-data: reduce)"),
    reducedMotion: () => media("(prefers-reduced-motion: reduce)"),
    hoverCapable: () => media("(hover: hover) and (pointer: fine)"),
    speculationRulesSupported: () => typeof HTMLScriptElement !== "undefined" && typeof HTMLScriptElement.supports === "function" && HTMLScriptElement.supports("speculationrules"),
    appendSpeculationRules: (target) => {
      const script = document.createElement("script");
      script.type = "speculationrules";
      script.textContent = JSON.stringify({ prerender: [{ source: "list", urls: [target], eagerness: "immediate" }] }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
      script.dataset.nexusInteractionPrerender = "1";
      document.head.appendChild(script);
    },
    appendPrefetch: (target) => {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = target;
      link.dataset.nexusInteractionPrerender = "1";
      document.head.appendChild(link);
    },
  };
}

function closestAnchor(target: EventTarget | null, selector: string): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest(selector);
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}

export function createInteractionPrerenderer(options: InteractionPrerendererOptions): InteractionPrerenderer {
  const env = options.environment ?? browserEnvironment();
  const selector = options.selector ?? "a[data-nexus-prerender]";
  const prepared = new Set<string>();
  let running = false;

  const emit = (decision: InteractionPrerenderDecision) => {
    try { options.onDecision?.(decision); } catch { /* observers cannot alter navigation semantics */ }
  };

  const handle = (signal: InteractionIntentSignal, target: EventTarget | null) => {
    if (!running) return;
    const anchor = closestAnchor(target, selector);
    if (!anchor) return;
    const absolute = new URL(anchor.href, env.locationHref).toString();
    const decision = decideInteractionPrerender({
      documentUrl: env.locationHref,
      targetUrl: absolute,
      signal,
      saveData: env.saveData(),
      prefersReducedData: env.reducedData(),
      prefersReducedMotion: env.reducedMotion(),
      hoverCapable: env.hoverCapable(),
      speculationRulesSupported: env.speculationRulesSupported(),
      alreadyPrepared: prepared.has(absolute),
      preparedCount: prepared.size,
    }, options.policy);
    emit(decision);
    if (decision.reason !== "SELECTED" || decision.target === null) return;
    if (decision.action === "PRERENDER") env.appendSpeculationRules(decision.target);
    else if (decision.action === "PREFETCH") env.appendPrefetch(decision.target);
    prepared.add(decision.target);
  };

  const onPointerEnter = (event: Event) => handle("pointerenter", event.target);
  const onPointerDown = (event: Event) => handle("pointerdown", event.target);
  const onTouchStart = (event: Event) => handle("touchstart", event.target);
  const onFocus = (event: Event) => handle("focus", event.target);

  return Object.freeze({
    start() {
      if (running) return;
      running = true;
      env.document.addEventListener("pointerover", onPointerEnter, { passive: true });
      env.document.addEventListener("pointerdown", onPointerDown, { passive: true });
      env.document.addEventListener("touchstart", onTouchStart, { passive: true });
      env.document.addEventListener("focusin", onFocus);
    },
    stop() {
      if (!running) return;
      running = false;
      env.document.removeEventListener("pointerover", onPointerEnter);
      env.document.removeEventListener("pointerdown", onPointerDown);
      env.document.removeEventListener("touchstart", onTouchStart);
      env.document.removeEventListener("focusin", onFocus);
    },
    preparedTargets() { return Object.freeze([...prepared].sort()); },
  });
}
