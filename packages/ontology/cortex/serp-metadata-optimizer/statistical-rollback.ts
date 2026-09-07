import { ontologyId, type OntologyScope } from "@nexus/ontology";
import type { JsonValue, OntologyTransactionPort } from "@nexus/ontology/transaction";
import type { SearchPerformanceProvider, SearchPerformanceSnapshot, SearchPerformanceRow } from "./index";
import { SerpMetadataOptimizerError } from "./index";

const STATE_PAYLOAD = "cortex.serp.state.payload";
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u;
const DAY_MS = 86_400_000;

export interface StatisticalRollbackPolicy {
  readonly version: 1;
  readonly evaluationWindowDays: number;
  readonly reportingLagDays: number;
  readonly minimumTargetImpressionsPerWindow: number;
  readonly minimumPeerImpressionsPerWindow: number;
  readonly minimumPeerPages: number;
  readonly minimumAbsoluteCtrDrop: number;
  readonly minimumRelativeCtrDrop: number;
  readonly minimumZScore: number;
  readonly maximumAveragePositionDelta: number;
  readonly maxRows: number;
}

export interface StatisticalRollbackTarget {
  readonly pageId: string;
  readonly pageUrl: string;
}

export interface StatisticalRollbackDecision {
  readonly pageId: string;
  readonly status: "NO_LIVE_MUTATION" | "WAITING_FOR_WINDOW" | "INSUFFICIENT_EVIDENCE" | "SEASONAL_OR_POSITION_CONFOUNDED" | "HEALTHY" | "ROLLBACK_REQUIRED" | "ROLLED_BACK";
  readonly mutationAt: string | null;
  readonly baselineStart: string | null;
  readonly baselineEnd: string | null;
  readonly evaluationStart: string | null;
  readonly evaluationEnd: string | null;
  readonly baselineCtr: number | null;
  readonly currentCtr: number | null;
  readonly baselinePeerCtr: number | null;
  readonly currentPeerCtr: number | null;
  readonly adjustedCtrDrop: number | null;
  readonly relativeAdjustedCtrDrop: number | null;
  readonly zScore: number | null;
  readonly averagePositionDelta: number | null;
  readonly reason: string;
}

export interface StatisticalRollbackSupervisorOptions {
  readonly transactions: OntologyTransactionPort;
  readonly scope: OntologyScope;
  readonly siteUrl: string;
  readonly targets: readonly StatisticalRollbackTarget[];
  readonly performance: SearchPerformanceProvider;
  readonly policy: StatisticalRollbackPolicy;
  readonly rollback: (pageId: string, runId: string) => Promise<unknown>;
  readonly now?: () => number;
  readonly onDecision?: (decision: StatisticalRollbackDecision) => void;
  readonly onTelemetryError?: (error: unknown) => void;
}

interface Aggregate {
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  readonly averagePosition: number;
  readonly pageCount: number;
}

interface MutationState {
  readonly lastMutationAt: string;
}

function positiveInt(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be 1..${max}`);
  return value;
}

function ratio(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} must be within 0..1`);
  return value;
}

export function createStatisticalRollbackPolicy(input: StatisticalRollbackPolicy): StatisticalRollbackPolicy {
  if (input.version !== 1) throw new SerpMetadataOptimizerError("INVALID_INPUT", "statistical rollback policy version must be 1");
  const evaluationWindowDays = positiveInt(input.evaluationWindowDays, "evaluationWindowDays", 90);
  const reportingLagDays = positiveInt(input.reportingLagDays, "reportingLagDays", 14);
  const minimumTargetImpressionsPerWindow = positiveInt(input.minimumTargetImpressionsPerWindow, "minimumTargetImpressionsPerWindow", 100_000_000);
  const minimumPeerImpressionsPerWindow = positiveInt(input.minimumPeerImpressionsPerWindow, "minimumPeerImpressionsPerWindow", 100_000_000);
  const minimumPeerPages = positiveInt(input.minimumPeerPages, "minimumPeerPages", 2_000);
  const minimumAbsoluteCtrDrop = ratio(input.minimumAbsoluteCtrDrop, "minimumAbsoluteCtrDrop");
  const minimumRelativeCtrDrop = ratio(input.minimumRelativeCtrDrop, "minimumRelativeCtrDrop");
  if (!Number.isFinite(input.minimumZScore) || input.minimumZScore < 1 || input.minimumZScore > 10) throw new SerpMetadataOptimizerError("INVALID_INPUT", "minimumZScore must be within 1..10");
  if (!Number.isFinite(input.maximumAveragePositionDelta) || input.maximumAveragePositionDelta < 0 || input.maximumAveragePositionDelta > 20) throw new SerpMetadataOptimizerError("INVALID_INPUT", "maximumAveragePositionDelta must be within 0..20");
  const maxRows = positiveInt(input.maxRows, "maxRows", 100_000);
  return Object.freeze({
    version: 1,
    evaluationWindowDays,
    reportingLagDays,
    minimumTargetImpressionsPerWindow,
    minimumPeerImpressionsPerWindow,
    minimumPeerPages,
    minimumAbsoluteCtrDrop,
    minimumRelativeCtrDrop,
    minimumZScore: input.minimumZScore,
    maximumAveragePositionDelta: input.maximumAveragePositionDelta,
    maxRows,
  });
}

function id(value: string, field: string): string {
  const normalized = value.trim();
  if (!ID.test(normalized)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `${field} is malformed`);
  return normalized;
}

function canonicalUtc(value: unknown, field: string): string {
  if (typeof value !== "string") throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `${field} must be canonical UTC`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", `${field} must be canonical UTC`);
  return value;
}

function date(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayStart(value: string): number {
  if (!DATE.test(value)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "date is malformed");
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "date is invalid");
  return parsed;
}

function windowEnding(endMs: number, days: number): Readonly<{ startDate: string; endDate: string }> {
  return Object.freeze({ startDate: date(endMs - (days - 1) * DAY_MS), endDate: date(endMs) });
}

function aggregate(rows: readonly SearchPerformanceRow[], predicate: (row: SearchPerformanceRow) => boolean): Aggregate {
  let clicks = 0;
  let impressions = 0;
  let positionWeighted = 0;
  const pages = new Set<string>();
  for (const row of rows) {
    if (!predicate(row)) continue;
    if (!Number.isFinite(row.clicks) || row.clicks < 0 || !Number.isFinite(row.impressions) || row.impressions < 0 || !Number.isFinite(row.position) || row.position < 0) {
      throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "Search Console row contains invalid metrics");
    }
    clicks += row.clicks;
    impressions += row.impressions;
    positionWeighted += row.position * row.impressions;
    pages.add(row.pageUrl);
  }
  return Object.freeze({ clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, averagePosition: impressions > 0 ? positionWeighted / impressions : 0, pageCount: pages.size });
}

function validateSnapshot(snapshot: SearchPerformanceSnapshot, siteUrl: string, startDate: string, endDate: string): void {
  if (snapshot.siteUrl !== siteUrl || snapshot.startDate !== startDate || snapshot.endDate !== endDate) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "statistical rollback Search Console scope/window mismatch");
  if (snapshot.dataState !== "FINAL" || snapshot.coverage !== "TOP_ROWS_BOUNDED" || snapshot.truncated) throw new SerpMetadataOptimizerError("POLICY_VIOLATION", "statistical rollback requires FINAL non-truncated Search Console evidence");
  canonicalUtc(snapshot.observedAt, "Search Console observedAt");
}

function proportionVariance(clicks: number, impressions: number): number {
  if (impressions <= 0) return Number.POSITIVE_INFINITY;
  const p = Math.min(1, Math.max(0, clicks / impressions));
  return (p * (1 - p)) / impressions;
}

function decisionBase(pageId: string, state: Partial<StatisticalRollbackDecision>): StatisticalRollbackDecision {
  return Object.freeze({
    pageId,
    status: state.status ?? "INSUFFICIENT_EVIDENCE",
    mutationAt: state.mutationAt ?? null,
    baselineStart: state.baselineStart ?? null,
    baselineEnd: state.baselineEnd ?? null,
    evaluationStart: state.evaluationStart ?? null,
    evaluationEnd: state.evaluationEnd ?? null,
    baselineCtr: state.baselineCtr ?? null,
    currentCtr: state.currentCtr ?? null,
    baselinePeerCtr: state.baselinePeerCtr ?? null,
    currentPeerCtr: state.currentPeerCtr ?? null,
    adjustedCtrDrop: state.adjustedCtrDrop ?? null,
    relativeAdjustedCtrDrop: state.relativeAdjustedCtrDrop ?? null,
    zScore: state.zScore ?? null,
    averagePositionDelta: state.averagePositionDelta ?? null,
    reason: state.reason ?? "insufficient evidence",
  });
}

export class StatisticalSerpRollbackSupervisor {
  readonly policy: StatisticalRollbackPolicy;
  private readonly targets: ReadonlyMap<string, StatisticalRollbackTarget>;
  private readonly targetUrls: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(private readonly options: StatisticalRollbackSupervisorOptions) {
    this.policy = createStatisticalRollbackPolicy(options.policy);
    const normalized = options.targets.map((target) => Object.freeze({ pageId: id(target.pageId, "pageId"), pageUrl: target.pageUrl }));
    if (normalized.length < 1 || normalized.length > 2_000) throw new SerpMetadataOptimizerError("INVALID_INPUT", "statistical rollback targets must contain 1..2000 pages");
    if (new Set(normalized.map((target) => target.pageId)).size !== normalized.length) throw new SerpMetadataOptimizerError("INVALID_INPUT", "statistical rollback pageId values must be unique");
    for (const target of normalized) {
      let url: URL;
      try { url = new URL(target.pageUrl); } catch { throw new SerpMetadataOptimizerError("INVALID_INPUT", `pageUrl for ${target.pageId} is invalid`); }
      if (url.protocol !== "https:" || !target.pageUrl.startsWith(options.siteUrl)) throw new SerpMetadataOptimizerError("INVALID_INPUT", `pageUrl for ${target.pageId} must be HTTPS within siteUrl`);
    }
    this.targets = new Map(normalized.map((target) => [target.pageId, target] as const));
    this.targetUrls = new Set(normalized.map((target) => target.pageUrl));
    this.now = options.now ?? Date.now;
  }

  private emit(decision: StatisticalRollbackDecision): void {
    try { this.options.onDecision?.(decision); }
    catch (error) { try { this.options.onTelemetryError?.(error); } catch { /* telemetry cannot alter rollback semantics */ } }
  }

  private mutationState(pageId: string): MutationState | null {
    const stateId = ontologyId("cortex-serp-state-v1", { scope: this.options.scope, siteUrl: this.options.siteUrl, pageId });
    const payload = this.options.transactions.getObject(this.options.scope, stateId)?.properties[STATE_PAYLOAD];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const object = payload as Readonly<Record<string, JsonValue>>;
    if (object.lastInverseAction === null || object.lastInverseAction === undefined || object.lastMutationAt === null || object.lastMutationAt === undefined) return null;
    return Object.freeze({ lastMutationAt: canonicalUtc(object.lastMutationAt, "SERP state lastMutationAt") });
  }

  async evaluate(pageIdValue: string, applyRollback = false): Promise<StatisticalRollbackDecision> {
    const pageId = id(pageIdValue, "pageId");
    const target = this.targets.get(pageId);
    if (!target) throw new SerpMetadataOptimizerError("POLICY_VIOLATION", "pageId is not configured for statistical rollback");
    const mutation = this.mutationState(pageId);
    if (!mutation) {
      const result = decisionBase(pageId, { status: "NO_LIVE_MUTATION", reason: "no certified live CORTEX metadata mutation is eligible for rollback" });
      this.emit(result);
      return result;
    }

    const mutationMs = Date.parse(mutation.lastMutationAt);
    const mutationDay = Date.parse(`${mutation.lastMutationAt.slice(0, 10)}T00:00:00.000Z`);
    const baseline = windowEnding(mutationDay - DAY_MS, this.policy.evaluationWindowDays);
    const latestFinalDay = Date.parse(`${date(this.now())}T00:00:00.000Z`) - this.policy.reportingLagDays * DAY_MS;
    const evaluation = windowEnding(latestFinalDay, this.policy.evaluationWindowDays);
    if (dayStart(evaluation.startDate) <= mutationDay || this.now() <= mutationMs) {
      const result = decisionBase(pageId, {
        status: "WAITING_FOR_WINDOW",
        mutationAt: mutation.lastMutationAt,
        baselineStart: baseline.startDate,
        baselineEnd: baseline.endDate,
        evaluationStart: evaluation.startDate,
        evaluationEnd: evaluation.endDate,
        reason: "a full post-mutation FINAL evaluation window is not available yet",
      });
      this.emit(result);
      return result;
    }

    const [before, after] = await Promise.all([
      this.options.performance.getPerformance({ siteUrl: this.options.siteUrl, pageUrl: target.pageUrl, startDate: baseline.startDate, endDate: baseline.endDate, maxRows: this.policy.maxRows }),
      this.options.performance.getPerformance({ siteUrl: this.options.siteUrl, pageUrl: target.pageUrl, startDate: evaluation.startDate, endDate: evaluation.endDate, maxRows: this.policy.maxRows }),
    ]);
    validateSnapshot(before, this.options.siteUrl, baseline.startDate, baseline.endDate);
    validateSnapshot(after, this.options.siteUrl, evaluation.startDate, evaluation.endDate);
    if (before.sourceId !== after.sourceId) throw new SerpMetadataOptimizerError("INTEGRITY_FAILURE", "statistical rollback Search Console source changed between windows");

    const beforeTarget = aggregate(before.pageRows, (row) => row.pageUrl === target.pageUrl);
    const afterTarget = aggregate(after.pageRows, (row) => row.pageUrl === target.pageUrl);
    const beforePeers = aggregate(before.pageRows, (row) => !this.targetUrls.has(row.pageUrl));
    const afterPeers = aggregate(after.pageRows, (row) => !this.targetUrls.has(row.pageUrl));
    const common = {
      mutationAt: mutation.lastMutationAt,
      baselineStart: baseline.startDate,
      baselineEnd: baseline.endDate,
      evaluationStart: evaluation.startDate,
      evaluationEnd: evaluation.endDate,
      baselineCtr: beforeTarget.ctr,
      currentCtr: afterTarget.ctr,
      baselinePeerCtr: beforePeers.ctr,
      currentPeerCtr: afterPeers.ctr,
    } as const;

    if (
      beforeTarget.impressions < this.policy.minimumTargetImpressionsPerWindow ||
      afterTarget.impressions < this.policy.minimumTargetImpressionsPerWindow ||
      beforePeers.impressions < this.policy.minimumPeerImpressionsPerWindow ||
      afterPeers.impressions < this.policy.minimumPeerImpressionsPerWindow ||
      beforePeers.pageCount < this.policy.minimumPeerPages ||
      afterPeers.pageCount < this.policy.minimumPeerPages
    ) {
      const result = decisionBase(pageId, { ...common, status: "INSUFFICIENT_EVIDENCE", reason: "minimum target/peer sample requirements are not met" });
      this.emit(result);
      return result;
    }

    const positionDelta = Math.abs(afterTarget.averagePosition - beforeTarget.averagePosition);
    const targetDelta = afterTarget.ctr - beforeTarget.ctr;
    const peerDelta = afterPeers.ctr - beforePeers.ctr;
    const differenceInDifferences = targetDelta - peerDelta;
    const adjustedDrop = Math.max(0, -differenceInDifferences);
    const relativeDrop = beforeTarget.ctr > 0 ? adjustedDrop / beforeTarget.ctr : 0;
    const variance =
      proportionVariance(beforeTarget.clicks, beforeTarget.impressions) +
      proportionVariance(afterTarget.clicks, afterTarget.impressions) +
      proportionVariance(beforePeers.clicks, beforePeers.impressions) +
      proportionVariance(afterPeers.clicks, afterPeers.impressions);
    const zScore = variance > 0 && Number.isFinite(variance) ? adjustedDrop / Math.sqrt(variance) : 0;
    const measured = { ...common, adjustedCtrDrop: adjustedDrop, relativeAdjustedCtrDrop: relativeDrop, zScore, averagePositionDelta: positionDelta } as const;

    if (positionDelta > this.policy.maximumAveragePositionDelta) {
      const result = decisionBase(pageId, { ...measured, status: "SEASONAL_OR_POSITION_CONFOUNDED", reason: "average position moved beyond the configured confounding limit" });
      this.emit(result);
      return result;
    }
    if (adjustedDrop < this.policy.minimumAbsoluteCtrDrop || relativeDrop < this.policy.minimumRelativeCtrDrop || zScore < this.policy.minimumZScore) {
      const result = decisionBase(pageId, { ...measured, status: "HEALTHY", reason: "seasonality-adjusted CTR deterioration does not satisfy rollback thresholds" });
      this.emit(result);
      return result;
    }

    if (!applyRollback) {
      const result = decisionBase(pageId, { ...measured, status: "ROLLBACK_REQUIRED", reason: "seasonality-adjusted statistically significant CTR deterioration is verified" });
      this.emit(result);
      return result;
    }

    const runId = `stat-rollback-${pageId}-${evaluation.endDate.replaceAll("-", "")}`;
    await this.options.rollback(pageId, runId);
    const result = decisionBase(pageId, { ...measured, status: "ROLLED_BACK", reason: "verified deterioration triggered exact operational rollback" });
    this.emit(result);
    return result;
  }

  async evaluateAll(applyRollback = false): Promise<readonly StatisticalRollbackDecision[]> {
    const results: StatisticalRollbackDecision[] = [];
    for (const pageId of this.targets.keys()) results.push(await this.evaluate(pageId, applyRollback));
    return Object.freeze(results);
  }
}
