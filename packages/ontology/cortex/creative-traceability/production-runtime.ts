import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteCreativeTraceRegistry } from "./index.js";
import { startCortex16Server } from "./production-server.js";
import { SqliteCortex16Control } from "./runtime-control.js";

const MAX_SECRET_FILE_BYTES = 4096;
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required`);
  return value;
}
function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name); if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`); return value;
}
function secret(env: NodeJS.ProcessEnv, name: string): string {
  const file = absolute(env, name); const stat = statSync(file);
  if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${name} must reference a bounded regular secret file`);
  const value = readFileSync(file, "utf8");
  if (Buffer.byteLength(value) !== stat.size || /[\r\n\0]/u.test(value)) throw new Error(`${name} contains invalid secret material`);
  return value;
}
function port(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXUS_CORTEX_16_PORT ?? "8816"; if (!/^\d+$/u.test(raw)) throw new Error("NEXUS_CORTEX_16_PORT is invalid");
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("NEXUS_CORTEX_16_PORT is invalid"); return value;
}

export interface Cortex16ProductionRuntime { close(): Promise<void>; }
export function startCortex16ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex16ProductionRuntime {
  if (env.NEXUS_CORTEX_16_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_16_PERSISTENCE_ACK must equal durable-volume; ephemeral creative/control storage is refused");
  const databasePath = absolute(env, "NEXUS_CORTEX_16_DATABASE");
  const writeToken = secret(env, "NEXUS_CORTEX_16_WRITE_TOKEN_FILE");
  const readToken = secret(env, "NEXUS_CORTEX_16_READ_TOKEN_FILE");
  const signingSecret = secret(env, "NEXUS_CORTEX_16_SIGNING_SECRET_FILE");
  if (writeToken === readToken || writeToken === signingSecret || readToken === signingSecret) throw new Error("CORTEX #16 credentials and signing secret must be distinct");
  const registry = new SqliteCreativeTraceRegistry(databasePath);
  const control = new SqliteCortex16Control(databasePath);
  let server: ReturnType<typeof startCortex16Server>;
  try { server = startCortex16Server({ registry, writeToken, readToken, signingSecret, port: port(env), host: "127.0.0.1", readMode: () => control.read().mode }); }
  catch (error) { control.close(); registry.close(); throw error; }
  let closed = false;
  return { async close() { if (closed) return; closed = true; try { await server.close(); } finally { control.close(); registry.close(); } } };
}
async function main(): Promise<void> {
  process.umask(0o077); const runtime = startCortex16ProductionRuntime(); let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => { console.error(JSON.stringify({ component: "cortex-16-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; });
}
