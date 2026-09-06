"use client";

import { useEffect } from "react";

const CONTROL_ENDPOINT = "/api/cortex/friction/control";
const SCORE_ENDPOINT = "/api/cortex/friction/score";
const SAMPLE_INTERVAL_MS = 5_000;

interface MutableSignals {
  startedAt: number;
  scrollDepthBps: number;
  maxInteractionLatencyMs: number;
  interactionCount: number;
  validationErrorCount: number;
  repeatedActionCount: number;
  longTaskCount: number;
  visibilityLossCount: number;
  lastTarget: EventTarget | null;
  lastActionAt: number;
}

async function readMode(): Promise<"ACTIVE" | "OBSERVE_ONLY" | "KILLED"> {
  const response = await fetch(CONTROL_ENDPOINT, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return "KILLED";
  const body = await response.json() as { mode?: unknown };
  return body.mode === "ACTIVE" || body.mode === "OBSERVE_ONLY" ? body.mode : "KILLED";
}

function rollback(): void {
  delete document.documentElement.dataset.nexusCortex09Risk;
  delete document.documentElement.dataset.nexusCortex09Probability;
}

export function Cortex09FrictionClient() {
  useEffect(() => {
    const signals: MutableSignals = {
      startedAt: performance.now(),
      scrollDepthBps: 0,
      maxInteractionLatencyMs: 0,
      interactionCount: 0,
      validationErrorCount: 0,
      repeatedActionCount: 0,
      longTaskCount: 0,
      visibilityLossCount: 0,
      lastTarget: null,
      lastActionAt: 0,
    };
    let stopped = false;

    const updateScroll = () => {
      const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      signals.scrollDepthBps = Math.max(signals.scrollDepthBps, Math.min(10_000, Math.round((window.scrollY / scrollable) * 10_000)));
    };
    updateScroll();

    const onInteraction = (event: Event) => {
      signals.interactionCount = Math.min(500, signals.interactionCount + 1);
      const now = performance.now();
      if (event.target === signals.lastTarget && now - signals.lastActionAt <= 600) signals.repeatedActionCount = Math.min(100, signals.repeatedActionCount + 1);
      signals.lastTarget = event.target;
      signals.lastActionAt = now;
      const started = now;
      requestAnimationFrame(() => {
        const latency = Math.max(0, Math.round(performance.now() - started));
        signals.maxInteractionLatencyMs = Math.min(10_000, Math.max(signals.maxInteractionLatencyMs, latency));
      });
    };
    const onInvalid = () => { signals.validationErrorCount = Math.min(100, signals.validationErrorCount + 1); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") signals.visibilityLossCount = Math.min(100, signals.visibilityLossCount + 1);
    };

    window.addEventListener("scroll", updateScroll, { passive: true });
    document.addEventListener("pointerdown", onInteraction, { passive: true });
    document.addEventListener("keydown", onInteraction, { passive: true });
    document.addEventListener("invalid", onInvalid, true);
    document.addEventListener("visibilitychange", onVisibility);

    let longTaskObserver: PerformanceObserver | null = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        signals.longTaskCount = Math.min(500, signals.longTaskCount + list.getEntries().length);
      });
      longTaskObserver.observe({ entryTypes: ["longtask"] });
    } catch {
      longTaskObserver = null;
    }

    const sample = async () => {
      if (stopped) return;
      const mode = await readMode().catch(() => "KILLED" as const);
      if (mode === "KILLED") {
        rollback();
        return;
      }
      const snapshot = {
        schemaVersion: 1,
        deviceClass: window.matchMedia("(pointer: coarse)").matches ? "MOBILE" : "DESKTOP",
        elapsedMs: Math.min(1_800_000, Math.max(0, Math.round(performance.now() - signals.startedAt))),
        scrollDepthBps: signals.scrollDepthBps,
        maxInteractionLatencyMs: signals.maxInteractionLatencyMs,
        interactionCount: signals.interactionCount,
        validationErrorCount: signals.validationErrorCount,
        repeatedActionCount: signals.repeatedActionCount,
        longTaskCount: signals.longTaskCount,
        visibilityLossCount: signals.visibilityLossCount,
      };
      try {
        const response = await fetch(SCORE_ENDPOINT, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(snapshot),
        });
        if (!response.ok) {
          rollback();
          return;
        }
        const result = await response.json() as { mode?: unknown; score?: { riskBand?: unknown; abandonmentProbability?: unknown } | null };
        if (mode === "OBSERVE_ONLY") {
          // Observation mode still exercises the real scoring boundary, but it
          // must never expose a consumer-visible intervention state.
          if (result.mode !== "OBSERVE_ONLY" || result.score !== null) rollback();
          else rollback();
          return;
        }
        if (result.mode !== "ACTIVE" || !result.score || typeof result.score.riskBand !== "string" || typeof result.score.abandonmentProbability !== "number") {
          rollback();
          return;
        }
        // Last-boundary kill check before mutating the consumer-visible DOM state.
        if (await readMode().catch(() => "KILLED" as const) !== "ACTIVE") {
          rollback();
          return;
        }
        document.documentElement.dataset.nexusCortex09Risk = result.score.riskBand;
        document.documentElement.dataset.nexusCortex09Probability = result.score.abandonmentProbability.toFixed(4);
      } catch {
        rollback();
      }
    };

    void sample();
    const interval = window.setInterval(() => { void sample(); }, SAMPLE_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      longTaskObserver?.disconnect();
      window.removeEventListener("scroll", updateScroll);
      document.removeEventListener("pointerdown", onInteraction);
      document.removeEventListener("keydown", onInteraction);
      document.removeEventListener("invalid", onInvalid, true);
      document.removeEventListener("visibilitychange", onVisibility);
      rollback();
    };
  }, []);

  return null;
}
