export type EdgeCacheMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";
export type EdgeCacheReason = "CACHEABLE" | "OBSERVE_ONLY" | "KILL_SWITCH" | "METHOD_NOT_CACHEABLE" | "QUERY_PRESENT" | "IDENTITY_PRESENT" | "PATH_NOT_ALLOWLISTED";

export interface EdgeCachePathPolicyInput {
  readonly path: string;
  readonly maxAgeSeconds: number;
  readonly staleWhileRevalidateSeconds: number;
  readonly prerenderAllowed: boolean;
}

export interface EdgeCachePolicyInput {
  readonly version: 1;
  readonly mode: EdgeCacheMode;
  readonly paths: readonly EdgeCachePathPolicyInput[];
}

export interface EdgeCachePathPolicy extends EdgeCachePathPolicyInput {}
export interface EdgeCachePolicy {
  readonly version: 1;
  readonly mode: EdgeCacheMode;
  readonly paths: ReadonlyMap<string, EdgeCachePathPolicy>;
}

export interface EdgeCacheRequestInput {
  readonly url: string;
  readonly method: string;
  readonly authorizationPresent: boolean;
  readonly cookiePresent: boolean;
}

export interface EdgeCacheDecision {
  readonly mode: EdgeCacheMode;
  readonly path: string;
  readonly cacheable: boolean;
  readonly prerenderAllowed: boolean;
  readonly cacheControl: string;
  readonly reason: EdgeCacheReason;
}

const PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/u;

function path(value: string): string {
  if (typeof value !== "string" || !PATH.test(value.trim())) throw new Error("edge cache path must be an absolute path without query or fragment");
  const normalized = value.trim();
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function seconds(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${field} must be 0..${max}`);
  return value;
}

export function createEdgeCachePolicy(input: EdgeCachePolicyInput): EdgeCachePolicy {
  if (!input || typeof input !== "object" || input.version !== 1) throw new Error("edge cache policy version must be 1");
  if (!(input.mode === "ACTIVE" || input.mode === "OBSERVE_ONLY" || input.mode === "KILLED")) throw new Error("edge cache mode is invalid");
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 64) throw new Error("edge cache paths must contain 1..64 items");
  const values = new Map<string, EdgeCachePathPolicy>();
  for (const [index, item] of input.paths.entries()) {
    if (!item || typeof item !== "object") throw new Error(`paths[${index}] is invalid`);
    const normalizedPath = path(item.path);
    if (values.has(normalizedPath)) throw new Error(`duplicate edge cache path ${normalizedPath}`);
    const maxAgeSeconds = seconds(item.maxAgeSeconds, `paths[${index}].maxAgeSeconds`, 86_400);
    const staleWhileRevalidateSeconds = seconds(item.staleWhileRevalidateSeconds, `paths[${index}].staleWhileRevalidateSeconds`, 604_800);
    if (typeof item.prerenderAllowed !== "boolean") throw new Error(`paths[${index}].prerenderAllowed must be boolean`);
    if (item.prerenderAllowed && maxAgeSeconds === 0) throw new Error(`paths[${index}] cannot allow prerender with zero edge cache lifetime`);
    values.set(normalizedPath, Object.freeze({ path: normalizedPath, maxAgeSeconds, staleWhileRevalidateSeconds, prerenderAllowed: item.prerenderAllowed }));
  }
  return Object.freeze({ version: 1, mode: input.mode, paths: values });
}

function noStore(mode: EdgeCacheMode, requestPath: string, reason: EdgeCacheReason): EdgeCacheDecision {
  return Object.freeze({ mode, path: requestPath, cacheable: false, prerenderAllowed: false, cacheControl: "private, no-store", reason });
}

export function evaluateEdgeCache(input: EdgeCacheRequestInput, policy: EdgeCachePolicy): EdgeCacheDecision {
  const url = new URL(input.url);
  const requestPath = path(url.pathname);
  if (policy.mode === "KILLED") return noStore(policy.mode, requestPath, "KILL_SWITCH");
  if (!(input.method === "GET" || input.method === "HEAD")) return noStore(policy.mode, requestPath, "METHOD_NOT_CACHEABLE");
  if (url.search.length > 0) return noStore(policy.mode, requestPath, "QUERY_PRESENT");
  if (input.authorizationPresent || input.cookiePresent) return noStore(policy.mode, requestPath, "IDENTITY_PRESENT");
  const configured = policy.paths.get(requestPath);
  if (!configured) return noStore(policy.mode, requestPath, "PATH_NOT_ALLOWLISTED");
  if (policy.mode === "OBSERVE_ONLY") return Object.freeze({ mode: policy.mode, path: requestPath, cacheable: false, prerenderAllowed: false, cacheControl: "private, no-store", reason: "OBSERVE_ONLY" });
  return Object.freeze({
    mode: policy.mode,
    path: requestPath,
    cacheable: configured.maxAgeSeconds > 0,
    prerenderAllowed: configured.prerenderAllowed,
    cacheControl: configured.maxAgeSeconds > 0 ? `public, s-maxage=${configured.maxAgeSeconds}, stale-while-revalidate=${configured.staleWhileRevalidateSeconds}` : "private, no-store",
    reason: "CACHEABLE",
  });
}

export function prerenderControlFromEdgeCache(policy: EdgeCachePolicy, maxPreparedTargets: number): Readonly<{ mode: EdgeCacheMode; allowedPaths: readonly string[]; maxPreparedTargets: number }> {
  if (!Number.isSafeInteger(maxPreparedTargets) || maxPreparedTargets < 1 || maxPreparedTargets > 16) throw new Error("maxPreparedTargets must be 1..16");
  const allowedPaths = [...policy.paths.values()].filter((item) => item.prerenderAllowed && item.maxAgeSeconds > 0).map((item) => item.path).sort();
  if (allowedPaths.length < 1) throw new Error("edge cache policy must expose at least one prerender-safe path");
  return Object.freeze({ mode: policy.mode, allowedPaths: Object.freeze(allowedPaths), maxPreparedTargets });
}
