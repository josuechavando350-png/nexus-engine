import type { QualityEvaluation, RepairAction, RepairDriver, RepairLoopResult } from "./repair-loop";
import { runBoundedRepairLoop } from "./repair-loop";

export interface CycleEvidence {
  evidenceId: string;
  stage: "BUILD" | "CAPTURE" | "JUDGE";
  subjectRevision: string;
  producedAt: string;
}

export interface CycleSnapshot {
  revision: string;
  evaluation: QualityEvaluation;
  evidence: readonly CycleEvidence[];
}

export interface JudgeCycleResult {
  evaluation: QualityEvaluation;
  evidence: CycleEvidence;
}

export interface QualityCycleExecutor {
  currentRevision(): Promise<string>;
  build(revision: string): Promise<CycleEvidence>;
  capture(revision: string): Promise<CycleEvidence>;
  judge(revision: string, evidence: readonly CycleEvidence[]): Promise<JudgeCycleResult>;
  repair(evaluation: QualityEvaluation, attempt: number): Promise<RepairAction>;
}

export interface QualityCycleResult extends RepairLoopResult {
  snapshots: readonly CycleSnapshot[];
}

function canonicalUtc(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validateEvidence(evidence: CycleEvidence, stage: CycleEvidence["stage"], revision: string): void {
  if (evidence.stage !== stage) throw new Error(`expected ${stage} evidence, received ${evidence.stage}`);
  if (!evidence.evidenceId.trim()) throw new Error(`${stage} evidenceId is required`);
  if (evidence.subjectRevision !== revision) throw new Error(`${stage} evidence is stale: expected revision ${revision}, received ${evidence.subjectRevision}`);
  if (!canonicalUtc(evidence.producedAt)) throw new Error(`${stage} producedAt must be a canonical UTC timestamp`);
}

async function evaluateFresh(executor: QualityCycleExecutor, snapshots: CycleSnapshot[]): Promise<QualityEvaluation> {
  const revision = await executor.currentRevision();
  if (!revision.trim()) throw new Error("quality cycle revision is required");

  const build = await executor.build(revision);
  validateEvidence(build, "BUILD", revision);
  const capture = await executor.capture(revision);
  validateEvidence(capture, "CAPTURE", revision);
  const preJudgeEvidence = Object.freeze([build, capture]);
  const judged = await executor.judge(revision, preJudgeEvidence);
  validateEvidence(judged.evidence, "JUDGE", revision);

  const referenced = new Set(judged.evaluation.evidenceIds);
  for (const item of [...preJudgeEvidence, judged.evidence]) {
    if (!referenced.has(item.evidenceId)) throw new Error(`judge evaluation omitted fresh ${item.stage} evidence ${item.evidenceId}`);
  }

  const finalEvaluation: QualityEvaluation = Object.freeze({
    ...judged.evaluation,
    evidenceIds: Object.freeze([...judged.evaluation.evidenceIds]),
  });
  snapshots.push(Object.freeze({ revision, evaluation: finalEvaluation, evidence: Object.freeze([...preJudgeEvidence, judged.evidence]) }));
  return finalEvaluation;
}

export async function runQualityCycle(
  executor: QualityCycleExecutor,
  options: { maxAttempts?: number } = {},
): Promise<QualityCycleResult> {
  const snapshots: CycleSnapshot[] = [];
  const driver: RepairDriver = {
    evaluate: () => evaluateFresh(executor, snapshots),
    repair: async (evaluation, attempt) => {
      const action = await executor.repair(evaluation, attempt);
      const beforeRevision = snapshots.at(-1)?.revision;
      const afterRevision = await executor.currentRevision();
      if (!afterRevision.trim()) throw new Error("quality cycle revision is required after repair");
      if (beforeRevision === afterRevision) throw new Error("repair must advance the subject revision before rebuild/recapture");
      return action;
    },
  };

  const result = await runBoundedRepairLoop(driver, options);
  return Object.freeze({ ...result, snapshots: Object.freeze(snapshots) });
}
