#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { createBehavioralSignalPolicy } from "../packages/ontology/dist/cortex/behavioral-signal-tracking/index.js";
import { CortexBehavioralSignalRuntime } from "../packages/ontology/dist/cortex/behavioral-signal-tracking/runtime.js";
import {
  PrivacyIsolationKeyLifecycle,
  PrivacyIsolationSessionService,
  PrivacyRetainingTransactionPort,
} from "../packages/ontology/dist/cortex/behavioral-signal-tracking/privacy-isolation.js";
import {
  loadPrivacyIsolationKeyRing,
  loadPrivacyIsolationPolicy,
} from "../packages/ontology/dist/cortex/behavioral-signal-tracking/privacy-isolation-config.js";
import { createPrivacyIsolationProductionServer } from "../packages/ontology/dist/cortex/behavioral-signal-tracking/privacy-isolation-production-server.js";

process.umask(0o077);
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_CONFIG_BYTES = 1024 * 1024;

function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function exactObject(value, allowed, field) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${field} must be a plain object`); for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${field} contains unknown field ${key}`); return value; }
function id(value, field) { if (typeof value !== "string" || !IDENTIFIER.test(value.trim())) throw new Error(`${field} is malformed`); return value.trim(); }
function loadConfig(path) {
  if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_BEHAVIORAL_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CONFIG_BYTES) throw new Error(`behavioral config must be a regular file <= ${MAX_CONFIG_BYTES} bytes`);
  const parsed = exactObject(JSON.parse(readFileSync(path, "utf8")), ["version", "scope", "initialPolicy", "allowedOrigins"], "behavioral config");
  if (parsed.version !== 1) throw new Error("behavioral config version must be 1");
  const scopeRaw = exactObject(parsed.scope, ["tenantId", "organizationId", "brandId"], "scope");
  const scope = Object.freeze({ tenantId: id(scopeRaw.tenantId, "scope.tenantId"), organizationId: id(scopeRaw.organizationId, "scope.organizationId"), ...(scopeRaw.brandId === undefined ? {} : { brandId: id(scopeRaw.brandId, "scope.brandId") }) });
  if (!Array.isArray(parsed.allowedOrigins) || parsed.allowedOrigins.length < 1 || parsed.allowedOrigins.length > 64) throw new Error("allowedOrigins must contain 1..64 origins");
  const allowedOrigins = Object.freeze(parsed.allowedOrigins.map((entry) => { if (typeof entry !== "string") throw new Error("allowedOrigins entries must be strings"); const url = new URL(entry); if (url.protocol !== "https:" || url.origin !== entry) throw new Error(`allowed origin must be canonical HTTPS: ${entry}`); return entry; }));
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new Error("allowedOrigins must be unique");
  return Object.freeze({ scope, initialPolicy: createBehavioralSignalPolicy(parsed.initialPolicy), allowedOrigins });
}
function port(value) { const parsed = Number(value ?? "8789"); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PORT must be 1..65535"); return parsed; }
function boundedSecret(value, name) { const bytes = Buffer.byteLength(value, "utf8"); if (bytes < 32 || bytes > 4096) throw new Error(`${name} must contain 32..4096 bytes`); return value; }
function log(stream, value) { stream.write(`${JSON.stringify(value)}\n`); }

const stateDbPath = required("NEXUS_CORTEX_STATE_DB");
if (stateDbPath === ":memory:" || !isAbsolute(stateDbPath)) throw new Error("NEXUS_CORTEX_STATE_DB must be an absolute path on a durable mounted volume");
if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const config = loadConfig(required("NEXUS_CORTEX_BEHAVIORAL_CONFIG"));
const privacyPolicy = loadPrivacyIsolationPolicy(required("NEXUS_CORTEX_BEHAVIORAL_PRIVACY_ISOLATION_CONFIG"));
const keyRing = loadPrivacyIsolationKeyRing(required("NEXUS_CORTEX_BEHAVIORAL_PRIVACY_KEYRING"));
const trackerKey = boundedSecret(required("NEXUS_BEHAVIORAL_PSEUDONYMIZATION_KEY"), "NEXUS_BEHAVIORAL_PSEUDONYMIZATION_KEY");
const ingestToken = boundedSecret(required("NEXUS_CORTEX_INGEST_TOKEN"), "NEXUS_CORTEX_INGEST_TOKEN");
const controlToken = boundedSecret(required("NEXUS_CORTEX_CONTROL_TOKEN"), "NEXUS_CORTEX_CONTROL_TOKEN");
const roleSecrets = [trackerKey, ingestToken, controlToken, ...keyRing.keys.map((entry) => entry.key)];
if (new Set(roleSecrets).size !== roleSecrets.length) throw new Error("tracker, ingest, control and privacy keyring secrets must all be distinct");

const rawStore = new SqliteOntologyTransactionStore(stateDbPath, { onTelemetryError: (error) => log(process.stderr, { component: "cortex-behavioral-private-store", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" }) });
const keyLifecycle = new PrivacyIsolationKeyLifecycle(rawStore, config.scope, privacyPolicy, keyRing);
const retainingStore = new PrivacyRetainingTransactionPort(rawStore, config.scope, privacyPolicy);
const runtime = new CortexBehavioralSignalRuntime(retainingStore, config.scope, config.initialPolicy, { pseudonymizationKey: trackerKey }, Date.now, {
  onTelemetry: (event) => log(process.stdout, { component: "cortex-behavioral-private", ...event }),
  onTelemetryError: (error) => log(process.stderr, { component: "cortex-behavioral-private", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" }),
});
const sessions = new PrivacyIsolationSessionService({ keyLifecycle });
const production = createPrivacyIsolationProductionServer({
  runtime,
  sessions,
  keyLifecycle,
  retention: retainingStore,
  allowedOrigins: config.allowedOrigins,
  ingestToken,
  controlToken,
  onOperationalEvent: (event) => log(process.stdout, { component: "cortex-behavioral-private-http", ...event }),
});

const startupSweep = retainingStore.sweepAll();
log(process.stdout, { component: "cortex-behavioral-private-retention", operation: "STARTUP_SWEEP", ...startupSweep });
const retentionTimer = setInterval(() => {
  try {
    const result = retainingStore.sweepAll();
    log(process.stdout, { component: "cortex-behavioral-private-retention", operation: "PERIODIC_SWEEP", ...result });
  } catch (error) {
    log(process.stderr, { component: "cortex-behavioral-private-retention", level: "error", operation: "PERIODIC_SWEEP", code: "RETENTION_SWEEP_FAILURE", message: error instanceof Error ? error.message : "unknown" });
  }
}, privacyPolicy.retentionSweepIntervalMs);
retentionTimer.unref();

const host = process.env.NEXUS_CORTEX_HOST?.trim() || "0.0.0.0";
const listenPort = port(process.env.PORT);
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(retentionTimer);
  log(process.stdout, { component: "cortex-behavioral-private", operation: "SHUTDOWN", signal });
  try { await production.close(); } finally { rawStore.close(); }
}
process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });
production.server.listen(listenPort, host, () => {
  const keys = keyLifecycle.controlState();
  log(process.stdout, { component: "cortex-behavioral-private", operation: "LISTEN", host, port: listenPort, allowedOrigins: config.allowedOrigins.length, privacyIsolation: true, retentionMs: privacyPolicy.aggregateRetentionMs, privacyKeyGeneration: keys.generation, activePrivacyKeyId: keys.activeKeyId });
});
