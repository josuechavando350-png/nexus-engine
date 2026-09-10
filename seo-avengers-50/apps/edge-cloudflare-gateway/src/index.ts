export interface Env {
  CONFIG_SEO_AVENGERS_50?: string;
  NEXUS_CANONICAL_ORIGIN?: string;
  NEXUS_SITE_ID: string;
  NEXUS_SEO_EDGE_PUBLISH_TOKEN?: string;
  SEO_VECTORS: KVNamespace;
  SEO_AVENGERS_TRANSFORMER: Fetcher;
}

const SEO_BUDGET_MS = 4;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function enabled(env: Env): boolean {
  return env.CONFIG_SEO_AVENGERS_50 === "true";
}

function vectorKey(siteId: string, pathname: string): string {
  return `seo_vectors:${siteId}:${pathname || "/"}`;
}

function cloneHeadersWithoutLength(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-length");
  next.delete("content-encoding");
  next.set("x-nexus-seo-avengers", "applied");
  return next;
}

async function publishVector(request: Request, env: Env): Promise<Response> {
  const expected = env.NEXUS_SEO_EDGE_PUBLISH_TOKEN ?? "";
  const got = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || got.length !== expected.length) return new Response("unauthorized", { status: 401 });
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  if (mismatch !== 0) return new Response("unauthorized", { status: 401 });

  const payload = await request.json() as {
    site_id: string;
    route: string;
    version: number;
    sections: Record<string, { json_ld: unknown; output_hash: string }>;
    output_hash: string;
  };
  if (!payload?.site_id || !payload?.route || !Number.isInteger(payload?.version) || payload.version < 1 || !payload?.sections || !payload?.output_hash) {
    return new Response("invalid payload", { status: 400 });
  }
  if (payload.site_id !== env.NEXUS_SITE_ID) return new Response("wrong tenant", { status: 403 });

  const key = vectorKey(payload.site_id, payload.route);
  const current = await env.SEO_VECTORS.get(key, "json") as { version?: number } | null;
  if ((current?.version ?? 0) > payload.version) return Response.json({ ok: true, stale: true });
  await env.SEO_VECTORS.put(key, JSON.stringify(payload));
  return Response.json({ ok: true, version: payload.version });
}

async function transformWithinBudget(nativeResponse: Response, requestUrl: URL, env: Env): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort("seo-avengers-4ms-budget");
      reject(new Error("SEO_AVENGERS_TIMEOUT"));
    }, SEO_BUDGET_MS);
  });

  const candidate = (async () => {
    const declared = Number(nativeResponse.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) throw new Error("SEO_HTML_TOO_LARGE");

    const [html, vectorRaw] = await Promise.all([
      nativeResponse.clone().text(),
      env.SEO_VECTORS.get(vectorKey(env.NEXUS_SITE_ID, requestUrl.pathname)),
    ]);
    if (html.length > MAX_HTML_BYTES) throw new Error("SEO_HTML_TOO_LARGE");
    if (!vectorRaw) throw new Error("SEO_VECTOR_MISS");
    if (controller.signal.aborted) throw new Error("SEO_AVENGERS_TIMEOUT");

    const transformed = await env.SEO_AVENGERS_TRANSFORMER.fetch("https://transformer.internal/transform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html, vector: JSON.parse(vectorRaw) }),
      signal: controller.signal,
    });
    if (!transformed.ok) throw new Error(`SEO_TRANSFORM_${transformed.status}`);
    const body = await transformed.text();
    return new Response(body, {
      status: nativeResponse.status,
      statusText: nativeResponse.statusText,
      headers: cloneHeadersWithoutLength(nativeResponse.headers),
    });
  })();

  try {
    return await Promise.race([candidate, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!enabled(env)) {
      return fetch(request);
    }

    if (url.pathname === "/__nexus/seo-vector" && request.method === "POST") {
      return publishVector(request, env);
    }

    const nativeResponse = await fetch(request);
    const contentType = nativeResponse.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") || nativeResponse.status === 204 || nativeResponse.status === 304) {
      return nativeResponse;
    }

    try {
      return await transformWithinBudget(nativeResponse.clone(), url, env);
    } catch {
      return nativeResponse;
    }
  },
};
