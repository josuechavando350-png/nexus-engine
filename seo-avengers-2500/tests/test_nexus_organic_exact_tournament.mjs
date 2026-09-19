import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runOrganicExactTournament } from "../commercial-demand/organic-exact-tournament.mjs";

const fixtureUrl = new URL("../demos/cano-organic-research-20260918.json", import.meta.url);
const fixture = async () => JSON.parse(await readFile(fixtureUrl, "utf8"));

test("Cano: exact GAUSS/WALLE Pareto runs with verified input boundaries and no invented contracts", async () => {
  const input = await fixture();
  const result = await runOrganicExactTournament(input);
  assert.equal(result.status, "PLANNING_ONLY_NOT_A_SALES_FORECAST");
  assert.equal(result.precision, "EXACT_INTEGER_AND_REDUCED_RATIONAL_ARITHMETIC_FOR_DECLARED_INPUTS");
  assert.equal(result.interpretation, "DEMAND_ONLY_NO_CLIENT_RANKING");
  assert.equal(result.portfolios[0].exactConditionalSignedContracts, null);
  assert.equal(result.portfolios[0].milestones[0].status, "NOT_ESTIMABLE_WITHOUT_RATES");
  assert.equal(result.cortexExperiment.status, "NOT_ACTIVATED");
  assert.equal(result.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
  assert.match(result.gaussExactReportSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.walleIndependentReplaySha256, /^sha256:[a-f0-9]{64}$/);
});

test("GAUSS returns reduced exact fractions; hypothetical conversion rates never become observed sales", async () => {
  const input = await fixture();
  input.planningRates = { evidenceClass: "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED",
    organicCapturePpm: 100000, contactPpm: 40000, qualifiedPpm: 500000, signedPpm: 250000 };
  const result = await runOrganicExactTournament(input);
  assert.deepEqual(result.portfolios[0].exactConditionalSignedContracts, { numerator: "39", denominator: "200" });
  assert.deepEqual(result.portfolios[1].exactConditionalSignedContracts, { numerator: "1", denominator: "200" });
  assert.equal(result.portfolios[0].milestones[0].status, "RESEARCHED_VOLUME_INSUFFICIENT_IF_ALL_ASSUMPTIONS_HOLD");
  assert.equal(result.interpretation, "HYPOTHETICAL_CONVERSION_RATES_NOT_OBSERVED_CLIENT_OUTCOMES");
  assert.equal(result.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
});

test("milliscale rounding ties distinct strategies; exact GAUSS Pareto does not", async () => {
  const input = await fixture();
  input.avengersOpportunities[0].monthlySearchVolume = 1;
  input.avengersOpportunities[1].monthlySearchVolume = 2;
  input.planningRates = { evidenceClass: "HYPOTHETICAL_PLANNING_ASSUMPTION_NOT_OBSERVED",
    organicCapturePpm: 1, contactPpm: 1000000, qualifiedPpm: 1000000, signedPpm: 1000000 };
  const result = await runOrganicExactTournament(input);
  assert.equal(result.legacyMilliscaleFrontierMatchesExact, false);
  assert.deepEqual(result.gaussExactParetoFrontierIds, ["audit-fraud-existing-page"]);
  assert.deepEqual(result.portfolios[0].exactConditionalSignedContracts, {
    numerator: "1", denominator: "1000000" });
  assert.deepEqual(result.portfolios[1].exactConditionalSignedContracts, {
    numerator: "1", denominator: "500000" });
});

test("no fabricated observed outcomes or unapproved services can bypass the exact wrapper", async () => {
  const forged = await fixture();
  forged.observedOutcomes = { signedContracts: 6 };
  await assert.rejects(runOrganicExactTournament(forged), /UNSUPPORTED_SCHEMA_OR_OBSERVED_OUTCOME_CLAIM/);
  const unapproved = await fixture();
  unapproved.avengersOpportunities[0].offerId = "unknown";
  await assert.rejects(runOrganicExactTournament(unapproved), /UNAPPROVED_OFFER/);
});
