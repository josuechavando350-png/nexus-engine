import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { independentlyVerifyCommercialPareto } from "./independent-pareto-verifier.mjs";
import { runOrganicColdStart } from "./organic-cold-start.mjs";

const PPM = 1_000_000n;
const DENOMINATOR = PPM ** 4n;
const OBJECTIVES = ["MAX", "MAX", "MAX", "MAX", "MIN"];
const fail = (reason) => { throw new Error(`ORGANIC_EXACT_TOURNAMENT_${reason}`); };
const gcd = (a, b) => {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};
const fraction = (n, d) => {
  if (d <= 0n || n < 0n) fail("INVALID_RATIONAL");
  const divisor = gcd(n, d);
  return { numerator: String(n / divisor), denominator: String(d / divisor) };
};
const ceilDiv = (n, d) => (n + d - 1n) / d;

// Reuse the tenant, offer, source, rate, and budget validation of the shared
// cold-start runner, but do NOT use its milliscale forecast to rank strategies.
// All four conversion rates are portfolio-invariant within schema v1. Hence
// exact signed-contract expectation is strictly increasing in raw demand;
// raw demand preserves the exact rational ordering without unsafe BigInt->Number
// conversion. Likewise strict/relevant sessions scale by the same positive rate.
export async function runOrganicExactTournament(raw) {
  const input = structuredClone(raw);
  const base = await runOrganicColdStart(input);
  const opportunities = new Map(input.avengersOpportunities.map((item) => [item.id, item]));
  const rates = input.planningRates ?? null;
  const rows = base.evaluatedPortfolios.map((portfolio) => {
    const selected = portfolio.opportunityIds.map((id) => opportunities.get(id));
    if (selected.some((item) => !item)) fail("UNBOUND_OPPORTUNITY");
    const demand = selected.reduce((sum, item) => sum + BigInt(item.monthlySearchVolume), 0n);
    const strict = selected.filter((item) => item.intent !== "MIXED")
      .reduce((sum, item) => sum + BigInt(item.monthlySearchVolume), 0n);
    if (demand > BigInt(Number.MAX_SAFE_INTEGER) || strict > BigInt(Number.MAX_SAFE_INTEGER)) fail("UNSAFE_GAUSS_VECTOR");
    const product = rates ? ["organicCapturePpm", "contactPpm", "qualifiedPpm", "signedPpm"]
      .reduce((value, field) => value * BigInt(rates[field]), 1n) : null;
    const numerator = product === null ? null : demand * product;
    if (numerator !== null && BigInt(portfolio.worstCaseModeledClientsMilli) !== numerator * 1_000n / DENOMINATOR) {
      fail("BASE_MODEL_ARITHMETIC_MISMATCH");
    }
    return {
      id: portfolio.id,
      pagePaths: portfolio.pagePaths,
      estimatedImplementationCostMxn: portfolio.estimatedImplementationCostMxn,
      researchedMonthlySearches: String(demand),
      strictIntentMonthlySearches: String(strict),
      exactConditionalSignedContracts: numerator === null ? null : fraction(numerator, DENOMINATOR),
      // Demand is a research estimate, not site visits. This comparison is
      // conditional on assumptions, rankings and absence of semantic overlap.
      milestones: [6n, 8n, 10n].map((target) => ({
        targetSignedContracts: Number(target),
        status: numerator === null ? "NOT_ESTIMABLE_WITHOUT_RATES" :
          numerator >= target * DENOMINATOR
            ? "ARITHMETICALLY_REACHABLE_IF_ALL_ASSUMPTIONS_HOLD_NOT_A_FORECAST"
            : "RESEARCHED_VOLUME_INSUFFICIENT_IF_ALL_ASSUMPTIONS_HOLD",
      })),
      vector: { id: portfolio.id, values: [Number(demand), Number(strict), Number(demand),
        portfolio.coveredDemandFamilyCount, portfolio.pageCount] },
    };
  });
  const receipt = await executeGaussProblem({
    schemaVersion: 1,
    problemId: `organic-exact-${base.inputSha256.slice(7, 23)}`,
    objective: "Exact rational ordering of researched organic portfolios, not an observed or guaranteed client forecast.",
    tasks: [{ taskId: "exact-organic-pareto", layerId: "GAUSS.MATH.PARETO.002",
      input: { points: rows.map((row) => row.vector), objectives: OBJECTIVES } }],
  }, { quantumContributor: contributeNexusQuantum });
  const result = receipt.taskResults?.[0];
  if (receipt.status !== "PASS" || result?.status !== "EXECUTED" || result.layerId !== "GAUSS.MATH.PARETO.002"
      || receipt.quantumContribution?.status !== "NOT_APPLICABLE"
      || receipt.quantumContribution?.hardwareExecution !== false) fail("GAUSS_RECEIPT_INVALID");
  const replay = independentlyVerifyCommercialPareto(rows.map((row) => row.vector), OBJECTIVES, result.output);
  if (rates) {
    const downstream = BigInt(rates.contactPpm) * BigInt(rates.qualifiedPpm) * BigInt(rates.signedPpm);
    for (const milestone of base.milestones) {
      if (BigInt(milestone.requiredOrganicSessions) !== ceilDiv(BigInt(milestone.targetSignedClients) * PPM ** 3n, downstream)) {
        fail("BASE_MILESTONE_ARITHMETIC_MISMATCH");
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1, tenantId: base.tenantId,
    status: "PLANNING_ONLY_NOT_A_SALES_FORECAST",
    precision: "EXACT_INTEGER_AND_REDUCED_RATIONAL_ARITHMETIC_FOR_DECLARED_INPUTS",
    interpretation: rates ? "HYPOTHETICAL_CONVERSION_RATES_NOT_OBSERVED_CLIENT_OUTCOMES" : "DEMAND_ONLY_NO_CLIENT_RANKING",
    researchEvidenceClass: base.researchEvidenceClass,
    salesClaimStatus: base.salesClaimStatus,
    inputSha256: base.inputSha256,
    portfolios: rows.map(({ vector: _vector, ...row }) => row),
    gaussExactParetoFrontierIds: replay.frontierIds,
    gaussExactReportSha256: receipt.reportSha256,
    axiomaCaseDigest: base.axiomaCaseDigest,
    walleIndependentReplaySha256: replay.inputSha256,
    legacyMilliscaleParetoFrontierIds: base.paretoFrontierIds,
    legacyMilliscaleFrontierMatchesExact: JSON.stringify([...base.paretoFrontierIds].sort()) === JSON.stringify([...replay.frontierIds].sort()),
    cortexExperiment: base.cortexExperiment,
    guardrails: "RESEARCH_ESTIMATE_NOT_VERIFIED_LOCAL_TRAFFIC; DEMAND_FAMILY_OVERLAP_NOT_INDEPENDENTLY_PROVEN; NO_TIME_TO_RANK_OR_CONTRACT_GUARANTEE",
  });
}
