import { DEFAULT_CWV_LIFECYCLE_THRESHOLDS } from "@nexus/core/cortex/cwv-lifecycle-optimizer";

export const dynamic = "force-dynamic";

function numberEnv(name: string, fallback: number, min: number, max: number): number | null {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export async function GET(): Promise<Response> {
  const configured = process.env.NEXUS_CORTEX_13_MODE;
  const mode = configured === "ACTIVE" || configured === "OBSERVE_ONLY" ? configured : "KILLED";
  const lcpPressureMs = numberEnv("NEXUS_CORTEX_13_LCP_PRESSURE_MS", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.lcpPressureMs, 100, 60_000);
  const clsPressure = numberEnv("NEXUS_CORTEX_13_CLS_PRESSURE", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.clsPressure, 0.001, 10);
  const inpPressureMs = numberEnv("NEXUS_CORTEX_13_INP_PRESSURE_MS", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.inpPressureMs, 10, 10_000);
  const longTaskPressureMs = numberEnv("NEXUS_CORTEX_13_LONG_TASK_PRESSURE_MS", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.longTaskPressureMs, 50, 10_000);
  const valid = lcpPressureMs !== null && clsPressure !== null && inpPressureMs !== null && longTaskPressureMs !== null;
  return Response.json({
    mode: valid ? mode : "KILLED",
    thresholds: valid ? { lcpPressureMs, clsPressure, inpPressureMs, longTaskPressureMs } : null,
  }, { headers: { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" } });
}
