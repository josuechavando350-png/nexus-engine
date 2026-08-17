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

export interface QualityCycleExecutor {
  currentRevision(): Promise<string>;
  build(revision: string): Promise<CycleEvidence>;
  capture(revision: string): Promise<CycleEvidence>;
  judge(revision: string, evidence: readonly CycleEvidence[]): Promise<QualityEvaluation>;
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
  const evidence = Object.freeze([build, capture]);
  const evaluation = await executor.judge(revision, evidence);

  const referenced = new Set(evaluation.evidenceIds);
  for (const item of evidence) {
    if (!referenced.has(item.evidenceId)) throw new Error(`judge evaluation omitted fresh ${item.stage} evidence ${item.evidenceId}`);
  }

  const judgeEvidence: CycleEvidence = Object.freeze({
    evidenceId: `judge:${revision}:${snapshots.length}`,
    stage: "JUDGE",
    subjectRevision: revision,
    producedAt: new Date().toISOString(),
  });
  const finalEvaluation: QualityEvaluation = Object.freeze({
    ...evaluation,
    evidenceIds: Object.freeze([...evaluation.evidenceIds, judgeEvidence.evidenceId]),
  });
  snapshots.push(Object.freeze({ revision, evaluation: finalEvaluation, evidence: Object.freeze([...evidence, judgeEvidence]) }));
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
