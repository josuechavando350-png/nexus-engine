import { runFinalCoreMathPhysicsBank } from "../../gauss/axioma/final-core-math-physics-v1.mjs";
import { auditCommercialGaussPareto } from "./gauss-pareto-audit.mjs";
import { independentlyVerifyCommercialPareto } from "./independent-pareto-verifier.mjs";

const METRICS = Object.freeze([
  "worstCaseModeledClientsMilli", "strictCommercialSessionsMilli", "relevantSessionsMilli",
  "coveredDemandFamilyCount", "pageCount",
]);
const OBJECTIVES = Object.freeze(["MAX", "MAX", "MAX", "MAX", "MIN"]);

// Only planning evidence is accepted by the underlying GAUSS audit.
// AXIOMA checks the actual GAUSS Pareto operator against separately written
// mathematical references. WALLE then independently recomputes THIS report's
// Pareto set instead of treating an AXIOMA sample test as per-input proof.
export async function auditCommercialGaussAxiomaWalle(report) {
  const gauss = await auditCommercialGaussPareto(report);
  const axioma = runFinalCoreMathPhysicsBank();
  const pareto = axioma.operatorResults.find((entry) => entry.id === "GAUSS.MATH.PARETO.002");
  if (!pareto || pareto.validCases !== 100 || pareto.passed !== 100 || pareto.failed !== 0
      || pareto.invalidCases !== 3 || pareto.rejected !== 3 || pareto.invalidAccepted !== 0) {
    throw new Error("AXIOMA_GAUSS_PARETO_ORACLE_FAILED");
  }
  const eligible = report.tournament.evaluatedStrategies.filter((strategy) => strategy.eligible);
  const points = eligible.map((row) => ({ id: row.id, values: METRICS.map((key) => row[key]) }));
  const walle = independentlyVerifyCommercialPareto(points, OBJECTIVES, gauss);
  if (!walle.frontierIds.includes(gauss.selectedStrategyId)
      || gauss.eligibleStrategyCount !== points.length
      || gauss.sourceTournamentReportSha256 !== report.reportSha256) {
    throw new Error("WALLE_GAUSS_SOURCE_OR_SELECTION_MISMATCH");
  }
  return Object.freeze({ ...gauss, axiomaStatus: "PASS_BOUNDED_PARETO_OPERATOR_CASES",
    axiomaCaseDigest: axioma.caseDigest, walleStatus: walle.status,
    walleReplayInputSha256: walle.inputSha256,
    verificationBoundary: "MODELED_MATH_ONLY_NO_OBSERVED_CLIENT_OR_CAUSAL_CLAIMS" });
}
