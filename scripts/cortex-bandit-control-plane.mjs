#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { SqliteOntologyTransactionStore } from "../packages/ontology/dist/cortex/sqlite-transaction-store.js";
import {
  createCortexBanditHttpRuntime,
  loadCortexBanditProductionConfig,
} from "../packages/ontology/dist/cortex/bandit-experimentation/production-runtime.js";

process.umask(0o077);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedPort(value) {
  const parsed = Number(value ?? "8787");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("PORT must be 1..65535");
  return parsed;
}

const stateDbPath = required("NEXUS_CORTEX_STATE_DB");
if (stateDbPath === ":memory:" || !isAbsolute(stateDbPath)) {
  throw new Error("NEXUS_CORTEX_STATE_DB must be an absolute path on a durable mounted volume");
}
if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") {
  throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
}
const configPath = required("NEXUS_CORTEX_BANDIT_CONFIG");
if (!isAbsolute(configPath)) throw new Error("NEXUS_CORTEX_BANDIT_CONFIG must be an absolute path");
const dataPlaneToken = required("NEXUS_CORTEX_DATA_TOKEN");
const controlPlaneToken = required("NEXUS_CORTEX_CONTROL_TOKEN");
const host = process.env.NEXUS_CORTEX_HOST?.trim() || "0.0.0.0";
const port = boundedPort(process.env.PORT);
const config = loadCortexBanditProductionConfig(configPath);
const store = new SqliteOntologyTransactionStore(stateDbPath, {
  onTelemetryError: (error) => {
    process.stderr.write(`${JSON.stringify({ component: "cortex-ontology-store", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`);
  },
});
const runtime = createCortexBanditHttpRuntime({
  transactions: store,
  config,
  dataPlaneToken,
  controlPlaneToken,
  onTelemetry: (event) => process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", ...event })}\n`),
  onTelemetryError: (error) => process.stderr.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", level: "error", code: "TELEMETRY_SINK_FAILURE", message: error instanceof Error ? error.message : "unknown" })}\n`),
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", operation: "SHUTDOWN", signal })}\n`);
  try {
    await runtime.close();
  } finally {
    store.close();
  }
}

process.once("SIGINT", () => { void shutdown("SIGINT").finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown("SIGTERM").finally(() => process.exit(0)); });

runtime.server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ component: "cortex-bandit-control-plane", operation: "LISTEN", host, port, experimentCount: config.experiments.length })}\n`);
});
