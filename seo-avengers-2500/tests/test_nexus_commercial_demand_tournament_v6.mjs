import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV6 } from "../commercial-demand/tournament-engine-v6.mjs";

const BASE_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const V3_EVIDENCE_URL = new URL("../commercial-demand/service-intent-evidence-v3.json", import.meta.url);
const V4_EVIDENCE_URL = new URL("../commercial-demand/software-intent-evidence-v4.json", import.meta.url);
const V5_EVIDENCE_URL = new URL("../commercial-demand/demand-fit-evidence-v5.json", import.meta.url);
const V6_EVIDENCE_URL = new URL("../commercial-demand/paid-search-channel-evidence-v6.json", import.meta.url);
const [baseSource, v3EvidenceSource, v4EvidenceSource, v5EvidenceSource, v6EvidenceSource] = await Promise.all([
  readFile(BASE_URL, "utf8").then(JSON.parse),
  readFile(V3_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V4_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V5_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V6_EVIDENCE_URL, "utf8").then(JSON.parse),
]);

function clone(value) {
  return structuredClone(value);
}

function run(v6 = clone(v6EvidenceSource)) {
  return runCommercialDemandTournamentV6(
    clone(baseSource),
    clone(v3EvidenceSource),
    clone(v4EvidenceSource),
    clone(v5EvidenceSource),
    v6,
  );
}

test("V6 report is deterministic and hash-bound to the certified V5 chain", () => {
  const first = run();
  const second = run();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.v5BaselineProof.selectedStrategyId, "OFFER_FIT_FULL_VALIDATED_40");
  assert.match(first.v5BaselineProof.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("V6 preserves the V5 organic architecture instead of inventing more pages", () => {
  const report = run();
  assert.equal(report.v5BaselineProof.pageCount, 40);
  assert.equal(report.v5BaselineProof.organicModeledSessionsMilli, 776_700);
  assert.equal(report.v5BaselineProof.validatedRelevantRawSearchVolume, 11_750);
  assert.equal(report.paidSearchEvidence.portfolio.keywordCount, 17);
});

test("exact paid-search frontier uses only the three evidence-bound bid forecasts", () => {
  const report = run();
  assert.deepEqual(
    report.channelFrontier.exactMatchForecasts.map((row) => [row.bidUsdCents, row.clicksMilli, row.costUsdCents]),
    [
      [200, 229_570, 26_079],
      [400, 347_330, 65_526],
      [800, 370_740, 92_696],
    ],
  );
  assert.deepEqual(
    report.channelFrontier.exactMatchForecasts.map((row) => row.highConversionUpperBoundModeledClientsMilli),
    [7_748, 8_655, 8_835],
  );
});

test("even the largest exact-match capture envelope remains below the 15-client floor", () => {
  const envelope = run().channelFrontier.maxExactCaptureEnvelope;
  assert.deepEqual(envelope, {
    bidUsdCents: 800,
    forecastPaidClicksMilli: 370_740,
    forecastPaidCostUsdCents: 92_696,
    organicModeledSessionsMilli: 776_700,
    combinedNoOverlapUpperBoundSessionsMilli: 1_147_440,
    zeroOverlapAssumption: "UPPER_BOUND_ONLY_NOT_EXPECTED_OUTCOME",
    highConversionSensitivityPpm: 7_700,
    highConversionUpperBoundModeledClientsMilli: 8_835,
    minimumPlanningFloorClientsMilli: 15_000,
    gapToFloorClientsMilli: 6_165,
    requiredSessionToClientPpmFor15Clients: 13_073,
    requiredSessionToClientPpmFor16Clients: 13_945,
    requiredSessionToClientPpmFor20Clients: 17_431,
  });
});

test("phrase-match can look like a false 15-client pass but remains ineligible", () => {
  const report = run();
  const phrase = report.channelFrontier.matchExpansionControls.find((row) => row.match === "phrase");
  assert.equal(phrase.clicksMilli, 1_240_300);
  assert.equal(phrase.combinedNoOverlapUpperBoundSessionsMilli, 2_017_000);
  assert.equal(phrase.rawHypotheticalHighConversionClientsMilli, 15_530);
  assert.equal(phrase.floorSupportEligible, false);
  assert.match(phrase.floorSupportReason, /MATCH_EXPANSION_LACKS_QUERY_LEVEL_INTENT/);
});

test("broad-match forecast is also an uncertainty control and cannot support the floor", () => {
  const report = run();
  const broad = report.channelFrontier.matchExpansionControls.find((row) => row.match === "broad");
  assert.equal(broad.clicksMilli, 1_141_360);
  assert.equal(broad.rawHypotheticalHighConversionClientsMilli, 14_769);
  assert.equal(broad.floorSupportEligible, false);
});

test("V6 refuses to turn paid planner forecasts into an outcome or guarantee", () => {
  const report = run();
  assert.equal(report.targetSupportVerdict, "MULTI_CHANNEL_AND_OBSERVED_FUNNEL_EVIDENCE_REQUIRED_BEFORE_FLOOR_CLAIM");
  assert.ok(report.warnings.includes("PAID_SEARCH_FORECAST_IS_NOT_ACTUAL_TRAFFIC"));
  assert.ok(report.warnings.includes("GA4_CONVERSION_EVIDENCE_IS_UNAVAILABLE"));
  assert.ok(report.warnings.includes("NO_LEAD_OR_CLIENT_GUARANTEE"));
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION");
});

test("exact forecast metrics are fail-closed and cannot be inflated", () => {
  const changed = clone(v6EvidenceSource);
  changed.exactMatchForecasts.find((row) => row.bidUsdCents === 800).clicksMilli = 3_707_400;
  assert.throws(() => run(changed), /V6 exact forecasts mismatch/);
});

test("phrase or broad controls cannot be promoted into floor-support evidence", () => {
  const changed = clone(v6EvidenceSource);
  changed.matchExpansionControls[0].floorSupportEligibility = "ELIGIBLE";
  assert.throws(() => run(changed), /V6 match controls cannot be promoted to floor support/);
});

test("V6 cannot invent GA4 conversion or paid-organic incrementality evidence", () => {
  const changed = clone(v6EvidenceSource);
  changed.analyticsBoundary.ga4ConversionEvidence = "AVAILABLE";
  assert.throws(() => run(changed), /V6 cannot invent GA4 conversion evidence/);

  const changedOverlap = clone(v6EvidenceSource);
  changedOverlap.analyticsBoundary.paidOrganicOverlap = "ZERO";
  assert.throws(() => run(changedOverlap), /V6 paid-organic overlap must remain unobserved/);
});

test("V6 portfolio membership is exact and cannot silently expand", () => {
  const changed = clone(v6EvidenceSource);
  changed.portfolio.keywords[0] = "seo gratis";
  assert.throws(() => run(changed), /V6 portfolio keywords does not match the required set/);
});
