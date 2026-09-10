import externalClientsRaw from "../external-clients.json" with { type: "json" };

interface ExternalClientRecord {
  client_id: string;
  incoming_domain: string;
  target_origin: string;
  CONFIG_SEO_AVENGERS_200: boolean;
}

interface ExternalTenant {
  clientId: string;
  incomingOrigin: string;
  incomingHost: string;
  targetOrigin: string;
  enabled: boolean;
}

export interface Env {
  SEO_VECTORS: KVNamespace;
  SEO_AVENGERS_TRANSFORMER: Fetcher;
  NEXUS_SEO_EDGE_PUBLISH_TOKEN?: string;
}

const SEO_BUDGET_MS = 4;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const VECTOR_ADMIN_PATH = "/__nexus/seo-vector";
let cachedIndex: ReadonlyMap<string, ExternalTenant> | null = null;

function normalizeOrigin(value: string, label: string): string {
  let candidate = String(value ?? "").trim();
  if (candidate.startsWith("://")) candidate = `https${candidate}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
    throw new Error(`${label} must use https`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an origin without credentials, path, query or fragment`);
  }
  return url.origin;
}

function assertClientId(value: string): string {
  const id = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error(`invalid external client_id: ${id}`);
  return id;
}

function buildClientIndex(): ReadonlyMap<string, ExternalTenant> {
  const index = new Map<string, ExternalTenant>();
  for (const raw of externalClientsRaw as ExternalClientRecord[]) {
    const clientId = assertClientId(raw.client_id);
    const incomingOrigin = normalizeOrigin(raw.incoming_domain, `incoming_domain for ${clientId}`);
    const targetOrigin = normalizeOrigin(raw.target_origin, `target_origin for ${clientId}`);
    const incomingHost = new URL(incomingOrigin).host.toLowerCase();
    if (index.has(incomingHost)) throw new Error(`duplicate incoming_domain: ${incomingHost}`);
    index.set(incomingHost, Object.freeze({
      clientId,
      incomingOrigin,
      incomingHost,
      targetOrigin,
      enabled: raw.CONFIG_SEO_AVENGERS_200 === true,
    }));
  }
  return index;
}

function clientIndex(): ReadonlyMap<string, ExternalTenant> {
  return cachedIndex ??= buildClientIndex();
}

function lookupTenant(url: URL): ExternalTenant | null {
  return clientIndex().get(url.host.toLowerCase()) ?? null;
}

function vectorKey(siteId: string, pathname: string): string {
  return `seo_vectors:${siteId}:${pathname || "/"}`;
}

function upstreamRequest(request: Request, targetOrigin: string): Request {
  const incoming = new URL(request.url);
  const upstream = new URL(targetOrigin);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return new Request(upstream, request);
}

function transformedHeaders(headers: Headers, tenant: ExternalTenant, etag?: string): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  next.delete("content-encoding");
  next.set("x-nexus-seo-avengers", "200-applied");
  next.set("x-nexus-seo-suite", "SEO_AVENGERS_200");
  next.set("x-nexus-seo-tenant", tenant.clientId);
  if (etag) next.set("etag", etag);
  return next;
}

function tokenMatches(expected: string, got: string): boolean {
  if (!expected || expected.length !== got.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ got.charCodeAt(i);
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
  const tenant = [...clientIndex().values()].find((candidate) => candidate.clientId === payload.site_id) ?? null;
  if (!tenant || !tenant.enabled) return new Response("tenant disabled", { status: 404 });

  const key = vectorKey(payload.site_id, payload.route);
  const current = await env.SEO_VECTORS.get(key, "json") as { version?: number } | null;
  if ((current?.version ?? 0) > payload.version) return Response.json({ ok: true, stale: true });
  await env.SEO_VECTORS.put(key, JSON.stringify(payload));
  return Response.json({ ok: true, version: payload.version });
}

async function sha256Etag(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
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
  return header.split(",").some((token) => token.trim() === "*" || weakValue(token) === weakValue(etag));
}

function deliveryProfile(request: Request): { save_data: boolean; ect?: string } {
  const saveData = request.headers.get("save-data")?.toLowerCase() === "on";
  const ect = request.headers.get("ect")?.toLowerCase() || undefined;
  return { save_data: saveData, ...(ect ? { ect } : {}) };
}

async function transformWithinBudget(
  originResponse: Response,
  request: Request,
  tenant: ExternalTenant,
  env: Env,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort("seo-avengers-200-4ms-transform-budget");
      reject(new Error("SEO_AVENGERS_200_TIMEOUT"));
    }, SEO_BUDGET_MS);
  });

  const candidate = (async () => {
    const requestUrl = new URL(request.url);
    const declared = Number(originResponse.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) throw new Error("SEO_HTML_TOO_LARGE");

    const [html, vectorRaw] = await Promise.all([
      originResponse.clone().text(),
      env.SEO_VECTORS.get(vectorKey(tenant.clientId, requestUrl.pathname)),
    ]);
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new Error("SEO_HTML_TOO_LARGE");
    if (!vectorRaw) throw new Error("SEO_VECTOR_MISS");
    if (controller.signal.aborted) throw new Error("SEO_AVENGERS_200_TIMEOUT");
    const vector: unknown = JSON.parse(vectorRaw);
    if (!validVectorPayload(vector) || vector.site_id !== tenant.clientId) throw new Error("SEO_VECTOR_INVALID");

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
    // Exactly as in the native gateway, only optional KV + Rust work is
    // deadline-gated. Local ETag/header assembly is not part of that budget.
    body = await Promise.race([candidate, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const etag = await sha256Etag(body);
  const headers = transformedHeaders(originResponse.headers, tenant, etag);
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.passThroughOnException();
    const url = new URL(request.url);
    const tenant = lookupTenant(url);

    // Routes are generated only for enabled tenants. This runtime check is a
    // second fail-closed boundary and guarantees no KV/Service Binding on false.
    if (!tenant || !tenant.enabled) return fetch(request);

    if (url.pathname === VECTOR_ADMIN_PATH && request.method === "POST") {
      return publishVector(request, env);
    }

    let originResponse: Response;
    try {
      originResponse = await fetch(upstreamRequest(request, tenant.targetOrigin));
    } catch {
      // Best-effort fail-open through the DNS origin for a route-based deployment.
      try { return await fetch(request); }
      catch { return new Response("Bad Gateway", { status: 502 }); }
    }

    const contentType = originResponse.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") || originResponse.status === 204 || originResponse.status === 304) {
      return originResponse;
    }

    try {
      // 4 ms covers only optional KV + Rust shadow transform after WAN origin exists.
      return await transformWithinBudget(originResponse.clone(), request, tenant, env);
    } catch {
      return originResponse;
    }
  },
};
