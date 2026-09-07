import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityGatedGeoExperimentRegistry, SqliteGeoCapabilityGateStore } from "./capability-gate";
import { CapabilityGeoHoldoutProductionServer } from "./capability-production-server";
import { SqliteGeoExperimentRegistry } from "./registry";
import { SqliteGeoHoldoutControl } from "./runtime-control";

const MAX_SECRET_FILE_BYTES = 16 * 1024;
function requiredEnv(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integerEnv(name: string, fallback: number, min: number, max: number): number { const raw = process.env[name]?.trim(); if (!raw) return fallback; if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`); const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`); return value; }
function readSecretFile(path: string, label: string): string { if (!isAbsolute(path)) throw new Error(`${label} must be absolute`); const stat = statSync(path); if (!stat.isFile() || stat.size < 24 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${label} must be a bounded regular file`); const value = readFileSync(path, "utf8").trim(); if (value.length < 24 || value.length > 4096 || /[\r\n]/u.test(value)) throw new Error(`${label} contains invalid secret`); return value; }

export interface CapabilityGeoHoldoutProductionRuntime {
  readonly control: SqliteGeoHoldoutControl;
  readonly gates: SqliteGeoCapabilityGateStore;
  readonly registry: CapabilityGatedGeoExperimentRegistry;
  readonly server: CapabilityGeoHoldoutProductionServer;
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createCapabilityGeoHoldoutProductionRuntimeFromEnv(): CapabilityGeoHoldoutProductionRuntime {
  if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
  const databasePath = requiredEnv("NEXUS_CORTEX_12_DATABASE");
  if (databasePath === ":memory:" || !isAbsolute(databasePath)) throw new Error("NEXUS_CORTEX_12_DATABASE must be an absolute path on a durable mounted volume");
  const experimentTokenFile = requiredEnv("NEXUS_CORTEX_12_EXPERIMENT_TOKEN_FILE");
  const controlTokenFile = requiredEnv("NEXUS_CORTEX_12_CONTROL_TOKEN_FILE");
  if (resolve(experimentTokenFile) === resolve(controlTokenFile)) throw new Error("experiment and control credentials must use distinct files");
  const experimentToken = readSecretFile(experimentTokenFile, "NEXUS_CORTEX_12_EXPERIMENT_TOKEN_FILE");
  const controlToken = readSecretFile(controlTokenFile, "NEXUS_CORTEX_12_CONTROL_TOKEN_FILE");
  if (experimentToken === controlToken) throw new Error("experiment and control credentials must be distinct");
  const control = new SqliteGeoHoldoutControl(databasePath);
  const base = new SqliteGeoExperimentRegistry(databasePath, Date.now, () => control.read().mode === "ACTIVE");
  const gates = new SqliteGeoCapabilityGateStore(databasePath);
  const registry = new CapabilityGatedGeoExperimentRegistry(base, gates);
  const server = new CapabilityGeoHoldoutProductionServer({ registry, control, experimentToken, controlToken, host: process.env.NEXUS_CORTEX_12_HOST?.trim() || "127.0.0.1", port: integerEnv("NEXUS_CORTEX_12_PORT", 8082, 1, 65_535) });
  let closed = false;
  return Object.freeze({ control, gates, registry, server, start: () => server.start(), close: async () => { if (closed) return; closed = true; await server.close(); gates.close(); base.close(); control.close(); } });
}

export async function runCapabilityGeoHoldoutProductionRuntimeFromEnv(): Promise<void> {
  const runtime = createCapabilityGeoHoldoutProductionRuntimeFromEnv(); await runtime.start(); let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); }); process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
}
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) runCapabilityGeoHoldoutProductionRuntimeFromEnv().catch((error) => { console.error(JSON.stringify({ component: "cortex-32-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; });
