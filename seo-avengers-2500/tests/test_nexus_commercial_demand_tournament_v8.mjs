import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV8 } from "../commercial-demand/tournament-engine-v8.mjs";

const BASE_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const V3_EVIDENCE_URL = new URL("../commercial-demand/service-intent-evidence-v3.json", import.meta.url);
const V4_EVIDENCE_URL = new URL("../commercial-demand/software-intent-evidence-v4.json", import.meta.url);
const V5_EVIDENCE_URL = new URL("../commercial-demand/demand-fit-evidence-v5.json", import.meta.url);
const V6_EVIDENCE_URL = new URL("../commercial-demand/paid-search-channel-evidence-v6.json", import.meta.url);
const V7_EVIDENCE_URL = new URL("../commercial-demand/funnel-observability-evidence-v7.json", import.meta.url);
const V8_CONTRACT_URL = new URL("../commercial-demand/funnel-measurement-contract-v8.json", import.meta.url);
const [baseSource, v3EvidenceSource, v4EvidenceSource, v5EvidenceSource, v6EvidenceSource, v7EvidenceSource, v8ContractSource] = await Promise.all([
  readFile(BASE_URL, "utf8").then(JSON.parse),
  readFile(V3_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V4_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V5_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V6_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V7_EVIDENCE_URL, "utf8").then(JSON.parse),
  readFile(V8_CONTRACT_URL, "utf8").then(JSON.parse),
]);

function clone(value) {
  return structuredClone(value);
}

function run(contract = clone(v8ContractSource), v7 = clone(v7EvidenceSource)) {
  return runCommercialDemandTournamentV8(
    clone(baseSource),
    clone(v3EvidenceSource),
    clone(v4EvidenceSource),
    clone(v5EvidenceSource),
    clone(v6EvidenceSource),
    v7,
    contract,
  );
}

test("V8 report is deterministic and hash-bound to the certified V7 chain", () => {
  const first = run();
  const second = run();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.v7BaselineProof.targetSupportVerdict, "OBSERVED_FUNNEL_REQUIRED_BEFORE_15_CLIENT_FLOOR_CLAIM");
  assert.equal(first.v7BaselineProof.probabilityStatus, "NOT_IDENTIFIABLE_FROM_AVAILABLE_EVIDENCE");
  assert.match(first.v7BaselineProof.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.contractSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("V8 preserves the V7/V6 acquisition envelope instead of inventing more traffic", () => {
  const report = run();
  assert.equal(report.v7BaselineProof.combinedNoOverlapUpperBoundSessionsMilli, 1_147_440);
  assert.equal(report.v7BaselineProof.requiredSessionToClientPpmFor15Clients, 13_073);
  assert.equal(report.measurementContract.objective.planningFloorClients, 15);
  assert.equal(report.measurementContract.objective.v6RequiredSessionToClientPpm, 13_073);
});

test("V8 defines all four first-party funnel events with exact count units", () => {
  const report = run();
  const units = Object.fromEntries(report.measurementContract.eventContract.map((row) => [row.eventType, row.unitOfCount]));
  assert.deepEqual(units, {
    CLOSED_CLIENT: "UNIQUE_NEW_CLIENT_ID_HASH",
    CONTACT: "UNIQUE_LEAD_ID",
    QUALIFIED_LEAD: "UNIQUE_LEAD_ID_UNDER_VERSIONED_POLICY",
    SESSION: "UNIQUE_SESSION_ID",
  });
});

test("V8 new-client counting rule forbids repeat purchases from inflating acquisition", () => {
  const rules = run().measurementContract.joinAndCountingRules;
  assert.equal(rules.closedClientCountRule, "COUNT_DISTINCT_NEW_CLIENT_ID_HASH_WHERE_IS_NEW_CLIENT_TRUE");
  assert.equal(rules.repeatPurchaseOrExpansionRule, "MUST_NOT_COUNT_AS_NEW_CLIENT");
  assert.equal(rules.qualificationPolicyRule, "POLICY_VERSION_MUST_BE_RETAINED_AND_NOT_REWRITTEN_RETROACTIVELY");
});

test("V8 analytics contract does not require raw phone, email, or message content", () => {
  const privacy = run().measurementContract.privacyRules;
  assert.equal(privacy.rawPhoneRequired, false);
  assert.equal(privacy.rawEmailRequired, false);
  assert.equal(privacy.messageBodyRequired, false);
  assert.equal(privacy.clientIdentityForAnalysis, "PSEUDONYMOUS_STABLE_HASH_ONLY");
});

test("V8 statistical checkpoints are deterministically tied to the V6 envelope", () => {
  const checkpoints = run().statisticalAcceptanceFrontier.checkpoints;
  assert.deepEqual(
    checkpoints.map((row) => [row.sessions, row.minimumUniqueNewClosedClientsForWilsonLowerBound, row.minimumObservedRatePpmAtThreshold, row.wilsonLowerPpmAtThreshold, row.wilsonLowerPpmOneFewerClient]),
    [
      [1_148, 23, 20_035, 13_386, 12_688],
      [2_296, 41, 17_857, 13_190, 12_819],
      [4_592, 76, 16_551, 13_244, 13_050],
      [9_184, 142, 15_462, 13_133, 13_033],
    ],
  );
});

test("V8 statistical threshold is a conversion-rate gate, not a monthly client forecast", () => {
  const report = run();
  assert.equal(report.statisticalAcceptanceFrontier.method, "WILSON_SCORE_LOWER_BOUND");
  assert.equal(report.statisticalAcceptanceFrontier.confidenceLevelPermille, 950);
  assert.equal(report.statisticalAcceptanceFrontier.targetSessionToClientPpm, 13_073);
  assert.match(report.statisticalAcceptanceFrontier.interpretation, /DO_NOT_PREDICT_MONTHLY_CLIENT_COUNTS/);
  assert.ok(report.warnings.includes("STATISTICAL_THRESHOLDS_ARE_NOT_TRAFFIC_OR_CLIENT_FORECASTS"));
});

test("V8 keeps monthly 15-plus probability unidentifiable until real cohorts exist", () => {
  const readiness = run().measurementImplementationReadiness;
  assert.equal(readiness.contractDefined, true);
  assert.equal(readiness.productionInstrumentationInstalledByV8, false);
  assert.equal(readiness.firstPartyObservedOutcomeDatasetAvailable, false);
  assert.equal(readiness.probabilityOfAtLeast15ClientsPerMonth, "STILL_NOT_IDENTIFIABLE_UNTIL_REAL_COHORTS_EXIST");
});

test("V8 cannot weaken the measurement boundary or pretend instrumentation was installed", () => {
  const weakened = clone(v8ContractSource);
  weakened.boundary = "OUTCOME_EVIDENCE";
  assert.throws(() => run(weakened), /V8 contract boundary cannot be weakened/);

  const installed = clone(v8ContractSource);
  installed.planningRules.instrumentationStatus = "INSTALLED";
  assert.throws(() => run(installed), /V8 planning rule drifted: instrumentationStatus/);
});

test("V8 cannot delete required funnel fields or quality gates", () => {
  const changedField = clone(v8ContractSource);
  changedField.eventContract.find((row) => row.eventType === "CLOSED_CLIENT").requiredFields.pop();
  assert.throws(() => run(changedField), /V8 CLOSED_CLIENT required fields does not match/);

  const changedGate = clone(v8ContractSource);
  changedGate.qualityGates = changedGate.qualityGates.filter((row) => row !== "NO_REPEAT_CLIENT_AS_NEW_CLIENT");
  assert.throws(() => run(changedGate), /V8 quality gates does not match/);
});

test("V8 target rate and checkpoint sizes cannot be tuned to manufacture a pass", () => {
  const changedTarget = clone(v8ContractSource);
  changedTarget.statisticalDesign.targetSessionToClientPpm = 7_700;
  assert.throws(() => run(changedTarget), /V8 target PPM drifted/);

  const changedBase = clone(v8ContractSource);
  changedBase.statisticalDesign.baseCheckpointSessions = 10_000;
  assert.throws(() => run(changedBase), /V8 base checkpoint drifted/);
});

test("V8 requires cohort maturity evidence before any statistical acceptance", () => {
  const report = run();
  assert.equal(report.measurementImplementationReadiness.cohortMaturityCutoffKnownFromObservedCloseLag, false);
  assert.equal(report.measurementContract.joinAndCountingRules.maturityRule, "DO_NOT_DECLARE_A_COHORT_MATURE_UNTIL_CLOSE_LAG_EVIDENCE_SUPPORTS_THE_CUTOFF");
  assert.ok(report.warnings.includes("COHORT_MATURITY_REQUIRES_OBSERVED_CLOSE_LAG_EVIDENCE"));
});

test("V8 remains planning-only with no production mutation", () => {
  const report = run();
  assert.equal(report.targetSupportVerdict, "MEASUREMENT_CONTRACT_READY_OBSERVED_COHORTS_STILL_REQUIRED");
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_OR_TENANT_MUTATION");
  assert.equal(report.measurementContract.planningRules.productionMutation, "FORBIDDEN");
  assert.ok(report.warnings.includes("NO_LEAD_CLIENT_OR_REVENUE_GUARANTEE"));
});
