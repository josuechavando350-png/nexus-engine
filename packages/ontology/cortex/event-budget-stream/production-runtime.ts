import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { startCortex17Server } from "./production-server.js";
import { SqliteCortex17Control } from "./runtime-control.js";

const MAX_SECRET_FILE_BYTES = 4096;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 1) throw new Error(`${name} is required`);
  return value;
}

function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const path = absolute(env, name);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${name} must reference a bounded regular secret file`);
  const value = readFileSync(path, "utf8");
  if (Buffer.byteLength(value, "utf8") !== stat.size || value.length < 32 || value.length > MAX_SECRET_FILE_BYTES || /[\r\n\0]/u.test(value)) throw new Error(`${name} contains an invalid secret`);
  return value;
}

function port(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXUS_CORTEX_17_PORT ?? "8787";
  if (!/^\d+$/u.test(raw)) throw new Error("NEXUS_CORTEX_17_PORT is invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("NEXUS_CORTEX_17_PORT is invalid");
  return value;
}

export interface Cortex17ProductionRuntime { close(): Promise<void>; }

export function startCortex17ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex17ProductionRuntime {
  if (env.NEXUS_CORTEX_17_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_17_PERSISTENCE_ACK must equal durable-volume; ephemeral event/control storage is refused");
  const databasePath = absolute(env, "NEXUS_CORTEX_17_DATABASE");
  const writeToken = secret(env, "NEXUS_CORTEX_17_WRITE_TOKEN_FILE");
  const readToken = secret(env, "NEXUS_CORTEX_17_READ_TOKEN_FILE");
  if (writeToken === readToken) throw new Error("CORTEX #17 read and write credentials must be distinct");
  const control = new SqliteCortex17Control(databasePath);
  let server: ReturnType<typeof startCortex17Server>;
  try {
    server = startCortex17Server({ databasePath, writeToken, readToken, port: port(env), host: "127.0.0.1", readMode: () => control.read().mode });
  } catch (error) { control.close(); throw error; }
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      try { await server.close(); } finally { control.close(); }
    },
  };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const runtime = startCortex17ProductionRuntime();
  let shuttingDown = false;
  const close = async () => { if (shuttingDown) return; shuttingDown = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-17-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}
