import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { SqliteDurableEventStream, arbitrateBudget, Cortex17Error } from "./index.js";
import type { Cortex17Mode } from "./runtime-control.js";

const MAX_BODY_BYTES = 65_536;
const REQUEST_TARGET = /^\/[\x21-\x7e]*$/u;
const DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u;

export interface Cortex17ServerConfig {
  readonly databasePath: string;
  readonly writeToken: string;
  readonly readToken: string;
  readonly port: number;
  readonly host?: "127.0.0.1";
  readonly readMode: () => Cortex17Mode;
}

function validateToken(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096 || /[\r\n\0]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") && secureEqual(header.slice(7), expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Cortex17Error("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Cortex17Error("INVALID_INPUT", "request body is too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new Cortex17Error("INVALID_INPUT", "request body is too large");
    }
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Cortex17Error("INVALID_INPUT", "request body must contain valid JSON"); }
}

function target(request: IncomingMessage): URL {
  const raw = request.url ?? "/";
  if (!REQUEST_TARGET.test(raw) || raw.includes("#")) throw new Cortex17Error("INVALID_INPUT", "request target must use bounded origin-form syntax");
  return new URL(raw, "http://127.0.0.1");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

function failClosedMode(readMode: () => Cortex17Mode): Cortex17Mode {
  try {
    const value = readMode();
    return value === "ACTIVE" || value === "OBSERVE_ONLY" || value === "KILLED" ? value : "KILLED";
  } catch { return "KILLED"; }
}

function errorResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof Cortex17Error) {
    const status = error.code === "CONFLICT" || error.code === "OFFSET_REGRESSION" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
    send(response, status, { error: error.code });
    return;
  }
  console.error(JSON.stringify({ component: "cortex-17-server", error: "INTERNAL" }));
  send(response, 500, { error: "INTERNAL" });
}

function parseArbitrationRequest(value: unknown): { decisionId: string; occurredAt: string; input: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Cortex17Error("INVALID_INPUT", "arbitration request must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "decisionId,input,occurredAt" || typeof raw.decisionId !== "string" || !DECISION_ID.test(raw.decisionId) || typeof raw.occurredAt !== "string") throw new Cortex17Error("INVALID_INPUT", "arbitration request identity is invalid");
  const occurred = new Date(raw.occurredAt);
  if (!Number.isFinite(occurred.getTime()) || occurred.toISOString() !== raw.occurredAt) throw new Cortex17Error("INVALID_INPUT", "arbitration occurredAt must be canonical UTC");
  return { decisionId: raw.decisionId, occurredAt: raw.occurredAt, input: raw.input };
}

export function startCortex17Server(config: Cortex17ServerConfig): { close(): Promise<void> } {
  if (!config.databasePath || typeof config.readMode !== "function") throw new Error("CORTEX #17 database and durable control reader are required");
  const writeToken = validateToken(config.writeToken, "CORTEX #17 write token");
  const readToken = validateToken(config.readToken, "CORTEX #17 read token");
  if (secureEqual(writeToken, readToken)) throw new Error("CORTEX #17 read and write credentials must be distinct");
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) throw new Error("CORTEX #17 port is invalid");
  if (config.host !== undefined && config.host !== "127.0.0.1") throw new Error("CORTEX #17 host must be 127.0.0.1");
  const stream = new SqliteDurableEventStream(config.databasePath);

  const server = createServer(async (request, response) => {
    try {
      const url = target(request);
      if (request.method === "GET" && url.pathname === "/healthz") {
        const currentMode = failClosedMode(config.readMode);
        return send(response, currentMode === "KILLED" ? 503 : 200, { mode: currentMode });
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        if (!authorized(request, writeToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (failClosedMode(config.readMode) !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const body = await readJson(request);
        if (failClosedMode(config.readMode) !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const event = stream.append(body);
        console.info(JSON.stringify({ component: "cortex-17-stream", operation: "APPEND", sequence: event.sequence }));
        return send(response, 201, event);
      }

      if (request.method === "GET" && url.pathname === "/v1/events") {
        if (!authorized(request, readToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (failClosedMode(config.readMode) === "KILLED") return send(response, 503, { error: "KILLED" });
        const streamName = url.searchParams.get("stream") ?? "";
        const afterRaw = url.searchParams.get("after") ?? "0";
        const limitRaw = url.searchParams.get("limit") ?? "100";
        if (!/^\d+$/u.test(afterRaw) || !/^\d+$/u.test(limitRaw)) throw new Cortex17Error("INVALID_INPUT", "read cursor is invalid");
        return send(response, 200, { events: stream.read(streamName, Number(afterRaw), Number(limitRaw)) });
      }

      if (request.method === "POST" && url.pathname === "/v1/offsets") {
        if (!authorized(request, writeToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        if (failClosedMode(config.readMode) !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const body = await readJson(request) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "consumerId,sequence,stream" || typeof body.consumerId !== "string" || typeof body.stream !== "string" || typeof body.sequence !== "number") throw new Cortex17Error("INVALID_INPUT", "offset contract is invalid");
        if (failClosedMode(config.readMode) !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const sequence = stream.commitOffset(body.consumerId, body.stream, body.sequence);
        return send(response, 200, { sequence });
      }

      if (request.method === "POST" && url.pathname === "/v1/budget/arbitrate") {
        if (!authorized(request, writeToken)) return send(response, 401, { error: "UNAUTHORIZED" });
        const initialMode = failClosedMode(config.readMode);
        if (initialMode === "KILLED") return send(response, 503, { error: "KILLED" });
        const arbitration = parseArbitrationRequest(await readJson(request));
        const result = arbitrateBudget(arbitration.input);
        if (initialMode === "OBSERVE_ONLY") return send(response, 200, { mode: "OBSERVE_ONLY", result, persistedSequence: null });
        if (failClosedMode(config.readMode) !== "ACTIVE") return send(response, 503, { error: "KILLED" });
        const event = stream.append({ stream: "budget.arbitration", eventId: `budget-${arbitration.decisionId}`, occurredAt: arbitration.occurredAt, payload: result });
        console.info(JSON.stringify({ component: "cortex-17-budget", operation: "ARBITRATE", decision: result.decision, sequence: event.sequence }));
        return send(response, 200, { mode: "ACTIVE", result, persistedSequence: event.sequence });
      }

      return send(response, 404, { error: "NOT_FOUND" });
    } catch (error) { errorResponse(response, error); }
  });

  server.listen(config.port, config.host ?? "127.0.0.1");
  let closed = false;
  return {
    close: () => new Promise<void>((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      server.close((error) => {
        stream.close();
        if (error) reject(error); else resolve();
      });
    }),
  };
}
