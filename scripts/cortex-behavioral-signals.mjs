#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { createBehavioralSignalPolicy } from "../packages/ontology/dist/cortex/behavioral-signal-tracking/index.js";
import { CortexBehavioralSignalRuntime } from "../packages/ontology/dist/cortex/behavioral-signal-tracking/runtime.js";
import { createBehavioralProductionServer } from "../packages/ontology/dist/cortex/behavioral-signal-tracking/production-server.js";

process.umask(0o077);
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const MAX_CONFIG_BYTES = 1024 * 1024;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function exactObject(value, allowed, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${field} contains unknown field ${key}`);
  return value;
}
function id(value, field) {
  if (typeof value !== "string" || !IDENTIFIER.test(value.trim())) throw new Error(`${field} is malformed`);
  return value.trim();
}
function loadConfig(path) {
  if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_BEHAVIORAL_CONFIG must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CONFIG_BYTES) throw new Error(`behavioral config must be a regular file <= ${MAX_CONFIG_BYTES} bytes`);
  const parsed = exactObject(JSON.parse(readFileSync(path, "utf8")), ["version", "scope", "initialPolicy", "allowedOrigins"], "behavioral config");
  if (parsed.version !== 1) throw new Error("behavioral config version must be 1");
  const scopeRaw = exactObject(parsed.scope, ["tenantId", "organizationId", "brandId"], "scope");
  const scope = Object.freeze({
    tenantId: id(scopeRaw.tenantId, "scope.tenantId"),
    organizationId: id(scopeRaw.organizationId, "scope.organizationId"),
    ...(scopeRaw.brandId === undefined ? {} : { brandId: id(scopeRaw.brandId, "scope.brandId") }),
  });
  if (!Array.isArray(parsed.allowedOrigins) || parsed.allowedOrigins.length < 1 || parsed.allowedOrigins.length > 64) throw new Error("allowedOrigins must contain 1..64 origins");
  const allowedOrigins = Object.freeze(parsed.allowedOrigins.map((entry) => {
    if (typeof entry !== "string") throw new Error("allowedOrigins entries must be strings");
    const url = new URL(entry);
    if (!/^https?:$/u.test(url.protocol) || url.origin !== entry) throw new Error(`allowed origin must be canonical: ${entry}`);
    return entry;
  }));
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new Error("allowedOrigins must be unique");
  const initialPolicy = createBehavioralSignalPolicy(parsed.initialPolicy);
  return Object.freeze({ scope, initialPolicy, allowedOrigins });
}
function port(value) {
  const parsed = Number(value ?? "8789");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PORT must be 1..65535");
  return parsed;
}

const stateDbPath = required("NEXUS_CORTEX_STATE_DB");
if (stateDbPath === ":memory:" || !isAbsolute(stateDbPath)) throw new Error("NEXUS_CORTEX_STATE_DB must be an absolute path on a durable mounted volume");
if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const config = loadConfig(required("NEXUS_CORTEX_BEHAVIORAL_CONFIG"));
const privacyKey = required("NEXUS_BEHAVIORAL_PSEUDONYMIZATION_KEY");
if (Buffer.byteLength(privacyKey, "utf8") < 32 || Buffer.byteLength(privacyKey, "utf8") > 4096) throw new Error("NEXUS_BEHAVIORAL_PSEUDONYMIZATION_KEY must contain 32..4096 bytes");
const ingestToken = required("NEXUS_CORTEX_INGEST_TOKEN");
const controlToken = required("NEXUS_CORTEX_CONTROL_TOKEN");
const store = new SqliteOntologyTransactionStore(stateDbPath, {
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-behavioral-store", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});
const runtime = new CortexBehavioralSignalRuntime(
  store,
  config.scope,
  config.initialPolicy,
  { pseudonymizationKey: privacyKey },
  Date.now,
  {
    onTelemetry: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-behavioral-signals", ...event })}\n`),
    onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-behavioral-signals", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
  },
);
const production = createBehavioralProductionServer({
  runtime,
  allowedOrigins: config.allowedOrigins,
  ingestToken,
  controlToken,
  onOperationalEvent: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-behavioral-http", ...event })}\n`),
});

const host = process.env.NEXUS_CORTEX_HOST?.trim() || "0.0.0.0";
const listenPort = port(process.env.PORT);
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ component: "cortex-behavioral-signals", operation: "SHUTDOWN", signal })}\n`);
  try { await production.close(); } finally { store.close(); }
}
process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });
production.server.listen(listenPort, host, () => {
  process.stdout.write(`${JSON.stringify({ component: "cortex-behavioral-signals", operation: "LISTEN", host, port: listenPort, allowedOrigins: config.allowedOrigins.length })}\n`);
});
