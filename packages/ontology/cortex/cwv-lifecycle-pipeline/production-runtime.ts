import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCwvBuildCertification, SqliteCwvPipelineAuditStore } from "./index";
import { CwvPipelineAuditServer } from "./production-server";

function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function integer(name: string, fallback: number, min: number, max: number): number { const raw = process.env[name]?.trim(); if (!raw) return fallback; if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`); const value = Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`); return value; }
function certification(path: string) {
  if (!isAbsolute(path)) throw new Error("NEXUS_CORTEX_33_BUILD_CERTIFICATION must be an absolute path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > 256 * 1024) throw new Error("CORTEX #33 build certification must be a bounded regular file");
  return parseCwvBuildCertification(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export interface CwvPipelineAuditRuntime {
  readonly store: SqliteCwvPipelineAuditStore;
  readonly server: CwvPipelineAuditServer;
  start(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export function createCwvPipelineAuditRuntimeFromEnv(): CwvPipelineAuditRuntime {
  if (process.env.NEXUS_CORTEX_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_PERSISTENCE_ACK must equal durable-volume; ephemeral filesystems are refused");
  const databasePath = required("NEXUS_CORTEX_33_DATABASE");
  if (databasePath === ":memory:" || !isAbsolute(databasePath)) throw new Error("NEXUS_CORTEX_33_DATABASE must be an absolute path on a durable mounted volume");
  const cert = certification(required("NEXUS_CORTEX_33_BUILD_CERTIFICATION"));
  const ingestToken = required("NEXUS_CORTEX_33_INGEST_TOKEN");
  const controlToken = required("NEXUS_CORTEX_33_CONTROL_TOKEN");
  if (ingestToken === controlToken) throw new Error("CORTEX #33 ingest/control credentials must be distinct");
  const store = new SqliteCwvPipelineAuditStore(databasePath, cert, Date.now, integer("NEXUS_CORTEX_33_MAX_EVIDENCE_AGE_MS", 300_000, 1_000, 86_400_000));
  const server = new CwvPipelineAuditServer({ store, ingestToken, controlToken, host: process.env.NEXUS_CORTEX_33_HOST?.trim() || "127.0.0.1", port: integer("NEXUS_CORTEX_33_PORT", 8083, 1, 65_535) });
  let closed = false;
  return Object.freeze({ store, server, start: () => server.start(), close: async () => { if (closed) return; closed = true; await server.close(); store.close(); } });
}

export async function runCwvPipelineAuditRuntimeFromEnv(): Promise<void> {
  const runtime = createCwvPipelineAuditRuntimeFromEnv(); await runtime.start(); let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); }); process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
}
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) runCwvPipelineAuditRuntimeFromEnv().catch((error) => { console.error(JSON.stringify({ component: "cortex-33-audit-runtime", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; });
