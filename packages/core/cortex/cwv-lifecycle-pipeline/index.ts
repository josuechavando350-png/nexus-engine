import { evaluateCwvLifecycle, type CwvLifecycleSample, type CwvLifecycleThresholds } from "../cwv-lifecycle-optimizer/index";

const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{2,127})$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/u;
const CACHE_CONTROL = /^(?:public,\s*)?max-age=\d+(?:,\s*s-maxage=\d+)?(?:,\s*stale-while-revalidate=\d+)?$/u;

export type CwvOptimizationKind = "BUNDLE_SPLIT" | "CRITICAL_CSS" | "IMAGE_PERCEPTUAL" | "FONT_LOADING" | "EDGE_CACHE" | "LAZY_LOADING" | "JS_SCHEDULING" | "LCP_PRELOAD";
export type CwvEdgeMode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

export interface CwvBuildOptimizationAction {
  readonly actionId: string;
  readonly kind: CwvOptimizationKind;
  readonly target: string;
  readonly required: boolean;
}
export interface CwvBuildOptimizationPlan { readonly version: 1; readonly policyId: string; readonly actions: readonly CwvBuildOptimizationAction[]; }
export interface CwvOptimizationReceipt { readonly actionId: string; readonly kind: CwvOptimizationKind; readonly status: "APPLIED" | "NO_CHANGE"; readonly beforeDigest: `sha256:${string}`; readonly afterDigest: `sha256:${string}`; readonly evidenceDigest: `sha256:${string}`; }
export interface CwvBuildOptimizationAdapter { apply(action: CwvBuildOptimizationAction): Promise<CwvOptimizationReceipt>; }

export interface CwvMetricsSnapshot {
  readonly lcpMs: number | null;
  readonly inpMs: number | null;
  readonly cls: number;
  readonly ttfbMs: number | null;
  readonly totalJsBytes: number;
  readonly totalCssBytes: number;
  readonly imageBytes: number;
  readonly fontBytes: number;
}
export interface CwvRegressionGuardrails {
  readonly maxLcpRegressionMs: number;
  readonly maxInpRegressionMs: number;
  readonly maxClsRegression: number;
  readonly maxTtfbRegressionMs: number;
  readonly maxJsGrowthBytes: number;
  readonly maxCssGrowthBytes: number;
  readonly maxImageGrowthBytes: number;
  readonly maxFontGrowthBytes: number;
}
export interface CwvProofDigest { readonly visual: `sha256:${string}`; readonly functional: `sha256:${string}`; }
export interface CwvLifecycleCertification { readonly plan: CwvBuildOptimizationPlan; readonly receipts: readonly CwvOptimizationReceipt[]; readonly before: CwvMetricsSnapshot; readonly after: CwvMetricsSnapshot; readonly proofs: CwvProofDigest; readonly improvements: Readonly<Record<"lcpMs" | "inpMs" | "cls" | "ttfbMs" | "totalJsBytes" | "totalCssBytes" | "imageBytes" | "fontBytes", number | null>>; }

export interface CwvEdgeRoutePolicy { readonly path: string; readonly cacheControl: string; readonly lcpPreloadPath: string | null; readonly lcpPreloadAs: "image" | "font" | "style" | null; }
export interface CwvEdgePolicy { readonly version: 1; readonly policyId: string; readonly mode: CwvEdgeMode; readonly routes: readonly CwvEdgeRoutePolicy[]; }
export interface CwvEdgeRequestInput { readonly url: string; readonly method: string; readonly hasAuthorization: boolean; readonly hasCookie: boolean; }
export interface CwvEdgeDecision { readonly mode: CwvEdgeMode; readonly path: string; readonly optimized: boolean; readonly reason: "OPTIMIZED" | "KILLED" | "OBSERVE_ONLY" | "METHOD_NOT_SAFE" | "PRIVATE_CONTEXT" | "QUERY_PRESENT" | "ROUTE_NOT_ALLOWLISTED"; readonly cacheControl: string; readonly preload: Readonly<{ href: string; as: "image" | "font" | "style" }> | null; }

export interface CwvRuntimeOptimizationDecision {
  readonly state: "NORMAL" | "PRESSURE" | "PAUSED";
  readonly reasons: readonly ("HIDDEN" | "LCP" | "CLS" | "INP" | "LONG_TASK")[];
  readonly shouldSuspendSpeculation: boolean;
  readonly javascriptScheduling: "NORMAL" | "YIELD_NON_CRITICAL";
  readonly lazyLoading: "NORMAL" | "SUSPEND_BACKGROUND";
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(`${label} is out of range`);
  return value;
}
function integer(value: unknown, label: string, max: number): number { const n = finite(value, label, 0, max); if (!Number.isSafeInteger(n)) throw new TypeError(`${label} must be an integer`); return n; }
function digest(value: string, label: string): `sha256:${string}` { if (!SHA256.test(value)) throw new TypeError(`${label} must be sha256`); return value as `sha256:${string}`; }
function metric(value: unknown, label: string, max: number): number | null { return value === null ? null : finite(value, label, 0, max); }

export function createCwvBuildOptimizationPlan(policyIdInput: string, actionsInput: readonly CwvBuildOptimizationAction[]): CwvBuildOptimizationPlan {
  const policyId = policyIdInput.trim();
  if (!ID.test(policyId)) throw new TypeError("CWV policyId is invalid");
  if (!Array.isArray(actionsInput) || actionsInput.length < 1 || actionsInput.length > 64) throw new TypeError("CWV build plan must contain 1..64 actions");
  const seen = new Set<string>();
  const actions = actionsInput.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "actionId,kind,required,target") throw new TypeError(`CWV action ${index} contract is invalid`);
    if (!ID.test(entry.actionId) || seen.has(entry.actionId)) throw new TypeError(`CWV action ${index} id is invalid or duplicated`); seen.add(entry.actionId);
    if (!(entry.kind === "BUNDLE_SPLIT" || entry.kind === "CRITICAL_CSS" || entry.kind === "IMAGE_PERCEPTUAL" || entry.kind === "FONT_LOADING" || entry.kind === "EDGE_CACHE" || entry.kind === "LAZY_LOADING" || entry.kind === "JS_SCHEDULING" || entry.kind === "LCP_PRELOAD")) throw new TypeError(`CWV action ${index} kind is invalid`);
    if (typeof entry.target !== "string" || entry.target.length < 1 || entry.target.length > 512 || /[\u0000-\u001f\u007f]/u.test(entry.target)) throw new TypeError(`CWV action ${index} target is invalid`);
    if (typeof entry.required !== "boolean") throw new TypeError(`CWV action ${index} required is invalid`);
    return Object.freeze({ actionId: entry.actionId, kind: entry.kind, target: entry.target, required: entry.required });
  });
  return Object.freeze({ version: 1, policyId, actions: Object.freeze(actions) });
}

export async function executeCwvBuildOptimizationPlan(plan: CwvBuildOptimizationPlan, adapter: CwvBuildOptimizationAdapter): Promise<readonly CwvOptimizationReceipt[]> {
  const receipts: CwvOptimizationReceipt[] = [];
  const seen = new Set<string>();
  for (const action of plan.actions) {
    const receipt = await adapter.apply(action);
    if (receipt.actionId !== action.actionId || receipt.kind !== action.kind || !(receipt.status === "APPLIED" || receipt.status === "NO_CHANGE")) throw new Error(`CWV adapter receipt does not match ${action.actionId}`);
    if (seen.has(receipt.actionId)) throw new Error(`CWV adapter emitted duplicate receipt ${receipt.actionId}`); seen.add(receipt.actionId);
    digest(receipt.beforeDigest, "beforeDigest"); digest(receipt.afterDigest, "afterDigest"); digest(receipt.evidenceDigest, "evidenceDigest");
    if (action.required && receipt.status !== "APPLIED") throw new Error(`required CWV action ${action.actionId} was not applied`);
    receipts.push(Object.freeze({ ...receipt }));
  }
  return Object.freeze(receipts);
}

function snapshot(value: CwvMetricsSnapshot, label: string): CwvMetricsSnapshot {
  return Object.freeze({
    lcpMs: metric(value.lcpMs, `${label}.lcpMs`, 600_000), inpMs: metric(value.inpMs, `${label}.inpMs`, 60_000), cls: finite(value.cls, `${label}.cls`, 0, 100), ttfbMs: metric(value.ttfbMs, `${label}.ttfbMs`, 600_000),
    totalJsBytes: integer(value.totalJsBytes, `${label}.totalJsBytes`, 2_000_000_000), totalCssBytes: integer(value.totalCssBytes, `${label}.totalCssBytes`, 1_000_000_000), imageBytes: integer(value.imageBytes, `${label}.imageBytes`, 10_000_000_000), fontBytes: integer(value.fontBytes, `${label}.fontBytes`, 2_000_000_000),
  });
}

export function certifyCwvLifecycleOptimization(input: { plan: CwvBuildOptimizationPlan; receipts: readonly CwvOptimizationReceipt[]; before: CwvMetricsSnapshot; after: CwvMetricsSnapshot; proofs: CwvProofDigest; guardrails: CwvRegressionGuardrails }): CwvLifecycleCertification {
  if (input.receipts.length !== input.plan.actions.length) throw new Error("CWV certification requires one receipt per planned action");
  const receipts = new Map<string, CwvOptimizationReceipt>();
  for (const receipt of input.receipts) {
    if (receipts.has(receipt.actionId)) throw new Error(`duplicate CWV receipt ${receipt.actionId}`);
    digest(receipt.beforeDigest, "beforeDigest"); digest(receipt.afterDigest, "afterDigest"); digest(receipt.evidenceDigest, "evidenceDigest");
    receipts.set(receipt.actionId, receipt);
  }
  for (const action of input.plan.actions) {
    const receipt = receipts.get(action.actionId);
    if (!receipt || receipt.kind !== action.kind) throw new Error(`CWV receipt missing or mismatched for ${action.actionId}`);
    if (action.required && receipt.status !== "APPLIED") throw new Error(`required CWV action ${action.actionId} lacks applied evidence`);
  }
  digest(input.proofs.visual, "visual proof"); digest(input.proofs.functional, "functional proof");
  const before = snapshot(input.before, "before"); const after = snapshot(input.after, "after");
  const g = input.guardrails;
  const maxLcp = finite(g.maxLcpRegressionMs, "maxLcpRegressionMs", 0, 60_000); const maxInp = finite(g.maxInpRegressionMs, "maxInpRegressionMs", 0, 10_000); const maxCls = finite(g.maxClsRegression, "maxClsRegression", 0, 10); const maxTtfb = finite(g.maxTtfbRegressionMs, "maxTtfbRegressionMs", 0, 60_000); const maxJs = integer(g.maxJsGrowthBytes, "maxJsGrowthBytes", 1_000_000_000); const maxCss = integer(g.maxCssGrowthBytes, "maxCssGrowthBytes", 500_000_000); const maxImages = integer(g.maxImageGrowthBytes, "maxImageGrowthBytes", 5_000_000_000); const maxFonts = integer(g.maxFontGrowthBytes, "maxFontGrowthBytes", 1_000_000_000);
  if (before.lcpMs !== null && after.lcpMs !== null && after.lcpMs - before.lcpMs > maxLcp) throw new Error("CWV LCP regression exceeds guardrail");
  if (before.inpMs !== null && after.inpMs !== null && after.inpMs - before.inpMs > maxInp) throw new Error("CWV INP regression exceeds guardrail");
  if (after.cls - before.cls > maxCls) throw new Error("CWV CLS regression exceeds guardrail");
  if (before.ttfbMs !== null && after.ttfbMs !== null && after.ttfbMs - before.ttfbMs > maxTtfb) throw new Error("CWV TTFB regression exceeds guardrail");
  if (after.totalJsBytes - before.totalJsBytes > maxJs) throw new Error("CWV JavaScript growth exceeds guardrail");
  if (after.totalCssBytes - before.totalCssBytes > maxCss) throw new Error("CWV CSS growth exceeds guardrail");
  if (after.imageBytes - before.imageBytes > maxImages) throw new Error("CWV image growth exceeds guardrail");
  if (after.fontBytes - before.fontBytes > maxFonts) throw new Error("CWV font growth exceeds guardrail");
  const diff = (left: number | null, right: number | null) => left === null || right === null ? null : left - right;
  return Object.freeze({ plan: input.plan, receipts: Object.freeze([...input.receipts]), before, after, proofs: Object.freeze({ ...input.proofs }), improvements: Object.freeze({ lcpMs: diff(before.lcpMs, after.lcpMs), inpMs: diff(before.inpMs, after.inpMs), cls: before.cls - after.cls, ttfbMs: diff(before.ttfbMs, after.ttfbMs), totalJsBytes: before.totalJsBytes - after.totalJsBytes, totalCssBytes: before.totalCssBytes - after.totalCssBytes, imageBytes: before.imageBytes - after.imageBytes, fontBytes: before.fontBytes - after.fontBytes }) });
}

export function evaluateCwvRuntimeOptimization(sample: CwvLifecycleSample, thresholds?: CwvLifecycleThresholds): CwvRuntimeOptimizationDecision {
  const decision = evaluateCwvLifecycle(sample, thresholds);
  return Object.freeze({ ...decision, javascriptScheduling: decision.state === "NORMAL" ? "NORMAL" as const : "YIELD_NON_CRITICAL" as const, lazyLoading: decision.state === "PAUSED" ? "SUSPEND_BACKGROUND" as const : "NORMAL" as const });
}

export function parseCwvEdgePolicy(value: unknown): CwvEdgePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("CWV edge policy must be a plain object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "mode,policyId,routes,version" || raw.version !== 1 || typeof raw.policyId !== "string" || !ID.test(raw.policyId) || !(raw.mode === "ACTIVE" || raw.mode === "OBSERVE_ONLY" || raw.mode === "KILLED") || !Array.isArray(raw.routes) || raw.routes.length < 1 || raw.routes.length > 128) throw new TypeError("CWV edge policy contract is invalid");
  const seen = new Set<string>();
  const routes = raw.routes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`CWV edge route ${index} is invalid`);
    const route = entry as Record<string, unknown>;
    if (Object.keys(route).sort().join(",") !== "cacheControl,lcpPreloadAs,lcpPreloadPath,path" || typeof route.path !== "string" || !PATH.test(route.path) || seen.has(route.path) || typeof route.cacheControl !== "string" || !CACHE_CONTROL.test(route.cacheControl.trim())) throw new TypeError(`CWV edge route ${index} contract is invalid`); seen.add(route.path);
    if (!(route.lcpPreloadAs === null || route.lcpPreloadAs === "image" || route.lcpPreloadAs === "font" || route.lcpPreloadAs === "style") || !(route.lcpPreloadPath === null || (typeof route.lcpPreloadPath === "string" && PATH.test(route.lcpPreloadPath))) || ((route.lcpPreloadAs === null) !== (route.lcpPreloadPath === null))) throw new TypeError(`CWV edge route ${index} preload is invalid`);
    return Object.freeze({ path: route.path, cacheControl: route.cacheControl.trim(), lcpPreloadPath: route.lcpPreloadPath as string | null, lcpPreloadAs: route.lcpPreloadAs as CwvEdgeRoutePolicy["lcpPreloadAs"] });
  });
  return Object.freeze({ version: 1, policyId: raw.policyId, mode: raw.mode, routes: Object.freeze(routes) });
}

export function evaluateCwvEdgeRequest(policyInput: unknown, input: CwvEdgeRequestInput): CwvEdgeDecision {
  const policy = parseCwvEdgePolicy(policyInput); const url = new URL(input.url); const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname; const privateCache = "private, no-store, max-age=0";
  const no = (reason: Exclude<CwvEdgeDecision["reason"], "OPTIMIZED">): CwvEdgeDecision => Object.freeze({ mode: policy.mode, path, optimized: false, reason, cacheControl: privateCache, preload: null });
  if (policy.mode === "KILLED") return no("KILLED"); if (policy.mode === "OBSERVE_ONLY") return no("OBSERVE_ONLY"); if (!(input.method === "GET" || input.method === "HEAD")) return no("METHOD_NOT_SAFE"); if (input.hasAuthorization || input.hasCookie) return no("PRIVATE_CONTEXT"); if (url.search.length > 0) return no("QUERY_PRESENT");
  const route = policy.routes.find((candidate) => candidate.path === path); if (!route) return no("ROUTE_NOT_ALLOWLISTED");
  return Object.freeze({ mode: policy.mode, path, optimized: true, reason: "OPTIMIZED", cacheControl: route.cacheControl, preload: route.lcpPreloadPath && route.lcpPreloadAs ? Object.freeze({ href: route.lcpPreloadPath, as: route.lcpPreloadAs }) : null });
}

export function cwvEdgeResponseHeaders(decision: CwvEdgeDecision): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { "cache-control": decision.cacheControl };
  if (decision.optimized && decision.preload) {
    const crossorigin = decision.preload.as === "font" ? "; crossorigin=anonymous" : "";
    headers.link = `<${decision.preload.href}>; rel=preload; as=${decision.preload.as}${crossorigin}`;
  }
  return Object.freeze(headers);
}
