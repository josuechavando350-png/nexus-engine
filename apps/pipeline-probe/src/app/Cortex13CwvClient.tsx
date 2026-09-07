"use client";

import { useEffect } from "react";
import { evaluateCwvLifecycle, type CwvLifecycleThresholds } from "@nexus/core/cortex/cwv-lifecycle-optimizer";

type PipelineIdentity = { prebuildDigest: string; edgePolicyDigest: string; sourceRevision: string };
type Control = { mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED"; thresholds: CwvLifecycleThresholds | null; pipeline: PipelineIdentity | null };
const CONTROL_ENDPOINT = "/api/cortex/cwv/control";
const REPORT_ENDPOINT = "/api/cortex/cwv/report";
const CONTROL_RECONCILE_MS = 2_000;
const LONG_TASK_PRESSURE_RETENTION_MS = 10_000;
const EVENT_LOOP_SAMPLE_MS = 50;
const EVENT_LOOP_WARMUP_MS = 1_000;
const MIN_REPORT_INTERVAL_MS = 10_000;
const SUSPENSION_EVENT = "nexus:cortex13-suspension-change";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;

function parseIdentity(value: unknown): PipelineIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "edgePolicyDigest,prebuildDigest,sourceRevision") return null;
  if (typeof raw.prebuildDigest !== "string" || !SHA256.test(raw.prebuildDigest)) return null;
  if (typeof raw.edgePolicyDigest !== "string" || !SHA256.test(raw.edgePolicyDigest)) return null;
  if (typeof raw.sourceRevision !== "string" || !SHA.test(raw.sourceRevision)) return null;
  return Object.freeze({ prebuildDigest: raw.prebuildDigest, edgePolicyDigest: raw.edgePolicyDigest, sourceRevision: raw.sourceRevision });
}

function parseControl(value: unknown): Control | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "mode,pipeline,thresholds") return null;
  if (!(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED")) return null;
  if (raw.mode === "KILLED") return raw.thresholds === null && raw.pipeline === null ? { mode: "KILLED", thresholds: null, pipeline: null } : null;
  const pipeline = parseIdentity(raw.pipeline);
  if (!pipeline || !raw.thresholds || typeof raw.thresholds !== "object" || Array.isArray(raw.thresholds) || Object.getPrototypeOf(raw.thresholds) !== Object.prototype) return null;
  const thresholds = raw.thresholds as Record<string, unknown>;
  const keys = ["lcpPressureMs", "clsPressure", "inpPressureMs", "longTaskPressureMs"] as const;
  if (Object.keys(thresholds).sort().join(",") !== [...keys].sort().join(",")) return null;
  if (!keys.every((key) => typeof thresholds[key] === "number" && Number.isFinite(thresholds[key]))) return null;
  return { mode: raw.mode, thresholds: thresholds as unknown as CwvLifecycleThresholds, pipeline };
}

async function readControl(signal?: AbortSignal): Promise<Control | null> {
  try {
    const response = await fetch(CONTROL_ENDPOINT, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal, headers: { accept: "application/json" } });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 4096)) return null;
    return parseControl(await response.json());
  } catch { return null; }
}

function documentIdentity(): PipelineIdentity | null {
  const prebuildDigest = document.querySelector<HTMLMetaElement>('meta[name="nexus-cortex33-prebuild"]')?.content ?? "";
  const edgePolicyDigest = document.querySelector<HTMLMetaElement>('meta[name="nexus-cortex33-edge"]')?.content ?? "";
  const sourceRevision = document.querySelector<HTMLMetaElement>('meta[name="nexus-cortex33-source"]')?.content ?? "";
  return parseIdentity({ prebuildDigest, edgePolicyDigest, sourceRevision });
}
function sameIdentity(left: PipelineIdentity | null, right: PipelineIdentity | null): boolean {
  return Boolean(left && right && left.prebuildDigest === right.prebuildDigest && left.edgePolicyDigest === right.edgePolicyDigest && left.sourceRevision === right.sourceRevision);
}
function removeSpeculation(): number { const nodes = [...document.querySelectorAll('[data-nexus-cortex08="1"]')]; for (const node of nodes) node.remove(); return nodes.length; }
function emitSuspensionChange(suspended: boolean): void { window.dispatchEvent(new CustomEvent(SUSPENSION_EVENT, { detail: Object.freeze({ suspended }) })); }
function clearState(): void {
  const wasSuspended = document.documentElement.dataset.nexusCortex13SuspendSpeculation === "1";
  delete document.documentElement.dataset.nexusCortex13State;
  delete document.documentElement.dataset.nexusCortex13Reasons;
  delete document.documentElement.dataset.nexusCortex13SuspendSpeculation;
  if (wasSuspended) emitSuspensionChange(false);
}
function publishState(state: "NORMAL" | "PRESSURE" | "PAUSED", reasons: readonly string[], suspend: boolean): void {
  const wasSuspended = document.documentElement.dataset.nexusCortex13SuspendSpeculation === "1";
  document.documentElement.dataset.nexusCortex13State = state;
  document.documentElement.dataset.nexusCortex13Reasons = reasons.join(",");
  if (suspend) document.documentElement.dataset.nexusCortex13SuspendSpeculation = "1"; else delete document.documentElement.dataset.nexusCortex13SuspendSpeculation;
  if (suspend !== wasSuspended) emitSuspensionChange(suspend);
}

export function Cortex13CwvClient(): null {
  useEffect(() => {
    const controller = new AbortController();
    const renderedIdentity = documentIdentity();
    let disposed = false;
    let lcpMs: number | null = null;
    let cls = 0;
    let inpMs: number | null = null;
    let recentLongTaskMs = 0;
    let longTaskPressureUntil = 0;
    let control: Control | null = null;
    let applyRevision = 0;
    let lastReportAt = 0;
    let lastReportSignature = "";
    const observers: PerformanceObserver[] = [];

    const snapshot = () => Object.freeze({
      visibility: document.visibilityState === "hidden" ? "HIDDEN" as const : "VISIBLE" as const,
      lcpMs,
      cls,
      inpMs,
      recentLongTaskMs: performance.now() <= longTaskPressureUntil ? recentLongTaskMs : 0,
    });

    const report = async (sample: ReturnType<typeof snapshot>, decision: ReturnType<typeof evaluateCwvLifecycle>, identity: PipelineIdentity) => {
      const signature = `${decision.state}:${decision.reasons.join(",")}:${identity.prebuildDigest}:${identity.edgePolicyDigest}`;
      const now = Date.now();
      if (signature === lastReportSignature && now - lastReportAt < MIN_REPORT_INTERVAL_MS) return;
      lastReportSignature = signature;
      lastReportAt = now;
      const payload = {
        sampleId: `cwv-${crypto.randomUUID()}`,
        occurredAt: new Date(now).toISOString(),
        routePath: window.location.pathname,
        prebuildDigest: identity.prebuildDigest,
        edgePolicyDigest: identity.edgePolicyDigest,
        sourceRevision: identity.sourceRevision,
        visibility: sample.visibility,
        lcpMs: sample.lcpMs,
        cls: sample.cls,
        inpMs: sample.inpMs,
        recentLongTaskMs: sample.recentLongTaskMs,
        state: decision.state,
        reasons: decision.reasons,
        speculationSuspended: decision.shouldSuspendSpeculation,
      };
      try {
        await fetch(REPORT_ENDPOINT, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", keepalive: true, headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload) });
      } catch { /* audit transport cannot alter user navigation or lifecycle state */ }
    };

    const apply = async () => {
      const revision = ++applyRevision;
      const initial = control;
      if (!initial || initial.mode !== "ACTIVE" || !initial.thresholds || !sameIdentity(initial.pipeline, renderedIdentity)) { clearState(); return; }
      const sample = snapshot();
      const decision = evaluateCwvLifecycle(sample, initial.thresholds);
      const finalControl = await readControl(controller.signal);
      if (disposed || revision !== applyRevision || !finalControl || finalControl.mode !== "ACTIVE" || !finalControl.thresholds || !sameIdentity(finalControl.pipeline, renderedIdentity)) { clearState(); return; }
      if (JSON.stringify(finalControl.thresholds) !== JSON.stringify(initial.thresholds) || !sameIdentity(initial.pipeline, finalControl.pipeline)) { control = finalControl; clearState(); return; }
      publishState(decision.state, decision.reasons, decision.shouldSuspendSpeculation);
      if (decision.shouldSuspendSpeculation) removeSpeculation();
      void report(sample, decision, renderedIdentity!);
    };

    const supported = new Set(PerformanceObserver.supportedEntryTypes ?? []);
    const observe = (type: string, callback: (entries: readonly PerformanceEntry[]) => void) => {
      if (!supported.has(type)) return;
      try { const observer = new PerformanceObserver((list) => { callback(list.getEntries()); void apply(); }); observer.observe({ type, buffered: true }); observers.push(observer); } catch { /* unsupported browser observation remains fail-safe */ }
    };
    observe("largest-contentful-paint", (entries) => { const latest = entries.at(-1); if (latest) lcpMs = Math.max(lcpMs ?? 0, latest.startTime); });
    observe("layout-shift", (entries) => { for (const entry of entries) { const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean }; if (!shift.hadRecentInput && typeof shift.value === "number" && Number.isFinite(shift.value) && shift.value >= 0) cls += shift.value; } });
    observe("event", (entries) => { for (const entry of entries) { const event = entry as PerformanceEntry & { interactionId?: number; duration: number }; if ((event.interactionId ?? 0) > 0 && Number.isFinite(event.duration) && event.duration >= 0) inpMs = Math.max(inpMs ?? 0, event.duration); } });
    observe("longtask", (entries) => { for (const entry of entries) if (Number.isFinite(entry.duration) && entry.duration >= 0) recentLongTaskMs = Math.max(recentLongTaskMs, entry.duration); if (entries.length) longTaskPressureUntil = performance.now() + LONG_TASK_PRESSURE_RETENTION_MS; });

    let eventLoopPreviousAt = performance.now();
    const eventLoopArmedAt = eventLoopPreviousAt + EVENT_LOOP_WARMUP_MS;
    const eventLoopInterval = window.setInterval(() => {
      const now = performance.now(); const elapsed = now - eventLoopPreviousAt; eventLoopPreviousAt = now;
      if (disposed || now < eventLoopArmedAt) return;
      const schedulingStallMs = Math.max(0, elapsed - EVENT_LOOP_SAMPLE_MS); if (schedulingStallMs <= 0) return;
      recentLongTaskMs = Math.max(recentLongTaskMs, schedulingStallMs); longTaskPressureUntil = now + LONG_TASK_PRESSURE_RETENTION_MS; void apply();
    }, EVENT_LOOP_SAMPLE_MS);

    const onVisibility = () => { void apply(); };
    document.addEventListener("visibilitychange", onVisibility, { passive: true }); window.addEventListener("pagehide", onVisibility, { passive: true });
    const reconcile = async () => { const next = await readControl(controller.signal); if (disposed) return; control = next; if (!next || next.mode !== "ACTIVE" || !sameIdentity(next.pipeline, renderedIdentity)) clearState(); await apply(); };
    void reconcile();
    const interval = window.setInterval(() => { void reconcile(); }, CONTROL_RECONCILE_MS);

    return () => {
      disposed = true; controller.abort(); window.clearInterval(interval); window.clearInterval(eventLoopInterval);
      document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", onVisibility);
      for (const observer of observers) observer.disconnect(); clearState();
    };
  }, []);
  return null;
}
