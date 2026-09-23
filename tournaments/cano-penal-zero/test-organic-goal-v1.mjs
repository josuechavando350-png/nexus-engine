import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const goal = JSON.parse(await readFile(new URL("./organic-goal-v1.json", import.meta.url), "utf8"));

test("CANO tournament objective is organic-first and requires at least five signed organic clients per month", () => {
  assert.equal(goal.acquisitionMode, "ORGANIC_FIRST");
  assert.equal(goal.businessOutcome.metric, "NEW_SIGNED_CLIENTS_ATTRIBUTABLE_TO_ORGANIC_SEARCH");
  assert.equal(goal.businessOutcome.minimumPerCalendarMonth, 5);
  assert.equal(goal.businessOutcome.leadMetricDoesNotCount, true);
  assert.equal(goal.businessOutcome.whatsappContactDoesNotCount, true);
});

test("ranking success is portfolio-based rather than a single-keyword vanity win", () => {
  assert.equal(goal.searchOutcome.singleKeywordVictoryInsufficient, true);
  assert(goal.searchOutcome.requiredMeasurement.includes("top3Count"));
  assert(goal.searchOutcome.requiredMeasurement.includes("top5Count"));
  assert(goal.searchOutcome.requiredMeasurement.includes("signedOrganicClients"));
});

test("commercial winner claims fail closed without attributable signed-client evidence", () => {
  assert.equal(goal.attributionEvidence.missingEvidenceVerdict, "INSUFFICIENT_DATA");
  assert.equal(goal.attributionEvidence.noInventedAttribution, true);
  assert.equal(goal.certification.rankingGuaranteeAllowed, false);
  assert.equal(goal.certification.clientForecastAllowed, false);
  assert(goal.hardBoundaries.includes("NO_PAID_SEARCH_DEPENDENCY_FOR_CHAMPION_STRATEGY"));
  assert(goal.hardBoundaries.includes("NO_COUNTING_LEADS_AS_CLIENTS"));
});

test("repeatability requires three consecutive target months after initial champion eligibility", () => {
  assert.match(goal.certification.championEligibility, /AT_LEAST_5_SIGNED_ORGANIC_CLIENTS/);
  assert.equal(goal.certification.repeatabilityEvidence, "3_CONSECUTIVE_MONTHS_AT_OR_ABOVE_TARGET");
});
