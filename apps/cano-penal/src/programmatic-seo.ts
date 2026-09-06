import "server-only";
import {
  CANO_PROGRAMMATIC_BASE_URL,
  CANO_PROGRAMMATIC_SITE_ID,
  approvedCanoProgrammaticPages,
} from "./approved-programmatic-seo";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 1_500;
const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export type CanoProgrammaticSeoPage = Readonly<{
  pageId: string;
  routeSegments: readonly string[];
  title: string;
  description: string;
  heading: string;
  bodyText: string;
  path: string;
  url: string;
  canonicalUrl: string;
  indexable: boolean;
  updatedAt: string;
  contentDigest: string;
}>;

type Bundle = Readonly<{
  schemaVersion: "cortex-programmatic-seo-bundle-v1";
  siteId: string;
  baseUrl: string;
  digest: string;
  pages: readonly CanoProgrammaticSeoPage[];
}>;

function endpointFromEnv(): URL | null {
  const raw = process.env.NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_ENDPOINT?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return null;
    return url;
  } catch { return null; }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return null; }
}

function cleanPath(parts: readonly string[]): string | null {
  if (parts.length < 1 || parts.length > 16 || parts.some((part) => !SEGMENT.test(part))) return null;
  return `/${parts.join("/")}/`;
}

function parseBundle(value: unknown): Bundle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outer = value as Record<string, unknown>;
  if (outer.siteId !== CANO_PROGRAMMATIC_SITE_ID || !outer.published || !outer.bundle || typeof outer.bundle !== "object" || Array.isArray(outer.bundle)) return null;
  const raw = outer.bundle as Record<string, unknown>;
  const approved = approvedCanoProgrammaticPages();
  const approvedByPath = new Map(approved.map((page) => {
    const path = page.routeSegments.length === 0 ? "/" : `/${page.routeSegments.join("/")}/`;
    return [path, page] as const;
  }));
  if (
    raw.schemaVersion !== "cortex-programmatic-seo-bundle-v1" ||
    raw.siteId !== CANO_PROGRAMMATIC_SITE_ID ||
    raw.baseUrl !== CANO_PROGRAMMATIC_BASE_URL ||
    typeof raw.digest !== "string" || !DIGEST.test(raw.digest) ||
    !Array.isArray(raw.pages) || raw.pages.length !== approved.length
  ) return null;

  const pages: CanoProgrammaticSeoPage[] = [];
  const seen = new Set<string>();
  for (const item of raw.pages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const page = item as Record<string, unknown>;
    if (
      typeof page.pageId !== "string" ||
      !Array.isArray(page.routeSegments) || !page.routeSegments.every((part) => typeof part === "string") ||
      typeof page.title !== "string" || typeof page.description !== "string" || typeof page.heading !== "string" || typeof page.bodyText !== "string" ||
      typeof page.path !== "string" || typeof page.url !== "string" || typeof page.canonicalUrl !== "string" ||
      typeof page.indexable !== "boolean" || typeof page.updatedAt !== "string" ||
      typeof page.contentDigest !== "string" || !DIGEST.test(page.contentDigest)
    ) return null;
    const routeSegments = page.routeSegments as string[];
    if (routeSegments.some((part) => !SEGMENT.test(part))) return null;
    const expectedPath = routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}/`;
    const expected = approvedByPath.get(expectedPath);
    if (!expected || seen.has(expectedPath)) return null;
    const expectedUrl = new URL(expectedPath.slice(1), CANO_PROGRAMMATIC_BASE_URL).toString();
    if (
      page.path !== expectedPath || page.pageId !== expected.pageId ||
      JSON.stringify(routeSegments) !== JSON.stringify(expected.routeSegments) ||
      page.title !== expected.title || page.description !== expected.description || page.heading !== expected.heading || page.bodyText !== expected.bodyText ||
      page.url !== expectedUrl || page.canonicalUrl !== expectedUrl || page.indexable !== expected.indexable || page.updatedAt !== expected.updatedAt
    ) return null;
    seen.add(expectedPath);
    pages.push(Object.freeze({
      pageId: page.pageId,
      routeSegments: Object.freeze([...routeSegments]),
      title: page.title,
      description: page.description,
      heading: page.heading,
      bodyText: page.bodyText,
      path: page.path,
      url: page.url,
      canonicalUrl: page.canonicalUrl,
      indexable: page.indexable,
      updatedAt: page.updatedAt,
      contentDigest: page.contentDigest,
    }));
  }
  if (seen.size !== approved.length) return null;
  return Object.freeze({
    schemaVersion: "cortex-programmatic-seo-bundle-v1",
    siteId: CANO_PROGRAMMATIC_SITE_ID,
    baseUrl: CANO_PROGRAMMATIC_BASE_URL,
    digest: raw.digest,
    pages: Object.freeze(pages),
  });
}

export async function readCanoProgrammaticSeoPage(routeSegments: readonly string[]): Promise<CanoProgrammaticSeoPage | null> {
  const path = cleanPath(routeSegments);
  if (!path) return null;
  const approved = approvedCanoProgrammaticPages();
  if (!approved.some((page) => `/${page.routeSegments.join("/")}/` === path)) return null;
  const endpoint = endpointFromEnv();
  const token = process.env.NEXUS_CORTEX_PROGRAMMATIC_SEO_BUNDLE_TOKEN?.trim();
  if (!endpoint || !token || token.length < 32 || token.length > 4096) return null;
  endpoint.search = new URLSearchParams({ siteId: CANO_PROGRAMMATIC_SITE_ID }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) return null;
    const bundle = parseBundle(await boundedJson(response));
    return bundle?.pages.find((page) => page.path === path) ?? null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
