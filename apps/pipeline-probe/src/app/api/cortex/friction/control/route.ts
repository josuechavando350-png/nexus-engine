import { readCortex09Runtime } from "../friction-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const control = readCortex09Runtime();
  return Response.json({
    mode: control.mode,
    modelId: control.model?.modelId ?? null,
    modelSourceDigest: control.model?.sourceDigest ?? null,
    modelArtifactDigest: control.modelArtifactDigest,
  }, {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}
