import type { VerdictState } from "@nexus/creative";

export interface QualityEvaluation {
  verdict: VerdictState;
  findings: readonly string[];
  evidenceIds: readonly string[];
}

export interface RepairAction {
  summary: string;
  changedFiles: readonly string[];
  evidenceIds: readonly string[];
}

export interface RepairIteration {
  attempt: number;
  before: QualityEvaluation;
  action: RepairAction;
  after: QualityEvaluation;
}

export interface RepairDriver {
  evaluate(): Promise<QualityEvaluation>;
  repair(evaluation: QualityEvaluation, attempt: number): Promise<RepairAction>;
}

export interface RepairLoopResult {
  authority: "NEXUS_BOUNDED_REPAIR_LOOP";
  status: "SHIPPABLE" | "ESCALATE";
  finalEvaluation: QualityEvaluation;
  iterations: readonly RepairIteration[];
  reason?: string;
}

function validateEvaluation(evaluation: QualityEvaluation): void {
  if (!["PASS", "FAIL", "WARNING", "NOT_TESTED"].includes(evaluation.verdict)) throw new Error("invalid quality verdict");
  if (!Array.isArray(evaluation.findings) || evaluation.findings.some((finding) => !finding.trim())) throw new Error("quality findings must be non-empty strings");
  if (!Array.isArray(evaluation.evidenceIds) || evaluation.evidenceIds.some((evidenceId) => !evidenceId.trim())) throw new Error("quality evidenceIds must be non-empty strings");
}

function validateAction(action: RepairAction): void {
  if (!action.summary.trim()) throw new Error("repair action summary is required");
  if (!action.changedFiles.length || action.changedFiles.some((path) => !path.trim())) throw new Error("repair action must report changed files");
  if (action.evidenceIds.some((evidenceId) => !evidenceId.trim())) throw new Error("repair action evidenceIds must be non-empty strings");
}

export async function runBoundedRepairLoop(
  driver: RepairDriver,
  options: { maxAttempts?: number } = {},
): Promise<RepairLoopResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("maxAttempts must be an integer from 1 to 3");

  let evaluation = await driver.evaluate();
  validateEvaluation(evaluation);
  if (evaluation.verdict === "PASS") {
    return Object.freeze({
      authority: "NEXUS_BOUNDED_REPAIR_LOOP",
      status: "SHIPPABLE",
      finalEvaluation: evaluation,
      iterations: Object.freeze([]),
    });
  }
  if (evaluation.verdict === "NOT_TESTED") {
    return Object.freeze({
      authority: "NEXUS_BOUNDED_REPAIR_LOOP",
      status: "ESCALATE",
      finalEvaluation: evaluation,
      iterations: Object.freeze([]),
      reason: "quality evidence is missing; repair cannot substitute for an unexecuted test",
    });
  }

  const iterations: RepairIteration[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const before = evaluation;
    const action = await driver.repair(before, attempt);
    validateAction(action);
    evaluation = await driver.evaluate();
    validateEvaluation(evaluation);
    iterations.push(Object.freeze({ attempt, before, action, after: evaluation }));

    if (evaluation.verdict === "PASS") {
      return Object.freeze({
        authority: "NEXUS_BOUNDED_REPAIR_LOOP",
        status: "SHIPPABLE",
        finalEvaluation: evaluation,
        iterations: Object.freeze(iterations),
      });
    }
    if (evaluation.verdict === "NOT_TESTED") {
      return Object.freeze({
        authority: "NEXUS_BOUNDED_REPAIR_LOOP",
        status: "ESCALATE",
        finalEvaluation: evaluation,
        iterations: Object.freeze(iterations),
        reason: "repair produced a state without complete evidence; recapture/retest is required",
      });
    }
  }

  return Object.freeze({
    authority: "NEXUS_BOUNDED_REPAIR_LOOP",
    status: "ESCALATE",
    finalEvaluation: evaluation,
    iterations: Object.freeze(iterations),
    reason: `quality did not reach PASS after ${maxAttempts} bounded repair attempts`,
  });
}
