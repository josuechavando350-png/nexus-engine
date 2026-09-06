import "server-only";
import type { Metadata } from "next";

const MAX_RESPONSE_BYTES = 8 * 1024;
const TIMEOUT_MS = 1_500;

type PublishedMetadata = Readonly<{ title: string; description: string | undefined }>;

function endpointFromEnv(): URL | null {
  const raw = process.env.NEXUS_CORTEX_SERP_METADATA_ENDPOINT?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
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
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
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
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { return null; }
}

export async function readSerpMetadataOverride(pageId: string, pageUrl: string): Promise<PublishedMetadata | null> {
  const endpoint = endpointFromEnv();
  const token = process.env.NEXUS_CORTEX_SERP_METADATA_TOKEN?.trim();
  if (!endpoint || !token || token.length < 32 || token.length > 4096) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    endpoint.search = new URLSearchParams({ siteUrl: "https://canopenal.com/", pageId, pageUrl }).toString();
    const response = await fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const value = await boundedJson(response);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.siteUrl !== "https://canopenal.com/" || record.pageId !== pageId || record.pageUrl !== pageUrl) return null;
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const fields = metadata as Record<string, unknown>;
    if (typeof fields.title !== "string" || !fields.title.trim()) return null;
    if (fields.metaDescription !== null && typeof fields.metaDescription !== "string") return null;
    return Object.freeze({ title: fields.title, description: fields.metaDescription === null ? undefined : fields.metaDescription });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function mergeSerpMetadata(fallback: Metadata, override: PublishedMetadata | null): Metadata {
  return override ? { ...fallback, title: override.title, description: override.description } : fallback;
}
