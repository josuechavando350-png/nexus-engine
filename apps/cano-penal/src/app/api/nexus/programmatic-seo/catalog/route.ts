import { timingSafeEqual } from "node:crypto";
import {
  CANO_PROGRAMMATIC_SITE_ID,
  approvedCanoProgrammaticCatalog,
} from "../../../../../approved-programmatic-seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

function response(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function configuredToken(): Buffer | null {
  const raw = process.env.NEXUS_CORTEX_PROGRAMMATIC_SEO_CATALOG_TOKEN?.trim();
  if (!raw || raw.length < 32 || raw.length > 4096) return null;
  return Buffer.from(raw, "utf8");
}

function authorized(request: Request, expected: Buffer): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7), "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return null;
    return parsed as Record<string, unknown>;
  } catch { return null; }
}

export async function POST(request: Request): Promise<Response> {
  const token = configuredToken();
  if (!token) return response(503, { error: "CATALOG_NOT_CONFIGURED" });
  if (!authorized(request, token)) return response(401, { error: "UNAUTHORIZED" });
  const body = await readBoundedJson(request);
  if (!body || Object.keys(body).length !== 1 || body.siteId !== CANO_PROGRAMMATIC_SITE_ID) return response(400, { error: "INVALID_REQUEST" });
  return response(200, approvedCanoProgrammaticCatalog());
}
