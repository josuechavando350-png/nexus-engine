import { describe, expect, it, vi } from "vitest";
import { runBoundedRepairLoop, type QualityEvaluation, type RepairAction } from "../repair-loop";

const evaluation = (verdict: QualityEvaluation["verdict"], findings: readonly string[] = []): QualityEvaluation => ({
  verdict,
  findings,
  evidenceIds: verdict === "NOT_TESTED" ? [] : [`evidence-${verdict.toLowerCase()}`],
});

const action = (attempt: number): RepairAction => ({
  summary: `repair attempt ${attempt}`,
  changedFiles: [`app/repair-${attempt}.tsx`],
  evidenceIds: [`repair-evidence-${attempt}`],
});

describe("NEXUS bounded repair loop", () => {
  it("ships immediately when the first real evaluation passes", async () => {
    const repair = vi.fn();
    const result = await runBoundedRepairLoop({
      evaluate: async () => evaluation("PASS"),
      repair,
    });
    expect(result.status).toBe("SHIPPABLE");
    expect(result.iterations).toHaveLength(0);
    expect(repair).not.toHaveBeenCalled();
  });

  it("repairs, re-evaluates and stops as soon as evidence reaches PASS", async () => {
    let state = 0;
    const repair = vi.fn(async (_before: QualityEvaluation, attempt: number) => {
      state += 1;
      return action(attempt);
    });
    const result = await runBoundedRepairLoop({
      evaluate: async () => state >= 2 ? evaluation("PASS") : evaluation("FAIL", ["visual hierarchy blocker"]),
      repair,
    });
    expect(result.status).toBe("SHIPPABLE");
    expect(result.iterations).toHaveLength(2);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(result.finalEvaluation.verdict).toBe("PASS");
  });

  it("never exceeds three repairs and escalates a persistent failure", async () => {
    const repair = vi.fn(async (_before: QualityEvaluation, attempt: number) => action(attempt));
    const result = await runBoundedRepairLoop({
      evaluate: async () => evaluation("FAIL", ["persistent blocker"]),
      repair,
    });
    expect(result.status).toBe("ESCALATE");
    expect(result.iterations).toHaveLength(3);
    expect(repair).toHaveBeenCalledTimes(3);
    expect(result.reason).toMatch(/after 3 bounded repair attempts/);
  });

  it("does not use repair to fake an unexecuted test", async () => {
    const repair = vi.fn();
    const result = await runBoundedRepairLoop({
      evaluate: async () => evaluation("NOT_TESTED", ["browser evidence missing"]),
      repair,
    });
    expect(result.status).toBe("ESCALATE");
    expect(result.finalEvaluation.verdict).toBe("NOT_TESTED");
    expect(repair).not.toHaveBeenCalled();
    expect(result.reason).toMatch(/missing/);
  });

  it("rejects attempts above the hard maximum instead of creating an infinite auto-fix loop", async () => {
    await expect(runBoundedRepairLoop({
      evaluate: async () => evaluation("FAIL", ["blocker"]),
      repair: async (_before, attempt) => action(attempt),
    }, { maxAttempts: 4 })).rejects.toThrow(/1 to 3/);
  });
});
