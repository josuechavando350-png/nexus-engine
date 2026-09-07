import { createEdgeCachePolicy, prerenderControlFromEdgeCache, type EdgeCachePolicyInput } from "@nexus/core/cortex/interaction-pointer-edge-caching";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configuredControl() {
  try {
    const raw = process.env.NEXUS_CORTEX_28_EDGE_CACHE_POLICY_JSON?.trim();
    if (!raw) throw new Error("NEXUS_CORTEX_28_EDGE_CACHE_POLICY_JSON is required");
    const policy = createEdgeCachePolicy(JSON.parse(raw) as EdgeCachePolicyInput);
    const maxRaw = process.env.NEXUS_CORTEX_08_MAX_PREPARED_TARGETS?.trim() ?? "4";
    if (!/^\d+$/u.test(maxRaw)) throw new Error("NEXUS_CORTEX_08_MAX_PREPARED_TARGETS is invalid");
    return prerenderControlFromEdgeCache(policy, Number(maxRaw));
  } catch {
    return { mode: "KILLED", allowedPaths: ["/"], maxPreparedTargets: 1 } as const;
  }
}

export async function GET(): Promise<Response> {
  return Response.json(configuredControl(), {
    status: 200,
    headers: {
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}