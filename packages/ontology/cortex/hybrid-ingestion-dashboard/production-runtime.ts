import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpIncrementalMetricSource, HybridFinancialMetricStore, type ExternalMetricSource } from "./index.js";
import { startCortex18Server } from "./production-server.js";
import { SqliteCortex18Control } from "./runtime-control.js";

const MAX_SECRET_FILE_BYTES = 8_192;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,191}$/u;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]; if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required`); return value;
}
function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be an absolute path`); return value;
}
function secretFile(path: string, label: string): string {
  absolute(path, label); const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${label} must reference a bounded regular secret file`);
  const value = readFileSync(path, "utf8");
  if (Buffer.byteLength(value) !== stat.size || !value || /[\r\n\0]/u.test(value)) throw new Error(`${label} contains invalid secret material`);
  return value;
}
function port(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXUS_CORTEX_18_PORT ?? "8818"; if (!/^\d+$/u.test(raw)) throw new Error("NEXUS_CORTEX_18_PORT is invalid");
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("NEXUS_CORTEX_18_PORT is invalid"); return value;
}

interface SourceConfig { readonly sourceId: string; readonly endpoint: string; readonly tokenFile: string; readonly timeoutMs?: number; }
function sources(env: NodeJS.ProcessEnv): Map<string, ExternalMetricSource> {
  let raw: unknown;
  try { raw = JSON.parse(required(env, "NEXUS_CORTEX_18_SOURCES_JSON")) as unknown; } catch { throw new Error("NEXUS_CORTEX_18_SOURCES_JSON must be valid JSON"); }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) throw new Error("NEXUS_CORTEX_18_SOURCES_JSON must contain 1-32 source configurations");
  const result = new Map<string, ExternalMetricSource>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw new Error("CORTEX #18 source configuration must be a plain object");
    const entry = item as Record<string, unknown>;
    const keys = Object.keys(entry).sort().join(",");
    if (!(keys === "endpoint,sourceId,tokenFile" || keys === "endpoint,sourceId,timeoutMs,tokenFile")) throw new Error("CORTEX #18 source configuration has unsupported fields");
    if (typeof entry.sourceId !== "string" || !SOURCE_ID.test(entry.sourceId) || result.has(entry.sourceId) || typeof entry.endpoint !== "string" || typeof entry.tokenFile !== "string") throw new Error("CORTEX #18 source identity is invalid or duplicated");
    const timeoutMs = entry.timeoutMs === undefined ? 10_000 : Number(entry.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("CORTEX #18 source timeout is invalid");
    const sourceConfig: SourceConfig = { sourceId: entry.sourceId, endpoint: entry.endpoint, tokenFile: entry.tokenFile, timeoutMs };
    result.set(sourceConfig.sourceId, new HttpIncrementalMetricSource(sourceConfig.sourceId, new URL(sourceConfig.endpoint), secretFile(sourceConfig.tokenFile, `CORTEX #18 token file for ${sourceConfig.sourceId}`), sourceConfig.timeoutMs));
  }
  return result;
}

export interface Cortex18ProductionRuntime { close(): Promise<void>; }
export function startCortex18ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex18ProductionRuntime {
  if (env.NEXUS_CORTEX_18_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_18_PERSISTENCE_ACK must equal durable-volume; ephemeral metric/control storage is refused");
  const databasePath = absolute(required(env, "NEXUS_CORTEX_18_DATABASE"), "NEXUS_CORTEX_18_DATABASE");
  const writeToken = secretFile(required(env, "NEXUS_CORTEX_18_WRITE_TOKEN_FILE"), "NEXUS_CORTEX_18_WRITE_TOKEN_FILE");
  const readToken = secretFile(required(env, "NEXUS_CORTEX_18_READ_TOKEN_FILE"), "NEXUS_CORTEX_18_READ_TOKEN_FILE");
  if (writeToken === readToken) throw new Error("CORTEX #18 read and write credentials must be distinct");
  const configuredSources = sources(env);
  const store = new HybridFinancialMetricStore(databasePath);
  const control = new SqliteCortex18Control(databasePath);
  let server: ReturnType<typeof startCortex18Server>;
  try { server = startCortex18Server({ store, sources: configuredSources, writeToken, readToken, port: port(env), host: "127.0.0.1", readMode: () => control.read().mode }); }
  catch (error) { control.close(); store.close(); throw error; }
  let closed = false;
  return { async close() { if (closed) return; closed = true; try { await server.close(); } finally { control.close(); store.close(); } } };
}
async function main(): Promise<void> {
  process.umask(0o077); const runtime = startCortex18ProductionRuntime(); let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => { console.error(JSON.stringify({ component: "cortex-18-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; });
}
