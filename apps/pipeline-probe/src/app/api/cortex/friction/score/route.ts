import { scoreFrictionAbandonment } from "@nexus/core/cortex/friction-abandonment-scoring";
import { readCortex09Runtime } from "../friction-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_048;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body) {
    throw new Error("INVALID_MEDIA_TYPE");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("BODY_TOO_LARGE");
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

function sameModel(
  left: ReturnType<typeof readCortex09Runtime>,
  right: ReturnType<typeof readCortex09Runtime>,
): boolean {
  return Boolean(
    left.model
    && right.model
    && left.modelArtifactDigest
    && right.modelArtifactDigest
    && left.featureContractId === right.featureContractId
    && left.modelArtifactDigest === right.modelArtifactDigest
    && left.model.modelId === right.model.modelId
    && left.model.sourceDigest === right.model.sourceDigest,
  );
}

export async function POST(request: Request): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== new URL(request.url).origin) return new Response(null, { status: 403 });
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") return new Response(null, { status: 403 });

  const initial = readCortex09Runtime();
  if (initial.mode === "KILLED" || !initial.model || !initial.modelArtifactDigest) {
    return Response.json({ mode: "KILLED" }, { status: 503, headers: { "cache-control": "no-store" } });
  }

  let score;
  try {
    score = scoreFrictionAbandonment(await readBoundedJson(request), initial.model);
  } catch {
    return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
  }

  // Mandatory final-boundary read. An ACTIVE result is only safe when the exact
  // artifact identity and both mode observations stayed ACTIVE through scoring.
  const final = readCortex09Runtime();
  if (final.mode === "KILLED" || !final.model || !final.modelArtifactDigest) {
    return Response.json({ mode: "KILLED" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (!sameModel(initial, final)) {
    return Response.json({ mode: "KILLED" }, { status: 409, headers: { "cache-control": "no-store" } });
  }

  if (!(initial.mode === "ACTIVE" && final.mode === "ACTIVE")) {
    console.info(JSON.stringify({
      component: "cortex-09-friction-scoring",
      mode: "OBSERVE_ONLY",
      pointerClass: score.pointerClass,
      riskBand: score.riskBand,
      modelSourceDigest: score.modelSourceDigest,
      modelArtifactDigest: final.modelArtifactDigest,
    }));
    return Response.json({
      mode: "OBSERVE_ONLY",
      modelArtifactDigest: final.modelArtifactDigest,
      score: null,
    }, { status: 200, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }

  console.info(JSON.stringify({
    component: "cortex-09-friction-scoring",
    mode: "ACTIVE",
    pointerClass: score.pointerClass,
    riskBand: score.riskBand,
    modelSourceDigest: score.modelSourceDigest,
    modelArtifactDigest: final.modelArtifactDigest,
  }));
  return Response.json({ mode: "ACTIVE", modelArtifactDigest: final.modelArtifactDigest, score }, {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
