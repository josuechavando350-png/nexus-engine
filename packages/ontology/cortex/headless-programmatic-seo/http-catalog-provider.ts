import {
  createProgrammaticSeoCatalogSnapshot,
  type ProgrammaticSeoCatalogProvider,
  type ProgrammaticSeoCatalogSnapshot,
} from "./index";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ProgrammaticSeoCatalogTransportError extends Error {
  constructor(readonly code: "INVALID_CONFIG" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE", message: string) {
    super(message);
    this.name = "ProgrammaticSeoCatalogTransportError";
  }
}

export interface HttpProgrammaticSeoCatalogProviderConfig {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly maxRouteDepth: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProgrammaticSeoCatalogTransportError("INVALID_CONFIG", "catalog endpoint is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new ProgrammaticSeoCatalogTransportError("INVALID_CONFIG", "catalog endpoint must be credential-free HTTPS");
  return url.toString();
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new ProgrammaticSeoCatalogTransportError("INVALID_RESPONSE", "catalog response must use application/json");
  if (!response.body) throw new ProgrammaticSeoCatalogTransportError("INVALID_RESPONSE", "catalog response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ProgrammaticSeoCatalogTransportError("INVALID_RESPONSE", "catalog response exceeds 8 MiB"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new ProgrammaticSeoCatalogTransportError("INVALID_RESPONSE", "catalog response contains malformed JSON"); }
}

export class HttpProgrammaticSeoCatalogProvider implements ProgrammaticSeoCatalogProvider {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRouteDepth: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpProgrammaticSeoCatalogProviderConfig) {
    this.url = endpoint(config.endpoint);
    this.token = config.bearerToken.trim();
    if (this.token.length < 32 || this.token.length > 4096) throw new ProgrammaticSeoCatalogTransportError("INVALID_CONFIG", "catalog token must contain 32..4096 characters");
    if (!Number.isSafeInteger(config.maxRouteDepth) || config.maxRouteDepth < 1 || config.maxRouteDepth > 32) throw new ProgrammaticSeoCatalogTransportError("INVALID_CONFIG", "maxRouteDepth must be 1..32");
    this.maxRouteDepth = config.maxRouteDepth;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) throw new ProgrammaticSeoCatalogTransportError("INVALID_CONFIG", "timeoutMs must be 1000..60000");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getCatalog(siteId: string): Promise<ProgrammaticSeoCatalogSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ siteId }),
      });
      if (!response.ok) throw new ProgrammaticSeoCatalogTransportError("HTTP_ERROR", `catalog endpoint returned HTTP ${response.status}`);
      const raw = await boundedJson(response);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProgrammaticSeoCatalogTransportError("INVALID_RESPONSE", "catalog response must be an object");
      const record = raw as Record<string, unknown>;
      if (record.siteId !== siteId) throw new ProgrammaticSeoCatalogTransportError("INVALID_RESPONSE", "catalog response site identity mismatch");
      try {
        return createProgrammaticSeoCatalogSnapshot(record as unknown as Omit<ProgrammaticSeoCatalogSnapshot, "digest">, this.maxRouteDepth);
      } catch {
        throw new ProgrammaticSeoCatalogTransportError("INVALID_RESPONSE", "catalog response failed semantic validation");
      }
    } catch (error) {
      if (error instanceof ProgrammaticSeoCatalogTransportError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new ProgrammaticSeoCatalogTransportError("TIMEOUT", "catalog endpoint timed out");
      throw new ProgrammaticSeoCatalogTransportError("HTTP_ERROR", "catalog transport failed");
    } finally { clearTimeout(timer); }
  }
}
