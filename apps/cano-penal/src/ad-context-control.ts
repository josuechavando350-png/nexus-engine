import type { AdContextDecision, AdContextMode } from "@nexus/core/cortex/ad-context-edge-workers";
import { adContextModeFromEnvironment } from "./ad-context";

const CONTROL_TIMEOUT_MS = 350;
const TELEMETRY_TIMEOUT_MS = 1_000;
const TOKEN_MIN = 32;
const TOKEN_MAX = 4096;
const MAX_CONTROL_RESPONSE_BYTES = 4_096;
const MODES = new Set<AdContextMode>(["ACTIVE", "OBSERVE_ONLY", "KILLED"]);
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

interface AdContextEdgeControlConfig { readonly baseUrl: string; readonly token: string }
interface AdContextRuntimePayload { readonly policyId: string; readonly mode: AdContextMode; readonly revision: number; readonly digest: string }

function config(): AdContextEdgeControlConfig | null {
  const rawUrl = process.env.NEXUS_AD_CONTEXT_CONTROL_ENDPOINT?.trim();
  const token = process.env.NEXUS_AD_CONTEXT_EDGE_TOKEN?.trim();
  if (!rawUrl || !token || token.length < TOKEN_MIN || token.length > TOKEN_MAX) return null;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return null;
  return { baseUrl: url.toString().replace(/\/$/u, ""), token };
}

function rank(mode: AdContextMode): number { return mode === "ACTIVE" ? 0 : mode === "OBSERVE_ONLY" ? 1 : 2; }
export function mostRestrictiveAdContextMode(left: AdContextMode, right: AdContextMode): AdContextMode { return rank(left) >= rank(right) ? left : right; }

function runtimePayload(value: unknown): AdContextRuntimePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["policyId", "mode", "revision", "digest"]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) return null;
  if (typeof record.policyId !== "string" || !IDENTIFIER.test(record.policyId)) return null;
  if (typeof record.mode !== "string" || !MODES.has(record.mode as AdContextMode)) return null;
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) return null;
  if (typeof record.digest !== "string" || !DIGEST.test(record.digest)) return null;
  return { policyId: record.policyId, mode: record.mode as AdContextMode, revision: record.revision, digest: record.digest };
}

async function boundedControlText(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) return null;
    if (Number(declared) > MAX_CONTROL_RESPONSE_BYTES) return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function effectiveCanoAdContextMode(): Promise<AdContextMode> {
  const emergency = adContextModeFromEnvironment(process.env.NEXUS_AD_CONTEXT_MODE);
  const configured = config();
  if (!configured) return "KILLED";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
  try {
    const response = await fetch(`${configured.baseUrl}/v1/ad-context/runtime`, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { authorization: `Bearer ${configured.token}`, accept: "application/json" },
    });
    if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return "KILLED";
    const raw = await boundedControlText(response);
    if (raw === null) return "KILLED";
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { return "KILLED"; }
    const payload = runtimePayload(parsed);
    if (!payload || payload.policyId !== "cano-paid-landing-v1") return "KILLED";
    return mostRestrictiveAdContextMode(emergency, payload.mode);
  } catch {
    return "KILLED";
  } finally {
    clearTimeout(timeout);
  }
}

export async function recordCanoAdContextDecision(decision: AdContextDecision): Promise<void> {
  const configured = config();
  if (!configured) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetch(`${configured.baseUrl}/v1/ad-context/observe`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { authorization: `Bearer ${configured.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        policyId: decision.policyId,
        mode: decision.mode,
        channel: decision.channel,
        reason: decision.reason,
        applied: decision.applied,
        observedAt: new Date().toISOString(),
      }),
    });
  } catch {
    // Observation is non-authoritative and cannot alter the request decision.
  } finally {
    clearTimeout(timeout);
  }
}
