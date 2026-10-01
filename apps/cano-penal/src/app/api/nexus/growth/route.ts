import { createHash, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;
const STAGES = new Set(["CONTACT","QUALIFIED_LEAD","CONSULTATION","SIGNED_CLIENT"]);
const CHANNELS = new Set(["GOOGLE_ADS","ORGANIC_SEARCH","GOOGLE_MAPS","REFERRAL","DIRECT","OTHER","UNKNOWN"]);
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function json(status: number, body: Readonly<Record<string, unknown>>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function secretEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function config(): { endpoint: string; token: string; writeToken: string } | null {
  const rawEndpoint = process.env.NEXUS_GROWTH_ATTRIBUTION_ENDPOINT?.trim();
  const token = process.env.NEXUS_GROWTH_ATTRIBUTION_TOKEN?.trim();
  const writeToken = process.env.NEXUS_CANO_GROWTH_WRITE_TOKEN?.trim();
  if (!rawEndpoint || !token || !writeToken || token.length < 32 || writeToken.length < 32) return null;
  let endpoint: URL;
  try { endpoint = new URL(rawEndpoint); } catch { return null; }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) return null;
  return { endpoint: endpoint.toString(), token, writeToken };
}

function validate(body: unknown): Readonly<Record<string, unknown>> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const v = body as Record<string, unknown>;
  if (v.siteId !== "cano-penal") return null;
  if (typeof v.eventId !== "string" || !SAFE_TOKEN.test(v.eventId)) return null;
  if (typeof v.journeySha256 !== "string" || !SHA256.test(v.journeySha256)) return null;
  if (typeof v.occurredAt !== "string" || new Date(v.occurredAt).toISOString() !== v.occurredAt) return null;
  if (typeof v.stage !== "string" || !STAGES.has(v.stage)) return null;
  if (typeof v.channel !== "string" || !CHANNELS.has(v.channel)) return null;
  if (typeof v.landingPath !== "string" || !v.landingPath.startsWith("/") || v.landingPath.length > 512 || v.landingPath.includes("?") || v.landingPath.includes("#")) return null;
  if (v.revenueMinor !== undefined && (!Number.isSafeInteger(v.revenueMinor) || (v.revenueMinor as number) < 0 || v.stage !== "SIGNED_CLIENT")) return null;
  if (v.adsClickSha256 !== undefined && (typeof v.adsClickSha256 !== "string" || !SHA256.test(v.adsClickSha256))) return null;
  if (v.searchQuerySha256 !== undefined && (typeof v.searchQuerySha256 !== "string" || !SHA256.test(v.searchQuerySha256))) return null;
  return Object.freeze({
    schemaVersion: 1,
    siteId: "cano-penal",
    eventId: v.eventId,
    journeySha256: v.journeySha256,
    occurredAt: v.occurredAt,
    stage: v.stage,
    channel: v.channel,
    landingPath: v.landingPath,
    ...(v.revenueMinor !== undefined ? { revenueMinor: v.revenueMinor } : {}),
    ...(v.adsClickSha256 !== undefined ? { adsClickSha256: v.adsClickSha256 } : {}),
    ...(v.searchQuerySha256 !== undefined ? { searchQuerySha256: v.searchQuerySha256 } : {}),
  });
}

export async function POST(request: Request): Promise<Response> {
  const cfg = config();
  if (!cfg) return json(503, { error: "GROWTH_ATTRIBUTION_NOT_CONFIGURED" });

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix) || !secretEqual(authorization.slice(prefix.length), cfg.writeToken)) {
    return json(401, { error: "UNAUTHORIZED" });
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return json(415, { error: "JSON_REQUIRED" });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json(413, { error: "BODY_TOO_LARGE" });

  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return json(400, { error: "INVALID_JSON" }); }
  const event = validate(decoded);
  if (!event) return json(400, { error: "INVALID_GROWTH_EVENT" });

  try {
    const response = await fetch(cfg.endpoint, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!response.ok) return json(502, { error: "GROWTH_UPSTREAM_REJECTED", status: response.status });
    return json(202, { accepted: true, stage: event.stage });
  } catch {
    return json(503, { error: "GROWTH_UPSTREAM_UNAVAILABLE" });
  }
}
