"use client";

import { useEffect } from "react";
import { FRICTION_FEATURE_CONTRACT_ID } from "@nexus/core/cortex/friction-abandonment-scoring";

const CONTROL_ENDPOINT = "/api/cortex/friction/control";
const ACTION_CONTROL_ENDPOINT = "/api/cortex/friction/action-control";
const SCORE_ENDPOINT = "/api/cortex/friction/score";
const SAMPLE_INTERVAL_MS = 5_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MODEL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const ACTION_ID = MODEL_ID;

interface RuntimeControl {
  readonly mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
  readonly featureContractId: typeof FRICTION_FEATURE_CONTRACT_ID;
  readonly modelId: string | null;
  readonly modelSourceDigest: string | null;
  readonly modelArtifactDigest: string | null;
}
interface ActionControl {
  readonly mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
  readonly policyId: string | null;
  readonly policySourceDigest: string | null;
  readonly policyArtifactDigest: string | null;
}
interface RescueAction {
  readonly actionId: string;
  readonly kind: "SHOW_HELP" | "SIMPLIFY_CHOICE" | "SURFACE_CONTACT";
  readonly label: string;
  readonly message: string;
}
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

function exactPlainObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("CORTEX_INVALID_RESPONSE");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== [...keys].sort().join(",")) throw new Error("CORTEX_INVALID_RESPONSE");
  return input;
}
function parseControl(value: unknown): RuntimeControl {
  const input = exactPlainObject(value, ["featureContractId", "mode", "modelArtifactDigest", "modelId", "modelSourceDigest"]);
  if (!(input.mode === "ACTIVE" || input.mode === "OBSERVE_ONLY" || input.mode === "KILLED")) throw new Error("CORTEX_09_INVALID_CONTROL");
  if (input.featureContractId !== FRICTION_FEATURE_CONTRACT_ID) throw new Error("CORTEX_09_INVALID_CONTROL");
  if (input.mode === "KILLED") {
    if (!(input.modelId === null && input.modelSourceDigest === null && input.modelArtifactDigest === null)) throw new Error("CORTEX_09_INVALID_CONTROL");
  } else if (typeof input.modelId !== "string" || !MODEL_ID.test(input.modelId) || typeof input.modelSourceDigest !== "string" || !SHA256.test(input.modelSourceDigest) || typeof input.modelArtifactDigest !== "string" || !SHA256.test(input.modelArtifactDigest)) {
    throw new Error("CORTEX_09_INVALID_CONTROL");
  }
  return Object.freeze({ mode: input.mode, featureContractId: FRICTION_FEATURE_CONTRACT_ID, modelId: input.modelId as string | null, modelSourceDigest: input.modelSourceDigest as string | null, modelArtifactDigest: input.modelArtifactDigest as string | null });
}
function parseActionControl(value: unknown): ActionControl {
  const input = exactPlainObject(value, ["mode", "policyArtifactDigest", "policyId", "policySourceDigest"]);
  if (!(input.mode === "ACTIVE" || input.mode === "OBSERVE_ONLY" || input.mode === "KILLED")) throw new Error("CORTEX_29_INVALID_CONTROL");
  if (input.mode === "KILLED") {
    if (!(input.policyId === null && input.policySourceDigest === null && input.policyArtifactDigest === null)) throw new Error("CORTEX_29_INVALID_CONTROL");
  } else if (typeof input.policyId !== "string" || !MODEL_ID.test(input.policyId) || typeof input.policySourceDigest !== "string" || !SHA256.test(input.policySourceDigest) || typeof input.policyArtifactDigest !== "string" || !SHA256.test(input.policyArtifactDigest)) {
    throw new Error("CORTEX_29_INVALID_CONTROL");
  }
  return Object.freeze({ mode: input.mode, policyId: input.policyId as string | null, policySourceDigest: input.policySourceDigest as string | null, policyArtifactDigest: input.policyArtifactDigest as string | null });
}
async function boundedJson(endpoint: string): Promise<unknown> {
  const response = await fetch(endpoint, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("CORTEX_CONTROL_UNAVAILABLE");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 4_096)) throw new Error("CORTEX_CONTROL_TOO_LARGE");
  return response.json();
}
const readControl = async () => parseControl(await boundedJson(CONTROL_ENDPOINT));
const readActionControl = async () => {
  try { return parseActionControl(await boundedJson(ACTION_CONTROL_ENDPOINT)); }
  catch { return Object.freeze({ mode: "KILLED", policyId: null, policySourceDigest: null, policyArtifactDigest: null }) as ActionControl; }
};
function sameModel(left: RuntimeControl, right: RuntimeControl): boolean {
  return Boolean(left.modelId && left.modelSourceDigest && left.modelArtifactDigest && left.featureContractId === right.featureContractId && left.modelId === right.modelId && left.modelSourceDigest === right.modelSourceDigest && left.modelArtifactDigest === right.modelArtifactDigest);
}
function sameActionControl(left: ActionControl, right: ActionControl): boolean {
  return Boolean(left.mode === right.mode && left.policyId && left.policySourceDigest && left.policyArtifactDigest && left.policyId === right.policyId && left.policySourceDigest === right.policySourceDigest && left.policyArtifactDigest === right.policyArtifactDigest);
}
function parseRescue(value: unknown): RescueAction | null {
  if (value === null) return null;
  const input = exactPlainObject(value, ["actionId", "kind", "label", "message"]);
  if (typeof input.actionId !== "string" || !ACTION_ID.test(input.actionId) || !(input.kind === "SHOW_HELP" || input.kind === "SIMPLIFY_CHOICE" || input.kind === "SURFACE_CONTACT") || typeof input.label !== "string" || input.label.length < 1 || input.label.length > 180 || typeof input.message !== "string" || input.message.length < 1 || input.message.length > 180) throw new Error("CORTEX_29_INVALID_ACTION");
  return Object.freeze({ actionId: input.actionId, kind: input.kind, label: input.label, message: input.message });
}
function rollback(): void {
  delete document.documentElement.dataset.nexusCortex09Risk;
  delete document.documentElement.dataset.nexusCortex09Probability;
  delete document.documentElement.dataset.nexusCortex29Action;
  for (const node of document.querySelectorAll('[data-nexus-cortex29-rescue="1"]')) node.remove();
}
function applyRescue(action: RescueAction): void {
  for (const node of document.querySelectorAll('[data-nexus-cortex29-rescue="1"]')) node.remove();
  const aside = document.createElement("aside");
  aside.dataset.nexusCortex29Rescue = "1";
  aside.setAttribute("role", "status");
  aside.setAttribute("aria-live", "polite");
  aside.dataset.actionKind = action.kind;
  const message = document.createElement("p");
  message.textContent = action.message;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action.label;
  button.addEventListener("click", () => { aside.remove(); }, { once: true });
  aside.append(message, button);
  document.body.appendChild(aside);
  document.documentElement.dataset.nexusCortex29Action = action.actionId;
}

export function Cortex09FrictionClient() {
  useEffect(() => {
    const signals: MutableSignals = { startedAt: performance.now(), scrollDepthBps: 0, maxInteractionLatencyMs: 0, interactionCount: 0, validationErrorCount: 0, repeatedActionCount: 0, longTaskCount: 0, visibilityLossCount: 0, lastTarget: null, lastActionAt: 0 };
    let stopped = false;
    let sampling = false;
    const updateScroll = () => { const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight); signals.scrollDepthBps = Math.max(signals.scrollDepthBps, Math.min(10_000, Math.round((window.scrollY / scrollable) * 10_000))); };
    updateScroll();
    const onInteraction = (event: Event) => {
      signals.interactionCount = Math.min(500, signals.interactionCount + 1);
      const now = performance.now();
      if (event.target === signals.lastTarget && now - signals.lastActionAt <= 600) signals.repeatedActionCount = Math.min(100, signals.repeatedActionCount + 1);
      signals.lastTarget = event.target;
      signals.lastActionAt = now;
      requestAnimationFrame(() => { const latency = Math.max(0, Math.round(performance.now() - now)); signals.maxInteractionLatencyMs = Math.min(10_000, Math.max(signals.maxInteractionLatencyMs, latency)); });
    };
    const onInvalid = () => { signals.validationErrorCount = Math.min(100, signals.validationErrorCount + 1); };
    const onVisibility = () => { if (document.visibilityState === "hidden") signals.visibilityLossCount = Math.min(100, signals.visibilityLossCount + 1); };
    window.addEventListener("scroll", updateScroll, { passive: true });
    document.addEventListener("pointerdown", onInteraction, { passive: true });
    document.addEventListener("keydown", onInteraction, { passive: true });
    document.addEventListener("invalid", onInvalid, true);
    document.addEventListener("visibilitychange", onVisibility);
    let longTaskObserver: PerformanceObserver | null = null;
    try { longTaskObserver = new PerformanceObserver((list) => { signals.longTaskCount = Math.min(500, signals.longTaskCount + list.getEntries().length); }); longTaskObserver.observe({ entryTypes: ["longtask"] }); } catch { longTaskObserver = null; }

    const sample = async () => {
      if (stopped || sampling) return;
      sampling = true;
      try {
        const [initial, initialActionControl] = await Promise.all([readControl(), readActionControl()]);
        if (stopped || initial.mode === "KILLED") { rollback(); return; }
        const snapshot = { schemaVersion: 1, featureContractId: FRICTION_FEATURE_CONTRACT_ID, pointerClass: window.matchMedia("(pointer: coarse)").matches ? "COARSE" : "FINE", elapsedMs: Math.min(1_800_000, Math.max(0, Math.round(performance.now() - signals.startedAt))), scrollDepthBps: signals.scrollDepthBps, maxInteractionLatencyMs: signals.maxInteractionLatencyMs, interactionCount: signals.interactionCount, validationErrorCount: signals.validationErrorCount, repeatedActionCount: signals.repeatedActionCount, longTaskCount: signals.longTaskCount, visibilityLossCount: signals.visibilityLossCount };
        const response = await fetch(SCORE_ENDPOINT, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(snapshot) });
        if (stopped || !response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") { rollback(); return; }
        const raw = exactPlainObject(await response.json(), ["action", "actionControl", "actionReason", "mode", "modelArtifactDigest", "score"]);
        const responseActionControl = parseActionControl(raw.actionControl);
        const rescue = parseRescue(raw.action);
        if (typeof raw.actionReason !== "string") { rollback(); return; }
        if (initial.mode === "OBSERVE_ONLY") {
          if (!(raw.mode === "OBSERVE_ONLY" && raw.score === null && raw.modelArtifactDigest === initial.modelArtifactDigest && rescue === null)) { rollback(); return; }
          rollback();
          return;
        }
        if (raw.mode !== "ACTIVE" || raw.modelArtifactDigest !== initial.modelArtifactDigest) { rollback(); return; }
        const score = exactPlainObject(raw.score, ["abandonmentProbability", "estimator", "evidence", "featureContractId", "modelId", "modelSourceDigest", "pointerClass", "riskBand", "schemaVersion"]);
        if (score.schemaVersion !== 1 || score.estimator !== "CONFIGURED_LOGISTIC_MODEL_V1" || score.featureContractId !== FRICTION_FEATURE_CONTRACT_ID || score.modelId !== initial.modelId || score.modelSourceDigest !== initial.modelSourceDigest || !(score.pointerClass === "COARSE" || score.pointerClass === "FINE") || !(score.riskBand === "LOW" || score.riskBand === "MEDIUM" || score.riskBand === "HIGH") || typeof score.abandonmentProbability !== "number" || !Number.isFinite(score.abandonmentProbability) || score.abandonmentProbability < 0 || score.abandonmentProbability > 1) { rollback(); return; }

        const [final, finalActionControl] = await Promise.all([readControl(), readActionControl()]);
        if (stopped || final.mode !== "ACTIVE" || !sameModel(initial, final)) { rollback(); return; }
        document.documentElement.dataset.nexusCortex09Risk = score.riskBand;
        document.documentElement.dataset.nexusCortex09Probability = score.abandonmentProbability.toFixed(4);

        // Final Control Plane guard at the DOM side-effect frontier.
        if (!rescue) {
          for (const node of document.querySelectorAll('[data-nexus-cortex29-rescue="1"]')) node.remove();
          delete document.documentElement.dataset.nexusCortex29Action;
          return;
        }
        if (initialActionControl.mode !== "ACTIVE" || finalActionControl.mode !== "ACTIVE" || !sameActionControl(initialActionControl, finalActionControl) || !sameActionControl(responseActionControl, finalActionControl)) {
          for (const node of document.querySelectorAll('[data-nexus-cortex29-rescue="1"]')) node.remove();
          delete document.documentElement.dataset.nexusCortex29Action;
          return;
        }
        applyRescue(rescue);
      } catch {
        rollback();
      } finally { sampling = false; }
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
