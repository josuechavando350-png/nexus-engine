import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV7 } from "../commercial-demand/tournament-engine-v7.mjs";

const BASE_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const V3_EVIDENCE_URL = new URL("../commercial-demand/service-intent-evidence-v3.json", import.meta.url);
const V4_EVIDENCE_URL = new URL("../commercial-demand/software-intent-evidence-v4.json", import.meta.url);
const V5_EVIDENCE_URL = new URL("../commercial-demand/demand-fit-evidence-v5.json", import.meta.url);
const V6_EVIDENCE_URL = new URL("../commercial-demand/paid-search-channel-evidence-v6.json", import.meta.url);
const V7_EVIDENCE_URL = new URL("../commercial-demand/funnel-observability-evidence-v7.json", import.meta.url);
const [baseSource, v3EvidenceSource, v4EvidenceSource, v5EvidenceSource, v6EvidenceSource, v7EvidenceSource] = await Promise.all([
  readFile(BASE_URL, "utf8").then(JSON.parse),
  readFile(V3_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V4_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V5_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V6_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V7_EVIDENCE_URL, "utf8").then(JSON.parse),
]);

function clone(value) {
  return structuredClone(value);
}

function run(v7 = clone(v7EvidenceSource)) {
  return runCommercialDemandTournamentV7(
    clone(baseSource),
    clone(v3EvidenceSource),
    clone(v4EvidenceSource),
    clone(v5EvidenceSource),
    clone(v6EvidenceSource),
    v7,
  );
}

test("V7 report is deterministic and hash-bound to the certified V6 chain", () => {
  const first = run();
  const second = run();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.v6BaselineProof.targetSupportVerdict, "MULTI_CHANNEL_AND_OBSERVED_FUNNEL_EVIDENCE_REQUIRED_BEFORE_FLOOR_CLAIM");
  assert.match(first.v6BaselineProof.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("V7 preserves the V6 traffic envelope instead of manufacturing more demand", () => {
  const report = run();
  assert.equal(report.v6BaselineProof.organicPageCount, 40);
  assert.equal(report.v6BaselineProof.organicModeledSessionsMilli, 776_700);
  assert.equal(report.v6BaselineProof.maxExactPaidClicksMilli, 370_740);
  assert.equal(report.v6BaselineProof.combinedNoOverlapUpperBoundSessionsMilli, 1_147_440);
  assert.equal(report.v6BaselineProof.hypotheticalHighConversionClientsMilli, 8_835);
});

test("V7 snapshots two live browser audits without claiming total analytics absence", () => {
  const report = run();
  assert.equal(report.measurementReadiness.auditedPageCount, 2);
  assert.equal(report.measurementReadiness.browserVisibleGoogleMeasurementTagObservedOnAuditedPages, false);
  assert.deepEqual(
    report.observabilityEvidence.liveBrowserAudits.map((row) => [row.rawUrl, row.statusCode, row.scriptCount]),
    [
      ["https://nexusbotstudio.com", 200, 13],
      ["https://nexusbotstudio.com/automation", 200, 10],
    ],
  );
  for (const row of report.observabilityEvidence.liveBrowserAudits) {
    assert.match(row.interpretation, /DOES_NOT_RULE_OUT_SERVER_SIDE_OR_OTHER_MEASUREMENT/);
  }
});

test("V7 keeps connected-source absence scoped to what is actually accessible", () => {
  const readiness = run().measurementReadiness;
  assert.equal(readiness.ga4AccessiblePropertyCount, 0);
  assert.equal(readiness.nexusGoogleAdsAccountObserved, false);
  assert.equal(readiness.metaAdsAccessibleAccountCount, 0);
  assert.equal(readiness.status, "FIRST_PARTY_FUNNEL_OUTCOME_DATA_UNAVAILABLE");
});

test("V7 computes the exact break-even uplift required for the 15-client planning floor", () => {
  const frontier = run().conversionFrontier;
  assert.equal(frontier.v6CombinedNoOverlapUpperBoundSessionsMilli, 1_147_440);
  assert.equal(frontier.hypotheticalPlanningSessionToClientPpm, 7_700);
  assert.equal(frontier.hypotheticalPlanningClientsMilliAtV6Envelope, 8_835);
  assert.equal(frontier.requiredSessionToClientPpmFor15Clients, 13_073);
  assert.equal(frontier.relativeUpliftFactorPpmVsHypotheticalPlanningSensitivity, 1_697_793);
  assert.equal(frontier.floorSupportEligible, false);
});

test("V7 exposes one-stage break-even requirements without presenting them as forecasts", () => {
  const requirements = run().conversionFrontier.oneStageBreakEvenRequirements;
  assert.deepEqual(requirements, {
    visitToContactPpmIfOtherStagesFixed: 67_912,
    contactToQualifiedPpmIfOtherStagesFixed: 933_786,
    qualifiedToClosePpmIfOtherStagesFixed: 594_228,
  });
});

test("V7 explicitly refuses to invent a probability for 15-plus clients", () => {
  const report = run();
  assert.equal(report.measurementReadiness.probabilityOfAtLeast15ClientsPerMonth, "NOT_IDENTIFIABLE_FROM_AVAILABLE_EVIDENCE");
  assert.ok(report.warnings.includes("PROBABILITY_OF_15_PLUS_CLIENTS_IS_NOT_IDENTIFIABLE"));
  assert.equal(report.targetSupportVerdict, "OBSERVED_FUNNEL_REQUIRED_BEFORE_15_CLIENT_FLOOR_CLAIM");
});

test("V7 cannot invent browser-visible tracking that the audit did not observe", () => {
  const changed = clone(v7EvidenceSource);
  changed.liveBrowserAudits[0].observedGoogleAnalyticsOrAdsBrowserTag = true;
  assert.throws(() => run(changed), /V7 cannot invent browser-visible Google measurement tags/);
});

test("V7 cannot invent connected GA4 or first-party conversion evidence", () => {
  const changedGa4 = clone(v7EvidenceSource);
  changedGa4.connectedDataSources.ga4AccessiblePropertyCount = 1;
  assert.throws(() => run(changedGa4), /V7 cannot invent an accessible GA4 property/);

  const changedDataset = clone(v7EvidenceSource);
  changedDataset.connectedDataSources.nexusFirstPartyConversionDataset = "AVAILABLE";
  assert.throws(() => run(changedDataset), /V7 cannot invent a first-party conversion dataset/);
});

test("V7 cannot promote the hypothetical funnel into observed evidence", () => {
  const changed = clone(v7EvidenceSource);
  changed.planningFunnelSensitivity.observed = true;
  assert.throws(() => run(changed), /V7 hypothetical funnel cannot be promoted to observed evidence/);
});

test("V7 funnel rates are evidence-bound and cannot be tuned to force a pass", () => {
  const changed = clone(v7EvidenceSource);
  changed.planningFunnelSensitivity.visitToContactPpm = 80_000;
  assert.throws(() => run(changed), /V7 hypothetical funnel sensitivity drifted/);
});

test("V7 remains planning-only and requires all four observed funnel events", () => {
  const report = run();
  assert.deepEqual(report.measurementReadiness.requiredObservedFunnelEvents, ["CLOSED_CLIENT", "CONTACT", "QUALIFIED_LEAD", "SESSION"]);
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION");
  assert.ok(report.warnings.includes("NO_LEAD_CLIENT_OR_REVENUE_GUARANTEE"));
});
