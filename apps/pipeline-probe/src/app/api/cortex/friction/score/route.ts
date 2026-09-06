import { scoreFrictionAbandonment } from "@nexus/core/cortex/friction-abandonment-scoring";
import { readCortex09Runtime } from "../friction-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_048;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body) throw new Error("INVALID_MEDIA_TYPE");
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
        throw new Error("BODY_TOO_LARGE");
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
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function POST(request: Request): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== new URL(request.url).origin) return new Response(null, { status: 403 });
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return new Response(null, { status: 403 });

  const initial = readCortex09Runtime();
  if (initial.mode === "KILLED" || !initial.model) return Response.json({ mode: "KILLED" }, { status: 503, headers: { "cache-control": "no-store" } });

  let score;
  try {
    score = scoreFrictionAbandonment(await readBoundedJson(request), initial.model);
  } catch {
    return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
  }

  const final = readCortex09Runtime();
  if (final.mode === "KILLED" || !final.model) return Response.json({ mode: "KILLED" }, { status: 503, headers: { "cache-control": "no-store" } });
  if (final.model.sourceDigest !== initial.model.sourceDigest || final.model.modelId !== initial.model.modelId) {
    return Response.json({ mode: "KILLED" }, { status: 409, headers: { "cache-control": "no-store" } });
  }
  if (final.mode === "OBSERVE_ONLY") {
    console.info(JSON.stringify({ component: "cortex-09-friction-scoring", mode: final.mode, deviceClass: score.deviceClass, riskBand: score.riskBand, modelSourceDigest: score.modelSourceDigest }));
    return Response.json({ mode: final.mode, score: null }, { status: 200, headers: { "cache-control": "no-store" } });
  }

  console.info(JSON.stringify({ component: "cortex-09-friction-scoring", mode: final.mode, deviceClass: score.deviceClass, riskBand: score.riskBand, modelSourceDigest: score.modelSourceDigest }));
  return Response.json({ mode: "ACTIVE", score }, {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
