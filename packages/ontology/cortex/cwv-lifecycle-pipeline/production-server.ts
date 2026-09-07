import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CwvPipelineAuditError, SqliteCwvPipelineAuditStore, type CwvAuditMode } from "./index";

const MAX_BODY_BYTES = 16 * 1024;

export interface CwvPipelineAuditServerOptions {
  readonly store: SqliteCwvPipelineAuditStore;
  readonly ingestToken: string;
  readonly controlToken: string;
  readonly host?: string;
  readonly port?: number;
}

function secret(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 4096 || /[\r\n]/u.test(normalized)) throw new Error(`${label} must contain 32..4096 characters`);
  return createHash("sha256").update(normalized, "utf8").digest();
}
function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const supplied = createHash("sha256").update(raw.slice(7), "utf8").digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" });
  response.end(body);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new CwvPipelineAuditError("INVALID_INPUT", "content-type must be application/json");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new CwvPipelineAuditError("INVALID_INPUT", "request body too large");
  const chunks: Buffer[] = []; let total = 0;
  for await (const part of request) { const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); total += bytes.length; if (total > MAX_BODY_BYTES) { request.resume(); throw new CwvPipelineAuditError("INVALID_INPUT", "request body too large"); } chunks.push(bytes); }
  if (!total) throw new CwvPipelineAuditError("INVALID_INPUT", "request body is required");
  try { return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown; } catch { throw new CwvPipelineAuditError("INVALID_INPUT", "request body contains malformed JSON"); }
}
function controlInput(value: unknown): { mode: CwvAuditMode; expectedRevision: number } {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new CwvPipelineAuditError("INVALID_INPUT", "control request must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "expectedRevision,mode" || !(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED") || !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 0) throw new CwvPipelineAuditError("INVALID_INPUT", "control request is invalid");
  return { mode: raw.mode, expectedRevision: raw.expectedRevision as number };
}

export class CwvPipelineAuditServer {
  private server: Server | null = null;
  private readonly ingestDigest: Buffer;
  private readonly controlDigest: Buffer;
  private readonly host: string;
  private readonly port: number;
  constructor(private readonly options: CwvPipelineAuditServerOptions) {
    if (options.ingestToken.trim() === options.controlToken.trim()) throw new Error("CWV ingest/control tokens must be distinct");
    this.ingestDigest = secret(options.ingestToken, "ingestToken"); this.controlDigest = secret(options.controlToken, "controlToken");
    this.host = options.host ?? "127.0.0.1"; this.port = options.port ?? 8083;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65_535) throw new Error("port must be 0..65535");
  }
  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("CWV audit server already running");
    const server = createServer((request, response) => { void this.handle(request, response); });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.port, this.host, () => { server.off("error", reject); resolve(); }); });
    this.server = server; const address = server.address(); if (!address || typeof address === "string") throw new Error("CWV audit server has no TCP address");
    return Object.freeze({ host: address.address, port: address.port });
  }
  async close(): Promise<void> { const server = this.server; this.server = null; if (!server) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/healthz") return json(response, 200, { status: "ok", mode: this.options.store.control().mode, certificationDigest: this.options.store.certification.certificationDigest });
      if (path === "/v1/cwv/control") {
        if (!authorized(request, this.controlDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
        if (request.method === "GET") return json(response, 200, this.options.store.control());
        if (request.method === "POST") { const input = controlInput(await body(request)); return json(response, 200, this.options.store.setMode(input.mode, input.expectedRevision)); }
        return json(response, 405, { error: "METHOD_NOT_ALLOWED" });
      }
      if (!authorized(request, this.ingestDigest)) return json(response, 401, { error: "UNAUTHORIZED" });
      if (request.method === "POST" && path === "/v1/cwv/runtime-evidence") {
        const record = this.options.store.record(await body(request));
        return record ? json(response, 202, { status: "RECORDED", evidenceDigest: record.evidenceDigest, certificationDigest: record.certificationDigest }) : json(response, 200, { status: "OBSERVED" });
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const code = error instanceof CwvPipelineAuditError ? error.code : "INTERNAL";
      const status = code === "CONFLICT" ? 409 : code === "PIPELINE_MISMATCH" ? 412 : code === "MODE_BLOCKED" ? 503 : code === "INTERNAL" ? 500 : 400;
      return json(response, status, { error: code });
    }
  }
}
