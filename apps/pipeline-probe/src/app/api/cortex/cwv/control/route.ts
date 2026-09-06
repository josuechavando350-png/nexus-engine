import { DEFAULT_CWV_LIFECYCLE_THRESHOLDS } from "@nexus/core/cortex/cwv-lifecycle-optimizer";

export const dynamic = "force-dynamic";

type Mode = "ACTIVE" | "OBSERVE_ONLY" | "KILLED";

function numberEnv(name: string, fallback: number, min: number, max: number): number | null {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function modeFromEnv(): Mode {
  const configured = process.env.NEXUS_CORTEX_13_MODE;
  return configured === "ACTIVE" || configured === "OBSERVE_ONLY" ? configured : "KILLED";
}

export async function GET(): Promise<Response> {
  const lcpPressureMs = numberEnv("NEXUS_CORTEX_13_LCP_PRESSURE_MS", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.lcpPressureMs, 100, 60_000);
  const clsPressure = numberEnv("NEXUS_CORTEX_13_CLS_PRESSURE", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.clsPressure, 0.001, 10);
  const inpPressureMs = numberEnv("NEXUS_CORTEX_13_INP_PRESSURE_MS", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.inpPressureMs, 10, 10_000);
  const longTaskPressureMs = numberEnv("NEXUS_CORTEX_13_LONG_TASK_PRESSURE_MS", DEFAULT_CWV_LIFECYCLE_THRESHOLDS.longTaskPressureMs, 50, 10_000);
  const valid = lcpPressureMs !== null && clsPressure !== null && inpPressureMs !== null && longTaskPressureMs !== null;
  const mode = valid ? modeFromEnv() : "KILLED";
  return Response.json({
    mode,
    thresholds: mode === "KILLED" ? null : { lcpPressureMs, clsPressure, inpPressureMs, longTaskPressureMs },
  }, { headers: { "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff" } });
}
