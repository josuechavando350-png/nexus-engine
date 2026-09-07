export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;

function endpoint(): string | null {
  const raw = process.env.NEXUS_CORTEX_33_AUDIT_ENDPOINT?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/v1/cwv/runtime-evidence")) return null;
    return url.toString();
  } catch { return null; }
}
function token(): string | null { const value = process.env.NEXUS_CORTEX_33_AUDIT_TOKEN?.trim(); return value && value.length >= 32 && value.length <= 4096 ? value : null; }
function origin(value: string | null): URL | null { if (!value) return null; try { const parsed = new URL(value); return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === value ? parsed : null; } catch { return null; } }
function sameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  const supplied = origin(request.headers.get("origin")); if (!supplied) return false;
  const configured = origin(process.env.NEXUS_CORTEX_33_PUBLIC_ORIGIN?.trim() ?? null);
  if (configured) return configured.origin === supplied.origin;
  const host = request.headers.get("host"); return Boolean(host && supplied.host.toLowerCase() === host.toLowerCase());
}
async function bytes(request: Request): Promise<Uint8Array> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body) throw new Error("INVALID_MEDIA_TYPE");
  const declared = request.headers.get("content-length"); if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("BODY_TOO_LARGE");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); } chunks.push(next.value); } } finally { reader.releaseLock(); }
  const merged = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; } return merged;
}
function identityMatches(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.prebuildDigest === process.env.NEXUS_CORTEX_33_PREBUILD_DIGEST
    && raw.edgePolicyDigest === process.env.NEXUS_CORTEX_33_EDGE_POLICY_DIGEST
    && raw.sourceRevision === process.env.NEXUS_CORTEX_33_SOURCE_REVISION
    && typeof raw.prebuildDigest === "string" && SHA256.test(raw.prebuildDigest)
    && typeof raw.edgePolicyDigest === "string" && SHA256.test(raw.edgePolicyDigest)
    && typeof raw.sourceRevision === "string" && SHA.test(raw.sourceRevision);
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const auditEndpoint = endpoint(); const auditToken = token();
  if (!auditEndpoint || !auditToken) return Response.json({ error: "AUDITOR_KILLED" }, { status: 503, headers: { "cache-control": "no-store" } });
  let bodyBytes: Uint8Array; let parsed: unknown;
  try { bodyBytes = await bytes(request); parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as unknown; } catch { return new Response(null, { status: 400, headers: { "cache-control": "no-store" } }); }
  if (!identityMatches(parsed)) return Response.json({ error: "PIPELINE_MISMATCH" }, { status: 412, headers: { "cache-control": "no-store" } });
  let response: Response;
  try {
    response = await fetch(auditEndpoint, { method: "POST", redirect: "error", cache: "no-store", headers: { authorization: `Bearer ${auditToken}`, accept: "application/json", "content-type": "application/json" }, body: bodyBytes, signal: AbortSignal.timeout(5_000) });
  } catch { return Response.json({ error: "AUDITOR_UNAVAILABLE" }, { status: 503, headers: { "cache-control": "no-store" } }); }
  if (!response.ok) return Response.json({ error: "AUDITOR_REJECTED" }, { status: response.status, headers: { "cache-control": "no-store" } });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store, max-age=0" } });
}
