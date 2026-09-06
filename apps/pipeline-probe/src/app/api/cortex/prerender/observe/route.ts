export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512;
const SIGNALS = new Set(["pointerenter", "pointerdown", "touchstart", "focus"]);
const ACTIONS = new Set(["PRERENDER", "PREFETCH", "NONE"]);
const REASONS = new Set([
  "SELECTED",
  "OBSERVE_ONLY",
  "KILL_SWITCH",
  "REDUCED_DATA",
  "REDUCED_MOTION",
  "CROSS_ORIGIN",
  "QUERY_NOT_ALLOWED",
  "TARGET_NOT_ALLOWLISTED",
  "BUDGET_EXHAUSTED",
  "DUPLICATE",
  "INVALID_TARGET",
  "CONTROL_UNAVAILABLE",
]);

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
      if (total > MAX_BODY_BYTES) {
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
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const expectedOrigin = new URL(request.url).origin;
  if (request.headers.get("origin") !== expectedOrigin) return new Response(null, { status: 403 });
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return new Response(null, { status: 403 });

  const body = await readBoundedJson(request);
  if (!body || Object.keys(body).sort().join(",") !== "action,reason,signal") return new Response(null, { status: 400 });
  if (typeof body.signal !== "string" || !SIGNALS.has(body.signal)) return new Response(null, { status: 400 });
  if (typeof body.action !== "string" || !ACTIONS.has(body.action)) return new Response(null, { status: 400 });
  if (typeof body.reason !== "string" || !REASONS.has(body.reason)) return new Response(null, { status: 400 });

  console.info(JSON.stringify({
    component: "cortex-08-interaction-pointer-prerenderer",
    signal: body.signal,
    action: body.action,
    reason: body.reason,
  }));
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
