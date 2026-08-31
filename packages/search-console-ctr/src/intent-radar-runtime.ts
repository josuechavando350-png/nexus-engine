import { fetchSearchAnalytics, type SearchAnalyticsRequest } from "./index";
import { analyzeIntentRadar, type IntentRadarReport, type IntentRadarScope, type IntentRule } from "./intent-radar";

export interface LiveIntentRadarInput {
  readonly scope: IntentRadarScope;
  readonly current: SearchAnalyticsRequest;
  readonly baseline: SearchAnalyticsRequest;
  readonly rules: readonly IntentRule[];
  readonly accessToken?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

export type LiveIntentRadarResult =
  | Readonly<{ status: "PASS"; report: IntentRadarReport }>
  | Readonly<{ status: "UNAVAILABLE" | "FAIL"; reason: string }>;

export async function runLiveIntentRadar(input: LiveIntentRadarInput): Promise<LiveIntentRadarResult> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("timeoutMs must be an integer from 100 to 60000");
  if (!input.accessToken?.trim()) return Object.freeze({ status: "UNAVAILABLE", reason: "Search Console OAuth access token unavailable" });
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) controller.abort(input.signal.reason);
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Intent Radar timeout")), timeoutMs);
  try {
    const [current, baseline] = await Promise.all([
      fetchSearchAnalytics(input.current, input.accessToken, input.fetchImpl ?? fetch, controller.signal),
      fetchSearchAnalytics(input.baseline, input.accessToken, input.fetchImpl ?? fetch, controller.signal),
    ]);
    if (current.status !== "PASS") return Object.freeze({ status: current.status, reason: `current window unavailable: ${current.reason ?? "unknown failure"}` });
    if (baseline.status !== "PASS") return Object.freeze({ status: baseline.status, reason: `baseline window unavailable: ${baseline.reason ?? "unknown failure"}` });
    return Object.freeze({ status: "PASS", report: analyzeIntentRadar({ scope: input.scope, dataset: current.dataset! }, { scope: input.scope, dataset: baseline.dataset! }, input.rules) });
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
