export type InteractionPointerSignal = "pointerenter" | "pointerdown" | "touchstart" | "focus";
export type InteractionPointerMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type InteractionPointerAction = "PRERENDER" | "PREFETCH" | "NONE";
export type InteractionPointerReason =
  | "SELECTED"
  | "OBSERVE_ONLY"
  | "KILL_SWITCH"
  | "REDUCED_DATA"
  | "REDUCED_MOTION"
  | "CROSS_ORIGIN"
  | "QUERY_NOT_ALLOWED"
  | "TARGET_NOT_ALLOWLISTED"
  | "BUDGET_EXHAUSTED"
  | "DUPLICATE"
  | "INVALID_TARGET"
  | "CONTROL_UNAVAILABLE";

export interface InteractionPointerControl {
  readonly mode: InteractionPointerMode;
  readonly allowedPaths: readonly string[];
  readonly maxPreparedTargets: number;
}

export interface InteractionPointerDecision {
  readonly signal: InteractionPointerSignal;
  readonly action: InteractionPointerAction;
  readonly reason: InteractionPointerReason;
}

export interface InteractionPointerEnvironment {
  readonly locationHref: () => string;
  readonly saveData: () => boolean;
  readonly reducedData: () => boolean;
  readonly reducedMotion: () => boolean;
  readonly speculationRulesSupported: () => boolean;
  readonly closestHref: (target: EventTarget | null) => string | null;
  readonly addListener: (type: string, handler: EventListener, options?: AddEventListenerOptions) => void;
  readonly removeListener: (type: string, handler: EventListener) => void;
  readonly apply: (action: Exclude<InteractionPointerAction, "NONE">, target: string) => void;
  readonly rollbackOwned: () => void;
}

export interface InteractionPointerPrerendererOptions {
  readonly controlProvider: () => Promise<unknown>;
  readonly environment?: InteractionPointerEnvironment;
  readonly onDecision?: (decision: InteractionPointerDecision) => void;
}

export interface InteractionPointerPrerenderer {
  start(): void;
  stop(): void;
  rollback(): void;
  preparedTargets(): readonly string[];
}

const PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/u;
const MAX_ALLOWED_PATHS = 64;
const MAX_PREPARED_TARGETS = 16;

function normalizePath(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!PATH.test(trimmed)) throw new Error(`${label} must be an absolute path without query or fragment`);
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

export function parseInteractionPointerControl(value: unknown): InteractionPointerControl {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("interaction pointer control must be a plain object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "allowedPaths,maxPreparedTargets,mode") throw new Error("interaction pointer control has unknown or missing fields");
  if (!(input.mode === "ACTIVE" || input.mode === "OBSERVE_ONLY" || input.mode === "KILLED")) throw new Error("interaction pointer control mode is invalid");
  if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length < 1 || input.allowedPaths.length > MAX_ALLOWED_PATHS) {
    throw new Error(`interaction pointer allowedPaths must contain 1..${MAX_ALLOWED_PATHS} items`);
  }
  const allowedPaths = input.allowedPaths.map((path, index) => normalizePath(path as string, `allowedPaths[${index}]`));
  if (new Set(allowedPaths).size !== allowedPaths.length) throw new Error("interaction pointer allowedPaths must be unique");
  if (!Number.isSafeInteger(input.maxPreparedTargets) || (input.maxPreparedTargets as number) < 1 || (input.maxPreparedTargets as number) > MAX_PREPARED_TARGETS) {
    throw new Error(`interaction pointer maxPreparedTargets must be 1..${MAX_PREPARED_TARGETS}`);
  }
  return Object.freeze({
    mode: input.mode,
    allowedPaths: Object.freeze([...allowedPaths]),
    maxPreparedTargets: input.maxPreparedTargets as number,
  });
}

function browserEnvironment(): InteractionPointerEnvironment {
  if (typeof document === "undefined" || typeof window === "undefined") throw new Error("interaction pointer prerenderer requires a browser environment");
  const media = (query: string) => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  return {
    locationHref: () => window.location.href,
    saveData: () => Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData),
    reducedData: () => media("(prefers-reduced-data: reduce)"),
    reducedMotion: () => media("(prefers-reduced-motion: reduce)"),
    speculationRulesSupported: () => typeof HTMLScriptElement !== "undefined" && typeof HTMLScriptElement.supports === "function" && HTMLScriptElement.supports("speculationrules"),
    closestHref: (target) => {
      if (!(target instanceof Element)) return null;
      const anchor = target.closest("a[href]");
      return anchor instanceof HTMLAnchorElement ? anchor.href : null;
    },
    addListener: (type, handler, options) => document.addEventListener(type, handler, options),
    removeListener: (type, handler) => document.removeEventListener(type, handler),
    apply: (action, target) => {
      if (action === "PRERENDER") {
        const script = document.createElement("script");
        script.type = "speculationrules";
        script.textContent = JSON.stringify({ prerender: [{ source: "list", urls: [target], eagerness: "immediate" }] })
          .replaceAll("<", "\\u003c")
          .replaceAll(">", "\\u003e");
        script.dataset.nexusCortex08 = "1";
        document.head.appendChild(script);
        return;
      }
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = target;
      link.dataset.nexusCortex08 = "1";
      document.head.appendChild(link);
    },
    rollbackOwned: () => {
      for (const node of document.querySelectorAll('[data-nexus-cortex08="1"]')) node.remove();
    },
  };
}

function safeDecision(signal: InteractionPointerSignal, action: InteractionPointerAction, reason: InteractionPointerReason): InteractionPointerDecision {
  return Object.freeze({ signal, action, reason });
}

function normalizeTarget(raw: string, documentHref: string): { absolute: string; path: string } | null {
  try {
    const documentUrl = new URL(documentHref);
    const target = new URL(raw, documentUrl);
    if (!(documentUrl.protocol === "https:" || documentUrl.protocol === "http:")) return null;
    if (!(target.protocol === "https:" || target.protocol === "http:")) return null;
    if (target.username || target.password) return null;
    if (target.origin !== documentUrl.origin) return { absolute: "", path: "__CROSS_ORIGIN__" };
    if (target.search) return { absolute: "", path: "__QUERY__" };
    target.hash = "";
    const path = normalizePath(target.pathname, "target pathname");
    target.pathname = path;
    return { absolute: target.toString(), path };
  } catch {
    return null;
  }
}

export function createInteractionPointerPrerenderer(options: InteractionPointerPrerendererOptions): InteractionPointerPrerenderer {
  const environment = options.environment ?? browserEnvironment();
  const prepared = new Set<string>();
  const inFlight = new Set<string>();
  let running = false;

  const emit = (decision: InteractionPointerDecision) => {
    try {
      options.onDecision?.(decision);
    } catch {
      // Observability must never alter navigation or speculative-loading semantics.
    }
  };

  const rollback = () => {
    environment.rollbackOwned();
    prepared.clear();
  };

  const readControl = async (): Promise<InteractionPointerControl | null> => {
    try {
      return parseInteractionPointerControl(await options.controlProvider());
    } catch {
      return null;
    }
  };

  const handle = async (signal: InteractionPointerSignal, eventTarget: EventTarget | null): Promise<void> => {
    if (!running) return;
    const href = environment.closestHref(eventTarget);
    if (!href) return;
    const normalized = normalizeTarget(href, environment.locationHref());
    if (!normalized) {
      emit(safeDecision(signal, "NONE", "INVALID_TARGET"));
      return;
    }
    if (normalized.path === "__CROSS_ORIGIN__") {
      emit(safeDecision(signal, "NONE", "CROSS_ORIGIN"));
      return;
    }
    if (normalized.path === "__QUERY__") {
      emit(safeDecision(signal, "NONE", "QUERY_NOT_ALLOWED"));
      return;
    }
    if (prepared.has(normalized.absolute) || inFlight.has(normalized.absolute)) {
      emit(safeDecision(signal, "NONE", "DUPLICATE"));
      return;
    }

    inFlight.add(normalized.absolute);
    try {
      const initialControl = await readControl();
      if (!initialControl) {
        emit(safeDecision(signal, "NONE", "CONTROL_UNAVAILABLE"));
        return;
      }
      if (initialControl.mode === "KILLED") {
        rollback();
        emit(safeDecision(signal, "NONE", "KILL_SWITCH"));
        return;
      }
      if (!initialControl.allowedPaths.includes(normalized.path)) {
        emit(safeDecision(signal, "NONE", "TARGET_NOT_ALLOWLISTED"));
        return;
      }
      if (prepared.size + inFlight.size - 1 >= initialControl.maxPreparedTargets) {
        emit(safeDecision(signal, "NONE", "BUDGET_EXHAUSTED"));
        return;
      }
      if (environment.saveData() || environment.reducedData()) {
        emit(safeDecision(signal, "NONE", "REDUCED_DATA"));
        return;
      }
      if (environment.reducedMotion()) {
        emit(safeDecision(signal, "NONE", "REDUCED_MOTION"));
        return;
      }
      const action: Exclude<InteractionPointerAction, "NONE"> = environment.speculationRulesSupported() ? "PRERENDER" : "PREFETCH";
      if (initialControl.mode === "OBSERVE_ONLY") {
        emit(safeDecision(signal, action, "OBSERVE_ONLY"));
        return;
      }

      // Mandatory last-boundary guard: re-read control after planning and immediately before the DOM side effect.
      const finalControl = await readControl();
      if (!finalControl) {
        emit(safeDecision(signal, "NONE", "CONTROL_UNAVAILABLE"));
        return;
      }
      if (finalControl.mode !== "ACTIVE" || !finalControl.allowedPaths.includes(normalized.path)) {
        if (finalControl.mode === "KILLED") rollback();
        emit(safeDecision(signal, "NONE", finalControl.mode === "KILLED" ? "KILL_SWITCH" : "TARGET_NOT_ALLOWLISTED"));
        return;
      }
      if (prepared.size >= finalControl.maxPreparedTargets) {
        emit(safeDecision(signal, "NONE", "BUDGET_EXHAUSTED"));
        return;
      }
      environment.apply(action, normalized.absolute);
      prepared.add(normalized.absolute);
      emit(safeDecision(signal, action, "SELECTED"));
    } finally {
      inFlight.delete(normalized.absolute);
    }
  };

  const onPointerOver: EventListener = (event) => { void handle("pointerenter", event.target); };
  const onPointerDown: EventListener = (event) => { void handle("pointerdown", event.target); };
  const onTouchStart: EventListener = (event) => { void handle("touchstart", event.target); };
  const onFocusIn: EventListener = (event) => { void handle("focus", event.target); };

  return Object.freeze({
    start() {
      if (running) return;
      running = true;
      environment.addListener("pointerover", onPointerOver, { passive: true });
      environment.addListener("pointerdown", onPointerDown, { passive: true });
      environment.addListener("touchstart", onTouchStart, { passive: true });
      environment.addListener("focusin", onFocusIn);
    },
    stop() {
      if (!running) return;
      running = false;
      environment.removeListener("pointerover", onPointerOver);
      environment.removeListener("pointerdown", onPointerDown);
      environment.removeListener("touchstart", onTouchStart);
      environment.removeListener("focusin", onFocusIn);
    },
    rollback,
    preparedTargets() {
      return Object.freeze([...prepared].sort());
    },
  });
}
