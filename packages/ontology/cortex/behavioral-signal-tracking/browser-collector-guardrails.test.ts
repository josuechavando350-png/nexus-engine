import { describe, expect, it } from "vitest";
import { createBehavioralBrowserCollector, type BehavioralBrowserEnvironment } from "./browser-collector";

const NOW = Date.parse("2026-09-05T20:00:00.000Z");
const ORIGIN = "https://example.test";

class FakeDocument {
  visibilityState = "hidden";
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

  dispatch(type: string, target: unknown): void {
    const event = { target } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  hasFocus(): boolean { return true; }
}

function environment(document: FakeDocument, requests: string[]): BehavioralBrowserEnvironment {
  let sequence = 0;
  return {
    document: document as unknown as Document,
    window: { location: { href: `${ORIGIN}/`, origin: ORIGIN }, innerHeight: 1_000, scrollY: 0 } as unknown as Window,
    fetch: async (_input, init) => {
      requests.push(String(init?.body ?? ""));
      return new Response(null, { status: 202 });
    },
    randomUUID: () => `00000000-0000-4000-8000-${(++sequence).toString().padStart(12, "0")}`,
    now: () => NOW,
    setTimer: () => 1,
    clearTimer: () => undefined,
    hasFocus: () => true,
  };
}

function formTarget(id: string) {
  const form = {
    getAttribute: (name: string) => name === "data-nexus-signal" ? id : null,
  };
  return {
    closest: (selector: string) => selector === "form[data-nexus-signal]" || selector === "[data-nexus-signal]" ? form : null,
  };
}

describe("behavioral browser collector guardrails", () => {
  it("fails closed when the upstream privacy provider throws and isolates its observer", async () => {
    const document = new FakeDocument();
    const requests: string[] = [];
    let privacyErrors = 0;
    const collector = createBehavioralBrowserCollector({
      endpoint: "/api/cortex/behavioral",
      siteId: "site-a",
      surfaceId: "home",
      sessionId: "browser-session-0001",
      privacy: () => { throw new Error("consent registry unavailable"); },
      onPrivacyError: () => { privacyErrors += 1; throw new Error("observer unavailable"); },
      maxRetries: 0,
      environment: environment(document, requests),
    });

    expect(() => collector.start()).not.toThrow();
    document.dispatch("click", { closest: () => null });
    await collector.drain();
    collector.stop();

    expect(requests).toHaveLength(0);
    expect(privacyErrors).toBeGreaterThanOrEqual(1);
  });

  it("does not misclassify clicks inside an annotated form as CTA clicks", async () => {
    const document = new FakeDocument();
    const requests: string[] = [];
    const collector = createBehavioralBrowserCollector({
      endpoint: "/api/cortex/behavioral",
      siteId: "site-a",
      surfaceId: "home",
      sessionId: "browser-session-0001",
      privacy: () => ({ collectionAllowed: true, privacyDecisionRef: "decision-v1" }),
      maxRetries: 0,
      environment: environment(document, requests),
    });

    collector.start();
    document.dispatch("click", formTarget("form.contact"));
    await collector.drain();
    collector.stop();

    const envelopes = requests.map((body) => JSON.parse(body) as { event: { kind: string } });
    expect(envelopes.map((item) => item.event.kind)).toEqual(["PAGE_VIEW"]);
  });
});
