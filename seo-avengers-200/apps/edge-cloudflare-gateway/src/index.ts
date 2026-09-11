export interface Env {
  CONFIG_SEO_AVENGERS_200?: string;
  NEXUS_SITE_ID: string;
  NEXUS_SEO_EDGE_PUBLISH_TOKEN?: string;
  SEO_VECTORS: KVNamespace;
  SEO_AVENGERS_TRANSFORMER: Fetcher;
}

const SEO_BUDGET_MS = 50;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const VECTOR_ADMIN_PATH = "/__nexus/seo-vector";

function enabled(env: Env): boolean {
  return env.CONFIG_SEO_AVENGERS_200 === "true";
}

function vectorKey(siteId: string, pathname: string): string {
  return `seo_vectors:${siteId}:${pathname || "/"}`;
}

function transformedHeaders(headers: Headers, etag?: string): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  next.delete("content-encoding");
  next.set("x-nexus-seo-avengers", "200-applied");
  next.set("x-nexus-seo-suite", "SEO_AVENGERS_200");
  if (etag) next.set("etag", etag);
  return next;
}

function tokenMatches(expected: string, got: string): boolean {
  if (!expected || expected.length !== got.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  }
  return mismatch === 0;
}

function validVectorPayload(payload: unknown): payload is {
  suite: "SEO_AVENGERS_200";
  module_count: 200;
  site_id: string;
  route: string;
  version: number;
  sections: Record<string, { json_ld: unknown; output_hash: string }>;
  output_hash: string;
} {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return p.suite === "SEO_AVENGERS_200"
    && p.module_count === 200
    && typeof p.site_id === "string" && p.site_id.length > 0
    && typeof p.route === "string" && p.route.startsWith("/")
    && Number.isInteger(p.version) && Number(p.version) > 0
    && !!p.sections && typeof p.sections === "object"
    && typeof p.output_hash === "string" && p.output_hash.startsWith("sha256:");
}

async function publishVector(request: Request, env: Env): Promise<Response> {
  const expected = env.NEXUS_SEO_EDGE_PUBLISH_TOKEN ?? "";
  const got = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!tokenMatches(expected, got)) return new Response("unauthorized", { status: 401 });

  const payload: unknown = await request.json();
  if (!validVectorPayload(payload)) return new Response("invalid payload", { status: 400 });
  if (payload.site_id !== env.NEXUS_SITE_ID) return new Response("wrong tenant", { status: 404 });

  const key = vectorKey(payload.site_id, payload.route);
  const current = await env.SEO_VECTORS.get<{ version?: number }>(key, "json");
  if ((current?.version ?? 0) > payload.version) {
    return Response.json({ ok: true, stale: true, version: current?.version });
  }
  await env.SEO_VECTORS.put(key, JSON.stringify(payload));
  return Response.json({ ok: true, version: payload.version });
}

async function sha256Etag(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const value of digest) hex += value.toString(16).padStart(2, "0");
  return `"sha256-${hex}"`;
}

function weakValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((token) => {
    const value = token.trim();
    return value === "*" || weakValue(value) === weakValue(etag);
  });
}

function deliveryProfile(request: Request): { save_data: boolean; ect?: string } {
  const saveData = request.headers.get("save-data")?.toLowerCase() === "on";
  const ect = request.headers.get("ect")?.toLowerCase() || undefined;
  return { save_data: saveData, ...(ect ? { ect } : {}) };
}

async function transformWithinBudget(
  nativeResponse: Response,
  request: Request,
  env: Env,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const declared = Number(nativeResponse.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) throw new Error("SEO_HTML_TOO_LARGE");

  // Origin body materialization is not part of the optional edge deadline.
  // The deadline below is reserved for the optional KV lookup + Rust transform.
  const html = await nativeResponse.clone().text();
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("SEO_HTML_TOO_LARGE");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(`seo-avengers-200-${SEO_BUDGET_MS}ms-budget`);
      reject(new Error("SEO_AVENGERS_200_TIMEOUT"));
    }, SEO_BUDGET_MS);
  });

  const candidate = (async () => {
    const vectorRaw = await env.SEO_VECTORS.get(vectorKey(env.NEXUS_SITE_ID, requestUrl.pathname));
    if (!vectorRaw) throw new Error("SEO_VECTOR_MISS");
    if (controller.signal.aborted) throw new Error("SEO_AVENGERS_200_TIMEOUT");

    const vector: unknown = JSON.parse(vectorRaw);
    if (!validVectorPayload(vector) || vector.site_id !== env.NEXUS_SITE_ID) {
      throw new Error("SEO_VECTOR_INVALID");
    }

    // Service binding is touched only after tenant=true and vector validation.
    const transformed = await env.SEO_AVENGERS_TRANSFORMER.fetch("https://transformer.internal/transform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html, vector, delivery_profile: deliveryProfile(request) }),
      signal: controller.signal,
    });
    if (!transformed.ok) throw new Error(`SEO_TRANSFORM_${transformed.status}`);
    return transformed.text();
  })();

  let body: string;
  try {
    // The 50 ms guard covers only optional KV lookup + Rust transform.
    // Local response hashing/header assembly happens after the shadow candidate
    // has already won the race and therefore cannot cause a false fail-open.
    body = await Promise.race([candidate, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const etag = await sha256Etag(body);
  const headers = transformedHeaders(nativeResponse.headers, etag);
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    status: nativeResponse.status,
    statusText: nativeResponse.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // GLOBAL FAIL-CLOSED + LAZY BYPASS. No KV, no Service Binding, no SEO state.
    // On a Cloudflare Worker Route, fetch(request) continues to the DNS origin
    // (Vercel for Nexus) without recursively re-entering this Worker.
    if (!enabled(env)) return fetch(request);

    const url = new URL(request.url);
    if (url.pathname === VECTOR_ADMIN_PATH && request.method === "POST") {
      return publishVector(request, env);
    }

    // Native origin work is deliberately outside the optional SEO edge budget.
    const nativeResponse = await fetch(request);
    const contentType = nativeResponse.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") || nativeResponse.status === 204 || nativeResponse.status === 304) {
      return nativeResponse;
    }

    try {
      // Pristine origin Response remains authoritative until the shadow transform
      // completes inside the deadline. Timeout/error/vector miss => byte-native fallback.
      return await transformWithinBudget(nativeResponse.clone(), request, env);
    } catch {
      return nativeResponse;
    }
  },
};
