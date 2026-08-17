import type { Page } from "playwright";

export type VitalState = "MEASURED" | "NOT_OBSERVED" | "UNSUPPORTED";

export interface VitalValue {
  state: VitalState;
  value?: number;
  unit: "ms" | "score";
}

export interface WebVitalsEvidence {
  schemaVersion: 1;
  lcp: VitalValue;
  cls: VitalValue;
  inp: VitalValue;
  fcp: VitalValue;
  navigationDuration: VitalValue;
  resourceCount: number;
  scriptTransferBytes: number;
}

export interface WebVitalsPolicy {
  maximumLcpMs?: number;
  maximumCls?: number;
  maximumInpMs?: number;
  requireMeasured?: readonly ("lcp" | "cls" | "inp")[];
}

export interface WebVitalsPolicyResult {
  verdict: "PASS" | "FAIL" | "NOT_TESTED";
  findings: readonly string[];
}

export async function installWebVitalsObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const store = { lcp: [] as number[], cls: [] as number[], inp: [] as number[] };
    Object.defineProperty(globalThis, "__NEXUS_WEB_VITALS__", { value: store, configurable: false, writable: false });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.lcp.push(entry.startTime);
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch { /* unsupported browser */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (!shift.hadRecentInput && Number.isFinite(shift.value)) store.cls.push(shift.value ?? 0);
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* unsupported browser */ }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEntry & { duration?: number; interactionId?: number };
          if ((event.interactionId ?? 0) > 0 && Number.isFinite(event.duration)) store.inp.push(event.duration ?? 0);
        }
      }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
    } catch { /* unsupported browser */ }
  });
}

export async function collectWebVitals(page: Page): Promise<WebVitalsEvidence> {
  return page.evaluate(() => {
    const store = (globalThis as typeof globalThis & { __NEXUS_WEB_VITALS__?: { lcp: number[]; cls: number[]; inp: number[] } }).__NEXUS_WEB_VITALS__;
    const supported = (type: string) => Array.isArray(PerformanceObserver.supportedEntryTypes) && PerformanceObserver.supportedEntryTypes.includes(type);
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    const scriptResources = resources.filter((entry) => entry.initiatorType === "script");
    const lcpValues = store?.lcp ?? [];
    const clsValues = store?.cls ?? [];
    const inpValues = store?.inp ?? [];
    const vital = (isSupported: boolean, values: number[], aggregate: (items: number[]) => number, unit: "ms" | "score"): VitalValue => {
      if (!isSupported) return { state: "UNSUPPORTED", unit };
      if (!values.length) return { state: "NOT_OBSERVED", unit };
      return { state: "MEASURED", value: aggregate(values), unit };
    };
    return {
      schemaVersion: 1 as const,
      lcp: vital(supported("largest-contentful-paint"), lcpValues, (items) => Math.max(...items), "ms"),
      cls: vital(supported("layout-shift"), clsValues, (items) => items.reduce((sum, value) => sum + value, 0), "score"),
      inp: vital(supported("event"), inpValues, (items) => Math.max(...items), "ms"),
      fcp: fcp ? { state: "MEASURED", value: fcp.startTime, unit: "ms" } : { state: "NOT_OBSERVED", unit: "ms" },
      navigationDuration: navigation ? { state: "MEASURED", value: navigation.duration, unit: "ms" } : { state: "NOT_OBSERVED", unit: "ms" },
      resourceCount: resources.length,
      scriptTransferBytes: scriptResources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    } satisfies WebVitalsEvidence;
  });
}

export function evaluateWebVitalsPolicy(evidence: WebVitalsEvidence, policy: WebVitalsPolicy): WebVitalsPolicyResult {
  const hasPolicy = policy.maximumLcpMs !== undefined || policy.maximumCls !== undefined || policy.maximumInpMs !== undefined || Boolean(policy.requireMeasured?.length);
  if (!hasPolicy) return Object.freeze({ verdict: "NOT_TESTED", findings: Object.freeze([]) });
  const findings: string[] = [];
  const required = new Set(policy.requireMeasured ?? []);
  const metricMap = { lcp: evidence.lcp, cls: evidence.cls, inp: evidence.inp } as const;
  for (const metric of required) {
    if (metricMap[metric].state !== "MEASURED") findings.push(`${metric.toUpperCase()} is ${metricMap[metric].state}; policy requires a measured value`);
  }
  const checkMax = (label: string, vital: VitalValue, maximum: number | undefined) => {
    if (maximum === undefined) return;
    if (!Number.isFinite(maximum) || maximum < 0) throw new Error(`${label} policy maximum must be a non-negative finite number`);
    if (vital.state !== "MEASURED") {
      findings.push(`${label} threshold cannot be evaluated because metric is ${vital.state}`);
      return;
    }
    if ((vital.value ?? Number.POSITIVE_INFINITY) > maximum) findings.push(`${label} ${vital.value} exceeds policy maximum ${maximum}`);
  };
  checkMax("LCP", evidence.lcp, policy.maximumLcpMs);
  checkMax("CLS", evidence.cls, policy.maximumCls);
  checkMax("INP", evidence.inp, policy.maximumInpMs);
  return Object.freeze({ verdict: findings.length ? "FAIL" : "PASS", findings: Object.freeze(findings) });
}
