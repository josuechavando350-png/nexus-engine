export type BehavioralCollectorChannel = "BASE" | "MICRO";

export interface BehavioralCollectorPrivacyDecision {
  readonly collectionAllowed: boolean;
  readonly privacyDecisionRef: string | null;
}

export interface BehavioralCollectorEnvelope {
  readonly channel: BehavioralCollectorChannel;
  readonly event: Readonly<Record<string, unknown>>;
}

export interface BehavioralBrowserEnvironment {
  readonly document: Document;
  readonly window: Window;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly randomUUID: () => string;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (token: unknown) => void;
  readonly hasFocus: () => boolean;
}

export interface BehavioralBrowserCollectorConfig {
  readonly endpoint: string;
  readonly siteId: string;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly privacy: () => BehavioralCollectorPrivacyDecision;
  readonly signalAttribute?: string;
  readonly readingPauseMs?: number;
  readonly scrollThresholds?: readonly number[];
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly onTransportError?: (error: unknown) => void;
  readonly environment?: BehavioralBrowserEnvironment;
}

export interface BehavioralBrowserCollector {
  start(): void;
  stop(): void;
  drain(): Promise<void>;
}

const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const OPAQUE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{7,255})$/u;
const ATTRIBUTE = /^data-[a-z0-9-]{1,64}$/u;

function defaultEnvironment(): BehavioralBrowserEnvironment {
  if (typeof document === "undefined" || typeof window === "undefined" || typeof fetch === "undefined" || typeof crypto === "undefined") {
    throw new Error("Behavioral browser collector requires a browser environment");
  }
  if (typeof crypto.randomUUID !== "function") throw new Error("Behavioral browser collector requires crypto.randomUUID");
  return {
    document,
    window,
    fetch: (input, init) => fetch(input, init),
    randomUUID: () => crypto.randomUUID(),
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (token) => clearTimeout(token as ReturnType<typeof setTimeout>),
    hasFocus: () => document.hasFocus(),
  };
}

function identifier(value: string, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${field} is malformed`);
  return normalized;
}

function opaqueId(value: string, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!OPAQUE_ID.test(normalized)) throw new Error(`${field} must be an opaque 8..256 character identifier`);
  return normalized;
}

function positiveInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} must be ${min}..${max}`);
  return value;
}

function thresholds(values: readonly number[] | undefined): readonly number[] {
  const input = values ?? [25, 50, 75, 100];
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) throw new Error("scrollThresholds must contain 1..20 items");
  const normalized = [...input].map((value) => positiveInteger(value, "scrollThreshold", 1, 100)).sort((a, b) => a - b);
  if (new Set(normalized).size !== normalized.length) throw new Error("scrollThresholds must be unique");
  return Object.freeze(normalized);
}

interface SignalElement {
  readonly node: object;
  readonly id: string;
}

function closestWithAttribute(target: unknown, selector: string, attribute: string): SignalElement | null {
  if (!target || typeof target !== "object") return null;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") return null;
  let node: unknown;
  try {
    node = (closest as (this: object, selector: string) => unknown).call(target, selector);
  } catch {
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const getAttribute = (node as { getAttribute?: unknown }).getAttribute;
  if (typeof getAttribute !== "function") return null;
  const raw = (getAttribute as (this: object, name: string) => unknown).call(node, attribute);
  if (typeof raw !== "string") return null;
  try {
    return Object.freeze({ node, id: identifier(raw, "signal element id") });
  } catch {
    return null;
  }
}

class BrowserCollector implements BehavioralBrowserCollector {
  private readonly env: BehavioralBrowserEnvironment;
  private readonly endpoint: string;
  private readonly siteId: string;
  private readonly surfaceId: string;
  private readonly sessionId: string;
  private readonly signalAttribute: string;
  private readonly readingPauseMs: number;
  private readonly scrollThresholds: readonly number[];
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly pending = new Set<Promise<void>>();
  private readonly crossedThresholds = new Set<number>();
  private readonly startedForms = new Set<string>();
  private running = false;
  private pauseTimer: unknown = null;

  private readonly onScroll = () => {
    this.armReadingPause();
    const root = this.env.document.documentElement;
    const maxScrollable = Math.max(0, root.scrollHeight - this.env.window.innerHeight);
    if (maxScrollable <= 0) return;
    const percent = Math.max(0, Math.min(100, Math.floor((this.env.window.scrollY / maxScrollable) * 100)));
    for (const threshold of this.scrollThresholds) {
      if (percent < threshold || this.crossedThresholds.has(threshold)) continue;
      this.crossedThresholds.add(threshold);
      this.send("BASE", { kind: "SCROLL_DEPTH", scrollDepthPercent: threshold });
    }
  };

  private readonly onPointerOver = (event: Event) => {
    this.armReadingPause();
    const current = this.signalElement(event.target);
    if (!current) return;
    const previous = this.signalElement((event as PointerEvent).relatedTarget);
    if (previous?.node === current.node) return;
    this.send("MICRO", { kind: "POINTER_ENTER", elementId: current.id });
  };

  private readonly onPointerDown = (event: Event) => {
    this.armReadingPause();
    const element = this.signalElement(event.target);
    if (element) this.send("MICRO", { kind: "POINTER_DOWN", elementId: element.id });
  };

  private readonly onTouchStart = (event: Event) => {
    this.armReadingPause();
    const element = this.signalElement(event.target);
    if (element) this.send("MICRO", { kind: "TOUCH_START", elementId: element.id });
  };

  private readonly onTouchEnd = (event: Event) => {
    this.armReadingPause();
    const element = this.signalElement(event.target);
    if (element) this.send("MICRO", { kind: "TOUCH_END", elementId: element.id });
  };

  private readonly onClick = (event: Event) => {
    this.armReadingPause();
    const element = this.signalElement(event.target);
    if (element) this.send("BASE", { kind: "CTA_CLICK", elementId: element.id });
  };

  private readonly onFocusIn = (event: Event) => {
    this.armReadingPause();
    const form = this.formElement(event.target);
    if (!form || this.startedForms.has(form.id)) return;
    this.startedForms.add(form.id);
    this.send("BASE", { kind: "FORM_START", elementId: form.id });
  };

  private readonly onSubmit = (event: Event) => {
    this.armReadingPause();
    const form = this.formElement(event.target);
    if (form) this.send("BASE", { kind: "FORM_SUBMIT", elementId: form.id });
  };

  private readonly onInvalid = (event: Event) => {
    const form = this.formElement(event.target);
    if (form) this.send("BASE", { kind: "FORM_ERROR", elementId: form.id });
  };

  private readonly onVisibilityChange = () => {
    if (this.env.document.visibilityState === "visible" && this.env.hasFocus()) this.armReadingPause();
    else this.clearReadingPause();
  };

  constructor(private readonly config: BehavioralBrowserCollectorConfig) {
    this.env = config.environment ?? defaultEnvironment();
    this.siteId = identifier(config.siteId, "siteId");
    this.surfaceId = identifier(config.surfaceId, "surfaceId");
    this.sessionId = opaqueId(config.sessionId, "sessionId");
    this.signalAttribute = config.signalAttribute ?? "data-nexus-signal";
    if (!ATTRIBUTE.test(this.signalAttribute)) throw new Error("signalAttribute must be a data-* attribute");
    this.readingPauseMs = positiveInteger(config.readingPauseMs ?? 4_000, "readingPauseMs", 500, 60_000);
    this.scrollThresholds = thresholds(config.scrollThresholds);
    this.maxRetries = positiveInteger(config.maxRetries ?? 2, "maxRetries", 0, 5);
    this.retryDelayMs = positiveInteger(config.retryDelayMs ?? 300, "retryDelayMs", 50, 10_000);
    const endpoint = new URL(config.endpoint, this.env.window.location.href);
    if (endpoint.origin !== this.env.window.location.origin) throw new Error("behavioral collector endpoint must be same-origin");
    if (!/^https?:$/u.test(endpoint.protocol)) throw new Error("behavioral collector endpoint must use http or https");
    this.endpoint = endpoint.toString();
  }

  private signalElement(target: unknown): SignalElement | null {
    return closestWithAttribute(target, `[${this.signalAttribute}]`, this.signalAttribute);
  }

  private formElement(target: unknown): SignalElement | null {
    return closestWithAttribute(target, `form[${this.signalAttribute}]`, this.signalAttribute);
  }

  private clearReadingPause(): void {
    if (this.pauseTimer === null) return;
    this.env.clearTimer(this.pauseTimer);
    this.pauseTimer = null;
  }

  private armReadingPause(): void {
    if (!this.running) return;
    this.clearReadingPause();
    if (this.env.document.visibilityState !== "visible" || !this.env.hasFocus()) return;
    this.pauseTimer = this.env.setTimer(() => {
      this.pauseTimer = null;
      if (!this.running || this.env.document.visibilityState !== "visible" || !this.env.hasFocus()) return;
      this.send("MICRO", { kind: "READING_PAUSE", durationMs: this.readingPauseMs });
    }, this.readingPauseMs);
  }

  private eventId(): string {
    const uuid = this.env.randomUUID();
    return opaqueId(`evt:${uuid}`, "generated eventId");
  }

  private send(channel: BehavioralCollectorChannel, fields: Readonly<Record<string, unknown>>): void {
    if (!this.running) return;
    const privacy = this.config.privacy();
    if (!privacy.collectionAllowed || typeof privacy.privacyDecisionRef !== "string" || !privacy.privacyDecisionRef.trim()) return;
    const event = Object.freeze({
      eventId: this.eventId(),
      sessionId: this.sessionId,
      siteId: this.siteId,
      occurredAt: new Date(this.env.now()).toISOString(),
      surfaceId: this.surfaceId,
      collectionAllowed: true,
      privacyDecisionRef: privacy.privacyDecisionRef,
      ...fields,
    });
    const envelope: BehavioralCollectorEnvelope = Object.freeze({ channel, event });
    const task = this.deliver(envelope, 0);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }

  private async delay(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.env.setTimer(resolve, this.retryDelayMs);
    });
  }

  private async deliver(envelope: BehavioralCollectorEnvelope, attempt: number): Promise<void> {
    const privacy = this.config.privacy();
    const capturedDecisionRef = envelope.event.privacyDecisionRef;
    if (!this.running || !privacy.collectionAllowed || typeof privacy.privacyDecisionRef !== "string" || privacy.privacyDecisionRef !== capturedDecisionRef) return;
    try {
      const response = await this.env.fetch(this.endpoint, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) throw new Error(`behavioral collector transport failed with HTTP ${response.status}`);
    } catch (error) {
      if (attempt < this.maxRetries) {
        await this.delay();
        return this.deliver(envelope, attempt + 1);
      }
      try {
        this.config.onTransportError?.(error);
      } catch {
        // Transport observability must not throw into application event handlers.
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const document = this.env.document;
    document.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("pointerover", this.onPointerOver, { passive: true });
    document.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    document.addEventListener("touchstart", this.onTouchStart, { passive: true });
    document.addEventListener("touchend", this.onTouchEnd, { passive: true });
    document.addEventListener("click", this.onClick, { passive: true });
    document.addEventListener("focusin", this.onFocusIn);
    document.addEventListener("submit", this.onSubmit, true);
    document.addEventListener("invalid", this.onInvalid, true);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.send("BASE", { kind: "PAGE_VIEW" });
    this.armReadingPause();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearReadingPause();
    const document = this.env.document;
    document.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("pointerover", this.onPointerOver);
    document.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("touchstart", this.onTouchStart);
    document.removeEventListener("touchend", this.onTouchEnd);
    document.removeEventListener("click", this.onClick);
    document.removeEventListener("focusin", this.onFocusIn);
    document.removeEventListener("submit", this.onSubmit, true);
    document.removeEventListener("invalid", this.onInvalid, true);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}

export function createBehavioralBrowserCollector(config: BehavioralBrowserCollectorConfig): BehavioralBrowserCollector {
  return new BrowserCollector(config);
}
