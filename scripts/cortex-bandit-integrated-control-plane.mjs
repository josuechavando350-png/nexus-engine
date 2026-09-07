#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import { loadCortexBanditProductionConfig } from "../packages/ontology/dist/cortex/bandit-experimentation/production-runtime.js";
import {
  CortexBanditControlPlaneReconciler,
  HttpCortexBanditControlPlaneSource,
  createExternallyGovernedCortexBanditHttpRuntime,
} from "../packages/ontology/dist/cortex/bandit-experimentation/control-plane-integration.js";

process.umask(0o077);
const MAX_CONTROL_POLICY_BYTES = 1024 * 1024;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required and must not contain control characters`);
  return value;
}

function boundedPort(value) {
  const parsed = Number(value ?? "8787");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PORT must be 1..65535");
  return parsed;
}

function boundedInterval(value) {
  const parsed = Number(value ?? "5000");
  if (!Number.isSafeInteger(parsed) || parsed < 1000 || parsed > 300000) throw new Error("NEXUS_CORTEX_CONTROL_PLANE_SYNC_INTERVAL_MS must be 1000..300000");
  return parsed;
}

function loadControlPolicy(path) {
  if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_CONTROL_PLANE_POLICY must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CONTROL_POLICY_BYTES) throw new Error(`control-plane policy must be a regular file containing 1..${MAX_CONTROL_POLICY_BYTES} bytes`);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error("control-plane policy must contain valid JSON", { cause: error }); }
}

const stateDbPath = required("NEXUS_CORTEX_STATE_DB");
if (stateDbPath === ":memory:" || !isAbsolute(stateDbPath)) throw new Error("NEXUS_CORTEX_STATE_DB must be an absolute path on a durable mounted volume");
if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
const configPath = required("NEXUS_CORTEX_BANDIT_CONFIG");
if (!isAbsolute(configPath)) throw new Error("NEXUS_CORTEX_BANDIT_CONFIG must be an absolute path");
const controlPolicyPath = required("NEXUS_CORTEX_CONTROL_PLANE_POLICY");
const dataPlaneToken = required("NEXUS_CORTEX_DATA_TOKEN");
const externalControlToken = required("NEXUS_CORTEX_EXTERNAL_CONTROL_PLANE_TOKEN");
if (dataPlaneToken === externalControlToken) throw new Error("data-plane and external-control credentials must be distinct");
const externalControlEndpoint = required("NEXUS_CORTEX_EXTERNAL_CONTROL_PLANE_URL");
const syncIntervalMs = boundedInterval(process.env.NEXUS_CORTEX_CONTROL_PLANE_SYNC_INTERVAL_MS);
const host = process.env.NEXUS_CORTEX_HOST?.trim() || "0.0.0.0";
if (!host || /[\r\n\0]/u.test(host)) throw new Error("NEXUS_CORTEX_HOST is invalid");
const port = boundedPort(process.env.PORT);
const config = loadCortexBanditProductionConfig(configPath);
const controlPolicyInput = loadControlPolicy(controlPolicyPath);
const store = new SqliteOntologyTransactionStore(stateDbPath, {
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-ontology-store", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});
const source = new HttpCortexBanditControlPlaneSource({ endpoint: externalControlEndpoint, bearerToken: externalControlToken });
const reconciler = new CortexBanditControlPlaneReconciler(store, config, controlPolicyInput, source);

const initialSync = await reconciler.syncOnce();
process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-external-control-plane", operation: "INITIAL_SYNC", applied: initialSync.appliedCommandIds.length, stale: initialSync.staleCommandIds.length, experiments: initialSync.experimentCount, controlPolicyDigest: reconciler.policy.digest })}\n`);

const runtime = createExternallyGovernedCortexBanditHttpRuntime({
  transactions: store,
  config,
  dataPlaneToken,
  onTelemetry: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", ...event })}\n`),
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});

let syncRunning = false;
const syncTimer = setInterval(() => {
  if (syncRunning) return;
  syncRunning = true;
  void reconciler.syncOnce()
    .then((result) => process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-external-control-plane", operation: "SYNC", status: "OK", applied: result.appliedCommandIds.length, stale: result.staleCommandIds.length, experiments: result.experimentCount, controlPolicyDigest: reconciler.policy.digest })}\n`))
    .catch((error) => process.stderr.write(`${JSON.stringify({ component: "cortex-bandit-external-control-plane", operation: "SYNC", status: "FAILED", code: error && typeof error === "object" && "code" in error ? String(error.code) : "UNEXPECTED" })}\n`))
    .finally(() => { syncRunning = false; });
}, syncIntervalMs);
syncTimer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(syncTimer);
  process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", operation: "SHUTDOWN", signal })}\n`);
  try { await runtime.close(); }
  finally { store.close(); }
}

process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });

runtime.server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", operation: "LISTEN", host, port, experimentCount: config.experiments.length, externalControlPlane: true, localControlRelaxation: false, controlPolicyDigest: reconciler.policy.digest })}\n`);
});
