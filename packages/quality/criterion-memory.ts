import { createHash } from "node:crypto";

export type CriterionVerdict = "PASS" | "FAIL" | "WARNING" | "NOT_TESTED";
export type HumanDecision = "APPROVE" | "VETO" | "NO_DECISION";
export type PriorLearningStatus = "READY" | "NOT_ENOUGH_HISTORY";

export interface CriterionArtifactRef {
  artifactId: string;
  digest: `sha256:${string}`;
  kind: "DNA" | "EMITTED_CSS" | "CAPTURE" | "JUDGE_REPORT" | "DELIVERY_EVIDENCE";
}

export interface BusinessOutcome {
  metric: string;
  value: number;
  observedAt: string;
  source: string;
}

export interface CriterionMemoryEntry {
  schemaVersion: 1;
  tenantId: string;
  projectId: string;
  revision: string;
  recordedAt: string;
  dnaDigest: `sha256:${string}`;
  emittedCssDigest: `sha256:${string}`;
  artifacts: readonly CriterionArtifactRef[];
  rubricVersion: string;
  judgeVerdict: CriterionVerdict;
  judgeFindings: readonly string[];
  humanDecision: HumanDecision;
  humanRationale?: string;
  deliveryVerdict: CriterionVerdict;
  businessOutcomes: readonly BusinessOutcome[];
}

export interface VersionedCriterionMemoryEntry extends CriterionMemoryEntry {
  entryId: `sha256:${string}`;
}

export interface RubricRegressionCase {
  entryId: string;
  projectId: string;
  historicalVerdict: CriterionVerdict;
  humanDecision: HumanDecision;
  candidateVerdict: CriterionVerdict;
}

export interface RubricRegressionReport {
  authority: "NEXUS_CRITERION_REGRESSION";
  candidateRubricVersion: string;
  historicalEntryCount: number;
  replayedEntryCount: number;
  promotable: boolean;
  violations: readonly string[];
  cases: readonly RubricRegressionCase[];
}

export interface PriorObservation {
  tenantId: string;
  projectId: string;
  revision: string;
  dnaFeatures: Readonly<Record<string, number>>;
  approvedWithoutCorrection: boolean;
  businessOutcomes: readonly BusinessOutcome[];
}

export interface PriorLearningReport {
  authority: "NEXUS_EMITTER_PRIOR_LEARNING";
  status: PriorLearningStatus;
  minimumProjects: number;
  minimumApprovedProjects: number;
  observedProjects: number;
  approvedWithoutCorrectionProjects: number;
  featureMeans: Readonly<Record<string, number>>;
  businessMetricMeans: Readonly<Record<string, number>>;
}

function canonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function assertSha256(value: string, label: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a canonical sha256 digest`);
}

function assertRevision(value: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("revision must be a full lowercase git SHA-1");
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function assertBusinessOutcome(outcome: BusinessOutcome): void {
  if (!outcome.metric.trim() || !outcome.source.trim()) throw new Error("business outcomes require metric and source");
  if (!Number.isFinite(outcome.value)) throw new Error("business outcome value must be finite");
  if (!canonicalTimestamp(outcome.observedAt)) throw new Error("business outcome observedAt must be a canonical ISO timestamp");
}

function assertObservation(observation: PriorObservation): void {
  if (!observation.tenantId.trim() || !observation.projectId.trim()) throw new Error("prior observation tenantId and projectId are required");
  assertRevision(observation.revision);
  for (const [feature, value] of Object.entries(observation.dnaFeatures)) {
    if (!feature.trim()) throw new Error("DNA feature names must be non-empty");
    if (!Number.isFinite(value)) throw new Error(`DNA feature ${feature} must be finite`);
  }
  observation.businessOutcomes.forEach(assertBusinessOutcome);
}

export function recordCriterionMemory(input: CriterionMemoryEntry): VersionedCriterionMemoryEntry {
  if (input.schemaVersion !== 1) throw new Error("criterion memory schemaVersion must be 1");
  if (!input.tenantId.trim() || !input.projectId.trim() || !input.rubricVersion.trim()) throw new Error("tenantId, projectId and rubricVersion are required");
  assertRevision(input.revision);
  if (!canonicalTimestamp(input.recordedAt)) throw new Error("recordedAt must be a canonical ISO timestamp");
  assertSha256(input.dnaDigest, "dnaDigest");
  assertSha256(input.emittedCssDigest, "emittedCssDigest");
  if (input.humanDecision === "VETO" && !input.humanRationale?.trim()) throw new Error("human veto requires rationale");
  if (input.humanDecision === "NO_DECISION" && input.humanRationale?.trim()) throw new Error("NO_DECISION cannot carry a human rationale");
  if (new Set(input.artifacts.map((artifact) => artifact.artifactId)).size !== input.artifacts.length) throw new Error("criterion artifact IDs must be unique");
  for (const artifact of input.artifacts) {
    if (!artifact.artifactId.trim()) throw new Error("criterion artifactId is required");
    assertSha256(artifact.digest, `artifact ${artifact.artifactId} digest`);
  }
  input.businessOutcomes.forEach(assertBusinessOutcome);

  const entryId = digest(input);
  return Object.freeze({
    ...input,
    artifacts: Object.freeze(input.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
    judgeFindings: Object.freeze([...input.judgeFindings]),
    businessOutcomes: Object.freeze(input.businessOutcomes.map((outcome) => Object.freeze({ ...outcome }))),
    entryId,
  });
}

export function assertCriterionHistory(entries: readonly VersionedCriterionMemoryEntry[]): void {
  const ids = new Set<string>();
  const revisions = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.entryId)) throw new Error(`duplicate criterion entry ${entry.entryId}`);
    ids.add(entry.entryId);
    const { entryId, ...unsignedEntry } = entry;
    const expected = digest(unsignedEntry);
    if (expected !== entryId) throw new Error(`criterion entry ${entryId} failed integrity verification`);
    const revisionKey = `${entry.tenantId}::${entry.projectId}::${entry.revision}`;
    if (revisions.has(revisionKey)) throw new Error(`duplicate project revision in criterion history: ${revisionKey}`);
    revisions.add(revisionKey);
  }
}

export function replayRubricRegression(input: {
  candidateRubricVersion: string;
  history: readonly VersionedCriterionMemoryEntry[];
  evaluate: (entry: VersionedCriterionMemoryEntry) => CriterionVerdict;
}): RubricRegressionReport {
  if (!input.candidateRubricVersion.trim()) throw new Error("candidateRubricVersion is required");
  assertCriterionHistory(input.history);
  const violations: string[] = [];
  const cases: RubricRegressionCase[] = [];

  for (const entry of input.history) {
    const candidateVerdict = input.evaluate(entry);
    cases.push({ entryId: entry.entryId, projectId: entry.projectId, historicalVerdict: entry.judgeVerdict, humanDecision: entry.humanDecision, candidateVerdict });
    if (entry.humanDecision === "VETO" && candidateVerdict === "PASS") {
      violations.push(`${entry.entryId}: candidate rubric approves a historically vetoed artifact`);
    }
    if (entry.deliveryVerdict === "FAIL" && candidateVerdict === "PASS") {
      violations.push(`${entry.entryId}: candidate rubric approves an artifact with historical delivery failure`);
    }
  }

  return Object.freeze({
    authority: "NEXUS_CRITERION_REGRESSION",
    candidateRubricVersion: input.candidateRubricVersion,
    historicalEntryCount: input.history.length,
    replayedEntryCount: cases.length,
    promotable: violations.length === 0,
    violations: Object.freeze(violations),
    cases: Object.freeze(cases.map((item) => Object.freeze(item))),
  });
}

export function learnEmitterPriors(input: {
  observations: readonly PriorObservation[];
  tenantId: string;
  minimumProjects?: number;
  minimumApprovedProjects?: number;
}): PriorLearningReport {
  const minimumProjects = input.minimumProjects ?? 20;
  const minimumApprovedProjects = input.minimumApprovedProjects ?? Math.max(1, Math.ceil(minimumProjects / 2));
  if (!Number.isInteger(minimumProjects) || minimumProjects < 1) throw new Error("minimumProjects must be a positive integer");
  if (!Number.isInteger(minimumApprovedProjects) || minimumApprovedProjects < 1 || minimumApprovedProjects > minimumProjects) throw new Error("minimumApprovedProjects must be a positive integer no greater than minimumProjects");
  if (!input.tenantId.trim()) throw new Error("tenantId is required");
  input.observations.forEach(assertObservation);
  const scoped = input.observations.filter((observation) => observation.tenantId === input.tenantId);
  const projectIds = new Set(scoped.map((observation) => observation.projectId));
  const approvedProjects = new Set(scoped.filter((observation) => observation.approvedWithoutCorrection).map((observation) => observation.projectId));

  if (projectIds.size < minimumProjects || approvedProjects.size < minimumApprovedProjects) {
    return Object.freeze({
      authority: "NEXUS_EMITTER_PRIOR_LEARNING",
      status: "NOT_ENOUGH_HISTORY",
      minimumProjects,
      minimumApprovedProjects,
      observedProjects: projectIds.size,
      approvedWithoutCorrectionProjects: approvedProjects.size,
      featureMeans: Object.freeze({}),
      businessMetricMeans: Object.freeze({}),
    });
  }

  const eligible = scoped.filter((observation) => observation.approvedWithoutCorrection);
  const featureBuckets = new Map<string, number[]>();
  const metricBuckets = new Map<string, number[]>();
  for (const observation of eligible) {
    for (const [feature, value] of Object.entries(observation.dnaFeatures)) {
      const bucket = featureBuckets.get(feature) ?? [];
      bucket.push(value);
      featureBuckets.set(feature, bucket);
    }
    for (const outcome of observation.businessOutcomes) {
      const bucket = metricBuckets.get(outcome.metric) ?? [];
      bucket.push(outcome.value);
      metricBuckets.set(outcome.metric, bucket);
    }
  }
  const means = (buckets: Map<string, number[]>): Readonly<Record<string, number>> => Object.freeze(Object.fromEntries([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, values.reduce((sum, value) => sum + value, 0) / values.length])));

  return Object.freeze({
    authority: "NEXUS_EMITTER_PRIOR_LEARNING",
    status: "READY",
    minimumProjects,
    minimumApprovedProjects,
    observedProjects: projectIds.size,
    approvedWithoutCorrectionProjects: approvedProjects.size,
    featureMeans: means(featureBuckets),
    businessMetricMeans: means(metricBuckets),
  });
}
