import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { Cortex20Error, ServerlessFormIngress, parseFormSubmission } from "./index.js";
import type { Cortex20Mode } from "./runtime-control.js";

const MAX_BODY_BYTES = 96 * 1024;
const REQUEST_TARGET = /^\/[\x21-\x7e]*$/u;

export interface Cortex20ServerConfig {
  readonly ingress: ServerlessFormIngress;
  readonly ingestToken: string;
  readonly port: number;
  readonly host?: "127.0.0.1";
  readonly readMode: () => Cortex20Mode;
}

function token(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error("CORTEX #20 ingest token is invalid");
  return value;
}
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function authorized(request: IncomingMessage, expected: string): boolean { const header = request.headers.authorization; return typeof header === "string" && header.startsWith("Bearer ") && equal(header.slice(7), expected); }
function mode(readMode: () => Cortex20Mode): Cortex20Mode { try { const value = readMode(); return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED"; } catch { return "KILLED"; } }
function target(request: IncomingMessage): URL {
  const raw = request.url ?? "/"; if (!REQUEST_TARGET.test(raw) || raw.includes("#")) throw new Cortex20Error("INVALID_INPUT", "request target must use bounded origin-form syntax"); return new URL(raw, "http://127.0.0.1");
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex20Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex20Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); total += bytes.length;
    if (total > MAX_BODY_BYTES) { request.destroy(); throw new Cortex20Error("INVALID_INPUT", "request body is too large"); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Cortex20Error("INVALID_INPUT", "request body must contain valid JSON"); }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(encoded);
}
function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof Cortex20Error) {
    const status = error.code === "CONSENT_VIOLATION" ? 422 : error.code === "QUEUE_FAILURE" ? 503 : error.code === "ENCRYPTION_ERROR" ? 500 : 400;
    return send(response, status, { error: error.code });
  }
  console.error(JSON.stringify({ component: "cortex-20-server", error: "INTERNAL" })); send(response, 500, { error: "INTERNAL" });
}

export function startCortex20Server(config: Cortex20ServerConfig): { close(): Promise<void> } {
  const ingestToken = token(config.ingestToken);
  if (!config.ingress || typeof config.readMode !== "function" || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535 || (config.host !== undefined && config.host !== "127.0.0.1")) throw new Error("CORTEX #20 server configuration is invalid");
  const server = createServer(async (request, response) => {
    try {
      const url = target(request);
      if (request.method === "GET" && url.pathname === "/healthz") { const current = mode(config.readMode); return send(response, current === "KILLED" ? 503 : 200, { mode: current }); }
      if (request.method === "POST" && url.pathname === "/v1/forms") {
        if (!authorized(request, ingestToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        const current = mode(config.readMode); if (current === "KILLED") return send(response, 503, { error: "KILLED" });
        const submission = await body(request);
        if (current === "OBSERVE_ONLY") {
          const validated = parseFormSubmission(submission);
          console.info(JSON.stringify({ component: "cortex-20-ingress", operation: "OBSERVE", formId: validated.formId }));
          return send(response, 200, { mode: "OBSERVE_ONLY", accepted: false, durableSequence: null });
        }
        const receipt = await config.ingress.accept(submission);
        console.info(JSON.stringify({ component: "cortex-20-ingress", operation: "ACCEPT", durableSequence: receipt.durableSequence }));
        return send(response, 202, { mode: "ACTIVE", receipt });
      }
      return send(response, 404, { error: "NOT_FOUND" });
    } catch (error) { fail(response, error); }
  });
  server.listen(config.port, config.host ?? "127.0.0.1");
  return { close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
