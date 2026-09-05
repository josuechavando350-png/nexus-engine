import type { BusinessProfitabilityProvider, BusinessProfitabilityQuery, BusinessProfitabilitySnapshot } from "./index";

const MAX_RESPONSE_BYTES = 32 * 1024;
const IDENTIFIER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;

export interface HttpBusinessProfitabilityProviderConfig {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class BusinessProfitabilityTransportError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "HTTP_ERROR" | "TIMEOUT" | "INVALID_RESPONSE", message: string) {
    super(message);
    this.name = "BusinessProfitabilityTransportError";
  }
}

function requireToken(value: string): string {
  if (typeof value !== "string" || value.trim().length < 32 || value.trim().length > 4096) throw new BusinessProfitabilityTransportError("INVALID_CONFIG", "profitability bearer token must contain 32..4096 characters");
  return value.trim();
}
function timeout(value: number | undefined): number { const resolved = value ?? 10_000; if (!Number.isSafeInteger(resolved) || resolved < 1_000 || resolved > 60_000) throw new BusinessProfitabilityTransportError("INVALID_CONFIG", "profitability timeoutMs must be 1000..60000"); return resolved; }
function endpoint(value: string): string { let parsed: URL; try { parsed = new URL(value); } catch { throw new BusinessProfitabilityTransportError("INVALID_CONFIG", "profitability endpoint is invalid"); } if (parsed.protocol !== "https:") throw new BusinessProfitabilityTransportError("INVALID_CONFIG", "profitability endpoint must use https"); if (parsed.username || parsed.password || parsed.hash) throw new BusinessProfitabilityTransportError("INVALID_CONFIG", "profitability endpoint must not contain credentials or fragment"); return parsed.toString(); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", "profitability response must be an object"); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>): void { const allowed = new Set(["customerId", "scopeKind", "scopeId", "windowStart", "windowEnd", "revenueMicros", "grossProfitBeforeAdSpendMicros", "qualifiedConversions", "observedAt", "sourceId"]); for (const key of Object.keys(value)) if (!allowed.has(key)) throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", `profitability response contains unknown field ${key}`); }
function stringField(value: Record<string, unknown>, key: string): string { const item = value[key]; if (typeof item !== "string" || !item) throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", `${key} must be a non-empty string`); return item; }
function numberField(value: Record<string, unknown>, key: string, integer: boolean): number { const item = value[key]; if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || (integer && !Number.isSafeInteger(item))) throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", `${key} is invalid`); return item; }
async function boundedJson(response: Response): Promise<unknown> { const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(); if (contentType !== "application/json") throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", "profitability response must use application/json"); if (!response.body) throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", "profitability response body is missing"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0; try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", `profitability response exceeds ${MAX_RESPONSE_BYTES} bytes`); } chunks.push(next.value); } } finally { reader.releaseLock(); } const merged = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; } try { return JSON.parse(new TextDecoder().decode(merged)) as unknown; } catch { throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", "profitability response contains malformed JSON"); } }

export class HttpBusinessProfitabilityProvider implements BusinessProfitabilityProvider {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(config: HttpBusinessProfitabilityProviderConfig) { this.endpoint = endpoint(config.endpoint); this.token = requireToken(config.bearerToken); this.fetchImpl = config.fetchImpl ?? fetch; this.timeoutMs = timeout(config.timeoutMs); }
  async getProfitability(query: BusinessProfitabilityQuery): Promise<BusinessProfitabilitySnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(query), signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new BusinessProfitabilityTransportError("TIMEOUT", "profitability request timed out");
      throw new BusinessProfitabilityTransportError("HTTP_ERROR", error instanceof Error ? error.message : "profitability transport failed");
    } finally { clearTimeout(timer); }
    if (!response.ok) throw new BusinessProfitabilityTransportError("HTTP_ERROR", `profitability endpoint returned HTTP ${response.status}`);
    const payload = object(await boundedJson(response)); exactKeys(payload);
    const snapshot: BusinessProfitabilitySnapshot = Object.freeze({
      customerId: stringField(payload, "customerId"),
      scopeKind: stringField(payload, "scopeKind") as BusinessProfitabilitySnapshot["scopeKind"],
      scopeId: stringField(payload, "scopeId"),
      windowStart: stringField(payload, "windowStart"),
      windowEnd: stringField(payload, "windowEnd"),
      revenueMicros: numberField(payload, "revenueMicros", true),
      grossProfitBeforeAdSpendMicros: numberField(payload, "grossProfitBeforeAdSpendMicros", true),
      qualifiedConversions: numberField(payload, "qualifiedConversions", false),
      observedAt: stringField(payload, "observedAt"),
      sourceId: stringField(payload, "sourceId"),
    });
    if (!(snapshot.scopeKind === "CAMPAIGN" || snapshot.scopeKind === "BIDDING_STRATEGY")) throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", "scopeKind is invalid");
    if (!IDENTIFIER.test(snapshot.sourceId)) throw new BusinessProfitabilityTransportError("INVALID_RESPONSE", "sourceId is malformed");
    return snapshot;
  }
}