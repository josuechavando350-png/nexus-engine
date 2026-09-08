import { resolve4, resolve6, resolveMx, resolveNs } from "node:dns/promises";
import { isIP } from "node:net";
import { normalizeDomainName } from "./rdap-client.js";

const MAX_RECORDS_PER_TYPE = 64;

export interface DnsMxRecord {
  readonly exchange: string;
  readonly priority: number;
}

export interface DomainDnsSnapshot {
  readonly domain: string;
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
  readonly mx: readonly DnsMxRecord[];
  readonly nameservers: readonly string[];
  readonly webAddressable: boolean;
  readonly mailRouted: boolean;
  readonly dnsActive: boolean;
}

export interface DnsResolverPort {
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
  resolveMx(hostname: string): Promise<readonly { exchange: string; priority: number }[]>;
  resolveNs(hostname: string): Promise<readonly string[]>;
}

export class DnsIntelligenceError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "DNS_ERROR" | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "DnsIntelligenceError";
  }
}

function dnsCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isAbsent(error: unknown): boolean {
  const code = dnsCode(error);
  return code === "ENODATA" || code === "ENOTFOUND" || code === "ENONAME";
}

async function optionalQuery<T>(query: () => Promise<readonly T[]>): Promise<readonly T[]> {
  try {
    const records = await query();
    if (!Array.isArray(records)) throw new DnsIntelligenceError("INVALID_RESPONSE", "DNS resolver returned a non-array response");
    if (records.length > MAX_RECORDS_PER_TYPE) throw new DnsIntelligenceError("INVALID_RESPONSE", "DNS resolver returned too many records");
    return records;
  } catch (error) {
    if (isAbsent(error)) return Object.freeze([]);
    if (error instanceof DnsIntelligenceError) throw error;
    throw new DnsIntelligenceError("DNS_ERROR", `DNS lookup failed${dnsCode(error) ? ` (${dnsCode(error)})` : ""}`);
  }
}

function defaultResolver(): DnsResolverPort {
  return {
    resolve4: async (hostname) => resolve4(hostname),
    resolve6: async (hostname) => resolve6(hostname),
    resolveMx: async (hostname) => resolveMx(hostname),
    resolveNs: async (hostname) => resolveNs(hostname),
  };
}

function normalizeIpAddresses(records: readonly string[], version: 4 | 6): readonly string[] {
  const output: string[] = [];
  for (const item of records) {
    if (typeof item !== "string" || isIP(item) !== version) throw new DnsIntelligenceError("INVALID_RESPONSE", `DNS returned a malformed IPv${version} address`);
    output.push(item.toLowerCase());
  }
  return Object.freeze([...new Set(output)].sort());
}

function normalizeMx(records: readonly { exchange: string; priority: number }[]): readonly DnsMxRecord[] {
  const output: DnsMxRecord[] = [];
  for (const item of records) {
    if (!item || typeof item !== "object" || typeof item.exchange !== "string" || !Number.isInteger(item.priority) || item.priority < 0 || item.priority > 65_535) {
      throw new DnsIntelligenceError("INVALID_RESPONSE", "DNS returned a malformed MX record");
    }
    output.push(Object.freeze({ exchange: normalizeDomainName(item.exchange), priority: item.priority }));
  }
  return Object.freeze(output.sort((left, right) => left.priority - right.priority || left.exchange.localeCompare(right.exchange, "en")));
}

function normalizeNameservers(records: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(records.map((item) => normalizeDomainName(item)))].sort());
}

export class NodeDnsDomainIntelligenceClient {
  private readonly resolver: DnsResolverPort;

  constructor(resolver: DnsResolverPort = defaultResolver()) {
    if (!resolver || typeof resolver !== "object") throw new DnsIntelligenceError("INVALID_INPUT", "DNS resolver is required");
    for (const method of ["resolve4", "resolve6", "resolveMx", "resolveNs"] as const) {
      if (typeof resolver[method] !== "function") throw new DnsIntelligenceError("INVALID_INPUT", `DNS resolver is missing ${method}`);
    }
    this.resolver = resolver;
  }

  async inspect(input: string): Promise<DomainDnsSnapshot> {
    const domain = normalizeDomainName(input);
    const [ipv4Raw, ipv6Raw, mxRaw, nsRaw] = await Promise.all([
      optionalQuery(() => this.resolver.resolve4(domain)),
      optionalQuery(() => this.resolver.resolve6(domain)),
      optionalQuery(() => this.resolver.resolveMx(domain)),
      optionalQuery(() => this.resolver.resolveNs(domain)),
    ]);
    const ipv4 = normalizeIpAddresses(ipv4Raw as readonly string[], 4);
    const ipv6 = normalizeIpAddresses(ipv6Raw as readonly string[], 6);
    const mx = normalizeMx(mxRaw as readonly { exchange: string; priority: number }[]);
    const nameservers = normalizeNameservers(nsRaw as readonly string[]);
    return Object.freeze({
      domain,
      ipv4,
      ipv6,
      mx,
      nameservers,
      webAddressable: ipv4.length > 0 || ipv6.length > 0,
      mailRouted: mx.length > 0,
      dnsActive: ipv4.length > 0 || ipv6.length > 0 || mx.length > 0 || nameservers.length > 0,
    });
  }
}
