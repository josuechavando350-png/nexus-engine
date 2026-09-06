import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { Cortex15Error, SqliteSemanticSearchIndex, type SemanticSearchOptions } from "./index.js";
import type { Cortex15Mode } from "./runtime-control.js";

const MAX_BODY_BYTES = 1_048_576;
const REQUEST_TARGET = /^\/[\x21-\x7e]*$/u;

export interface Cortex15ServerConfig {
  readonly index: SqliteSemanticSearchIndex;
  readonly writeToken: string;
  readonly readToken: string;
  readonly port: number;
  readonly host?: "127.0.0.1";
  readonly readMode: () => Cortex15Mode;
}

class ControlTransition extends Error {}

function token(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function authorized(request: IncomingMessage, expected: string): boolean { const value = request.headers.authorization; return typeof value === "string" && value.startsWith("Bearer ") && equal(value.slice(7), expected); }
function mode(readMode: () => Cortex15Mode): Cortex15Mode { try { const value = readMode(); return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED"; } catch { return "KILLED"; } }

function target(request: IncomingMessage): URL {
  const raw = request.url ?? "/";
  if (!REQUEST_TARGET.test(raw) || raw.includes("#")) throw new Cortex15Error("INVALID_INPUT", "request target must use bounded origin-form syntax");
  return new URL(raw, "http://127.0.0.1");
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex15Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex15Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); total += bytes.length;
    if (total > MAX_BODY_BYTES) { request.destroy(); throw new Cortex15Error("INVALID_INPUT", "request body is too large"); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Cortex15Error("INVALID_INPUT", "request body must contain valid JSON"); }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(encoded);
}

function error(response: ServerResponse, value: unknown): void {
  if (value instanceof ControlTransition) return send(response, 503, { error: "KILLED" });
  if (value instanceof Cortex15Error) {
    const status = value.code === "PROVIDER_ERROR" ? 502 : value.code === "INTEGRITY_FAILURE" ? 500 : 400;
    return send(response, status, { error: value.code });
  }
  console.error(JSON.stringify({ component: "cortex-15-server", error: "INTERNAL" }));
  send(response, 500, { error: "INTERNAL" });
}

export function startCortex15Server(config: Cortex15ServerConfig): { close(): Promise<void> } {
  const writeToken = token(config.writeToken, "CORTEX #15 write token"); const readToken = token(config.readToken, "CORTEX #15 read token");
  if (equal(writeToken, readToken)) throw new Error("CORTEX #15 read and write credentials must be distinct");
  if (!config.index || typeof config.readMode !== "function" || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535 || (config.host !== undefined && config.host !== "127.0.0.1")) throw new Error("CORTEX #15 server configuration is invalid");
  const server = createServer(async (request, response) => {
    try {
      const url = target(request);
      if (request.method === "GET" && url.pathname === "/healthz") { const current = mode(config.readMode); return send(response, current === "KILLED" ? 503 : 200, { mode: current }); }
      if (request.method === "POST" && url.pathname === "/v1/documents") {
        if (!authorized(request, writeToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (mode(config.readMode) !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const body = await jsonBody(request) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "documents" || !Array.isArray(body.documents)) throw new Cortex15Error("INVALID_INPUT", "document request contract is invalid");
        const result = await config.index.upsertDocuments(body.documents, () => { if (mode(config.readMode) !== "ACTIVE") throw new ControlTransition(); });
        console.info(JSON.stringify({ component: "cortex-15-index", operation: "UPSERT", indexed: result.indexed, semantic: result.semantic, lexicalOnly: result.lexicalOnly }));
        return send(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/v1/search") {
        if (!authorized(request, readToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        const current = mode(config.readMode); if (current === "KILLED") return send(response, 503, { error: "KILLED" });
        const body = await jsonBody(request) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "options,query" || typeof body.query !== "string" || !body.options || typeof body.options !== "object") throw new Cortex15Error("INVALID_INPUT", "search request contract is invalid");
        const result = await config.index.search(body.query, body.options as SemanticSearchOptions);
        console.info(JSON.stringify({ component: "cortex-15-search", mode: current, resultMode: result.mode, semanticCoverage: result.semanticCoverage, hits: result.hits.length }));
        return send(response, 200, { mode: current, result });
      }
      return send(response, 404, { error: "NOT_FOUND" });
    } catch (value) { error(response, value); }
  });
  server.listen(config.port, config.host ?? "127.0.0.1");
  return { close: () => new Promise<void>((resolve, reject) => server.close((value) => value ? reject(value) : resolve())) };
}
