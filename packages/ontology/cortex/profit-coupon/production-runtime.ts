import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteCouponIssuer, type CouponPolicy } from "./index.js";
import { SqliteCouponOutboxDispatcher } from "./production-outbox.js";
import { startCortex19Server } from "./production-server.js";
import { SqliteCortex19Control } from "./runtime-control.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
const MAX_SECRET_BYTES = 4096;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required and must not contain control characters`);
  return value;
}
function absolutePath(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name); if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`); return value;
}
function secretFile(env: NodeJS.ProcessEnv, name: string): string {
  const path = absolutePath(env, name); const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_BYTES) throw new Error(`${name} must reference a bounded regular secret file`);
  const value = readFileSync(path, "utf8");
  if (Buffer.byteLength(value, "utf8") !== stat.size || value.length < 32 || value.length > MAX_SECRET_BYTES || /[\r\n\0]/u.test(value)) throw new Error(`${name} contains an invalid secret`);
  return value;
}
function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name] ?? String(fallback); if (!/^\d+$/u.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is invalid`); return value;
}
function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is invalid`); return value;
}
function money(value: unknown, label: string): number {
  const parsed = finite(value, label, 0, 1e12); const cents = Math.round(parsed * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(parsed * 100 - cents) > 1e-7) throw new Error(`${label} must use at most two decimal places`);
  return cents / 100;
}

function policyFromEnv(env: NodeJS.ProcessEnv): CouponPolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(required(env, "NEXUS_CORTEX_19_POLICY_JSON")) as unknown; } catch { throw new Error("NEXUS_CORTEX_19_POLICY_JSON must contain valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error("CORTEX #19 policy must be a plain object");
  const raw = parsed as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "frequencyWindowSeconds,maxCouponsPerWindow,maxDiscountBps,maxDiscountCostPerWindow,minProfitAmount,tiers") throw new Error("CORTEX #19 policy contract is invalid");
  const minProfitAmount = money(raw.minProfitAmount, "minProfitAmount");
  const maxDiscountBps = finite(raw.maxDiscountBps, "maxDiscountBps", 0, 10_000);
  const maxCouponsPerWindow = finite(raw.maxCouponsPerWindow, "maxCouponsPerWindow", 1, 100_000);
  const maxDiscountCostPerWindow = money(raw.maxDiscountCostPerWindow, "maxDiscountCostPerWindow");
  const frequencyWindowSeconds = finite(raw.frequencyWindowSeconds, "frequencyWindowSeconds", 60, 31_536_000);
  if (!Number.isInteger(maxDiscountBps) || !Number.isInteger(maxCouponsPerWindow) || !Number.isInteger(frequencyWindowSeconds)) throw new Error("CORTEX #19 integer policy values are invalid");
  if (!Array.isArray(raw.tiers) || raw.tiers.length < 1 || raw.tiers.length > 20) throw new Error("CORTEX #19 tiers are invalid");
  const thresholds = new Set<number>();
  const tiers = raw.tiers.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype || Object.keys(item as object).sort().join(",") !== "discountBps,probabilityAtOrBelow") throw new Error("CORTEX #19 tier contract is invalid");
    const tier = item as Record<string, unknown>; const probabilityAtOrBelow = finite(tier.probabilityAtOrBelow, "probabilityAtOrBelow", 0, 1); const discountBps = finite(tier.discountBps, "discountBps", 0, maxDiscountBps);
    if (!Number.isInteger(discountBps) || thresholds.has(probabilityAtOrBelow)) throw new Error("CORTEX #19 tier threshold is duplicated or discountBps is invalid"); thresholds.add(probabilityAtOrBelow);
    return Object.freeze({ probabilityAtOrBelow, discountBps });
  }).sort((a, b) => a.probabilityAtOrBelow - b.probabilityAtOrBelow || b.discountBps - a.discountBps);
  return Object.freeze({ minProfitAmount, maxDiscountBps, maxCouponsPerWindow, maxDiscountCostPerWindow, frequencyWindowSeconds, tiers: Object.freeze(tiers) });
}

function allowedModelsFromEnv(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(required(env, "NEXUS_CORTEX_19_ALLOWED_MODELS_JSON")) as unknown; } catch { throw new Error("NEXUS_CORTEX_19_ALLOWED_MODELS_JSON must contain valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error("CORTEX #19 allowed model map must be a plain object");
  const entries = Object.entries(parsed as Record<string, unknown>); if (entries.length < 1 || entries.length > 64) throw new Error("CORTEX #19 allowed model map size is invalid");
  const result = new Map<string, string>();
  for (const [modelId, digest] of entries) { if (!MODEL_ID.test(modelId) || typeof digest !== "string" || !SHA256.test(digest)) throw new Error("CORTEX #19 allowed model provenance is invalid"); result.set(modelId, digest); }
  return result;
}
function eventEndpoint(env: NodeJS.ProcessEnv): URL {
  const url = new URL(required(env, "NEXUS_CORTEX_19_EVENT_ENDPOINT"));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/v1/events") throw new Error("NEXUS_CORTEX_19_EVENT_ENDPOINT must be the credential-free HTTPS CORTEX #17 /v1/events endpoint");
  return url;
}

export interface Cortex19ProductionRuntime { close(): Promise<void>; }
export function startCortex19ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex19ProductionRuntime {
  if (env.NEXUS_CORTEX_19_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_19_PERSISTENCE_ACK must equal durable-volume; ephemeral coupon/control storage is refused");
  const databasePath = absolutePath(env, "NEXUS_CORTEX_19_DATABASE");
  const signingSecret = secretFile(env, "NEXUS_CORTEX_19_SIGNING_SECRET_FILE"); const apiToken = secretFile(env, "NEXUS_CORTEX_19_API_TOKEN_FILE"); const eventToken = secretFile(env, "NEXUS_CORTEX_19_EVENT_TOKEN_FILE");
  if (new Set([signingSecret, apiToken, eventToken]).size !== 3) throw new Error("CORTEX #19 signing/API/event credentials must be distinct");
  const policy = policyFromEnv(env); const allowedModelDigests = allowedModelsFromEnv(env);
  const control = new SqliteCortex19Control(databasePath); const issuer = new SqliteCouponIssuer(databasePath, signingSecret, () => control.read().mode);
  const outbox = new SqliteCouponOutboxDispatcher(databasePath, eventEndpoint(env), eventToken, integerEnv(env, "NEXUS_CORTEX_19_EVENT_TIMEOUT_MS", 5_000, 100, 30_000));
  const server = startCortex19Server({ issuer, apiToken, policy, allowedModelDigests, port: integerEnv(env, "NEXUS_CORTEX_19_PORT", 8789, 1, 65_535), host: "127.0.0.1", readMode: () => control.read().mode });
  const flushIntervalMs = integerEnv(env, "NEXUS_CORTEX_19_FLUSH_INTERVAL_MS", 5_000, 500, 3_600_000);
  let activeFlush: Promise<void> | null = null; let closed = false;
  const runFlush = () => {
    if (activeFlush || closed) return;
    let current: ReturnType<SqliteCortex19Control["read"]>;
    try { current = control.read(); } catch { return; }
    if (current.mode !== "ACTIVE") return;
    activeFlush = outbox.flush(100, () => { if (control.read().mode !== "ACTIVE") throw new Error("CORTEX #19 killed before outbox acknowledgement"); })
      .then(() => undefined)
      .catch((error) => { console.error(JSON.stringify({ component: "cortex-19-outbox", error: error instanceof Error ? error.name : "UNKNOWN" })); })
      .finally(() => { activeFlush = null; });
  };
  const timer = setInterval(runFlush, flushIntervalMs); timer.unref(); runFlush();

  return {
    async close() {
      if (closed) return; closed = true; clearInterval(timer);
      if (activeFlush) await activeFlush.catch(() => undefined);
      try { await server.close(); } finally { outbox.close(); issuer.close(); control.close(); }
    },
  };
}

async function main(): Promise<void> {
  process.umask(0o077); const runtime = startCortex19ProductionRuntime(); let shuttingDown = false;
  const close = async () => { if (shuttingDown) return; shuttingDown = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => { console.error(JSON.stringify({ component: "cortex-19-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; });
}
