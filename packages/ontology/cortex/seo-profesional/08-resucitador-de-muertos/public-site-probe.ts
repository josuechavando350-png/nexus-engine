import { lookup } from "node:dns/promises";
import { request as httpsRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:https";
import { isIP } from "node:net";

export class PassivePublicSiteProbeError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "NON_PUBLIC_ADDRESS" | "REDIRECT_DENIED" | "NETWORK_FAILURE" | "BOUNDS_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "PassivePublicSiteProbeError";
  }
}

export interface PassiveDnsResolverPort {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface PinnedHttpsTransportResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface PinnedHttpsTransportPort {
  get(url: URL, pinnedAddress: string, timeoutMs: number): Promise<PinnedHttpsTransportResponse>;
}

export interface PassivePublicSiteEvidence {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly html: string;
  readonly capturedAt: string;
  readonly source: "PINNED_HTTPS_PUBLIC_HOMEPAGE";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_REDIRECTS = 3;
const KEPT_HEADERS = new Set(["server", "x-powered-by", "cf-ray", "x-vercel-id", "x-nf-request-id", "content-type", "content-length", "etag", "last-modified"]);

function assertPublicIpv4(ip: string): void {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `resolved IPv4 address is malformed: ${ip}`);
  }
  const [a, b, c] = octets as [number, number, number, number];
  const blocked = a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
  if (blocked) throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `resolved IPv4 address is not public: ${ip}`);
}

function ipv6Words(ip: string): number[] {
  let input = ip.toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  if (input.includes(".")) throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `IPv4-mapped IPv6 is not accepted: ${ip}`);
  const halves = input.split("::");
  if (halves.length > 2) throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is malformed: ${ip}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if ((halves.length === 1 && left.length !== 8) || left.length + right.length > 8) {
    throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is malformed: ${ip}`);
  }
  const missing = 8 - left.length - right.length;
  const raw = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (raw.length !== 8 || raw.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) {
    throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is malformed: ${ip}`);
  }
  return raw.map((word) => Number.parseInt(word, 16));
}

function assertPublicIpv6(ip: string): void {
  const words = ipv6Words(ip);
  const [w0, w1, w2, w3, w4, w5] = words as [number, number, number, number, number, number, number, number];
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const uniqueLocal = (w0 & 0xfe00) === 0xfc00;
  const linkLocal = (w0 & 0xffc0) === 0xfe80;
  const multicast = (w0 & 0xff00) === 0xff00;
  const documentation = w0 === 0x2001 && w1 === 0x0db8;
  const ipv4Mapped = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff;
  if (allZero || loopback || uniqueLocal || linkLocal || multicast || documentation || ipv4Mapped) {
    throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is not public: ${ip}`);
  }
}

function assertPublicAddress(ip: string): void {
  const family = isIP(ip);
  if (family === 4) assertPublicIpv4(ip);
  else if (family === 6) assertPublicIpv6(ip);
  else throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", `resolver returned a non-IP address: ${ip}`);
}

function canonicalHomepage(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new PassivePublicSiteProbeError("INVALID_INPUT", "candidate website URL must be absolute"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") || url.pathname !== "/") {
    throw new PassivePublicSiteProbeError("INVALID_INPUT", "candidate website must be a bare HTTPS origin on port 443");
  }
  if (isIP(url.hostname) !== 0) throw new PassivePublicSiteProbeError("INVALID_INPUT", "candidate website must use a DNS hostname");
  return url;
}

function keptHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") result[name] = value.slice(0, 2_048);
    else if (Array.isArray(value)) result[name] = value.join(", ").slice(0, 2_048);
  }
  return Object.freeze(result);
}

const defaultResolver: PassiveDnsResolverPort = Object.freeze({
  resolve: async (hostname: string) => {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return Object.freeze(records.map((record) => record.address));
  },
});

async function readBody(response: IncomingMessage, declaredLength: string | undefined): Promise<string> {
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > MAX_BODY_BYTES) throw new PassivePublicSiteProbeError("BOUNDS_EXCEEDED", "public homepage response exceeds passive body limit");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new PassivePublicSiteProbeError("BOUNDS_EXCEEDED", "public homepage response exceeds passive body limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class NodePinnedHttpsTransport implements PinnedHttpsTransportPort {
  async get(url: URL, pinnedAddress: string, timeoutMs: number): Promise<PinnedHttpsTransportResponse> {
    const family = isIP(pinnedAddress);
    if (family === 0) throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", "pinned transport requires an IP address");
    return await new Promise((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:",
        hostname: pinnedAddress,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        agent: false,
        headers: {
          host: url.host,
          accept: "text/html,application/xhtml+xml;q=0.9",
          "accept-encoding": "identity",
          "user-agent": "NexusSEO8PassiveProbe/1.0",
          "x-nexus-passive-probe": "1",
        },
      }, async (response) => {
        try {
          const status = response.statusCode ?? 0;
          if (status < 100 || status > 599) throw new PassivePublicSiteProbeError("NETWORK_FAILURE", "public homepage returned an invalid HTTP status");
          const body = await readBody(response, typeof response.headers["content-length"] === "string" ? response.headers["content-length"] : undefined);
          resolve(Object.freeze({ status, headers: response.headers, body }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("passive homepage request timed out")));
      request.once("error", (error) => reject(new PassivePublicSiteProbeError("NETWORK_FAILURE", `passive homepage request failed: ${error.message}`)));
      request.end();
    });
  }
}

export class PassivePublicSiteProbe {
  private readonly resolver: PassiveDnsResolverPort;
  private readonly transport: PinnedHttpsTransportPort;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(input: {
    readonly resolver?: PassiveDnsResolverPort;
    readonly transport?: PinnedHttpsTransportPort;
    readonly now?: () => number;
    readonly timeoutMs?: number;
  } = {}) {
    this.resolver = input.resolver ?? defaultResolver;
    this.transport = input.transport ?? new NodePinnedHttpsTransport();
    this.now = input.now ?? Date.now;
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!this.resolver || typeof this.resolver.resolve !== "function" || !this.transport || typeof this.transport.get !== "function" || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new PassivePublicSiteProbeError("INVALID_INPUT", "passive site probe configuration is invalid");
    }
  }

  private async resolvePublic(hostname: string): Promise<readonly string[]> {
    const addresses = await this.resolver.resolve(hostname);
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 16) {
      throw new PassivePublicSiteProbeError("NON_PUBLIC_ADDRESS", "candidate website must resolve to 1..16 public addresses");
    }
    for (const address of addresses) assertPublicAddress(address);
    return addresses;
  }

  async inspect(websiteUrl: string): Promise<PassivePublicSiteEvidence> {
    const requested = canonicalHomepage(websiteUrl);
    let current = new URL(requested.toString());
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const addresses = await this.resolvePublic(current.hostname);
      const response = await this.transport.get(current, addresses[0]!, this.timeoutMs);
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && typeof location === "string") {
        if (redirectCount === MAX_REDIRECTS) throw new PassivePublicSiteProbeError("REDIRECT_DENIED", "public homepage exceeded redirect limit");
        const next = new URL(location, current);
        if (next.protocol !== "https:" || next.origin !== requested.origin || next.username || next.password) {
          throw new PassivePublicSiteProbeError("REDIRECT_DENIED", "public homepage redirect left the verified candidate origin");
        }
        current = next;
        continue;
      }
      const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : "";
      const html = /(?:text\/html|application\/xhtml\+xml)/iu.test(contentType) || contentType === "" ? response.body : "";
      return Object.freeze({
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        status: response.status,
        headers: keptHeaders(response.headers),
        html,
        capturedAt: new Date(this.now()).toISOString(),
        source: "PINNED_HTTPS_PUBLIC_HOMEPAGE" as const,
      });
    }
    throw new PassivePublicSiteProbeError("REDIRECT_DENIED", "public homepage redirect state is invalid");
  }
}
