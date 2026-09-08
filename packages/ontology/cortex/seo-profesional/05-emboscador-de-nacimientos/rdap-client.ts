import { domainToASCII } from "node:url";

const IANA_RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_READ_RETRIES = 3;

export type RdapFetch = typeof fetch;

export interface RdapDomainRecord {
  readonly domain: string;
  readonly registrationDate: string | null;
  readonly lastChangedDate: string | null;
  readonly expirationDate: string | null;
  readonly statuses: readonly string[];
  readonly nameservers: readonly string[];
  readonly registrarHandle: string | null;
  readonly delegationSigned: boolean | null;
}

export type RdapLookupResult =
  | Readonly<{ status: "REGISTERED"; record: RdapDomainRecord }>
  | Readonly<{ status: "NOT_REGISTERED"; domain: string }>;

export interface IanaRdapClientConfig {
  readonly fetchImpl?: RdapFetch;
  readonly timeoutMs?: number;
  readonly maxReadRetries?: number;
  readonly bootstrapTtlMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class RdapClientError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIG"
      | "INVALID_INPUT"
      | "BOOTSTRAP_ERROR"
      | "QUOTA_EXHAUSTED"
      | "API_ERROR"
      | "INVALID_RESPONSE"
      | "TIMEOUT",
    message: string,
    public readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "RdapClientError";
  }
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeDomainName(value: unknown): string {
  if (typeof value !== "string") throw new RdapClientError("INVALID_INPUT", "domain must be a string");
  const input = value.normalize("NFKC").trim().replace(/\.+$/u, "").toLowerCase();
  if (!input || input.length > 253 || containsControlCharacters(input)) {
    throw new RdapClientError("INVALID_INPUT", "domain is empty, oversized, or malformed");
  }
  const ascii = domainToASCII(input).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii.includes("..")) throw new RdapClientError("INVALID_INPUT", "domain cannot be converted to valid DNS form");
  const labels = ascii.split(".");
  if (labels.length < 2) throw new RdapClientError("INVALID_INPUT", "domain must include a public suffix label");
  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)) {
      throw new RdapClientError("INVALID_INPUT", "domain contains a malformed label");
    }
  }
  return ascii;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RdapClientError("INVALID_CONFIG", `${label} is outside the supported range`);
  }
  return resolved;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await discardBody(response);
    throw new RdapClientError("INVALID_RESPONSE", "RDAP response declared an invalid or oversized body", response.status);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RdapClientError("INVALID_RESPONSE", "RDAP response exceeded the bounded body size", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function discardBody(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // Disposal is best-effort and must not replace the authoritative API outcome.
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await readBoundedBody(response);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RdapClientError("INVALID_RESPONSE", "RDAP returned malformed JSON", response.status);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RdapClientError("INVALID_RESPONSE", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function canonicalUtc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function eventDate(events: unknown, action: string): string | null {
  if (!Array.isArray(events)) return null;
  for (const item of events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = item as Record<string, unknown>;
    if (event.eventAction === action) return canonicalUtc(event.eventDate);
  }
  return null;
}

function strings(value: unknown, maxItems = 128, maxLength = 512): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const output: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== "string") continue;
    const normalized = item.normalize("NFKC").trim();
    if (!normalized || normalized.length > maxLength || containsControlCharacters(normalized)) continue;
    output.push(normalized);
  }
  return Object.freeze([...new Set(output)]);
}

function parseNameservers(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const output: string[] = [];
  for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.ldhName !== "string") continue;
    try {
      output.push(normalizeDomainName(raw.ldhName));
    } catch {
      // Ignore malformed server names returned by a remote RDAP implementation.
    }
  }
  return Object.freeze([...new Set(output)].sort());
}

function registrarHandle(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (!Array.isArray(raw.roles) || !raw.roles.includes("registrar")) continue;
    if (typeof raw.handle !== "string") return null;
    const normalized = raw.handle.normalize("NFKC").trim();
    if (!normalized || normalized.length > 256 || containsControlCharacters(normalized)) return null;
    return normalized;
  }
  return null;
}

function parseRecord(payload: unknown, expectedDomain: string): RdapDomainRecord {
  const raw = object(payload, "RDAP domain response");
  if (typeof raw.ldhName !== "string") throw new RdapClientError("INVALID_RESPONSE", "RDAP domain response is missing ldhName");
  const returnedDomain = normalizeDomainName(raw.ldhName);
  if (returnedDomain !== expectedDomain) throw new RdapClientError("INVALID_RESPONSE", "RDAP returned a different domain");
  const secureDns = raw.secureDNS && typeof raw.secureDNS === "object" && !Array.isArray(raw.secureDNS)
    ? raw.secureDNS as Record<string, unknown>
    : null;
  return Object.freeze({
    domain: expectedDomain,
    registrationDate: eventDate(raw.events, "registration"),
    lastChangedDate: eventDate(raw.events, "last changed"),
    expirationDate: eventDate(raw.events, "expiration"),
    statuses: strings(raw.status, 64, 128),
    nameservers: parseNameservers(raw.nameservers),
    registrarHandle: registrarHandle(raw.entities),
    delegationSigned: typeof secureDns?.delegationSigned === "boolean" ? secureDns.delegationSigned : null,
  });
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class IanaRdapClient {
  private readonly fetchImpl: RdapFetch;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly bootstrapTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private bootstrapCache: { expiresAt: number; services: ReadonlyMap<string, string> } | null = null;

  constructor(config: IanaRdapClientConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 30_000, "timeoutMs");
    this.maxReadRetries = boundedInteger(config.maxReadRetries, 1, 0, MAX_READ_RETRIES, "maxReadRetries");
    this.bootstrapTtlMs = boundedInteger(config.bootstrapTtlMs, DEFAULT_BOOTSTRAP_TTL_MS, 60_000, 7 * 24 * 60 * 60 * 1_000, "bootstrapTtlMs");
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async lookupDomain(input: string): Promise<RdapLookupResult> {
    const domain = normalizeDomainName(input);
    const tld = domain.split(".").at(-1)!;
    const services = await this.bootstrapServices();
    const base = services.get(tld);
    if (!base) throw new RdapClientError("BOOTSTRAP_ERROR", `IANA RDAP bootstrap has no service for .${tld}`);
    const url = new URL(`domain/${encodeURIComponent(domain)}`, base).href;
    const response = await this.read(url, "application/rdap+json, application/json");
    if (response.status === 404) {
      await discardBody(response);
      return Object.freeze({ status: "NOT_REGISTERED", domain });
    }
    if (!response.ok) {
      await discardBody(response);
      this.throwHttp(response.status, "RDAP domain lookup failed");
    }
    return Object.freeze({ status: "REGISTERED", record: parseRecord(await boundedJson(response), domain) });
  }

  private async bootstrapServices(): Promise<ReadonlyMap<string, string>> {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RdapClientError("INVALID_CONFIG", "clock returned a non-finite timestamp");
    if (this.bootstrapCache && this.bootstrapCache.expiresAt > now) return this.bootstrapCache.services;
    const response = await this.read(IANA_RDAP_BOOTSTRAP_URL, "application/json");
    if (!response.ok) {
      await discardBody(response);
      this.throwHttp(response.status, "IANA RDAP bootstrap lookup failed");
    }
    const payload = object(await boundedJson(response), "IANA RDAP bootstrap");
    if (!Array.isArray(payload.services)) throw new RdapClientError("BOOTSTRAP_ERROR", "IANA RDAP bootstrap services are missing");
    const services = new Map<string, string>();
    for (const service of payload.services) {
      if (!Array.isArray(service) || service.length !== 2 || !Array.isArray(service[0]) || !Array.isArray(service[1])) continue;
      const urls = service[1].filter((item): item is string => typeof item === "string");
      const chosen = urls.find((candidate) => {
        try {
          const parsed = new URL(candidate);
          return parsed.protocol === "https:" && !parsed.username && !parsed.password;
        } catch {
          return false;
        }
      });
      if (!chosen) continue;
      const base = chosen.endsWith("/") ? chosen : `${chosen}/`;
      for (const rawTld of service[0]) {
        if (typeof rawTld !== "string") continue;
        const tld = rawTld.trim().toLowerCase().replace(/^\./u, "");
        if (/^[a-z0-9-]{2,63}$/u.test(tld)) services.set(tld, base);
      }
    }
    if (services.size === 0) throw new RdapClientError("BOOTSTRAP_ERROR", "IANA RDAP bootstrap contained no usable HTTPS services");
    const frozen = new Map(services);
    this.bootstrapCache = { expiresAt: now + this.bootstrapTtlMs, services: frozen };
    return frozen;
  }

  private async read(url: string, accept: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxReadRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept, "user-agent": "nexus-engine-rdap/1.0" },
          redirect: "error",
          signal: controller.signal,
        });
        if (!retryableStatus(response.status) || attempt === this.maxReadRetries) return response;
        lastError = new RdapClientError(response.status === 429 ? "QUOTA_EXHAUSTED" : "API_ERROR", "RDAP read returned a retryable status", response.status);
        await discardBody(response);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxReadRetries) {
          if (error instanceof Error && error.name === "AbortError") throw new RdapClientError("TIMEOUT", "RDAP read timed out");
          throw new RdapClientError("API_ERROR", "RDAP read failed before receiving a response");
        }
      } finally {
        clearTimeout(timeout);
      }
      await this.sleep(Math.min(1_000, 100 * 2 ** attempt));
    }
    throw lastError instanceof Error ? lastError : new RdapClientError("API_ERROR", "RDAP read failed");
  }

  private throwHttp(status: number, message: string): never {
    if (status === 429) throw new RdapClientError("QUOTA_EXHAUSTED", message, status);
    throw new RdapClientError("API_ERROR", message, status);
  }
}
