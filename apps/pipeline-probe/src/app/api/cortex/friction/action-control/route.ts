import { readCortex29ActionRuntime } from "../friction-action-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const runtime = readCortex29ActionRuntime();
  return Response.json({
    mode: runtime.mode,
    policyId: runtime.policy?.policyId ?? null,
    policySourceDigest: runtime.policy?.sourceDigest ?? null,
    policyArtifactDigest: runtime.policyArtifactDigest,
  }, {
    status: runtime.mode === "KILLED" ? 503 : 200,
    headers: { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" },
  });
}
