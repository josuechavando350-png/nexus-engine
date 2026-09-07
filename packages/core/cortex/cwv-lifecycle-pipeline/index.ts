export type CwvEdgeMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export interface CwvEdgeRoutePolicy {
  readonly path: string;
  readonly cacheControl: string;
  readonly lcpPreloadPath: string | null;
  readonly lcpPreloadAs: "image" | "font" | "style" | null;
}

export interface CwvEdgePolicy {
  readonly version: 1;
  readonly policyId: string;
  readonly mode: CwvEdgeMode;
  readonly routes: readonly CwvEdgeRoutePolicy[];
}

export interface CwvEdgeRequestInput {
  readonly url: string;
  readonly method: string;
  readonly hasAuthorization: boolean;
  readonly hasCookie: boolean;
}

export interface CwvEdgeDecision {
  readonly mode: CwvEdgeMode;
  readonly path: string;
  readonly optimized: boolean;
  readonly reason: "OPTIMIZED" | "KILLED" | "OBSERVE_ONLY" | "METHOD_NOT_SAFE" | "PRIVATE_CONTEXT" | "QUERY_PRESENT" | "ROUTE_NOT_ALLOWLISTED";
  readonly cacheControl: string;
  readonly preload: Readonly<{ href: string; as: "image" | "font" | "style" }> | null;
}

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/u;
const CACHE = /^(?:public,\s*)?max-age=\d+(?:,\s*s-maxage=\d+)?(?:,\s*stale-while-revalidate=\d+)?$/u;

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function normalizedPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !PATH.test(value)) throw new Error(`${label} must be a clean absolute path`);
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

export function parseCwvEdgePolicy(value: unknown): CwvEdgePolicy {
  const raw = plain(value, "CWV edge policy");
  if (Object.keys(raw).sort().join(",") !== "mode,policyId,routes,version" || raw.version !== 1) throw new Error("CWV edge policy contract/version is invalid");
  if (typeof raw.policyId !== "string" || !ID.test(raw.policyId.trim())) throw new Error("CWV edge policyId is malformed");
  if (!(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED")) throw new Error("CWV edge mode is invalid");
  if (!Array.isArray(raw.routes) || raw.routes.length < 1 || raw.routes.length > 128) throw new Error("CWV edge routes must contain 1..128 entries");
  const seen = new Set<string>();
  const routes = raw.routes.map((entry, index): CwvEdgeRoutePolicy => {
    const item = plain(entry, `CWV edge routes[${index}]`);
    if (Object.keys(item).sort().join(",") !== "cacheControl,lcpPreloadAs,lcpPreloadPath,path") throw new Error(`CWV edge routes[${index}] contract is invalid`);
    const path = normalizedPath(item.path, `routes[${index}].path`);
    if (seen.has(path)) throw new Error(`CWV edge route ${path} is duplicated`);
    seen.add(path);
    if (typeof item.cacheControl !== "string" || !CACHE.test(item.cacheControl.trim())) throw new Error(`routes[${index}].cacheControl is invalid`);
    const lcpPreloadPath = item.lcpPreloadPath === null ? null : normalizedPath(item.lcpPreloadPath, `routes[${index}].lcpPreloadPath`);
    const lcpPreloadAs = item.lcpPreloadAs;
    if (!(lcpPreloadAs === null || lcpPreloadAs === "image" || lcpPreloadAs === "font" || lcpPreloadAs === "style")) throw new Error(`routes[${index}].lcpPreloadAs is invalid`);
    if ((lcpPreloadPath === null) !== (lcpPreloadAs === null)) throw new Error(`routes[${index}] preload path/as must be supplied together`);
    return Object.freeze({ path, cacheControl: item.cacheControl.trim(), lcpPreloadPath, lcpPreloadAs });
  });
  return Object.freeze({ version: 1, policyId: raw.policyId.trim(), mode: raw.mode, routes: Object.freeze(routes) });
}

export function evaluateCwvEdgeRequest(policyInput: unknown, input: CwvEdgeRequestInput): CwvEdgeDecision {
  const policy = parseCwvEdgePolicy(policyInput);
  const url = new URL(input.url);
  const path = normalizedPath(url.pathname, "request path");
  const privateCache = "private, no-store, max-age=0";
  const no = (reason: Exclude<CwvEdgeDecision["reason"], "OPTIMIZED">): CwvEdgeDecision => Object.freeze({ mode: policy.mode, path, optimized: false, reason, cacheControl: privateCache, preload: null });
  if (policy.mode === "KILLED") return no("KILLED");
  if (policy.mode === "OBSERVE_ONLY") return no("OBSERVE_ONLY");
  if (!(input.method === "GET" || input.method === "HEAD")) return no("METHOD_NOT_SAFE");
  if (input.hasAuthorization || input.hasCookie) return no("PRIVATE_CONTEXT");
  if (url.search.length > 0) return no("QUERY_PRESENT");
  const route = policy.routes.find((entry) => entry.path === path);
  if (!route) return no("ROUTE_NOT_ALLOWLISTED");
  return Object.freeze({
    mode: policy.mode,
    path,
    optimized: true,
    reason: "OPTIMIZED",
    cacheControl: route.cacheControl,
    preload: route.lcpPreloadPath && route.lcpPreloadAs ? Object.freeze({ href: route.lcpPreloadPath, as: route.lcpPreloadAs }) : null,
  });
}
