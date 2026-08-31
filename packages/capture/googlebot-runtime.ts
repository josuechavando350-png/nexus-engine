import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { chromium, type Browser, type Route } from "playwright";
import {
  canonicalGooglebotTimestamp,
  canonicalGooglebotUrl,
  normalizeGooglebotRenderSnapshot,
  type GooglebotEvidenceSource,
  type GooglebotRenderSnapshot,
} from "./googlebot-render-diff.js";

export const GOOGLEBOT_SMARTPHONE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export interface GooglebotRuntimeControl {
  signal?: AbortSignal;
  timeoutMs?: number;
  clock?: () => Date;
  toolVersion?: string;
}

export interface GooglebotSimulationOptions extends GooglebotRuntimeControl {
  viewport?: Readonly<{ width: number; height: number }>;
  maxHtmlBytes?: number;
  maxTextChars?: number;
  maxScreenshotBytes?: number;
  maxObservedHosts?: number;
}

export interface GooglebotFetchOptions extends GooglebotRuntimeControl {
  maxResponseBytes?: number;
  maxRedirects?: number;
  allowedOrigins?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 250_000;
const DEFAULT_MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_REDIRECTS = 10;
const DEFAULT_MAX_OBSERVED_HOSTS = 64;
const MAX_OBSERVED_HOSTS = 256;
const RUNTIME_TOOL_VERSION = "nexus-capture-googlebot/1.0.0";

const RESERVED_IPS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) RESERVED_IPS.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["2001:db8::", 32],
] as const) RESERVED_IPS.addSubnet(network, prefix, "ipv6");

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function boundedInteger(value: number | undefined, fallback: number, field: string, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return resolved;
}

function nowIso(clock: (() => Date) | undefined): string {
  return canonicalGooglebotTimestamp((clock?.() ?? new Date()).toISOString());
}

function toolVersion(value: string | undefined): string {
  const resolved = (value ?? RUNTIME_TOOL_VERSION).trim();
  if (!resolved || resolved.length > 256) throw new Error("toolVersion must be between 1 and 256 characters");
  return resolved;
}

function unavailableSnapshot(
  source: GooglebotEvidenceSource,
  url: string,
  reason: string,
  control: GooglebotRuntimeControl,
  status: "UNAVAILABLE" | "NOT_VERIFIED" = "NOT_VERIFIED",
): GooglebotRenderSnapshot {
  return normalizeGooglebotRenderSnapshot({
    source,
    status,
    url,
    observedAt: nowIso(control.clock),
    userAgent: source === "GOOGLE_SEARCH_CONSOLE_API" ? "NOT_EXPOSED_BY_URL_INSPECTION_API" : GOOGLEBOT_SMARTPHONE_USER_AGENT,
    toolVersion: toolVersion(control.toolVersion),
    htmlDigest: null,
    textDigest: null,
    screenshotDigest: null,
    apiPayloadDigest: null,
    reason,
  });
}

function normalizedTimeout(value: number | undefined): number {
  return boundedInteger(value, DEFAULT_TIMEOUT_MS, "timeoutMs", 100, MAX_TIMEOUT_MS);
}

function assertPublicIp(address: string): void {
  const normalized = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(normalized);
  if (family === 0) throw new Error(`invalid resolved IP address: ${address}`);
  const familyName = family === 4 ? "ipv4" : "ipv6";
  if (RESERVED_IPS.check(normalized, familyName)) throw new Error(`private or reserved ${familyName.toUpperCase()} target is blocked: ${normalized}`);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, label: string): Promise<T> {
  if (signal?.aborted) throw new Error(`${label} cancelled`);
  let timeout: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  const abortPromise = signal === undefined
    ? new Promise<never>(() => undefined)
    : new Promise<never>((_, reject) => {
      abortHandler = () => reject(new Error(`${label} cancelled`));
      signal.addEventListener("abort", abortHandler, { once: true });
    });
  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (signal !== undefined && abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
  }
}

async function assertPublicHostname(url: URL, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (unbracketedHostname === "localhost" || unbracketedHostname.endsWith(".localhost") || unbracketedHostname.endsWith(".local") || unbracketedHostname.endsWith(".internal")) {
    throw new Error(`local hostname is blocked: ${unbracketedHostname}`);
  }
  const directFamily = isIP(unbracketedHostname);
  if (directFamily !== 0) {
    assertPublicIp(unbracketedHostname);
    return;
  }
  const addresses = await raceAbort(lookup(unbracketedHostname, { all: true, verbatim: true }), signal, Math.min(timeoutMs, 5_000), "DNS resolution");
  if (addresses.length === 0) throw new Error(`hostname did not resolve: ${unbracketedHostname}`);
  for (const address of addresses) assertPublicIp(address.address);
}

function safeUrl(raw: string): URL {
  return new URL(canonicalGooglebotUrl(raw));
}

function normalizedAllowedOrigins(url: URL, values: readonly string[] | undefined): ReadonlySet<string> {
  const origins = new Set<string>([url.origin]);
  for (const value of values ?? []) {
    const parsed = safeUrl(value);
    origins.add(parsed.origin);
  }
  if (origins.size > 16) throw new Error("allowedOrigins exceeds 16 origins");
  return origins;
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new Error(`HTTP response Content-Length exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new Error("HTTP body read cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isHtmlContentType(value: string | null): boolean {
  if (value === null) return false;
  const type = value.split(";", 1)[0]?.trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

export async function observeHttpFetchAsGooglebot(urlInput: string, options: GooglebotFetchOptions = {}): Promise<GooglebotRenderSnapshot> {
  const url = safeUrl(urlInput);
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, DEFAULT_MAX_HTML_BYTES, "maxResponseBytes", 1, MAX_ARTIFACT_BYTES);
  const maxRedirects = boundedInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, "maxRedirects", 0, MAX_REDIRECTS);
  const allowedOrigins = normalizedAllowedOrigins(url, options.allowedOrigins);
  let current = url;

  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      if (!allowedOrigins.has(current.origin)) throw new Error(`redirect origin is not approved: ${current.origin}`);
      await assertPublicHostname(current, options.signal, timeoutMs);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      let response: Response;
      try {
        response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": GOOGLEBOT_SMARTPHONE_USER_AGENT,
            accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          },
        });
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", forwardAbort);
      }

      if (response.status >= 300 && response.status < 400) {
        if (redirects === maxRedirects) throw new Error("HTTP redirect budget exhausted");
        const location = response.headers.get("location");
        if (!location) throw new Error(`HTTP ${response.status} redirect omitted Location`);
        current = safeUrl(new URL(location, current).toString());
        continue;
      }

      if (!isHtmlContentType(response.headers.get("content-type"))) {
        return unavailableSnapshot(
          "OBSERVED_HTTP_FETCH",
          url.toString(),
          `observed HTTP ${response.status}, but response Content-Type was not HTML/XHTML`,
          options,
        );
      }
      const body = await readBoundedBody(response, maxResponseBytes, options.signal);
      return normalizeGooglebotRenderSnapshot({
        source: "OBSERVED_HTTP_FETCH",
        status: "OBSERVED_FETCH",
        url: url.toString(),
        observedAt: nowIso(options.clock),
        userAgent: GOOGLEBOT_SMARTPHONE_USER_AGENT,
        toolVersion: toolVersion(options.toolVersion),
        htmlDigest: sha256(body),
        textDigest: null,
        screenshotDigest: null,
        apiPayloadDigest: null,
        metadata: {
          finalUrl: current.toString(),
          httpStatus: String(response.status),
          contentType: response.headers.get("content-type") ?? "unknown",
          contentBytes: String(body.byteLength),
          evidenceMeaning: "HTTP response observed by NEXUS using a Googlebot user-agent; not proof the request originated from Google",
        },
      });
    }
    throw new Error("HTTP redirect budget exhausted");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "HTTP Googlebot-style fetch failed";
    return unavailableSnapshot(
      "OBSERVED_HTTP_FETCH",
      url.toString(),
      reason,
      options,
      /blocked|cancelled|timed out|abort|resolve|fetch failed|network/iu.test(reason) ? "UNAVAILABLE" : "NOT_VERIFIED",
    );
  }
}

async function routePublicRequest(
  route: Route,
  hostCache: Map<string, Promise<boolean>>,
  hostBudget: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const requestUrl = route.request().url();
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    await route.abort("blockedbyclient");
    return;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
    await route.continue();
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    await route.abort("blockedbyclient");
    return;
  }
  const hostname = parsed.hostname.toLowerCase();
  let check = hostCache.get(hostname);
  if (check === undefined) {
    if (hostCache.size >= hostBudget) {
      await route.abort("blockedbyclient");
      return;
    }
    check = assertPublicHostname(parsed, signal, timeoutMs).then(() => true, () => false);
    hostCache.set(hostname, check);
  }
  if (await check) await route.continue();
  else await route.abort("blockedbyclient");
}

async function launchBoundedBrowser(signal: AbortSignal | undefined, timeoutMs: number): Promise<Browser> {
  if (signal?.aborted) throw new Error("Chromium launch cancelled");
  const launchPromise = chromium.launch({ headless: true, timeout: timeoutMs });
  try {
    return await raceAbort(launchPromise, signal, timeoutMs, "Chromium launch");
  } catch (error) {
    void launchPromise.then((browser) => browser.close(), () => undefined);
    throw error;
  }
}

export async function simulateGooglebotRender(urlInput: string, options: GooglebotSimulationOptions = {}): Promise<GooglebotRenderSnapshot> {
  const url = safeUrl(urlInput);
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  const maxHtmlBytes = boundedInteger(options.maxHtmlBytes, DEFAULT_MAX_HTML_BYTES, "maxHtmlBytes", 1, MAX_ARTIFACT_BYTES);
  const maxTextChars = boundedInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, "maxTextChars", 1, 1_000_000);
  const maxScreenshotBytes = boundedInteger(options.maxScreenshotBytes, DEFAULT_MAX_SCREENSHOT_BYTES, "maxScreenshotBytes", 1, MAX_ARTIFACT_BYTES);
  const maxObservedHosts = boundedInteger(options.maxObservedHosts, DEFAULT_MAX_OBSERVED_HOSTS, "maxObservedHosts", 1, MAX_OBSERVED_HOSTS);
  const viewport = options.viewport ?? { width: 412, height: 915 };
  if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) || viewport.width < 240 || viewport.width > 4_096 || viewport.height < 240 || viewport.height > 4_096) {
    throw new Error("viewport dimensions must be integers from 240 to 4096");
  }

  try {
    await assertPublicHostname(url, options.signal, timeoutMs);
    if (options.signal?.aborted) throw new Error("browser render cancelled");
    const browser = await launchBoundedBrowser(options.signal, timeoutMs);
    try {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        userAgent: GOOGLEBOT_SMARTPHONE_USER_AGENT,
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      try {
        const hostCache = new Map<string, Promise<boolean>>();
        await context.route("**/*", (route) => routePublicRequest(route, hostCache, maxObservedHosts, options.signal, timeoutMs));
        const page = await context.newPage();
        await raceAbort(page.goto(url.toString(), { waitUntil: "networkidle", timeout: timeoutMs }), options.signal, timeoutMs, "Googlebot simulation navigation");
        const html = await raceAbort(page.content(), options.signal, timeoutMs, "rendered HTML extraction");
        const htmlBytes = Buffer.byteLength(html, "utf8");
        if (htmlBytes > maxHtmlBytes) throw new Error(`rendered HTML exceeds ${maxHtmlBytes} bytes`);
        const text = await raceAbort(page.locator("body").innerText({ timeout: Math.min(timeoutMs, 10_000) }), options.signal, timeoutMs, "rendered text extraction");
        if (text.length > maxTextChars) throw new Error(`rendered text exceeds ${maxTextChars} characters`);
        const screenshot = await raceAbort(page.screenshot({ type: "png", fullPage: false, animations: "disabled" }), options.signal, timeoutMs, "render screenshot");
        if (screenshot.byteLength > maxScreenshotBytes) throw new Error(`render screenshot exceeds ${maxScreenshotBytes} bytes`);
        return normalizeGooglebotRenderSnapshot({
          source: "SIMULATED_BROWSER",
          status: "SIMULATED_RENDER",
          url: url.toString(),
          observedAt: nowIso(options.clock),
          userAgent: GOOGLEBOT_SMARTPHONE_USER_AGENT,
          toolVersion: toolVersion(options.toolVersion),
          htmlDigest: sha256(html),
          textDigest: text.length === 0 ? null : sha256(text),
          screenshotDigest: sha256(screenshot),
          apiPayloadDigest: null,
          metadata: {
            browser: "chromium",
            browserVersion: browser.version(),
            viewport: `${viewport.width}x${viewport.height}`,
            screenshotScope: "viewport",
            htmlBytes: String(htmlBytes),
            textChars: String(text.length),
            screenshotBytes: String(screenshot.byteLength),
            observedHosts: String(hostCache.size),
            evidenceMeaning: "NEXUS Playwright prediction of Googlebot-like rendering; not a Google-operated render",
          },
        });
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Googlebot simulation failed";
    return unavailableSnapshot(
      "SIMULATED_BROWSER",
      url.toString(),
      reason,
      options,
      /blocked|cancelled|timed out|abort|browserType\.launch|Executable|resolve/iu.test(reason) ? "UNAVAILABLE" : "NOT_VERIFIED",
    );
  }
}
