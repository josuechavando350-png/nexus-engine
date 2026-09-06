import { describe, expect, it } from "vitest";
import { DEFAULT_CWV_LIFECYCLE_THRESHOLDS, evaluateCwvLifecycle } from "./index";

describe("CORTEX #13 lifecycle CWV optimizer", () => {
  it("keeps speculation enabled when measured signals are inside configured budgets", () => {
    expect(evaluateCwvLifecycle({ visibility: "VISIBLE", lcpMs: 1_900, cls: 0.03, inpMs: 120, recentLongTaskMs: 80 })).toEqual({ state: "NORMAL", reasons: [], shouldSuspendSpeculation: false });
  });

  it("suspends non-critical speculation when real CWV pressure is observed", () => {
    const result = evaluateCwvLifecycle({ visibility: "VISIBLE", lcpMs: 2_900, cls: 0.12, inpMs: 250, recentLongTaskMs: 300 });
    expect(result.state).toBe("PRESSURE");
    expect(result.shouldSuspendSpeculation).toBe(true);
    expect(result.reasons).toEqual(["LCP", "CLS", "INP", "LONG_TASK"]);
  });

  it("pauses non-critical resource work while the document is hidden", () => {
    expect(evaluateCwvLifecycle({ visibility: "HIDDEN", lcpMs: null, cls: 0, inpMs: null, recentLongTaskMs: 0 })).toEqual({ state: "PAUSED", reasons: ["HIDDEN"], shouldSuspendSpeculation: true });
  });

  it("uses strict inequality so observations exactly on a published budget do not oscillate into pressure", () => {
    expect(evaluateCwvLifecycle({
      visibility: "VISIBLE",
      lcpMs: DEFAULT_CWV_LIFECYCLE_THRESHOLDS.lcpPressureMs,
      cls: DEFAULT_CWV_LIFECYCLE_THRESHOLDS.clsPressure,
      inpMs: DEFAULT_CWV_LIFECYCLE_THRESHOLDS.inpPressureMs,
      recentLongTaskMs: DEFAULT_CWV_LIFECYCLE_THRESHOLDS.longTaskPressureMs,
    }).state).toBe("NORMAL");
  });

  it("rejects malformed metrics and threshold contracts instead of normalizing impossible observations", () => {
    expect(() => evaluateCwvLifecycle({ visibility: "VISIBLE", lcpMs: -1, cls: 0, inpMs: null, recentLongTaskMs: 0 })).toThrowError(/out of range/u);
    expect(() => evaluateCwvLifecycle({ visibility: "VISIBLE", lcpMs: null, cls: Number.NaN, inpMs: null, recentLongTaskMs: 0 })).toThrowError(/out of range/u);
    expect(() => evaluateCwvLifecycle({ visibility: "VISIBLE", lcpMs: null, cls: 0, inpMs: null, recentLongTaskMs: 0 }, { ...DEFAULT_CWV_LIFECYCLE_THRESHOLDS, longTaskPressureMs: 49 })).toThrowError(/out of range/u);
    expect(() => evaluateCwvLifecycle({ visibility: "VISIBLE", lcpMs: null, cls: 0, inpMs: null, recentLongTaskMs: 0 }, { ...DEFAULT_CWV_LIFECYCLE_THRESHOLDS, extra: 1 } as never)).toThrowError(/threshold contract/u);
  });
});
