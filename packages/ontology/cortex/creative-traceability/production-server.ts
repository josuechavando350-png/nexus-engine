import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { Cortex16Error, SqliteCreativeTraceRegistry, signCreativeTrace } from "./index.js";
import type { Cortex16Mode } from "./runtime-control.js";

const MAX_BODY_BYTES = 1_048_576;
const REQUEST_TARGET = /^\/[\x21-\x7e]*$/u;

export interface Cortex16ServerConfig {
  readonly registry: SqliteCreativeTraceRegistry;
  readonly writeToken: string;
  readonly readToken: string;
  readonly signingSecret: string;
  readonly port: number;
  readonly host?: "127.0.0.1";
  readonly readMode: () => Cortex16Mode;
}

class ControlTransition extends Error {}

function token(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function authorized(request: IncomingMessage, expected: string): boolean { const header = request.headers.authorization; return typeof header === "string" && header.startsWith("Bearer ") && equal(header.slice(7), expected); }
function mode(readMode: () => Cortex16Mode): Cortex16Mode { try { const value = readMode(); return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED"; } catch { return "KILLED"; } }

function target(request: IncomingMessage): URL {
  const raw = request.url ?? "/";
  if (!REQUEST_TARGET.test(raw) || raw.includes("#")) throw new Cortex16Error("INVALID_INPUT", "request target must use bounded origin-form syntax");
  return new URL(raw, "http://127.0.0.1");
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex16Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex16Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); total += bytes.length;
    if (total > MAX_BODY_BYTES) { request.destroy(); throw new Cortex16Error("INVALID_INPUT", "request body is too large"); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Cortex16Error("INVALID_INPUT", "request body must contain valid JSON"); }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(encoded);
}

function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof ControlTransition) return send(response, 503, { error: "KILLED" });
  if (error instanceof Cortex16Error) {
    const status = error.code === "CONFLICT" ? 409 : error.code === "INVALID_SIGNATURE" ? 403 : error.code === "INTEGRITY_FAILURE" ? 500 : 400;
    return send(response, status, { error: error.code });
  }
  console.error(JSON.stringify({ component: "cortex-16-server", error: "INTERNAL" }));
  send(response, 500, { error: "INTERNAL" });
}

export function startCortex16Server(config: Cortex16ServerConfig): { close(): Promise<void> } {
  const writeToken = token(config.writeToken, "CORTEX #16 write token"); const readToken = token(config.readToken, "CORTEX #16 read token");
  token(config.signingSecret, "CORTEX #16 signing secret");
  if (equal(writeToken, readToken)) throw new Error("CORTEX #16 read and write credentials must be distinct");
  if (!config.registry || typeof config.readMode !== "function" || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535 || (config.host !== undefined && config.host !== "127.0.0.1")) throw new Error("CORTEX #16 server configuration is invalid");

  const server = createServer(async (request, response) => {
    try {
      const url = target(request);
      if (request.method === "GET" && url.pathname === "/healthz") { const current = mode(config.readMode); return send(response, current === "KILLED" ? 503 : 200, { mode: current }); }

      if (request.method === "POST" && url.pathname === "/v1/creatives/register") {
        if (!authorized(request, writeToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (mode(config.readMode) !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const record = config.registry.register(await body(request), () => { if (mode(config.readMode) !== "ACTIVE") throw new ControlTransition(); });
        const signedTrace = signCreativeTrace(record, config.signingSecret);
        console.info(JSON.stringify({ component: "cortex-16-traceability", operation: "REGISTER", assetCount: record.assetDigests.length, deploymentCount: record.deploymentKeys.length }));
        return send(response, 201, { record, signedTrace });
      }

      if (request.method === "POST" && url.pathname === "/v1/aggregates/resolve") {
        if (!authorized(request, readToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        const current = mode(config.readMode); if (current === "KILLED") return send(response, 503, { error: "KILLED" });
        const result = config.registry.resolveAggregate(await body(request));
        console.info(JSON.stringify({ component: "cortex-16-traceability", operation: "RESOLVE", mode: current, resolution: result.resolution, creativeCount: result.creativeIds.length }));
        return send(response, 200, { mode: current, result });
      }

      return send(response, 404, { error: "NOT_FOUND" });
    } catch (error) { fail(response, error); }
  });
  server.listen(config.port, config.host ?? "127.0.0.1");
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
