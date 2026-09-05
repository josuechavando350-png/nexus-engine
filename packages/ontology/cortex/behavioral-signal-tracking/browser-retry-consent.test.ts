import { describe, expect, it } from "vitest";
import { createBehavioralBrowserCollector, type BehavioralBrowserEnvironment } from "./browser-collector";

const NOW = Date.parse("2026-09-05T19:45:00.000Z");
const ORIGIN = "https://example.test";

class FakeDocument {
  visibilityState = "visible";
  documentElement = { scrollHeight: 2_000 };
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") return;
    const bucket = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.get(type)?.delete(listener);
  }
  hasFocus(): boolean { return true; }
}

describe("behavioral browser retry privacy guard", () => {
  it("does not retry a queued event after consent is revoked during backoff", async () => {
    const document = new FakeDocument();
    let allowed = true;
    let requests = 0;
    let uuid = 0;
    const timerQueue: Array<() => void> = [];
    const environment: BehavioralBrowserEnvironment = {
      document: document as unknown as Document,
      window: { location: { href: `${ORIGIN}/`, origin: ORIGIN }, innerHeight: 1_000, scrollY: 0 } as unknown as Window,
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 503 });
      },
      randomUUID: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
      now: () => NOW,
      setTimer: (callback) => { timerQueue.push(callback); return timerQueue.length; },
      clearTimer: () => undefined,
      hasFocus: () => true,
    };

    const collector = createBehavioralBrowserCollector({
      endpoint: "/api/cortex/behavioral",
      siteId: "site-a",
      surfaceId: "home",
      sessionId: "browser-session-0001",
      privacy: () => ({ collectionAllowed: allowed, privacyDecisionRef: allowed ? "decision-v1" : null }),
      readingPauseMs: 1_000,
      maxRetries: 1,
      retryDelayMs: 50,
      environment,
    });

    collector.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toBe(1);

    allowed = false;
    for (const timer of timerQueue.splice(0)) timer();
    await collector.drain();
    collector.stop();

    expect(requests).toBe(1);
  });

  it("also drops a retry when the privacy decision reference changes", async () => {
    const document = new FakeDocument();
    let decisionRef = "decision-v1";
    let requests = 0;
    let uuid = 0;
    const timerQueue: Array<() => void> = [];
    const environment: BehavioralBrowserEnvironment = {
      document: document as unknown as Document,
      window: { location: { href: `${ORIGIN}/`, origin: ORIGIN }, innerHeight: 1_000, scrollY: 0 } as unknown as Window,
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 503 });
      },
      randomUUID: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
      now: () => NOW,
      setTimer: (callback) => { timerQueue.push(callback); return timerQueue.length; },
      clearTimer: () => undefined,
      hasFocus: () => true,
    };

    const collector = createBehavioralBrowserCollector({
      endpoint: "/api/cortex/behavioral",
      siteId: "site-a",
      surfaceId: "home",
      sessionId: "browser-session-0001",
      privacy: () => ({ collectionAllowed: true, privacyDecisionRef: decisionRef }),
      readingPauseMs: 1_000,
      maxRetries: 1,
      retryDelayMs: 50,
      environment,
    });

    collector.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toBe(1);

    decisionRef = "decision-v2";
    for (const timer of timerQueue.splice(0)) timer();
    await collector.drain();
    collector.stop();

    expect(requests).toBe(1);
  });
});
