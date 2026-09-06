import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const keys = [
  "NEXUS_CORTEX_13_MODE",
  "NEXUS_CORTEX_13_LCP_PRESSURE_MS",
  "NEXUS_CORTEX_13_CLS_PRESSURE",
  "NEXUS_CORTEX_13_INP_PRESSURE_MS",
  "NEXUS_CORTEX_13_LONG_TASK_PRESSURE_MS",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("CORTEX #13 probe control", () => {
  it("defaults fail-closed to KILLED", async () => {
    for (const key of keys) delete process.env[key];
    const response = await GET();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ mode: "KILLED", thresholds: null });
  });

  it("returns ACTIVE only with a valid threshold contract", async () => {
    process.env.NEXUS_CORTEX_13_MODE = "ACTIVE";
    process.env.NEXUS_CORTEX_13_LCP_PRESSURE_MS = "2500";
    process.env.NEXUS_CORTEX_13_CLS_PRESSURE = "0.1";
    process.env.NEXUS_CORTEX_13_INP_PRESSURE_MS = "200";
    process.env.NEXUS_CORTEX_13_LONG_TASK_PRESSURE_MS = "250";
    const body = await (await GET()).json();
    expect(body).toEqual({ mode: "ACTIVE", thresholds: { lcpPressureMs: 2500, clsPressure: 0.1, inpPressureMs: 200, longTaskPressureMs: 250 } });
  });

  it("kills the optimizer when any configured threshold is invalid", async () => {
    process.env.NEXUS_CORTEX_13_MODE = "ACTIVE";
    process.env.NEXUS_CORTEX_13_LONG_TASK_PRESSURE_MS = "49";
    expect(await (await GET()).json()).toEqual({ mode: "KILLED", thresholds: null });
    process.env.NEXUS_CORTEX_13_LONG_TASK_PRESSURE_MS = "NaN";
    expect(await (await GET()).json()).toEqual({ mode: "KILLED", thresholds: null });
  });

  it("preserves OBSERVE_ONLY as a non-mutating measurement mode", async () => {
    process.env.NEXUS_CORTEX_13_MODE = "OBSERVE_ONLY";
    const body = await (await GET()).json();
    expect(body.mode).toBe("OBSERVE_ONLY");
    expect(body.thresholds).not.toBeNull();
  });
});
