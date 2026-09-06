import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { EnhancedConversionMode } from "./index";
import { DurableEnhancedConversionsPipeline, EnhancedConversionError, observeEnhancedConversionInput } from "./index";
import { DurableEnhancedConversionControl } from "./runtime-control";

const JSON_TYPE = "application/json";
const MAX_BODY_BYTES = 16 * 1024;

export interface EnhancedConversionProductionServerOptions {
  readonly engine: DurableEnhancedConversionsPipeline;
  readonly control: DurableEnhancedConversionControl;
  readonly ingestToken: string;
  readonly controlToken: string;
  readonly host?: string;
  readonly port?: number;
}

function secret(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 24 || normalized.length > 4096) throw new Error(`${label} must contain 24..4096 characters`);
  return normalized;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice(7);
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": `${JSON_TYPE}; charset=utf-8`,
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

async function boundedJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== JSON_TYPE) throw new Error("INVALID_MEDIA_TYPE");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("BODY_TOO_LARGE");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) {
      request.destroy();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
}

function pathOf(request: IncomingMessage): string {
  try { return new URL(request.url ?? "/", "http://localhost").pathname; }
  catch { return "/__invalid__"; }
}

function controlInput(value: unknown): { mode: EnhancedConversionMode; expectedRevision: number } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("INVALID_CONTROL");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "expectedRevision,mode") throw new Error("INVALID_CONTROL");
  if (!(input.mode === "ACTIVE" || input.mode === "OBSERVE_ONLY" || input.mode === "KILLED")) throw new Error("INVALID_CONTROL");
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) throw new Error("INVALID_CONTROL");
  return { mode: input.mode, expectedRevision: input.expectedRevision as number };
}

function transactionInput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("INVALID_TRANSACTION");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).join(",") !== "transactionId" || typeof input.transactionId !== "string") throw new Error("INVALID_TRANSACTION");
  return input.transactionId;
}

export class EnhancedConversionProductionServer {
  private server: Server | null = null;
  private readonly ingestToken: string;
  private readonly controlToken: string;
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: EnhancedConversionProductionServerOptions) {
    this.ingestToken = secret(options.ingestToken, "ingestToken");
    this.controlToken = secret(options.controlToken, "controlToken");
    if (this.ingestToken === this.controlToken) throw new Error("ingestToken and controlToken must be distinct credentials");
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8080;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65_535) throw new Error("port must be an integer from 0 to 65535");
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("enhanced-conversion server is already running");
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 20_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("enhanced-conversion server has no TCP address");
    return Object.freeze({ host: address.address, port: address.port });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = pathOf(request);
      if (request.method === "GET" && path === "/healthz") {
        json(response, 200, { status: "ok", mode: this.options.control.read().mode });
        return;
      }
      if (path === "/v1/enhanced-conversions/control") {
        if (!authorized(request, this.controlToken)) { json(response, 401, { error: "UNAUTHORIZED" }); return; }
        if (request.method === "GET") { json(response, 200, this.options.control.read()); return; }
        if (request.method === "POST") {
          const input = controlInput(await boundedJson(request));
          try { json(response, 200, this.options.control.setMode(input.mode, input.expectedRevision)); }
          catch (error) { json(response, /revision conflict/u.test(String(error)) ? 409 : 400, { error: "CONTROL_REJECTED" }); }
          return;
        }
      }
      if (!authorized(request, this.ingestToken)) { json(response, 401, { error: "UNAUTHORIZED" }); return; }
      if (request.method === "POST" && path === "/v1/enhanced-conversions/events") {
        const initialMode = this.options.control.read().mode;
        if (initialMode === "KILLED") { json(response, 503, { error: "KILLED" }); return; }
        const input = await boundedJson(request);
        if (initialMode === "OBSERVE_ONLY") {
          json(response, 200, { status: "OBSERVED", observation: observeEnhancedConversionInput(input) });
          return;
        }

        // Final control read before any durable PREPARE mutation. The engine
        // performs another independent read at its persistence boundary.
        const finalMode = this.options.control.read().mode;
        if (finalMode === "KILLED") { json(response, 503, { error: "KILLED" }); return; }
        if (finalMode === "OBSERVE_ONLY") {
          json(response, 200, { status: "OBSERVED", observation: observeEnhancedConversionInput(input) });
          return;
        }
        const prepared = this.options.engine.prepare(input);
        try {
          const result = await this.options.engine.dispatch(prepared.transactionId);
          json(response, result.status === "SENT" ? 202 : 200, { transactionId: result.transactionId, status: result.status, digest: result.digest, externalRequestId: result.externalRequestId });
        } catch (error) {
          if (error instanceof EnhancedConversionError && (error.code === "KILLED" || error.code === "MODE_BLOCKED")) { json(response, 503, { error: error.code, transactionId: prepared.transactionId }); return; }
          if (error instanceof EnhancedConversionError && error.code === "AMBIGUOUS_OUTCOME") { json(response, 202, { transactionId: prepared.transactionId, status: "AMBIGUOUS" }); return; }
          throw error;
        }
        return;
      }
      if (request.method === "POST" && path === "/v1/enhanced-conversions/rollback") {
        const transactionId = transactionInput(await boundedJson(request));
        const result = this.options.engine.rollback(transactionId);
        json(response, 200, { transactionId: result.transactionId, status: result.status, digest: result.digest });
        return;
      }
      json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const code = error instanceof EnhancedConversionError ? error.code : "INVALID_REQUEST";
      const status = error instanceof EnhancedConversionError && error.code === "CONFLICT" ? 409
        : error instanceof EnhancedConversionError && error.code === "CONSENT_VIOLATION" ? 403
          : error instanceof EnhancedConversionError && (error.code === "KILLED" || error.code === "MODE_BLOCKED") ? 503
            : 400;
      json(response, status, { error: code });
    }
  }
}
