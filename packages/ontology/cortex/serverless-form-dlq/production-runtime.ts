import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Cortex20Error, HttpDurableEventWriter, ServerlessFormIngress, type DurableEventWriter } from "./index.js";
import { startCortex20Server } from "./production-server.js";
import { SqliteCortex20Control } from "./runtime-control.js";

const MAX_SECRET_FILE_BYTES = 8_192;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]; if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required`); return value;
}
function absolute(value: string, label: string): string { if (!isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be an absolute path`); return value; }
function secretFile(path: string, label: string): string {
  absolute(path, label); const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${label} must reference a bounded regular secret file`);
  const value = readFileSync(path, "utf8"); if (Buffer.byteLength(value) !== stat.size || !value || /[\r\n\0]/u.test(value)) throw new Error(`${label} contains invalid secret material`); return value;
}
function port(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXUS_CORTEX_20_PORT ?? "8820"; if (!/^\d+$/u.test(raw)) throw new Error("NEXUS_CORTEX_20_PORT is invalid");
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("NEXUS_CORTEX_20_PORT is invalid"); return value;
}

export interface Cortex20ProductionRuntime { close(): Promise<void>; }
export function startCortex20ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex20ProductionRuntime {
  if (env.NEXUS_CORTEX_20_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_20_PERSISTENCE_ACK must equal durable-volume; ephemeral control/retry storage is refused");
  const databasePath = absolute(required(env, "NEXUS_CORTEX_20_DATABASE"), "NEXUS_CORTEX_20_DATABASE");
  const ingestToken = secretFile(required(env, "NEXUS_CORTEX_20_INGEST_TOKEN_FILE"), "NEXUS_CORTEX_20_INGEST_TOKEN_FILE");
  const queueToken = secretFile(required(env, "NEXUS_CORTEX_20_QUEUE_TOKEN_FILE"), "NEXUS_CORTEX_20_QUEUE_TOKEN_FILE");
  if (ingestToken === queueToken) throw new Error("CORTEX #20 ingress and queue credentials must be distinct");
  const encryptionKey = secretFile(required(env, "NEXUS_CORTEX_20_ENCRYPTION_KEY_FILE"), "NEXUS_CORTEX_20_ENCRYPTION_KEY_FILE");
  const keyId = required(env, "NEXUS_CORTEX_20_ENCRYPTION_KEY_ID"); if (!KEY_ID.test(keyId)) throw new Error("NEXUS_CORTEX_20_ENCRYPTION_KEY_ID is invalid");
  const queueEndpoint = new URL(required(env, "NEXUS_CORTEX_20_QUEUE_ENDPOINT"));
  const control = new SqliteCortex20Control(databasePath);
  const queue = new HttpDurableEventWriter(queueEndpoint, queueToken);
  const guardedQueue: DurableEventWriter = {
    async append(event) {
      if (control.read().mode !== "ACTIVE") throw new Cortex20Error("QUEUE_FAILURE", "durable append disabled by CORTEX #20 control");
      return queue.append(event);
    },
  };
  const ingress = new ServerlessFormIngress(guardedQueue, encryptionKey, keyId);
  let server: ReturnType<typeof startCortex20Server>;
  try { server = startCortex20Server({ ingress, ingestToken, port: port(env), host: "127.0.0.1", readMode: () => control.read().mode }); }
  catch (error) { control.close(); throw error; }
  let closed = false;
  return { async close() { if (closed) return; closed = true; try { await server.close(); } finally { control.close(); } } };
}
async function main(): Promise<void> {
  process.umask(0o077); const runtime = startCortex20ProductionRuntime(); let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => { console.error(JSON.stringify({ component: "cortex-20-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" })); process.exitCode = 1; });
}
