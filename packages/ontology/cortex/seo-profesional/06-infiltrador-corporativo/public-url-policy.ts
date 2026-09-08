import { isIP } from "node:net";

export class PublicUrlPolicyError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "ORIGIN_NOT_ALLOWED" | "NON_PUBLIC_ADDRESS", message: string) {
    super(message);
    this.name = "PublicUrlPolicyError";
  }
}

export interface PublicDnsResolverPort {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface PublicUrlAuthorization {
  readonly url: string;
  readonly origin: string;
  readonly addresses: readonly string[];
}

function assertPublicIpv4(ip: string): void {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `resolved IPv4 address is malformed: ${ip}`);
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
  if (blocked) throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `resolved IPv4 address is not public: ${ip}`);
}

function ipv6Words(ip: string): number[] {
  let input = ip.toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  if (input.includes(".")) throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `IPv4-mapped IPv6 is not accepted: ${ip}`);
  const halves = input.split("::");
  if (halves.length > 2) throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is malformed: ${ip}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if ((halves.length === 1 && left.length !== 8) || left.length + right.length > 8) {
    throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is malformed: ${ip}`);
  }
  const missing = 8 - left.length - right.length;
  const raw = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (raw.length !== 8 || raw.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) {
    throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is malformed: ${ip}`);
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
    throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `resolved IPv6 address is not public: ${ip}`);
  }
}

function assertPublicAddress(ip: string): void {
  const family = isIP(ip);
  if (family === 4) assertPublicIpv4(ip);
  else if (family === 6) assertPublicIpv6(ip);
  else throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", `resolver returned a non-IP address: ${ip}`);
}

export class PublicProcurementUrlPolicy {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(allowedOrigins: readonly string[], private readonly resolver: PublicDnsResolverPort) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length < 1 || allowedOrigins.length > 64 || !resolver || typeof resolver.resolve !== "function") {
      throw new PublicUrlPolicyError("INVALID_INPUT", "public procurement URL policy configuration is invalid");
    }
    const normalized = new Set<string>();
    for (const raw of allowedOrigins) {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/") {
        throw new PublicUrlPolicyError("INVALID_INPUT", "allowed procurement origins must be bare HTTPS origins");
      }
      normalized.add(url.origin);
    }
    this.allowedOrigins = normalized;
  }

  async authorize(input: URL): Promise<PublicUrlAuthorization> {
    if (!(input instanceof URL) || input.protocol !== "https:" || input.username || input.password) {
      throw new PublicUrlPolicyError("INVALID_INPUT", "procurement source URL must be HTTPS without embedded credentials");
    }
    if (!this.allowedOrigins.has(input.origin)) {
      throw new PublicUrlPolicyError("ORIGIN_NOT_ALLOWED", `procurement origin is not allowlisted: ${input.origin}`);
    }
    const addresses = await this.resolver.resolve(input.hostname);
    if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 16) {
      throw new PublicUrlPolicyError("NON_PUBLIC_ADDRESS", "procurement host must resolve to 1..16 public addresses");
    }
    for (const address of addresses) assertPublicAddress(address);
    return Object.freeze({ url: input.toString(), origin: input.origin, addresses: Object.freeze([...addresses]) });
  }
}
