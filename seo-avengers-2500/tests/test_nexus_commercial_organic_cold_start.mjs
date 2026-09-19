import test from "node:test";
import assert from "node:assert/strict";
import { runOrganicColdStart } from "../commercial-demand/organic-cold-start.mjs";

// All research and rates below are explicitly SYNTHETIC software fixtures.
// They are not evidence of actual Google searches, ranking or signed clients.
const fixture = () => ({
  schemaVersion: 1, tenantId: "test-bakery-mx", maxImplementationCostMxn: 40000,
  business: { siteHostname: null, country: "Mexico", language: "Spanish", approvedOffers: [
    { id: "cakes", label: "Pasteles por encargo", qualifiedClientDefinition: "Pedido local que acepta cotizacion" },
  ] },
  researchSnapshots: [
    { id: "research-1", sourceUrl: "https://example.org/illustrative-research",
      capturedAt: "2026-09-17", country: "Mexico", language: "Spanish",
      evidenceClass: "RESEARCH_ESTIMATE_NOT_OBSERVED_OUTCOME" },
  ],
  avengersOpportunities: [
    { id: "birthday", offerId: "cakes", demandFamilyId: "BIRTHDAY_CAKE",
      keyword: "pastel de cumpleanos por encargo", intent: "DIRECT", monthlySearchVolume: 700,
      sourceSnapshotId: "research-1", proposedPagePath: "/pasteles-cumpleanos" },
    { id: "custom", offerId: "cakes", demandFamilyId: "CUSTOM_CAKE",
      keyword: "pasteles personalizados", intent: "DECISION", monthlySearchVolume: 300,
      sourceSnapshotId: "research-1", proposedPagePath: "/pasteles-personalizados" },
  ],
  avengersPortfolios: [
    { id: "core", opportunityIds: ["birthday"], estimatedImplementationCostMxn: 20000 },
    { id: "full", opportunityIds: ["birthday", "custom"], estimatedImplementationCostMxn: 38000 },
  ],
  planningRates: null,
});

test("new tenant without site, Search Console or CRM still receives actionable researched page portfolio", async () => {
  const report = await runOrganicColdStart(fixture());
  assert.equal(report.siteState, "COLD_START_NO_SITE");
  assert.equal(report.planningStatus, "NOT_ESTIMABLE_WITHOUT_RATES");
  assert.equal(report.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
  assert.equal(report.opportunities.length, 2);
  assert.deepEqual(report.evaluatedPortfolios.find((p) => p.id === "full").pagePaths,
    ["/pasteles-cumpleanos", "/pasteles-personalizados"]);
  assert.deepEqual(report.milestones, []);
  assert.equal(report.cortexExperiment.status, "NOT_ACTIVATED");
  assert.match(report.gaussReportSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.axiomaCaseDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.walleReplayInputSha256, /^sha256:[a-f0-9]{64}$/);
});

test("GAUSS calculates 6/8/10 exact conditional session requirements; no synthetic rate becomes observed", async () => {
  const input = fixture();
  input.planningRates = { evidenceClass: "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED",
    organicCapturePpm: 100000, contactPpm: 40000, qualifiedPpm: 500000, signedPpm: 250000 };
  const result = await runOrganicColdStart(input);
  assert.equal(result.planningStatus, "CONDITIONAL_SCENARIOS_ONLY");
  assert.deepEqual(result.milestones.map((m) => m.requiredOrganicSessions), [1200, 1600, 2000]);
  assert.equal(result.evaluatedPortfolios.find((p) => p.id === "full").relevantSessionsMilli, 100000);
  assert.equal(result.evaluatedPortfolios.find((p) => p.id === "full").worstCaseModeledClientsMilli, 500);
  assert.equal(result.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
});

test("separate tenants never inherit each other's identified first-party outcomes", async () => {
  const a = fixture();
  const b = fixture();
  b.tenantId = "test-lawyer-mx";
  const first = await runOrganicColdStart(a);
  const second = await runOrganicColdStart(b);
  assert.notEqual(first.inputSha256, second.inputSha256);
  assert.equal(first.salesClaimStatus, second.salesClaimStatus);
  assert.equal(second.tenantId, "test-lawyer-mx");
});

test("unapproved offer, duplicated demand, foreign research or fabricated observed outcomes fail closed", async () => {
  const input = fixture();
  input.avengersOpportunities[0].offerId = "not-approved";
  await assert.rejects(runOrganicColdStart(input), /UNAPPROVED_OFFER/);
  const duplicated = fixture();
  duplicated.avengersOpportunities[1].demandFamilyId = "BIRTHDAY_CAKE";
  await assert.rejects(runOrganicColdStart(duplicated), /DUPLICATE_DEMAND_FAMILY_ID/);
  const foreign = fixture();
  foreign.researchSnapshots[0].country = "Canada";
  await assert.rejects(runOrganicColdStart(foreign), /RESEARCH_SOURCE_MARKET_OR_CLASS_MISMATCH/);
  const forged = fixture();
  forged.observedOutcomes = { signedContracts: 6 };
  await assert.rejects(runOrganicColdStart(forged), /UNSUPPORTED_SCHEMA_OR_OBSERVED_OUTCOME_CLAIM/);
  const informational = fixture();
  informational.avengersOpportunities[0].intent = "INFORMATIONAL";
  await assert.rejects(runOrganicColdStart(informational), /INFORMATIONAL_DEMAND/);
  const rates = fixture();
  rates.planningRates = { evidenceClass: "MEASURED_SIGNED_CONTRACTS", organicCapturePpm: 100000,
    contactPpm: 40000, qualifiedPpm: 500000, signedPpm: 250000 };
  await assert.rejects(runOrganicColdStart(rates), /UNSUPPORTED_OR_UNBOUNDED_PLANNING_RATE/);
});
