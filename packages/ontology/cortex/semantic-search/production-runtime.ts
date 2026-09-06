import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenAICompatibleEmbeddingProvider, SqliteSemanticSearchIndex } from "./index.js";
import { startCortex15Server } from "./production-server.js";
import { SqliteCortex15Control } from "./runtime-control.js";

const MAX_SECRET_FILE_BYTES = 8_192;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < 1 || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required`);
  return value;
}

function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const file = absolute(env, name);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${name} must reference a bounded regular file`);
  const value = readFileSync(file, "utf8");
  if (Buffer.byteLength(value, "utf8") !== stat.size || /[\r\n\0]/u.test(value)) throw new Error(`${name} contains invalid secret material`);
  return value;
}

function port(env: NodeJS.ProcessEnv): number {
  const raw = env.NEXUS_CORTEX_15_PORT ?? "8815";
  if (!/^\d+$/u.test(raw)) throw new Error("NEXUS_CORTEX_15_PORT is invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("NEXUS_CORTEX_15_PORT is invalid");
  return value;
}

export interface Cortex15ProductionRuntime { close(): Promise<void>; }

export function startCortex15ProductionRuntime(env: NodeJS.ProcessEnv = process.env): Cortex15ProductionRuntime {
  if (env.NEXUS_CORTEX_15_PERSISTENCE_ACK !== "durable-volume") throw new Error("NEXUS_CORTEX_15_PERSISTENCE_ACK must equal durable-volume; ephemeral search/control storage is refused");
  const databasePath = absolute(env, "NEXUS_CORTEX_15_DATABASE");
  const writeToken = secret(env, "NEXUS_CORTEX_15_WRITE_TOKEN_FILE");
  const readToken = secret(env, "NEXUS_CORTEX_15_READ_TOKEN_FILE");
  if (writeToken === readToken) throw new Error("CORTEX #15 read and write credentials must be distinct");
  const endpoint = new URL(required(env, "NEXUS_CORTEX_15_EMBEDDING_ENDPOINT"));
  const modelId = required(env, "NEXUS_CORTEX_15_EMBEDDING_MODEL_ID");
  const embeddingToken = secret(env, "NEXUS_CORTEX_15_EMBEDDING_TOKEN_FILE");
  const provider = new OpenAICompatibleEmbeddingProvider(endpoint, modelId, embeddingToken);
  const index = new SqliteSemanticSearchIndex(databasePath, provider);
  const control = new SqliteCortex15Control(databasePath);
  let server: ReturnType<typeof startCortex15Server>;
  try {
    server = startCortex15Server({ index, writeToken, readToken, port: port(env), host: "127.0.0.1", readMode: () => control.read().mode });
  } catch (error) { control.close(); index.close(); throw error; }
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      try { await server.close(); } finally { control.close(); index.close(); }
    },
  };
}

async function main(): Promise<void> {
  process.umask(0o077);
  const runtime = startCortex15ProductionRuntime();
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await runtime.close(); };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(JSON.stringify({ component: "cortex-15-production-runtime", error: error instanceof Error ? error.message : "UNKNOWN" }));
    process.exitCode = 1;
  });
}
