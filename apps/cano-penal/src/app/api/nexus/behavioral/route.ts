const MAX_BODY_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 8_192;
const TIMEOUT_MS = 5_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function upstreamConfig(): { readonly endpoint: string; readonly token: string } | null {
  const rawEndpoint = process.env.NEXUS_CORTEX_BEHAVIORAL_ENDPOINT?.trim();
  const token = process.env.NEXUS_CORTEX_BEHAVIORAL_INGEST_TOKEN?.trim();
  if (!rawEndpoint || !token || token.length < 32 || token.length > 4096) return null;
  let endpoint: URL;
  try { endpoint = new URL(rawEndpoint); } catch { return null; }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) return null;
  return { endpoint: endpoint.toString(), token };
}

async function boundedBody(request: Request): Promise<Uint8Array | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) return null;
    if (Number(contentLength) > MAX_BODY_BYTES) return null;
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength <= MAX_BODY_BYTES ? bytes : null;
}

async function boundedResponse(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
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
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json(415, { error: "JSON_REQUIRED" });
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (!origin || origin !== requestUrl.origin) return json(403, { error: "ORIGIN_DENIED" });
  const body = await boundedBody(request);
  if (!body) return json(413, { error: "BODY_TOO_LARGE" });
  const upstream = upstreamConfig();
  if (!upstream) return json(503, { error: "BEHAVIORAL_UPSTREAM_UNAVAILABLE" });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(upstream.endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${upstream.token}`,
        "content-type": "application/json",
        origin,
      },
      body,
    });
    const responseBody = await boundedResponse(response);
    if (!responseBody) return json(502, { error: "BEHAVIORAL_UPSTREAM_INVALID_RESPONSE" });
    const responseType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (responseType !== "application/json") return json(502, { error: "BEHAVIORAL_UPSTREAM_INVALID_RESPONSE" });
    return new Response(responseBody, {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return json(503, { error: "BEHAVIORAL_UPSTREAM_UNAVAILABLE" });
  } finally {
    clearTimeout(timeout);
  }
}
