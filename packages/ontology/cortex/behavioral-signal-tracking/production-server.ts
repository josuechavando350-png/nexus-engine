import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CortexBehavioralSignalRuntime } from "./runtime";
import { createBehavioralSignalHttpHandler } from "./http-handler";

const MAX_PROXY_BODY_BYTES = 65_536;

export interface BehavioralProductionServerOptions {
  readonly runtime: CortexBehavioralSignalRuntime;
  readonly allowedOrigins: readonly string[];
  readonly ingestToken: string;
  readonly controlToken: string;
  readonly onOperationalEvent?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface BehavioralProductionServer {
  readonly server: Server;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "BehavioralProductionHttpError";
  }
}

function secret(value: string, field: string): Buffer {
  if (typeof value !== "string" || value.trim().length < 32 || value.trim().length > 4096) throw new Error(`${field} must contain 32..4096 characters`);
  return Buffer.from(value.trim(), "utf8");
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(raw.slice(7), "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) throw new HttpError(400, "INVALID_CONTENT_LENGTH");
    if (Number(declared) > MAX_PROXY_BODY_BYTES) throw new HttpError(413, "BODY_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PROXY_BODY_BYTES) {
      request.resume();
      throw new HttpError(413, "BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

async function sendWebResponse(response: ServerResponse, web: Response): Promise<void> {
  response.statusCode = web.status;
  for (const [name, value] of web.headers) response.setHeader(name, value);
  const body = new Uint8Array(await web.arrayBuffer());
  response.setHeader("content-length", body.byteLength);
  response.end(body);
}

function exactJson(bytes: Uint8Array, allowed: readonly string[]): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_BODY");
  const record = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) if (!allowedSet.has(key)) throw new HttpError(400, "INVALID_BODY");
  return record;
}

export function createBehavioralProductionServer(options: BehavioralProductionServerOptions): BehavioralProductionServer {
  const ingestToken = secret(options.ingestToken, "ingestToken");
  const controlToken = secret(options.controlToken, "controlToken");
  if (ingestToken.length === controlToken.length && timingSafeEqual(ingestToken, controlToken)) throw new Error("ingestToken and controlToken must be distinct");
  const handler = createBehavioralSignalHttpHandler(options.runtime, { allowedOrigins: options.allowedOrigins, maxBodyBytes: 16_384 });

  const emit = (event: Readonly<Record<string, unknown>>) => {
    try { options.onOperationalEvent?.(event); } catch { /* operational telemetry cannot change ingestion semantics */ }
  };

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://cortex.invalid");
      if (method === "GET" && url.pathname === "/healthz") {
        const control = options.runtime.controlState();
        writeJson(response, 200, { ok: true, mode: control.active.mode, generation: control.generation });
        return;
      }

      if (url.pathname === "/v1/behavioral/ingest" && (method === "POST" || method === "OPTIONS")) {
        if (!authorized(request, ingestToken)) throw new HttpError(401, "UNAUTHORIZED");
        const body = method === "POST" ? await readBody(request) : new Uint8Array();
        const originHeader = request.headers.origin;
        const headers = new Headers();
        if (typeof originHeader === "string") headers.set("origin", originHeader);
        const contentType = request.headers["content-type"];
        if (typeof contentType === "string") headers.set("content-type", contentType);
        if (typeof request.headers["content-length"] === "string") headers.set("content-length", String(body.byteLength));
        const webRequest = new Request("https://cortex.internal/v1/behavioral/ingest", {
          method,
          headers,
          ...(method === "POST" ? { body } : {}),
        });
        const webResponse = await handler(webRequest);
        await sendWebResponse(response, webResponse);
        emit({ operation: "INGEST_HTTP", status: webResponse.status, durationMs: Math.max(0, Date.now() - startedAt) });
        return;
      }

      if (url.pathname === "/v1/behavioral/control" && method === "GET") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        writeJson(response, 200, options.runtime.controlState());
        return;
      }

      if ((url.pathname === "/v1/behavioral/control/kill" || url.pathname === "/v1/behavioral/control/rollback") && method === "POST") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        const body = exactJson(await readBody(request), ["expectedActiveDigest"]);
        if (typeof body.expectedActiveDigest !== "string") throw new HttpError(400, "INVALID_BODY");
        const state = url.pathname.endsWith("/kill")
          ? options.runtime.kill(body.expectedActiveDigest)
          : options.runtime.rollbackPolicy(body.expectedActiveDigest);
        writeJson(response, 200, state);
        emit({ operation: url.pathname.endsWith("/kill") ? "KILL" : "ROLLBACK", status: 200, generation: state.generation, activePolicyDigest: state.active.digest });
        return;
      }

      writeJson(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL_ERROR";
      if (!response.headersSent && !response.writableEnded) writeJson(response, status, { error: code });
      emit({ operation: "HTTP_ERROR", status, code, durationMs: Math.max(0, Date.now() - startedAt) });
    }
  });

  return Object.freeze({
    server,
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
    }),
  });
}
