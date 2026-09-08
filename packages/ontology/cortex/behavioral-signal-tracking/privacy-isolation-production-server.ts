import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BehavioralSignalError } from "./index";
import type { CortexBehavioralSignalRuntime } from "./runtime";
import {
  PrivacyIsolatedBehavioralSignalAdapter,
  PrivacyIsolationKeyLifecycle,
  PrivacyIsolationSessionService,
  PrivacyRetainingTransactionPort,
  type PrivacyIsolatedBehavioralEventInput,
  type PrivacyIsolatedMicroInteractionInput,
} from "./privacy-isolation";

const MAX_BODY_BYTES = 32 * 1024;
const ENVELOPE_KEYS = new Set(["channel", "event"]);
const SESSION_KEYS = new Set(["siteId", "collectionAllowed", "privacyDecisionRef"]);
const KEY_CHANGE_KEYS = new Set(["keyId", "expectedControlDigest"]);
const CONTROL_KEYS = new Set(["expectedActiveDigest"]);

export interface PrivacyIsolationProductionServerOptions {
  readonly runtime: CortexBehavioralSignalRuntime;
  readonly sessions: PrivacyIsolationSessionService;
  readonly keyLifecycle: PrivacyIsolationKeyLifecycle;
  readonly retention: PrivacyRetainingTransactionPort;
  readonly allowedOrigins: readonly string[];
  readonly ingestToken: string;
  readonly controlToken: string;
  readonly onOperationalEvent?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface PrivacyIsolationProductionServer {
  readonly server: Server;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "PrivacyIsolationProductionHttpError";
  }
}

function secret(value: string, field: string): Buffer {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.byteLength < 32 || bytes.byteLength > 4096) throw new Error(`${field} must contain 32..4096 bytes`);
  return bytes;
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const raw = request.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(raw.slice(7), "utf8");
  return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
}

function origin(request: IncomingMessage, allowed: ReadonlySet<string>): string {
  const value = request.headers.origin;
  if (typeof value !== "string" || !allowed.has(value)) throw new HttpError(403, "ORIGIN_DENIED");
  return value;
}

function setCors(response: ServerResponse, allowedOrigin: string): void {
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-max-age", "300");
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "JSON_REQUIRED");
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) throw new HttpError(400, "INVALID_CONTENT_LENGTH");
    if (Number(declared) > MAX_BODY_BYTES) throw new HttpError(413, "BODY_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      request.resume();
      throw new HttpError(413, "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (bytes === 0) throw new HttpError(400, "BODY_REQUIRED");
  return Buffer.concat(chunks);
}

function jsonRecord(bytes: Uint8Array, allowed: ReadonlySet<string>, required: ReadonlySet<string>, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new HttpError(400, "INVALID_BODY");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new HttpError(400, "INVALID_BODY");
  for (const key of required) if (!(key in record)) throw new HttpError(400, `${label.toUpperCase()}_FIELD_REQUIRED`);
  return record;
}

async function emptyJson(request: IncomingMessage): Promise<void> {
  const body = jsonRecord(await readBody(request), new Set(), new Set(), "body");
  if (Object.keys(body).length !== 0) throw new HttpError(400, "INVALID_BODY");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof BehavioralSignalError) {
    if (error.code === "CONFLICT") return 409;
    if (error.code === "PERSISTENCE_FAILURE" || error.code === "INTEGRITY_FAILURE") return 503;
    return 400;
  }
  return 500;
}

function codeFor(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof BehavioralSignalError) return error.code;
  return "INTERNAL_ERROR";
}

export function createPrivacyIsolationProductionServer(options: PrivacyIsolationProductionServerOptions): PrivacyIsolationProductionServer {
  const ingestToken = secret(options.ingestToken, "ingestToken");
  const controlToken = secret(options.controlToken, "controlToken");
  if (ingestToken.byteLength === controlToken.byteLength && timingSafeEqual(ingestToken, controlToken)) throw new Error("ingestToken and controlToken must be distinct");
  if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length < 1 || options.allowedOrigins.length > 64) throw new Error("allowedOrigins must contain 1..64 origins");
  const allowedOrigins = new Set(options.allowedOrigins.map((value) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.origin !== value) throw new Error(`allowed origin must be canonical HTTPS: ${value}`);
    return value;
  }));
  if (allowedOrigins.size !== options.allowedOrigins.length) throw new Error("allowedOrigins must be unique");
  const adapter = new PrivacyIsolatedBehavioralSignalAdapter(options.runtime, options.sessions, options.retention);

  const emit = (event: Readonly<Record<string, unknown>>) => {
    try { options.onOperationalEvent?.(event); } catch { /* operational telemetry cannot change semantics */ }
  };

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://cortex.invalid");

      if (method === "GET" && url.pathname === "/healthz") {
        const control = options.runtime.controlState();
        const keys = options.keyLifecycle.controlState();
        writeJson(response, 200, { ok: true, mode: control.active.mode, generation: control.generation, privacyIsolation: true, privacyKeyGeneration: keys.generation, activePrivacyKeyId: keys.activeKeyId });
        return;
      }

      if (url.pathname === "/v1/behavioral/ingest" && method === "OPTIONS") {
        if (!authorized(request, ingestToken)) throw new HttpError(401, "UNAUTHORIZED");
        const allowedOrigin = origin(request, allowedOrigins);
        setCors(response, allowedOrigin);
        response.statusCode = 204;
        response.setHeader("cache-control", "no-store");
        response.end();
        return;
      }

      if (url.pathname === "/v1/behavioral/privacy/session" && method === "POST") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        const body = jsonRecord(await readBody(request), SESSION_KEYS, SESSION_KEYS, "session");
        if (typeof body.siteId !== "string" || typeof body.collectionAllowed !== "boolean" || typeof body.privacyDecisionRef !== "string") throw new HttpError(400, "INVALID_BODY");
        const sessionToken = options.sessions.issue(body.siteId, body.privacyDecisionRef, body.collectionAllowed);
        writeJson(response, 201, { sessionToken, expiresInMs: options.sessions.policy.sessionTtlMs });
        emit({ operation: "SESSION_ISSUE", status: 201, siteId: body.siteId, durationMs: Math.max(0, Date.now() - startedAt) });
        return;
      }

      if (url.pathname === "/v1/behavioral/ingest" && method === "POST") {
        if (!authorized(request, ingestToken)) throw new HttpError(401, "UNAUTHORIZED");
        const allowedOrigin = origin(request, allowedOrigins);
        const envelope = jsonRecord(await readBody(request), ENVELOPE_KEYS, ENVELOPE_KEYS, "envelope");
        if (!(envelope.channel === "BASE" || envelope.channel === "MICRO") || !envelope.event || typeof envelope.event !== "object" || Array.isArray(envelope.event)) throw new HttpError(400, "INVALID_BODY");
        const result = envelope.channel === "BASE"
          ? adapter.ingest(envelope.event as PrivacyIsolatedBehavioralEventInput)
          : adapter.ingestMicroInteraction(envelope.event as PrivacyIsolatedMicroInteractionInput);
        setCors(response, allowedOrigin);
        writeJson(response, 200, result);
        emit({ operation: "INGEST_HTTP", channel: envelope.channel, status: 200, outcome: result.status, reason: result.reason, siteId: result.siteId, durationMs: Math.max(0, Date.now() - startedAt) });
        return;
      }

      if (url.pathname === "/v1/behavioral/privacy/keys" && method === "GET") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        writeJson(response, 200, options.keyLifecycle.controlState());
        return;
      }

      if ((url.pathname === "/v1/behavioral/privacy/keys/activate" || url.pathname === "/v1/behavioral/privacy/keys/retire") && method === "POST") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        const body = jsonRecord(await readBody(request), KEY_CHANGE_KEYS, KEY_CHANGE_KEYS, "key");
        if (typeof body.keyId !== "string" || typeof body.expectedControlDigest !== "string") throw new HttpError(400, "INVALID_BODY");
        const state = url.pathname.endsWith("/activate")
          ? options.keyLifecycle.activate(body.keyId, body.expectedControlDigest)
          : options.keyLifecycle.retire(body.keyId, body.expectedControlDigest);
        writeJson(response, 200, state);
        emit({ operation: url.pathname.endsWith("/activate") ? "PRIVACY_KEY_ACTIVATE" : "PRIVACY_KEY_RETIRE", status: 200, generation: state.generation, activeKeyId: state.activeKeyId });
        return;
      }

      if (url.pathname === "/v1/behavioral/privacy/retention/sweep" && method === "POST") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        await emptyJson(request);
        const result = options.retention.sweepAll();
        writeJson(response, 200, result);
        emit({ operation: "RETENTION_SWEEP", status: 200, purgedSites: result.purgedSites, deletedObjects: result.deletedObjects });
        return;
      }

      if (url.pathname === "/v1/behavioral/control" && method === "GET") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        writeJson(response, 200, options.runtime.controlState());
        return;
      }

      if ((url.pathname === "/v1/behavioral/control/kill" || url.pathname === "/v1/behavioral/control/rollback") && method === "POST") {
        if (!authorized(request, controlToken)) throw new HttpError(401, "UNAUTHORIZED");
        const body = jsonRecord(await readBody(request), CONTROL_KEYS, CONTROL_KEYS, "control");
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
      const status = statusFor(error);
      const code = codeFor(error);
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
