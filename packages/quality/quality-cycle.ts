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

export interface CycleRepairLineage {
  attempt: number;
  fromRevision: string;
  toRevision: string;
  triggeringEvidenceIds: readonly string[];
  repairEvidenceIds: readonly string[];
  changedFiles: readonly string[];
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
  repairLineage: readonly CycleRepairLineage[];
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

function assertUniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} evidenceIds must be unique`);
}

async function evaluateFresh(
  executor: QualityCycleExecutor,
  snapshots: CycleSnapshot[],
  usedEvidenceIds: Set<string>,
): Promise<QualityEvaluation> {
  const revision = await executor.currentRevision();
  if (!revision.trim()) throw new Error("quality cycle revision is required");

  const build = await executor.build(revision);
  validateEvidence(build, "BUILD", revision);
  const capture = await executor.capture(revision);
  validateEvidence(capture, "CAPTURE", revision);
  const preJudgeEvidence = Object.freeze([build, capture]);
  const judged = await executor.judge(revision, preJudgeEvidence);
  validateEvidence(judged.evidence, "JUDGE", revision);

  const snapshotEvidence = [build, capture, judged.evidence] as const;
  assertUniqueIds(snapshotEvidence.map((item) => item.evidenceId), "build/capture/judge");
  for (const item of snapshotEvidence) {
    if (usedEvidenceIds.has(item.evidenceId)) {
      throw new Error(`quality cycle refused reused evidenceId ${item.evidenceId} across revisions`);
    }
  }

  const referenced = new Set(judged.evaluation.evidenceIds);
  for (const item of snapshotEvidence) {
    if (!referenced.has(item.evidenceId)) throw new Error(`judge evaluation omitted fresh ${item.stage} evidence ${item.evidenceId}`);
  }
  assertUniqueIds(judged.evaluation.evidenceIds, "judge evaluation");

  for (const item of snapshotEvidence) usedEvidenceIds.add(item.evidenceId);
  const finalEvaluation: QualityEvaluation = Object.freeze({
    ...judged.evaluation,
    evidenceIds: Object.freeze([...judged.evaluation.evidenceIds]),
  });
  snapshots.push(Object.freeze({ revision, evaluation: finalEvaluation, evidence: Object.freeze([...snapshotEvidence]) }));
  return finalEvaluation;
}

export async function runQualityCycle(
  executor: QualityCycleExecutor,
  options: { maxAttempts?: number } = {},
): Promise<QualityCycleResult> {
  const snapshots: CycleSnapshot[] = [];
  const repairLineage: CycleRepairLineage[] = [];
  const usedEvidenceIds = new Set<string>();
  const seenRevisions = new Set<string>();

  const driver: RepairDriver = {
    evaluate: async () => {
      const evaluation = await evaluateFresh(executor, snapshots, usedEvidenceIds);
      const revision = snapshots.at(-1)!.revision;
      if (seenRevisions.has(revision)) throw new Error(`quality cycle refused previously evaluated revision ${revision}`);
      seenRevisions.add(revision);
      return evaluation;
    },
    repair: async (evaluation, attempt) => {
      const beforeSnapshot = snapshots.at(-1);
      if (!beforeSnapshot) throw new Error("repair requires a fresh pre-repair snapshot");
      const triggeringEvidenceIds = [...evaluation.evidenceIds];
      assertUniqueIds(triggeringEvidenceIds, "repair triggering");
      if (!triggeringEvidenceIds.length) throw new Error("repair requires evidence from the triggering evaluation");
      const triggeringSet = new Set(triggeringEvidenceIds);
      for (const item of beforeSnapshot.evidence) {
        if (!triggeringSet.has(item.evidenceId)) {
          throw new Error(`repair trigger omitted current snapshot evidence: ${item.evidenceId}`);
        }
      }

      const action = await executor.repair(evaluation, attempt);
      if (!action.evidenceIds.length) throw new Error("repair must emit evidence identifying the applied change");
      assertUniqueIds(action.evidenceIds, "repair action");
      for (const evidenceId of action.evidenceIds) {
        if (usedEvidenceIds.has(evidenceId)) throw new Error(`repair evidenceId ${evidenceId} collides with existing cycle evidence`);
      }

      const afterRevision = await executor.currentRevision();
      if (!afterRevision.trim()) throw new Error("quality cycle revision is required after repair");
      if (beforeSnapshot.revision === afterRevision) throw new Error("repair must advance the subject revision before rebuild/recapture");
      if (seenRevisions.has(afterRevision)) throw new Error(`repair cannot roll back to previously evaluated revision ${afterRevision}`);

      for (const evidenceId of action.evidenceIds) usedEvidenceIds.add(evidenceId);
      repairLineage.push(Object.freeze({
        attempt,
        fromRevision: beforeSnapshot.revision,
        toRevision: afterRevision,
        triggeringEvidenceIds: Object.freeze(triggeringEvidenceIds),
        repairEvidenceIds: Object.freeze([...action.evidenceIds]),
        changedFiles: Object.freeze([...action.changedFiles]),
      }));
      return action;
    },
  };

  const result = await runBoundedRepairLoop(driver, options);
  return Object.freeze({
    ...result,
    snapshots: Object.freeze(snapshots),
    repairLineage: Object.freeze(repairLineage),
  });
}
