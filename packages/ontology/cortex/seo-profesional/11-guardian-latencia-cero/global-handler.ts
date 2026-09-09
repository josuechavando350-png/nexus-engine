import {
  assertRouteKey,
  type EdgePlatform,
  type EdgeUpstreamHandler,
} from "../10-candado-invisible/index.js";
import {
  EdgeRuntimeGuardError,
  assertOperationKey,
  type EdgeRuntimeGuardIdentity,
  type EdgeRuntimeHandler,
} from "./contracts.js";

export interface EdgeResilienceBoundaryPort {
  identity(): Readonly<{
    strategy: 10;
    provider: "PORTABLE_EDGE_RESILIENCE";
    platform: EdgePlatform;
    operatorWebsiteOrigin: string;
  }>;
  handle(routeKey: string, request: Request, upstream: EdgeUpstreamHandler): Promise<Response>;
}

export interface EdgeRuntimeGuardBoundaryPort {
  identity(): EdgeRuntimeGuardIdentity;
  handle(operationKey: string, request: Request, parentSignal: AbortSignal, primary: EdgeRuntimeHandler, fallback: EdgeRuntimeHandler): Promise<Response>;
}

export function createGuardedEdgeFetchHandler(input: {
  readonly edgeResilience: EdgeResilienceBoundaryPort;
  readonly runtimeGuard: EdgeRuntimeGuardBoundaryPort;
  readonly routeKey: string;
  readonly operationKey: string;
  readonly primary: EdgeRuntimeHandler;
  readonly fallback: EdgeRuntimeHandler;
}): (request: Request) => Promise<Response> {
  if (!input || typeof input !== "object") throw new EdgeRuntimeGuardError("INVALID_CONFIG", "guarded edge handler configuration is required");
  if (!input.edgeResilience || typeof input.edgeResilience.identity !== "function" || typeof input.edgeResilience.handle !== "function") {
    throw new EdgeRuntimeGuardError("INVALID_CONFIG", "edgeResilience is not a usable #10 runtime");
  }
  if (!input.runtimeGuard || typeof input.runtimeGuard.identity !== "function" || typeof input.runtimeGuard.handle !== "function") {
    throw new EdgeRuntimeGuardError("INVALID_CONFIG", "runtimeGuard is not a usable #11 runtime");
  }
  if (typeof input.primary !== "function" || typeof input.fallback !== "function") throw new EdgeRuntimeGuardError("INVALID_CONFIG", "primary and fallback handlers are required");
  const routeKey = assertRouteKey(input.routeKey);
  const operationKey = assertOperationKey(input.operationKey);
  const edgeIdentity = input.edgeResilience.identity();
  const guardIdentity = input.runtimeGuard.identity();
  if (edgeIdentity.strategy !== 10 || edgeIdentity.provider !== "PORTABLE_EDGE_RESILIENCE") {
    throw new EdgeRuntimeGuardError("IDENTITY_MISMATCH", "outer boundary must identify SEO strategy #10");
  }
  if (guardIdentity.strategy !== 11 || guardIdentity.provider !== "EDGE_RUNTIME_GLOBAL_GUARD" || guardIdentity.upstreamProvider !== "PORTABLE_EDGE_RESILIENCE") {
    throw new EdgeRuntimeGuardError("IDENTITY_MISMATCH", "runtime guard must identify SEO strategy #11 over #10");
  }
  if (edgeIdentity.operatorWebsiteOrigin !== guardIdentity.operatorWebsiteOrigin || edgeIdentity.platform !== guardIdentity.platform) {
    throw new EdgeRuntimeGuardError("IDENTITY_MISMATCH", "#10 and #11 must protect the same origin on the same platform");
  }

  return async (request: Request) => input.edgeResilience.handle(
    routeKey,
    request,
    (edgeRequest, edgeSignal) => input.runtimeGuard.handle(operationKey, edgeRequest, edgeSignal, input.primary, input.fallback),
  );
}
