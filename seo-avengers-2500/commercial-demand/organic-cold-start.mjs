import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { runFinalCoreMathPhysicsBank } from "../../gauss/axioma/final-core-math-physics-v1.mjs";
import { independentlyVerifyCommercialPareto } from "./independent-pareto-verifier.mjs";
import { __test as v2Test } from "./tournament-engine-v2.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OBJECTIVES = ["MAX", "MAX", "MAX", "MAX", "MIN"];
const RATE_DENOMINATOR = 1_000_000n ** 4n;
const SALES_BOUNDARY = "NOT_VALIDATED_FOR_SALES_CLAIMS";
function fail(reason) { throw new Error(`ORGANIC_COLD_START_${reason}`); }
function obj(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`INVALID_${name}`);
  return value;
}
function str(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) fail(`INVALID_${name}`);
  return value.trim().normalize("NFC");
}
function id(value, name) {
  if (!IDENTIFIER.test(str(value, name))) fail(`INVALID_${name}`);
  return value;
}
function count(value, name, max = 10_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`INVALID_${name}`);
  return value;
}
function arr(value, name, max = 100) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) fail(`INVALID_${name}`);
  return value;
}
function httpsUrl(value, name) {
  let url;
  try { url = new URL(str(value, name)); } catch { fail(`INVALID_${name}`); }
  if (url.protocol !== "https:" || url.username || url.password) fail(`INVALID_${name}`);
  return url.href;
}
function pagePath(value) {
  const path = str(value, "PAGE_PATH");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")
      || path.includes("\\") || path.split("/").includes("..")) fail("INVALID_PAGE_PATH");
  return path;
}
function unique(items, name) {
  if (new Set(items).size !== items.length) fail(`DUPLICATE_${name}`);
}
function safeBigInt(value, name) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) fail(`OVERFLOW_${name}`);
  return Number(value);
}
function ceilDiv(n, d) { return (n + d - 1n) / d; }

// Avengers supplies research snapshots and actionable page portfolios, NOT made-up
// first-party GSC rows. No site, traffic history or CRM is required to enter.
export async function runOrganicColdStart(raw) {
  const input = structuredClone(obj(raw, "INPUT"));
  if (input.schemaVersion !== 1 || input.observedOutcomes !== undefined || input.salesClaimStatus !== undefined) {
    fail("UNSUPPORTED_SCHEMA_OR_OBSERVED_OUTCOME_CLAIM");
  }
  const tenantId = id(input.tenantId, "TENANT_ID");
  const business = obj(input.business, "BUSINESS");
  const country = str(business.country, "COUNTRY");
  const language = str(business.language, "LANGUAGE");
  if (business.siteHostname !== null && business.siteHostname !== undefined) {
    const hostname = str(business.siteHostname, "SITE_HOSTNAME");
    if (hostname !== hostname.toLowerCase() || !/^[a-z0-9.-]+$/.test(hostname)
        || !hostname.includes(".") || hostname.includes("..") || new URL(`https://${hostname}`).hostname !== hostname) {
      fail("INVALID_SITE_HOSTNAME");
    }
  }
  const offers = arr(business.approvedOffers, "APPROVED_OFFERS", 50).map((offer) => ({
    id: id(obj(offer, "OFFER").id, "OFFER_ID"),
    label: str(offer.label, "OFFER_LABEL"),
    qualifiedClientDefinition: str(offer.qualifiedClientDefinition, "QUALIFIED_CLIENT_DEFINITION"),
  }));
  unique(offers.map((offer) => offer.id), "OFFER_ID");
  const offerIds = new Set(offers.map((offer) => offer.id));
  const sources = arr(input.researchSnapshots, "RESEARCH_SNAPSHOTS", 100).map((source) => ({
    id: id(obj(source, "RESEARCH_SOURCE").id, "RESEARCH_SOURCE_ID"),
    sourceUrl: httpsUrl(source.sourceUrl, "RESEARCH_SOURCE_URL"),
    capturedAt: str(source.capturedAt, "RESEARCH_CAPTURE_DATE"),
    country: str(source.country, "RESEARCH_COUNTRY"),
    language: str(source.language, "RESEARCH_LANGUAGE"),
    evidenceClass: source.evidenceClass,
  }));
  unique(sources.map((source) => source.id), "RESEARCH_SOURCE_ID");
  for (const source of sources) {
    if (source.evidenceClass !== "RESEARCH_ESTIMATE_NOT_OBSERVED_OUTCOME"
        || source.country !== country || source.language !== language
        || !/^\d{4}-\d{2}-\d{2}$/.test(source.capturedAt)
        || Number.isNaN(Date.parse(`${source.capturedAt}T00:00:00Z`))) {
      fail("RESEARCH_SOURCE_MARKET_OR_CLASS_MISMATCH");
    }
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  const opportunities = arr(input.avengersOpportunities, "AVENGERS_OPPORTUNITIES", 100).map((entry) => ({
    id: id(obj(entry, "OPPORTUNITY").id, "OPPORTUNITY_ID"),
    offerId: id(entry.offerId, "OPPORTUNITY_OFFER_ID"),
    demandFamilyId: id(entry.demandFamilyId, "DEMAND_FAMILY_ID"),
    keyword: str(entry.keyword, "KEYWORD"),
    intent: entry.intent,
    monthlySearchVolume: count(entry.monthlySearchVolume, "RESEARCH_SEARCH_VOLUME"),
    sourceSnapshotId: id(entry.sourceSnapshotId, "SOURCE_SNAPSHOT_ID"),
    proposedPagePath: pagePath(entry.proposedPagePath),
  }));
  unique(opportunities.map((entry) => entry.id), "OPPORTUNITY_ID");
  unique(opportunities.map((entry) => entry.demandFamilyId), "DEMAND_FAMILY_ID");
  const opportunityById = new Map(opportunities.map((entry) => [entry.id, entry]));
  for (const entry of opportunities) {
    if (!offerIds.has(entry.offerId) || !sourceIds.has(entry.sourceSnapshotId)
        || !["DIRECT", "DECISION", "MIXED"].includes(entry.intent)) {
      fail("UNAPPROVED_OFFER_OR_UNBOUND_RESEARCH_OR_INFORMATIONAL_DEMAND");
    }
  }
  const budget = count(input.maxImplementationCostMxn, "IMPLEMENTATION_BUDGET", 1_000_000_000);
  const portfolios = arr(input.avengersPortfolios, "AVENGERS_PORTFOLIOS", 40).map((rawPortfolio) => {
    const p = obj(rawPortfolio, "PORTFOLIO");
    const opportunityIds = arr(p.opportunityIds, "PORTFOLIO_OPPORTUNITIES", 100).map((value) => id(value, "PORTFOLIO_OPPORTUNITY_ID"));
    unique(opportunityIds, "PORTFOLIO_OPPORTUNITY_ID");
    if (opportunityIds.some((value) => !opportunityById.has(value))) fail("FOREIGN_PORTFOLIO_OPPORTUNITY");
    const entries = opportunityIds.map((value) => opportunityById.get(value));
    const paths = [...new Set(entries.map((entry) => entry.proposedPagePath))];
    return { id: id(p.id, "PORTFOLIO_ID"), opportunityIds, entries,
      pagePaths: paths, pageCount: paths.length,
      estimatedImplementationCostMxn: count(p.estimatedImplementationCostMxn, "IMPLEMENTATION_COST", 1_000_000_000),
    };
  });
  unique(portfolios.map((p) => p.id), "PORTFOLIO_ID");
  const rates = input.planningRates === null || input.planningRates === undefined ? null : obj(input.planningRates, "PLANNING_RATES");
  const rateFields = ["organicCapturePpm", "contactPpm", "qualifiedPpm", "signedPpm"];
  if (rates && (rates.evidenceClass !== "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED"
      || rateFields.some((field) => !Number.isSafeInteger(rates[field]) || rates[field] < 1 || rates[field] > 1_000_000))) {
    fail("UNSUPPORTED_OR_UNBOUNDED_PLANNING_RATE");
  }
  const eligible = portfolios.filter((p) => p.estimatedImplementationCostMxn <= budget);
  if (!eligible.length) fail("NO_PORTFOLIOS_WITHIN_BUDGET");
  const rows = eligible.map((p) => {
    const demand = p.entries.reduce((n, entry) => n + BigInt(entry.monthlySearchVolume), 0n);
    const strict = p.entries.filter((entry) => entry.intent !== "MIXED")
      .reduce((n, entry) => n + BigInt(entry.monthlySearchVolume), 0n);
    const capture = BigInt(rates?.organicCapturePpm ?? 0);
    const clientsMilli = rates ? demand * capture * BigInt(rates.contactPpm)
      * BigInt(rates.qualifiedPpm) * BigInt(rates.signedPpm) * 1_000n / RATE_DENOMINATOR : 0n;
    return { id: p.id, opportunityIds: p.opportunityIds, pagePaths: p.pagePaths,
      estimatedImplementationCostMxn: p.estimatedImplementationCostMxn,
      worstCaseModeledClientsMilli: safeBigInt(clientsMilli, "MODELED_CLIENTS"),
      strictCommercialSessionsMilli: safeBigInt(strict * capture / 1_000n, "STRICT_SESSIONS"),
      relevantSessionsMilli: safeBigInt(demand * capture / 1_000n, "RELEVANT_SESSIONS"),
      coveredDemandFamilyCount: p.entries.length, pageCount: p.pageCount,
    };
  });
  const vectors = rows.map((row) => ({ id: row.id, values: [row.worstCaseModeledClientsMilli,
    row.strictCommercialSessionsMilli, row.relevantSessionsMilli, row.coveredDemandFamilyCount, row.pageCount] }));
  const inputSha256 = v2Test.sha256Canonical({ tenantId, business, sources, opportunities, portfolios: portfolios.map(({ entries: _ignored, ...p }) => p),
    planningRates: rates, maxImplementationCostMxn: budget });
  const receipt = await executeGaussProblem({ schemaVersion: 1, problemId: `organic-cold-start-${inputSha256.slice(7, 23)}`,
    objective: "Compute modeled Pareto frontier for tenant-specific researched organic page portfolios; not observed sales.",
    tasks: [{ taskId: "tenant-organic-pareto", layerId: "GAUSS.MATH.PARETO.002",
      input: { points: vectors, objectives: OBJECTIVES } }] }, { quantumContributor: contributeNexusQuantum });
  const result = receipt.taskResults?.[0];
  if (receipt.status !== "PASS" || result?.status !== "EXECUTED" || result.layerId !== "GAUSS.MATH.PARETO.002"
      || receipt.quantumContribution?.status !== "NOT_APPLICABLE"
      || receipt.quantumContribution?.hardwareExecution !== false) fail("GAUSS_RECEIPT_INVALID");
  const axioma = runFinalCoreMathPhysicsBank();
  const pareto = axioma.operatorResults.find((item) => item.id === "GAUSS.MATH.PARETO.002");
  if (!pareto || pareto.passed !== 100 || pareto.failed !== 0 || pareto.rejected !== 3) fail("AXIOMA_PARETO_ORACLE_FAILED");
  const walle = independentlyVerifyCommercialPareto(vectors, OBJECTIVES, result.output);
  const milestones = rates ? [6, 8, 10].map((targetSignedClients) => ({
    targetSignedClients,
    requiredOrganicSessions: safeBigInt(ceilDiv(BigInt(targetSignedClients) * (1_000_000n ** 3n),
      BigInt(rates.contactPpm) * BigInt(rates.qualifiedPpm) * BigInt(rates.signedPpm)), "REQUIRED_SESSIONS"),
    interpretation: "IF_HYPOTHETICAL_RATES_HOLD_NOT_AN_OBSERVED_TRAFFIC_OR_CONTRACT_FORECAST",
  })) : [];
  return Object.freeze({ schemaVersion: 1, tenantId, status: "PLANNING_ONLY", siteState: business.siteHostname ? "EXISTING_SITE" : "COLD_START_NO_SITE",
    researchEvidenceClass: "OPERATOR_SUPPLIED_RESEARCH_METADATA_NOT_AUTHENTICATED_PROVIDER_PROOF",
    salesClaimStatus: SALES_BOUNDARY, planningStatus: rates ? "CONDITIONAL_SCENARIOS_ONLY" : "NOT_ESTIMABLE_WITHOUT_RATES",
    horizon: "MONTHLY_STEADY_STATE_IF_RANKING_AND_FUNNEL_ASSUMPTIONS_HOLD_NOT_TIME_TO_RANK",
    inputSha256, sources, opportunities, evaluatedPortfolios: rows, milestones,
    paretoFrontierIds: walle.frontierIds, gaussReportSha256: receipt.reportSha256,
    axiomaCaseDigest: axioma.caseDigest, walleReplayInputSha256: walle.inputSha256,
    cortexExperiment: { status: "NOT_ACTIVATED", reason: "NO_VERIFIED_ORGANIC_EXPOSURES_AND_SIGNED_OUTCOMES" },
    execution: "READ_ONLY_NO_SITE_CHANGE_NO_RANK_OR_SALES_GUARANTEE" });
}
