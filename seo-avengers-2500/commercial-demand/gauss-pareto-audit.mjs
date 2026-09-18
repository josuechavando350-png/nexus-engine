import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { __test as v2Test } from "./tournament-engine-v2.mjs";

const OBJECTIVES = Object.freeze(["MAX", "MAX", "MAX", "MAX", "MIN"]);
const PLANNING_INTERPRETATION = "DETERMINISTIC_PLANNING_EXPERIMENT_NOT_RANK_TRAFFIC_LEAD_CLIENT_OR_REVENUE_FORECAST";
const MAX_STRATEGIES = 1_000;
const METRICS = Object.freeze([
  "worstCaseModeledClientsMilli",
  "strictCommercialSessionsMilli",
  "relevantSessionsMilli",
  "coveredDemandFamilyCount",
  "pageCount",
]);

function fail(message) {
  throw new Error(`COMMERCIAL_GAUSS_PARETO_${message}`);
}

function modeledPoint(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)
      || typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.id)) {
    fail("INVALID_STRATEGY_ID");
  }
  const values = METRICS.map((metric) => {
    const value = row[metric];
    if (!Number.isSafeInteger(value) || value < 0) fail(`INVALID_${metric}`);
    return value;
  });
  if (values[4] === 0) fail("ZERO_PAGE_STRATEGY");
  return { id: row.id, values };
}

function checkedPlanningReport(rawReport) {
  const report = structuredClone(rawReport);
  if (!report || typeof report !== "object" || Array.isArray(report)) fail("REPORT_REQUIRED");
  const { reportSha256, ...unsigned } = report;
  if (reportSha256 !== v2Test.sha256Canonical(unsigned)) fail("REPORT_HASH_MISMATCH");
  if (report.engineId !== "WALLE_NEXUS_COMMERCIAL_DEMAND_TOURNAMENT_V2"
      || report.status !== "TOURNAMENT_COMPLETE"
      || report.interpretation !== PLANNING_INTERPRETATION
      || report.evidenceBoundary?.trafficAndFunnel !== "EXPLICIT_PLANNING_ASSUMPTIONS"
      || report.evidenceBoundary?.productionMutationAuthorized !== false) {
    fail("NOT_A_BOUNDED_V2_PLANNING_REPORT");
  }
  const evaluated = report.tournament?.evaluatedStrategies;
  if (!Array.isArray(evaluated) || evaluated.length === 0 || evaluated.length > MAX_STRATEGIES) {
    fail("INVALID_STRATEGY_COUNT");
  }
  const ids = new Set();
  for (const row of evaluated) {
    const point = modeledPoint(row);
    if (ids.has(point.id)) fail("DUPLICATE_STRATEGY_ID");
    ids.add(point.id);
    if (typeof row.eligible !== "boolean" || !Array.isArray(row.disqualifiers)
        || row.eligible !== (row.disqualifiers.length === 0)) {
      fail("INVALID_ELIGIBILITY");
    }
  }
  const eligible = evaluated.filter((row) => row.eligible);
  if (eligible.length === 0) fail("NO_ELIGIBLE_STRATEGY");
  const selectedId = report.tournament.selectedStrategyId;
  const selected = eligible.find((row) => row.id === selectedId);
  if (!selected || report.tournament.selectedStrategy?.id !== selectedId
      || JSON.stringify(modeledPoint(selected).values)
         !== JSON.stringify(modeledPoint(report.tournament.selectedStrategy).values)) {
    fail("SELECTED_STRATEGY_NOT_BOUND");
  }
  return { report, eligible, selectedId };
}

// GAUSS certifies an internal Pareto property of hypothetical inputs only.
// It does not certify evidence ownership, Google rankings, lift or signed clients.
export async function auditCommercialGaussPareto(rawV2Report) {
  const { report, eligible, selectedId } = checkedPlanningReport(rawV2Report);
  const problem = {
    schemaVersion: 1,
    problemId: `commercial-pareto-${report.scenarioSha256.slice(7, 23)}`,
    objective: "Check whether the selected modeled strategy is dominated under five declared planning metrics; no sales forecast.",
    tasks: [{
      taskId: "modeled-strategy-pareto",
      layerId: "GAUSS.MATH.PARETO.002",
      input: { points: eligible.map(modeledPoint), objectives: [...OBJECTIVES] },
    }],
  };
  const receipt = await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum });
  const task = receipt.taskResults?.[0];
  if (receipt.status !== "PASS" || receipt.failedLayerCount !== 0
      || receipt.executedLayerCount !== 1 || task?.status !== "EXECUTED"
      || task.layerId !== "GAUSS.MATH.PARETO.002"
      || receipt.quantumContribution?.status !== "NOT_APPLICABLE"
      || receipt.quantumContribution?.hardwareExecution !== false
      || receipt.quantumContribution?.quantumAdvantageClaimAllowed !== false) {
    fail("GAUSS_OR_QUANTUM_RECEIPT_INVALID");
  }
  const frontierIds = task.output?.frontierIds;
  const dominatedIds = task.output?.dominatedIds;
  if (!Array.isArray(frontierIds) || !Array.isArray(dominatedIds)
      || frontierIds.length + dominatedIds.length !== eligible.length
      || new Set([...frontierIds, ...dominatedIds]).size !== eligible.length
      || !eligible.every((row) => frontierIds.includes(row.id) || dominatedIds.includes(row.id))) {
    fail("PARETO_PARTITION_INVALID");
  }
  if (!frontierIds.includes(selectedId)) fail("SELECTED_STRATEGY_DOMINATED");
  return Object.freeze({
    schemaVersion: 1,
    engineId: "NEXUS_COMMERCIAL_GAUSS_PARETO_AUDIT_V1",
    status: "PASS",
    interpretation: "MODELED_STRATEGY_PARETO_ONLY_NOT_OBSERVED_COMMERCIAL_OUTCOMES_OR_FORECAST",
    salesClaimStatus: "NOT_VALIDATED_FOR_SALES_CLAIMS",
    sourceScenarioSha256: report.scenarioSha256,
    sourceTournamentReportSha256: report.reportSha256,
    gaussProblemSha256: receipt.problemSha256,
    gaussReportSha256: receipt.reportSha256,
    quantumStatus: "NOT_APPLICABLE",
    selectedStrategyId: selectedId,
    eligibleStrategyCount: eligible.length,
    frontierIds: Object.freeze([...frontierIds]),
    dominatedIds: Object.freeze([...dominatedIds]),
  });
}
