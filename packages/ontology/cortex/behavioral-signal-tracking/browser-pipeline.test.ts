import { describe, expect, it } from "vitest";
import { InMemoryOntologyTransactionStore } from "@nexus/ontology/transaction";
import { createBehavioralSignalPolicy } from "./index";
import { createBehavioralBrowserCollector, type BehavioralBrowserEnvironment } from "./browser-collector";
import { createBehavioralSignalHttpHandler } from "./http-handler";
import { CortexBehavioralSignalRuntime } from "./runtime";

const scope = Object.freeze({ tenantId: "tenant-cortex", organizationId: "org-cortex", brandId: "brand-cortex" });
const NOW = Date.parse("2026-09-05T19:30:00.000Z");
const ORIGIN = "https://example.test";
const KEY = "browser-pipeline-test-key-material-64-bytes-minimum-xxxxxxxxxxxxxx";

function policy() {
  return createBehavioralSignalPolicy({
    policyId: "behavioral-browser",
    version: "v1",
    pseudonymizationKeyId: "behavior-key-v1",
    allowedSurfaceIds: ["home"],
    allowedElementIds: ["cta.primary", "form.contact"],
    maxEventAgeMs: 60_000,
    maxFutureSkewMs: 1_000,
    maxSessionDurationMs: 60_000,
    maxEventsPerSession: 64,
    maxEngagementMsPerEvent: 10_000,
    maxWriteRetries: 3,
    mode: "ACTIVE",
  });
}

class FakeDocument {
  visibilityState = "visible";
  documentElement = { scrollHeight: 2_000 };
  private listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    const bucket = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    bucket.add(callback);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") return;
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  hasFocus(): boolean { return true; }
}

function node(id: string, form = false) {
  const self = {
    getAttribute: (name: string) => name === "data-nexus-signal" ? id : null,
    closest: (selector: string) => selector === "[data-nexus-signal]" || (form && selector === "form[data-nexus-signal]") ? self : null,
  };
  return self;
}

function fakeEvent(target: unknown, relatedTarget?: unknown): Event {
  return { target, relatedTarget } as unknown as Event;
}

describe("browser behavioral signal pipeline", () => {
  it("captures real browser interactions and delivers them through HTTP into the governed runtime", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const runtime = new CortexBehavioralSignalRuntime(store, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
    const handler = createBehavioralSignalHttpHandler(runtime, { allowedOrigins: [ORIGIN] });
    const document = new FakeDocument();
    const timers = new Map<number, () => void>();
    let timerSequence = 0;
    let uuidSequence = 0;
    const windowState = { location: { href: `${ORIGIN}/`, origin: ORIGIN }, innerHeight: 1_000, scrollY: 0 };
    const environment: BehavioralBrowserEnvironment = {
      document: document as unknown as Document,
      window: windowState as unknown as Window,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("origin", ORIGIN);
        return handler(new Request(String(input), { ...init, headers }));
      },
      randomUUID: () => `00000000-0000-4000-8000-${(++uuidSequence).toString().padStart(12, "0")}`,
      now: () => NOW,
      setTimer: (callback) => { const id = ++timerSequence; timers.set(id, callback); return id; },
      clearTimer: (token) => { if (typeof token === "number") timers.delete(token); },
      hasFocus: () => true,
    };

    const collector = createBehavioralBrowserCollector({
      endpoint: "/api/cortex/behavioral",
      siteId: "site-a",
      surfaceId: "home",
      sessionId: "browser-session-0001",
      privacy: () => ({ collectionAllowed: true, privacyDecisionRef: "decision-v1" }),
      readingPauseMs: 1_000,
      maxRetries: 0,
      environment,
    });
    collector.start();

    windowState.scrollY = 750;
    document.dispatch("scroll", fakeEvent(document));
    const cta = node("cta.primary");
    document.dispatch("pointerover", fakeEvent(cta));
    document.dispatch("pointerdown", fakeEvent(cta));
    document.dispatch("touchstart", fakeEvent(cta));
    document.dispatch("touchend", fakeEvent(cta));
    document.dispatch("click", fakeEvent(cta));
    const form = node("form.contact", true);
    document.dispatch("focusin", fakeEvent(form));
    document.dispatch("submit", fakeEvent(form));
    document.dispatch("invalid", fakeEvent(form));
    for (const callback of [...timers.values()]) callback();

    await collector.drain();
    collector.stop();

    expect(runtime.controlState().active.mode).toBe("ACTIVE");
    expect(store.checkpoint().objects).toHaveLength(5);
    const serialized = JSON.stringify(store.checkpoint());
    expect(serialized).not.toContain("browser-session-0001");
    expect(serialized).not.toContain("decision-v1");
    expect(serialized).not.toContain("clientX");

    const base = runtime.ingest({
      eventId: "inspection-event-0001",
      sessionId: "browser-session-0001",
      siteId: "site-a",
      kind: "NAVIGATION",
      occurredAt: new Date(NOW).toISOString(),
      surfaceId: "home",
      collectionAllowed: true,
      privacyDecisionRef: "decision-v1",
    });
    expect(base.site).toMatchObject({
      counts: { PAGE_VIEW: 1, CTA_CLICK: 1, FORM_START: 1, FORM_SUBMIT: 1, FORM_ERROR: 1, SCROLL_DEPTH: 3, NAVIGATION: 1 },
      maxScrollDepthPercent: 75,
    });
    const micro = runtime.ingestMicroInteraction({
      eventId: "inspection-micro-0001",
      sessionId: "browser-session-0001",
      siteId: "site-a",
      kind: "POINTER_ENTER",
      occurredAt: new Date(NOW).toISOString(),
      surfaceId: "home",
      elementId: "cta.primary",
      collectionAllowed: true,
      privacyDecisionRef: "decision-v1",
    });
    expect(micro.site).toMatchObject({
      counts: { READING_PAUSE: 1, POINTER_ENTER: 2, POINTER_DOWN: 1, TOUCH_START: 1, TOUCH_END: 1 },
      totalReadingPauseMs: 1_000,
    });
  });

  it("fails closed when consent is denied and rejects cross-origin transport", async () => {
    const document = new FakeDocument();
    let requests = 0;
    const environment: BehavioralBrowserEnvironment = {
      document: document as unknown as Document,
      window: { location: { href: `${ORIGIN}/`, origin: ORIGIN }, innerHeight: 1_000, scrollY: 0 } as unknown as Window,
      fetch: async () => { requests += 1; return new Response(null, { status: 202 }); },
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      now: () => NOW,
      setTimer: () => 1,
      clearTimer: () => undefined,
      hasFocus: () => true,
    };
    const denied = createBehavioralBrowserCollector({
      endpoint: "/api/cortex/behavioral",
      siteId: "site-a",
      surfaceId: "home",
      sessionId: "browser-session-0001",
      privacy: () => ({ collectionAllowed: false, privacyDecisionRef: null }),
      maxRetries: 0,
      environment,
    });
    denied.start();
    document.dispatch("click", fakeEvent(node("cta.primary")));
    await denied.drain();
    expect(requests).toBe(0);
    denied.stop();

    expect(() => createBehavioralBrowserCollector({
      endpoint: "https://evil.example/collect",
      siteId: "site-a",
      surfaceId: "home",
      sessionId: "browser-session-0001",
      privacy: () => ({ collectionAllowed: true, privacyDecisionRef: "decision-v1" }),
      environment,
    })).toThrow(/same-origin/);
  });

  it("HTTP handler enforces origin, envelope and body-size boundaries before runtime ingestion", async () => {
    const store = new InMemoryOntologyTransactionStore();
    const runtime = new CortexBehavioralSignalRuntime(store, scope, policy(), { pseudonymizationKey: KEY }, () => NOW);
    const handler = createBehavioralSignalHttpHandler(runtime, { allowedOrigins: [ORIGIN], maxBodyBytes: 1_024 });

    expect((await handler(new Request(`${ORIGIN}/api`, { method: "POST", headers: { origin: "https://denied.test", "content-type": "application/json" }, body: "{}" }))).status).toBe(403);
    expect((await handler(new Request(`${ORIGIN}/api`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ channel: "BASE", event: {}, extra: true }) }))).status).toBe(400);
    expect((await handler(new Request(`${ORIGIN}/api`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "x".repeat(1_025) }))).status).toBe(413);
    expect(store.checkpoint().objects).toHaveLength(1);
  });
});
