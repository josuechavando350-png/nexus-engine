import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { chromium, type Route } from "playwright";
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
    userAgent: source === "GOOGLE_SEARCH_CONSOLE_API" ? "Google Search Console URL Inspection API" : GOOGLEBOT_SMARTPHONE_USER_AGENT,
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

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/u.test(normalized)) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  return mapped ? isPrivateIpv4(mapped[1]!) : false;
}

function assertPublicIp(address: string): void {
  const family = isIP(address);
  if (family === 4 && isPrivateIpv4(address)) throw new Error(`private or reserved IPv4 target is blocked: ${address}`);
  if (family === 6 && isPrivateIpv6(address)) throw new Error(`private or reserved IPv6 target is blocked: ${address}`);
  if (family === 0) throw new Error(`invalid resolved IP address: ${address}`);
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
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error(`local hostname is blocked: ${hostname}`);
  }
  const directFamily = isIP(hostname);
  if (directFamily !== 0) {
    assertPublicIp(hostname);
    return;
  }
  const addresses = await raceAbort(lookup(hostname, { all: true, verbatim: true }), signal, Math.min(timeoutMs, 5_000), "DNS resolution");
  if (addresses.length === 0) throw new Error(`hostname did not resolve: ${hostname}`);
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
      const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(body);
      return normalizeGooglebotRenderSnapshot({
        source: "OBSERVED_HTTP_FETCH",
        status: "OBSERVED_FETCH",
        url: url.toString(),
        observedAt: nowIso(options.clock),
        userAgent: GOOGLEBOT_SMARTPHONE_USER_AGENT,
        toolVersion: toolVersion(options.toolVersion),
        htmlDigest: sha256(body),
        textDigest: bodyText.length === 0 ? null : sha256(bodyText),
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
    return unavailableSnapshot(
      "OBSERVED_HTTP_FETCH",
      url.toString(),
      error instanceof Error ? error.message : "HTTP Googlebot-style fetch failed",
      options,
      error instanceof Error && /blocked|cancelled|timed out|resolve/u.test(error.message) ? "UNAVAILABLE" : "NOT_VERIFIED",
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
    const browser = await raceAbort(chromium.launch({ headless: true }), options.signal, timeoutMs, "Chromium launch");
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
        const text = await raceAbort(page.locator("body").innerText({ timeout: Math.min(timeoutMs, 10_000) }).catch(() => ""), options.signal, timeoutMs, "rendered text extraction");
        if (text.length > maxTextChars) throw new Error(`rendered text exceeds ${maxTextChars} characters`);
        const screenshot = await raceAbort(page.screenshot({ type: "png", fullPage: true, animations: "disabled" }), options.signal, timeoutMs, "render screenshot");
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
    return unavailableSnapshot(
      "SIMULATED_BROWSER",
      url.toString(),
      error instanceof Error ? error.message : "Googlebot simulation failed",
      options,
      error instanceof Error && /blocked|cancelled|timed out|browserType\.launch|Executable/u.test(error.message) ? "UNAVAILABLE" : "NOT_VERIFIED",
    );
  }
}
