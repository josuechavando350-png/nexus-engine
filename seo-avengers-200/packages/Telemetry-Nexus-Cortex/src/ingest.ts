import type { NexusMetric } from "./index";

const names = new Set(["CLS", "INP", "LCP", "FCP", "TTFB"]);
export function validateMetric(value: unknown): NexusMetric {
  if (!value || typeof value !== "object") throw new Error("metric must be an object");
  const m = value as Record<string, unknown>;
  if (typeof m.name !== "string" || !names.has(m.name)) throw new Error("invalid metric name");
  if (typeof m.value !== "number" || !Number.isFinite(m.value) || m.value < 0) throw new Error("invalid metric value");
  if (typeof m.route !== "string" || !m.route.startsWith("/")) throw new Error("invalid route");
  return value as NexusMetric;
}
