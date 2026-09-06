"use client";

import { useEffect } from "react";
import { evaluateCwvLifecycle, type CwvLifecycleThresholds } from "@nexus/core/cortex/cwv-lifecycle-optimizer";

type Control = { mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED"; thresholds: CwvLifecycleThresholds | null };

function parseControl(value: unknown): Control | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED")) return null;
  if (raw.mode === "KILLED") return { mode: "KILLED", thresholds: null };
  if (!raw.thresholds || typeof raw.thresholds !== "object" || Array.isArray(raw.thresholds)) return null;
  const thresholds = raw.thresholds as Record<string, unknown>;
  const keys = ["lcpPressureMs", "clsPressure", "inpPressureMs", "longTaskPressureMs"] as const;
  if (!keys.every((key) => typeof thresholds[key] === "number" && Number.isFinite(thresholds[key]))) return null;
  return { mode: raw.mode, thresholds: thresholds as unknown as CwvLifecycleThresholds };
}

async function readControl(signal?: AbortSignal): Promise<Control | null> {
  try {
    const response = await fetch("/api/cortex/cwv/control", { cache: "no-store", redirect: "error", signal, headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return parseControl(await response.json());
  } catch {
    return null;
  }
}

function removeSpeculation(): number {
  const nodes = [...document.querySelectorAll('[data-nexus-cortex08="1"]')];
  for (const node of nodes) node.remove();
  return nodes.length;
}

function clearState(): void {
  delete document.documentElement.dataset.nexusCortex13State;
  delete document.documentElement.dataset.nexusCortex13Reasons;
}

export function Cortex13CwvClient(): null {
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let lcpMs: number | null = null;
    let cls = 0;
    let inpMs: number | null = null;
    let recentLongTaskMs = 0;
    let longTaskPressureUntil = 0;
    let control: Control | null = null;
    let applyRevision = 0;
    const observers: PerformanceObserver[] = [];

    const snapshot = () => ({
      visibility: document.visibilityState === "hidden" ? "HIDDEN" as const : "VISIBLE" as const,
      lcpMs,
      cls,
      inpMs,
      recentLongTaskMs: performance.now() <= longTaskPressureUntil ? recentLongTaskMs : 0,
    });

    const apply = async () => {
      const revision = ++applyRevision;
      const initial = control;
      if (!initial || initial.mode !== "ACTIVE" || !initial.thresholds) {
        clearState();
        return;
      }
      const decision = evaluateCwvLifecycle(snapshot(), initial.thresholds);
      // Final control read immediately before any optimization mutation.
      const finalControl = await readControl(controller.signal);
      if (disposed || revision !== applyRevision || !finalControl || finalControl.mode !== "ACTIVE" || !finalControl.thresholds) {
        clearState();
        return;
      }
      const sameThresholds = JSON.stringify(finalControl.thresholds) === JSON.stringify(initial.thresholds);
      if (!sameThresholds) {
        control = finalControl;
        clearState();
        return;
      }
      document.documentElement.dataset.nexusCortex13State = decision.state;
      document.documentElement.dataset.nexusCortex13Reasons = decision.reasons.join(",");
      if (decision.shouldSuspendSpeculation) removeSpeculation();
    };

    const supported = new Set(PerformanceObserver.supportedEntryTypes ?? []);
    const observe = (type: string, callback: (entries: readonly PerformanceEntry[]) => void) => {
      if (!supported.has(type)) return;
      try {
        const observer = new PerformanceObserver((list) => { callback(list.getEntries()); void apply(); });
        observer.observe({ type, buffered: true });
        observers.push(observer);
      } catch { /* unsupported observer options remain non-fatal */ }
    };

    observe("largest-contentful-paint", (entries) => {
      const latest = entries.at(-1); if (latest) lcpMs = Math.max(lcpMs ?? 0, latest.startTime);
    });
    observe("layout-shift", (entries) => {
      for (const entry of entries) {
        const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
        if (!shift.hadRecentInput && typeof shift.value === "number" && Number.isFinite(shift.value) && shift.value >= 0) cls += shift.value;
      }
    });
    observe("event", (entries) => {
      for (const entry of entries) {
        const event = entry as PerformanceEntry & { interactionId?: number; duration: number };
        if ((event.interactionId ?? 0) > 0 && Number.isFinite(event.duration)) inpMs = Math.max(inpMs ?? 0, event.duration);
      }
    });
    observe("longtask", (entries) => {
      for (const entry of entries) if (Number.isFinite(entry.duration)) recentLongTaskMs = Math.max(recentLongTaskMs, entry.duration);
      if (entries.length) longTaskPressureUntil = performance.now() + 10_000;
    });

    const onVisibility = () => { void apply(); };
    document.addEventListener("visibilitychange", onVisibility, { passive: true });
    window.addEventListener("pagehide", onVisibility, { passive: true });

    const reconcile = async () => {
      const next = await readControl(controller.signal);
      if (disposed) return;
      control = next;
      if (!next || next.mode !== "ACTIVE") clearState();
      await apply();
    };
    void reconcile();
    const interval = window.setInterval(() => { void reconcile(); }, 2_000);

    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onVisibility);
      for (const observer of observers) observer.disconnect();
      clearState();
    };
  }, []);
  return null;
}
