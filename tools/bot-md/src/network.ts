import dns from "node:dns/promises";
import net from "node:net";
import type { BrowserContext } from "playwright";
import type { Issue } from "./types.js";
import { remoteDNSAllowed } from "./transport.js";

export function privateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (a.includes(":"))
    return (
      a === "::1" ||
      a === "::" ||
      a.startsWith("fc") ||
      a.startsWith("fd") ||
      /^fe[89ab]/.test(a) ||
      a.startsWith("ff") ||
      a.startsWith("::ffff:")
    );
  const p = a.split(".").map(Number);
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 198 && [18, 19].includes(p[1]))
  );
}
export async function allowedURL(input: string, allowLocalhost: boolean) {
  const u = new URL(input);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (allowLocalhost && ["localhost", "127.0.0.1", "::1"].includes(h))
    return true;
  if (!net.isIP(h) && remoteDNSAllowed(h)) return true;
  const addresses = net.isIP(h)
    ? [h]
    : (await dns.lookup(h, { all: true })).map((a) => a.address);
  return addresses.length > 0 && addresses.every((a) => !privateAddress(a));
}
export async function installCapturePolicy(
  context: BrowserContext,
  allowLocalhost: boolean,
  issues: Issue[],
) {
  const cache = new Map<string, boolean>();
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (!["GET", "HEAD"].includes(req.method())) {
      issues.push({
        code: "WRITE_BLOCKED",
        detail: req.method() + " " + req.url(),
      });
      await route.abort();
      return;
    }
    try {
      const origin = new URL(req.url()).origin;
      let allowed = cache.get(origin);
      if (allowed === undefined) {
        allowed = await allowedURL(req.url(), allowLocalhost);
        cache.set(origin, allowed);
      }
      if (!allowed) {
        issues.push({ code: "NETWORK_BLOCKED", detail: req.url() });
        await route.abort();
      } else await route.continue();
    } catch {
      issues.push({ code: "NETWORK_FAILED", detail: req.url() });
      await route.abort();
    }
  });
  await context.routeWebSocket("**/*", (ws) => {
    issues.push({ code: "WEBSOCKET_UNSUPPORTED", detail: ws.url() });
    ws.close();
  });
}
