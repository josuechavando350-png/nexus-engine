import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runOrganicColdStart } from "../commercial-demand/organic-cold-start.mjs";

const path = fileURLToPath(new URL("../demos/cano-organic-research-20260918.json", import.meta.url));
const load = async () => JSON.parse(await readFile(path, "utf8"));

test("CANO's five independently audited search opportunities run on the shared multi-tenant engine", async () => {
  const input = await load();
  assert.equal(input.tenantId, "cano-penal-demo");
  assert.equal(input.business.siteHostname, "canopenal.com");
  assert.equal(input.planningRates, null);
  assert.equal(input.maxImplementationCostMxn, 0, "zero-cost is an audit of existing paths, not free SEO implementation");
  assert.deepEqual(input.avengersOpportunities.map((row) => row.monthlySearchVolume), [390, 10, 20, 20, 20]);
  assert.deepEqual(input.researchSnapshots.map((row) => row.id), [
    "hypd-c216c893-541a-4955-b304-70888b5cd8e3",
    "hypd-80c27513-9dd4-4087-8601-f7034478a869",
    "hypd-119874fb-e7b6-4d13-bf49-fec4fad8ceb8",
  ]);
  assert.ok(input.avengersPortfolios.every((p) => p.opportunityIds.length === 1),
    "no combined demand without independent overlap verification");
  assert.equal(input.avengersOpportunities.find((row) => row.id === "fiscal-penal-mixed").intent, "MIXED");
  const report = await runOrganicColdStart(input);
  assert.equal(report.status, "PLANNING_ONLY");
  assert.equal(report.siteState, "EXISTING_SITE");
  assert.equal(report.tenantId, "cano-penal-demo");
  assert.equal(report.planningStatus, "NOT_ESTIMABLE_WITHOUT_RATES");
  assert.equal(report.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
  assert.equal(report.researchEvidenceClass, "OPERATOR_SUPPLIED_RESEARCH_METADATA_NOT_AUTHENTICATED_PROVIDER_PROOF");
  assert.deepEqual(report.milestones, []);
  assert.deepEqual(report.evaluatedPortfolios.map((row) => row.pagePaths), [
    ["/"], ["/areas/delitos-patrimoniales-y-fraude"], ["/"],
    ["/areas/delitos-fiscales-y-financieros"], ["/areas/delitos-patrimoniales-y-fraude"],
  ]);
  assert.deepEqual(report.evaluatedPortfolios.map((row) => row.worstCaseModeledClientsMilli), [0, 0, 0, 0, 0]);
  assert.equal(report.cortexExperiment.status, "NOT_ACTIVATED");
  assert.match(report.gaussReportSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.axiomaCaseDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(report.walleReplayInputSha256, /^sha256:[a-f0-9]{64}$/);
});

test("relabeling research as observed signed clients fails closed", async () => {
  const input = await load();
  input.observedOutcomes = { signedContracts: 6 };
  await assert.rejects(runOrganicColdStart(input), /UNSUPPORTED_SCHEMA_OR_OBSERVED_OUTCOME_CLAIM/);
});
