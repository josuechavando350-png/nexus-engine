import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

export interface PublicAddress { readonly address: string; readonly family: 4 | 6 }
export type LookupPublic = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 100 && b! >= 64 && b! <= 127 || a === 127 || a === 169 && b === 254
    || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 0 || b === 168) || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 || a === 203 && b === 0 || a! >= 224;
}

function isPrivateIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/u.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8:")
    || normalized.startsWith("2001:2:") || normalized.startsWith("2001:10:")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return false;
}

async function defaultLookup(hostname: string): Promise<readonly { address: string; family: number }[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function resolvePublicAddress(url: string, lookup: LookupPublic = defaultLookup): Promise<PublicAddress> {
  const parsed = new URL(url);
  const literalFamily = isIP(parsed.hostname);
  if (literalFamily) {
    if (isPrivateIp(parsed.hostname)) throw new Error("private or reserved IP destination is forbidden");
    return Object.freeze({ address: parsed.hostname, family: literalFamily as 4 | 6 });
  }
  const addresses = await lookup(parsed.hostname);
  if (addresses.length === 0) throw new Error("hostname did not resolve");
  const normalized = addresses.map(({ address, family }) => ({ address, family }));
  if (normalized.some(({ address }) => isPrivateIp(address))) throw new Error("hostname resolves to a private or reserved destination");
  const selected = normalized.find(({ family }) => family === 4 || family === 6);
  if (!selected || (selected.family !== 4 && selected.family !== 6)) throw new Error("hostname resolved to an unsupported address family");
  return Object.freeze({ address: selected.address, family: selected.family });
}

export async function requestPinnedPublicUrl(url: string, signal: AbortSignal, lookup?: LookupPublic): Promise<Response> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("request cancelled");
  const parsed = new URL(url);
  const pinned = await resolvePublicAddress(url, lookup);
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("request cancelled");
  return new Promise<Response>((resolve, reject) => {
    const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const pinnedLookup = ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
      callback(null, pinned.address, pinned.family);
    }) as unknown as LookupFunction;
    const request = requestFn(parsed, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "user-agent": "NEXUS-Competitive-Observation/1.0" },
      lookup: pinnedLookup,
      ...(parsed.protocol === "https:" ? { servername: parsed.hostname } : {}),
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, String(value));
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on("data", (chunk: Buffer | Uint8Array | string) => controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk)));
          response.on("end", () => controller.close());
          response.on("error", (error) => controller.error(error));
        },
        cancel() { response.destroy(); },
      });
      resolve(new Response(body, { status: response.statusCode ?? 599, statusText: response.statusMessage, headers }));
    });
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("request cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal.removeEventListener("abort", onAbort));
    request.once("error", reject);
    request.end();
  });
}
