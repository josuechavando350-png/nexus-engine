import type { SeoAuditHttpPort, SeoAuditIssue, SeoAuditSitemapReport } from "./contracts.js";
import { FirstPartySeoAuditUrlPolicy } from "./url-policy.js";

const MAX_SITEMAP_BYTES = 8 * 1024 * 1024;
const MAX_SITEMAPS = 64;
const MAX_DISCOVERED_URLS = 20_000;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .trim();
}

function extractLocs(xml: string): readonly string[] {
  const locs: string[] = [];
  const matcher = /<loc\b[^>]*>([\s\S]*?)<\/loc>/giu;
  for (const match of xml.matchAll(matcher)) {
    const value = decodeXmlText(match[1] ?? "");
    if (value) locs.push(value);
    if (locs.length > MAX_DISCOVERED_URLS) break;
  }
  return Object.freeze(locs);
}

export function sitemapDirectivesFromRobots(robotsText: string): readonly string[] {
  const values: string[] = [];
  for (const raw of robotsText.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.split("#", 1)[0]?.trim() ?? "";
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0 || line.slice(0, colon).trim().toLowerCase() !== "sitemap") continue;
    const value = line.slice(colon + 1).trim();
    if (value) values.push(value);
  }
  return Object.freeze(values);
}

export async function inspectSitemaps(input: {
  readonly http: SeoAuditHttpPort;
  readonly policy: FirstPartySeoAuditUrlPolicy;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly robotsText: string;
  readonly configuredSitemaps?: readonly string[];
}): Promise<SeoAuditSitemapReport> {
  const issues: SeoAuditIssue[] = [];
  const discoveredSitemaps: string[] = [];
  const urls: string[] = [];
  const seenSitemaps = new Set<string>();
  const seenUrls = new Set<string>();
  const queue: string[] = [];

  const seedCandidates = [
    ...(input.configuredSitemaps ?? []),
    ...sitemapDirectivesFromRobots(input.robotsText),
    new URL("/sitemap.xml", input.policy.origin).toString(),
  ];

  for (const candidate of seedCandidates) {
    try {
      const authorized = input.policy.authorize(candidate).toString();
      if (!seenSitemaps.has(authorized)) queue.push(authorized);
    } catch {
      issues.push(Object.freeze({
        code: "SITEMAP_CROSS_ORIGIN_DENIED",
        severity: "WARNING",
        category: "SITEMAP",
        url: input.policy.origin,
        message: "A sitemap declaration was ignored because it is outside the configured first-party origin.",
      }));
    }
  }

  while (queue.length > 0 && seenSitemaps.size < MAX_SITEMAPS && seenUrls.size < MAX_DISCOVERED_URLS) {
    const sitemapUrl = queue.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    discoveredSitemaps.push(sitemapUrl);

    let response;
    try {
      response = await input.http.fetch(sitemapUrl, { userAgent: input.userAgent, timeoutMs: input.timeoutMs });
    } catch (error) {
      issues.push(Object.freeze({
        code: "SITEMAP_FETCH_FAILED",
        severity: "WARNING",
        category: "SITEMAP",
        url: sitemapUrl,
        message: `Sitemap request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      }));
      continue;
    }

    if (response.status === 404 && sitemapUrl.endsWith("/sitemap.xml")) continue;
    if (response.status < 200 || response.status >= 300) {
      issues.push(Object.freeze({
        code: "SITEMAP_HTTP_STATUS",
        severity: "WARNING",
        category: "SITEMAP",
        url: sitemapUrl,
        message: `Sitemap returned HTTP ${response.status}.`,
        evidence: Object.freeze({ status: response.status }),
      }));
      continue;
    }

    const xml = await response.text();
    if (utf8Length(xml) > MAX_SITEMAP_BYTES) {
      issues.push(Object.freeze({
        code: "SITEMAP_TOO_LARGE",
        severity: "ERROR",
        category: "SITEMAP",
        url: sitemapUrl,
        message: "Sitemap exceeded the configured 8 MiB audit bound.",
      }));
      continue;
    }

    const isIndex = /<sitemapindex\b/iu.test(xml);
    const isUrlSet = /<urlset\b/iu.test(xml);
    if (!isIndex && !isUrlSet) {
      issues.push(Object.freeze({
        code: "SITEMAP_INVALID_ROOT",
        severity: "WARNING",
        category: "SITEMAP",
        url: sitemapUrl,
        message: "Sitemap does not contain a recognized sitemapindex or urlset root.",
      }));
      continue;
    }

    for (const loc of extractLocs(xml)) {
      try {
        const authorized = input.policy.authorize(loc).toString();
        if (isIndex) {
          if (!seenSitemaps.has(authorized) && seenSitemaps.size + queue.length < MAX_SITEMAPS) queue.push(authorized);
        } else if (!seenUrls.has(authorized)) {
          seenUrls.add(authorized);
          urls.push(authorized);
        }
      } catch {
        issues.push(Object.freeze({
          code: isIndex ? "SITEMAP_CHILD_CROSS_ORIGIN_DENIED" : "SITEMAP_URL_CROSS_ORIGIN_DENIED",
          severity: "WARNING",
          category: "SITEMAP",
          url: sitemapUrl,
          message: "A sitemap location outside the configured first-party origin was ignored.",
        }));
      }
      if (seenUrls.size >= MAX_DISCOVERED_URLS) break;
    }
  }

  if (seenSitemaps.size >= MAX_SITEMAPS && queue.length > 0) {
    issues.push(Object.freeze({
      code: "SITEMAP_LIMIT_REACHED",
      severity: "WARNING",
      category: "SITEMAP",
      url: input.policy.origin,
      message: `Sitemap traversal stopped after ${MAX_SITEMAPS} sitemap documents.`,
    }));
  }

  return Object.freeze({
    discoveredSitemaps: Object.freeze(discoveredSitemaps),
    urls: Object.freeze(urls),
    issues: Object.freeze(issues),
  });
}
