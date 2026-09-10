export type NexusMetric = {
  name: "CLS" | "INP" | "LCP" | "FCP" | "TTFB";
  value: number;
  rating: "good" | "needs-improvement" | "poor";
  id: string;
  navigationType: string;
  route: string;
  sourceRevision?: string;
  generationHash?: string;
};

export type CortexOptions = {
  endpoint: string;
  sourceRevision?: string;
  generationHash?: string;
  sampleRate?: number;
  requireConsent?: () => boolean;
};

function sampled(rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 0xffffffff < rate;
}

function send(endpoint: string, metric: NexusMetric): void {
  const body = JSON.stringify(metric);
  if (navigator.sendBeacon) {
    navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
    return;
  }
  void fetch(endpoint, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true, credentials: "same-origin" });
}

export function startNexusCortex(options: CortexOptions): void {
  if (typeof window === "undefined") return;
  const rate = options.sampleRate ?? 0.1;
  if (!sampled(rate)) return;
  if (options.requireConsent && !options.requireConsent()) return;

  const boot = async () => {
    const { onCLS, onINP, onLCP, onFCP, onTTFB } = await import("web-vitals");
    const report = (m: {name: NexusMetric["name"]; value: number; rating: NexusMetric["rating"]; id: string; navigationType: string}) => {
      send(options.endpoint, {
        name: m.name,
        value: m.value,
        rating: m.rating,
        id: m.id,
        navigationType: m.navigationType,
        route: location.pathname,
        sourceRevision: options.sourceRevision,
        generationHash: options.generationHash,
      });
    };
    onCLS(report); onINP(report); onLCP(report); onFCP(report); onTTFB(report);
  };

  // web-vitals uses buffered PerformanceObserver entries, so it can be deferred safely.
  if (document.readyState === "complete") void boot();
  else window.addEventListener("load", () => void boot(), { once: true, passive: true });
}
