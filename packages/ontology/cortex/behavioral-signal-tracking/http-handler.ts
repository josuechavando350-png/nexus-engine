import { BehavioralSignalError, type BehavioralSignalEventInput } from "./index";
import type { BehavioralMicroInteractionInput } from "./browser-micro-signals";
import { CortexBehavioralSignalRuntime } from "./runtime";

export interface BehavioralSignalHttpHandlerOptions {
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes?: number;
}

const ENVELOPE_KEYS = new Set(["channel", "event"]);

type BodyReadResult =
  | { readonly kind: "OK"; readonly bytes: Uint8Array }
  | { readonly kind: "TOO_LARGE" }
  | { readonly kind: "INVALID_CONTENT_LENGTH" }
  | { readonly kind: "READ_FAILED" };

function jsonResponse(status: number, body: Readonly<Record<string, unknown>>, origin?: string): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function normalizeOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 64) throw new Error("allowedOrigins must contain 1..64 origins");
  const normalized = origins.map((origin) => {
    const url = new URL(origin);
    if (!/^https?:$/u.test(url.protocol) || url.origin !== origin) throw new Error(`allowed origin must be canonical: ${origin}`);
    return origin;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("allowedOrigins must be unique");
  return new Set(normalized);
}

function statusFor(error: unknown): number {
  if (!(error instanceof BehavioralSignalError)) return 500;
  switch (error.code) {
    case "INVALID_INPUT":
    case "POLICY_VIOLATION":
      return 400;
    case "CONFLICT":
      return 409;
    case "INTEGRITY_FAILURE":
    case "PERSISTENCE_FAILURE":
      return 500;
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const [mediaType] = value.split(";", 1);
  return mediaType?.trim().toLowerCase() === "application/json";
}

async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<BodyReadResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) return { kind: "INVALID_CONTENT_LENGTH" };
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) return { kind: "INVALID_CONTENT_LENGTH" };
    if (declaredBytes > maxBodyBytes) return { kind: "TOO_LARGE" };
  }

  if (request.body === null) return { kind: "OK", bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        try {
          await reader.cancel("behavioral request body exceeds configured limit");
        } catch {
          // A failed stream cancellation must not turn a bounded rejection into ingestion.
        }
        return { kind: "TOO_LARGE" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "READ_FAILED" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "OK", bytes };
}

export function createBehavioralSignalHttpHandler(
  runtime: CortexBehavioralSignalRuntime,
  options: BehavioralSignalHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  const allowedOrigins = normalizeOrigins(options.allowedOrigins);
  const maxBodyBytes = options.maxBodyBytes ?? 16_384;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 65_536) throw new Error("maxBodyBytes must be 1024..65536");

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    if (!origin || !allowedOrigins.has(origin)) return jsonResponse(403, { error: "ORIGIN_DENIED" });

    if (request.method === "OPTIONS") {
      const headers = new Headers({
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
        "cache-control": "no-store",
        "vary": "Origin",
      });
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      const response = jsonResponse(405, { error: "METHOD_NOT_ALLOWED" }, origin);
      response.headers.set("allow", "POST, OPTIONS");
      return response;
    }
    if (!isJsonContentType(request.headers.get("content-type"))) return jsonResponse(415, { error: "JSON_REQUIRED" }, origin);

    const body = await readBoundedBody(request, maxBodyBytes);
    if (body.kind === "TOO_LARGE") return jsonResponse(413, { error: "BODY_TOO_LARGE" }, origin);
    if (body.kind === "INVALID_CONTENT_LENGTH") return jsonResponse(400, { error: "INVALID_CONTENT_LENGTH" }, origin);
    if (body.kind === "READ_FAILED") return jsonResponse(400, { error: "BODY_READ_FAILED" }, origin);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
    } catch {
      return jsonResponse(400, { error: "INVALID_JSON" }, origin);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonResponse(400, { error: "INVALID_ENVELOPE" }, origin);
    const envelope = parsed as Record<string, unknown>;
    for (const key of Object.keys(envelope)) if (!ENVELOPE_KEYS.has(key)) return jsonResponse(400, { error: "INVALID_ENVELOPE" }, origin);
    if (!envelope.event || typeof envelope.event !== "object" || Array.isArray(envelope.event)) return jsonResponse(400, { error: "INVALID_EVENT" }, origin);

    try {
      const result = envelope.channel === "BASE"
        ? runtime.ingest(envelope.event as unknown as BehavioralSignalEventInput)
        : envelope.channel === "MICRO"
          ? runtime.ingestMicroInteraction(envelope.event as unknown as BehavioralMicroInteractionInput)
          : null;
      if (!result) return jsonResponse(400, { error: "INVALID_CHANNEL" }, origin);
      return jsonResponse(202, {
        status: result.status,
        reason: result.reason,
        mode: result.mode,
        siteId: result.siteId,
        eventDigest: result.eventDigest,
        policyDigest: result.policyDigest,
      }, origin);
    } catch (error) {
      return jsonResponse(statusFor(error), { error: error instanceof BehavioralSignalError ? error.code : "INTERNAL_ERROR" }, origin);
    }
  };
}
