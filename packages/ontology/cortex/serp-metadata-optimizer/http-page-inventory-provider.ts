import { createPageInventorySnapshot, type PageInventoryProvider, type PageInventorySnapshot } from "./index";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class PageInventoryTransportError extends Error {
  constructor(readonly code: "INVALID_CONFIG" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE", message: string) {
    super(message);
    this.name = "PageInventoryTransportError";
  }
}

export interface HttpPageInventoryProviderConfig {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function configEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PageInventoryTransportError("INVALID_CONFIG", "inventory endpoint is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new PageInventoryTransportError("INVALID_CONFIG", "inventory endpoint must be credential-free HTTPS");
  return url.toString();
}

function token(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 32 || normalized.length > 4096) throw new PageInventoryTransportError("INVALID_CONFIG", "inventory token must contain 32..4096 characters");
  return normalized;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new PageInventoryTransportError("INVALID_RESPONSE", "inventory response must use application/json");
  if (!response.body) throw new PageInventoryTransportError("INVALID_RESPONSE", "inventory response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new PageInventoryTransportError("INVALID_RESPONSE", "inventory response exceeds 2 MiB"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new PageInventoryTransportError("INVALID_RESPONSE", "inventory response contains malformed JSON"); }
}

export class HttpPageInventoryProvider implements PageInventoryProvider {
  private readonly endpoint: string;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpPageInventoryProviderConfig) {
    this.endpoint = configEndpoint(config.endpoint);
    this.bearerToken = token(config.bearerToken);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) throw new PageInventoryTransportError("INVALID_CONFIG", "timeoutMs must be 1000..60000");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getInventory(siteUrl: string): Promise<PageInventorySnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.bearerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ siteUrl }),
      });
      if (!response.ok) throw new PageInventoryTransportError("HTTP_ERROR", `inventory endpoint returned HTTP ${response.status}`);
      const raw = await boundedJson(response);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PageInventoryTransportError("INVALID_RESPONSE", "inventory response must be an object");
      const record = raw as Record<string, unknown>;
      if (record.siteUrl !== siteUrl) throw new PageInventoryTransportError("INVALID_RESPONSE", "inventory response site identity mismatch");
      try {
        return createPageInventorySnapshot(record as unknown as Omit<PageInventorySnapshot, "digest">);
      } catch {
        throw new PageInventoryTransportError("INVALID_RESPONSE", "inventory response failed semantic validation");
      }
    } catch (error) {
      if (error instanceof PageInventoryTransportError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new PageInventoryTransportError("TIMEOUT", "inventory endpoint timed out");
      throw new PageInventoryTransportError("HTTP_ERROR", "inventory transport failed");
    } finally { clearTimeout(timer); }
  }
}
