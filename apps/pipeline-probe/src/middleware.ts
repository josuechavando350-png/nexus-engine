import { NextResponse, type NextRequest } from "next/server";
import { evaluateCwvEdgeRequest, parseCwvEdgePolicy } from "@nexus/core/cortex/cwv-lifecycle-pipeline";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;

function identities(): { prebuild: string; edge: string; source: string; policy: ReturnType<typeof parseCwvEdgePolicy> } | null {
  const prebuild = process.env.NEXUS_CORTEX_33_PREBUILD_DIGEST;
  const edge = process.env.NEXUS_CORTEX_33_EDGE_POLICY_DIGEST;
  const source = process.env.NEXUS_CORTEX_33_SOURCE_REVISION;
  const rawPolicy = process.env.NEXUS_CORTEX_33_EDGE_POLICY_JSON;
  if (!prebuild || !edge || !source || !rawPolicy || !SHA256.test(prebuild) || !SHA256.test(edge) || !SHA.test(source)) return null;
  try { return { prebuild, edge, source, policy: parseCwvEdgePolicy(JSON.parse(rawPolicy) as unknown) }; }
  catch { return null; }
}

export function middleware(request: NextRequest) {
  const identity = identities();
  if (!identity) {
    const response = NextResponse.next();
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-nexus-cortex33-mode", "KILLED");
    return response;
  }

  const decision = evaluateCwvEdgeRequest(identity.policy, {
    url: request.url,
    method: request.method,
    hasAuthorization: request.headers.has("authorization"),
    hasCookie: request.headers.has("cookie"),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nexus-cortex33-prebuild", identity.prebuild);
  requestHeaders.set("x-nexus-cortex33-edge", identity.edge);
  requestHeaders.set("x-nexus-cortex33-source", identity.source);
  requestHeaders.set("x-nexus-cortex33-edge-reason", decision.reason);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("cache-control", decision.cacheControl);
  response.headers.set("x-nexus-cortex33-mode", decision.mode);
  response.headers.set("x-nexus-cortex33-prebuild", identity.prebuild);
  response.headers.set("x-nexus-cortex33-edge", identity.edge);
  response.headers.set("x-nexus-cortex33-edge-reason", decision.reason);
  if (decision.preload) {
    response.headers.append("link", `<${decision.preload.href}>; rel=preload; as=${decision.preload.as}`);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
