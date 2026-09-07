import { parseFrictionSnapshot, scoreFrictionAbandonment } from "@nexus/core/cortex/friction-abandonment-scoring";
import { decideFrictionControlPlaneAction } from "@nexus/core/cortex/friction-control-plane-actions";
import { readCortex09Runtime } from "../friction-runtime";
import { readCortex29ActionRuntime, sameCortex29ActionRuntime } from "../friction-action-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_048;

async function readBoundedJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body) throw new Error("INVALID_MEDIA_TYPE");
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
      if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function normalizedOrigin(value: string | null): URL | null {
  if (!value) return null;
  try { const parsed = new URL(value); if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null; return parsed; }
  catch { return null; }
}
function normalizedHost(value: string | null): string | null {
  if (!value || value.includes(",") || /[\s/@\\]/u.test(value)) return null;
  try { return new URL(`http://${value}`).host.toLowerCase(); } catch { return null; }
}
function isSameOriginBrowserRequest(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  const origin = normalizedOrigin(request.headers.get("origin"));
  if (!origin) return false;
  const configured = normalizedOrigin(process.env.NEXUS_CORTEX_09_PUBLIC_ORIGIN ?? null);
  if (process.env.NEXUS_CORTEX_09_PUBLIC_ORIGIN !== undefined) return Boolean(configured && configured.origin === origin.origin);
  const effectiveHost = normalizedHost(request.headers.get("host"));
  return Boolean(effectiveHost && effectiveHost === origin.host.toLowerCase());
}
function sameModel(left: ReturnType<typeof readCortex09Runtime>, right: ReturnType<typeof readCortex09Runtime>): boolean {
  return Boolean(left.model && right.model && left.modelArtifactDigest && right.modelArtifactDigest && left.featureContractId === right.featureContractId && left.modelArtifactDigest === right.modelArtifactDigest && left.model.modelId === right.model.modelId && left.model.sourceDigest === right.model.sourceDigest);
}
function actionControl(runtime: ReturnType<typeof readCortex29ActionRuntime>) {
  return Object.freeze({ mode: runtime.mode, policyId: runtime.policy?.policyId ?? null, policySourceDigest: runtime.policy?.sourceDigest ?? null, policyArtifactDigest: runtime.policyArtifactDigest });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginBrowserRequest(request)) return new Response(null, { status: 403 });
  const initial = readCortex09Runtime();
  const initialAction = readCortex29ActionRuntime();
  if (initial.mode === "KILLED" || !initial.model || !initial.modelArtifactDigest) return Response.json({ mode: "KILLED" }, { status: 503, headers: { "cache-control": "no-store" } });

  let snapshot;
  let score;
  try {
    snapshot = parseFrictionSnapshot(await readBoundedJson(request));
    score = scoreFrictionAbandonment(snapshot, initial.model);
  } catch {
    return new Response(null, { status: 400, headers: { "cache-control": "no-store" } });
  }

  const final = readCortex09Runtime();
  const finalAction = readCortex29ActionRuntime();
  if (final.mode === "KILLED" || !final.model || !final.modelArtifactDigest) return Response.json({ mode: "KILLED" }, { status: 503, headers: { "cache-control": "no-store" } });
  if (!sameModel(initial, final)) return Response.json({ mode: "KILLED" }, { status: 409, headers: { "cache-control": "no-store" } });

  const controlStable = initialAction.mode === "KILLED" && finalAction.mode === "KILLED"
    ? true
    : sameCortex29ActionRuntime(initialAction, finalAction);
  let rescue = null;
  let rescueReason = controlStable ? "KILL_SWITCH" : "CONTROL_CHANGED";
  if (controlStable && finalAction.policy) {
    const decision = decideFrictionControlPlaneAction(snapshot, score, final.model, finalAction.policy);
    rescue = decision.action;
    rescueReason = decision.reason;
  }

  if (!(initial.mode === "ACTIVE" && final.mode === "ACTIVE")) {
    console.info(JSON.stringify({ component: "cortex-09-friction-scoring", mode: "OBSERVE_ONLY", pointerClass: score.pointerClass, riskBand: score.riskBand, modelSourceDigest: score.modelSourceDigest, modelArtifactDigest: final.modelArtifactDigest, rescueReason }));
    return Response.json({ mode: "OBSERVE_ONLY", modelArtifactDigest: final.modelArtifactDigest, score: null, actionControl: actionControl(finalAction), action: null, actionReason: rescueReason }, { status: 200, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }

  console.info(JSON.stringify({ component: "cortex-09-friction-scoring", mode: "ACTIVE", pointerClass: score.pointerClass, riskBand: score.riskBand, modelSourceDigest: score.modelSourceDigest, modelArtifactDigest: final.modelArtifactDigest, rescueReason }));
  return Response.json({ mode: "ACTIVE", modelArtifactDigest: final.modelArtifactDigest, score, actionControl: actionControl(finalAction), action: rescue, actionReason: rescueReason }, {
    status: 200,
    headers: { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" },
  });
}