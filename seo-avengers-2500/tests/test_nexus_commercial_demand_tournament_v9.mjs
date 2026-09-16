import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV9 } from "../commercial-demand/tournament-engine-v9.mjs";

const BASE_URL = new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url);
const V3_EVIDENCE_URL = new URL("../commercial-demand/service-intent-evidence-v3.json", import.meta.url);
const V4_EVIDENCE_URL = new URL("../commercial-demand/software-intent-evidence-v4.json", import.meta.url);
const V5_EVIDENCE_URL = new URL("../commercial-demand/demand-fit-evidence-v5.json", import.meta.url);
const V6_EVIDENCE_URL = new URL("../commercial-demand/paid-search-channel-evidence-v6.json", import.meta.url);
const V7_EVIDENCE_URL = new URL("../commercial-demand/funnel-observability-evidence-v7.json", import.meta.url);
const V8_CONTRACT_URL = new URL("../commercial-demand/funnel-measurement-contract-v8.json", import.meta.url);
const V9_CONTRACT_URL = new URL("../commercial-demand/execution-sequence-contract-v9.json", import.meta.url);

const sources = await Promise.all([
  BASE_URL,
  V3_EVIDENCE_URL,
  V4_EVIDENCE_URL,
  V5_EVIDENCE_URL,
  V6_EVIDENCE_URL,
  V7_EVIDENCE_URL,
  V8_CONTRACT_URL,
  V9_CONTRACT_URL,
].map((url) => readFile(url, "utf8").then(JSON.parse)));

const [baseSource, v3EvidenceSource, v4EvidenceSource, v5EvidenceSource, v6EvidenceSource, v7EvidenceSource, v8ContractSource, v9ContractSource] = sources;

function clone(value) {
  return structuredClone(value);
}

function run(v9 = clone(v9ContractSource)) {
  return runCommercialDemandTournamentV9(
    clone(baseSource),
    clone(v3EvidenceSource),
    clone(v4EvidenceSource),
    clone(v5EvidenceSource),
    clone(v6EvidenceSource),
    clone(v7EvidenceSource),
    clone(v8ContractSource),
    v9,
  );
}

test("V9 report is deterministic and hash-bound to the certified V8 chain", () => {
  const first = run();
  const second = run();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.v8BaselineProof.targetSupportVerdict, "MEASUREMENT_CONTRACT_READY_OBSERVED_COHORTS_STILL_REQUIRED");
  assert.equal(first.v8BaselineProof.measurementContractId, "NEXUS_FUNNEL_MEASUREMENT_CONTRACT_V8");
  assert.match(first.v8BaselineProof.reportSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.reportSha256, /^sha256:[0-9a-f]{64}$/);
});

test("V9 conserves the certified 40-page V5 capacity exactly", () => {
  const sequence = run().executionSequence;
  assert.equal(sequence.strategyId, "OFFER_FIT_FULL_VALIDATED_40");
  assert.equal(sequence.pageCount, 40);
  assert.equal(sequence.conservedRelevantSessionsMilli, 776_700);
  assert.equal(sequence.waveSize, 8);
  assert.equal(sequence.waveCount, 5);
  assert.deepEqual(sequence.waves.map((wave) => wave.pageCount), [8, 8, 8, 8, 8]);
});

test("V9 puts the highest modeled incremental demand pages in wave one", () => {
  const first = run().executionSequence.waves[0];
  assert.deepEqual(first.pageIds, [
    "web-design",
    "seo-agency",
    "business-process-automation",
    "software-development-companies",
    "seo-consulting",
    "software-company",
    "whatsapp-chatbot",
    "web-design-agency",
  ]);
  assert.equal(first.waveRelevantSessionsMilli, 546_300);
  assert.equal(first.cumulativeRelevantSessionsMilli, 546_300);
  assert.equal(first.cumulativeCapacityPpm, 703_360);
});

test("V9 assigns each relevant demand family once instead of double-counting hubs", () => {
  const pages = run().executionSequence.waves.flatMap((wave) => wave.pages);
  const assigned = pages.flatMap((page) => page.assignedDemandFamilyIds);
  assert.equal(new Set(assigned).size, assigned.length);
  assert.equal(pages.filter((page) => page.role === "ARCHITECTURE_OR_DECISION_SUPPORT").length, 2);
  const commercialHub = pages.find((page) => page.pageId === "commercial-decision-hub");
  const automationHub = pages.find((page) => page.pageId === "automation-commercial-hub");
  assert.deepEqual(commercialHub.assignedDemandFamilyIds, []);
  assert.deepEqual(automationHub.assignedDemandFamilyIds, []);
});

test("V9 remains blocked from production, paid activation, Vercel, and protected third-party resources", () => {
  const report = run();
  assert.equal(report.v8BaselineProof.instrumentationStatus, "NOT_INSTALLED_BY_V8");
  assert.equal(report.executionSequence.productionExecutionStatus, "NOT_AUTHORIZED");
  assert.equal(report.executionSequence.paidSearchActivation, "BLOCKED_PENDING_MEASUREMENT_IMPLEMENTATION_AND_SEPARATE_AUTHORIZATION");
  assert.equal(report.executionSequence.protectedThirdPartyResources, "BLOCKED_UNTIL_EXPLICIT_USER_AUTHORIZATION");
  assert.equal(report.executionContract.protectedThirdPartyResources.protectedClientAlias, "LIC_CANO");
  assert.equal(report.executionContract.protectedThirdPartyResources.clientDataAccess, "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION");
  assert.equal(report.executionContract.protectedThirdPartyResources.vercelAccess, "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION");
  assert.equal(report.executionContract.protectedThirdPartyResources.vercelMutation, "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION");
  assert.equal(report.executionContract.protectedThirdPartyResources.vercelDeployment, "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION");
  assert.equal(report.targetSupportVerdict, "EXECUTION_SEQUENCE_READY_MEASUREMENT_AND_OBSERVED_COHORTS_STILL_REQUIRED");
  assert.equal(report.decisionBoundary, "PLAN_ONLY_NO_AUTONOMOUS_SITE_CMS_ADS_DNS_VERCEL_OR_TENANT_MUTATION");
  assert.ok(report.warnings.includes("LIC_CANO_ADS_DATA_VERCEL_AND_TENANT_RESOURCES_PROTECTED"));
});

test("V9 cannot promote informational demand into the execution capacity", () => {
  const changed = clone(v9ContractSource);
  changed.sequencingPolicy.informationalFamiliesEligible = true;
  assert.throws(() => run(changed), /V9 informational families cannot become execution capacity/);
});

test("V9 cannot pretend production instrumentation is installed", () => {
  const changed = clone(v9ContractSource);
  changed.preconditions.productionInstrumentationStatus = "INSTALLED";
  assert.throws(() => run(changed), /V9 cannot pretend instrumentation is installed/);
});

test("V9 cannot authorize paid search through the planning contract", () => {
  const changed = clone(v9ContractSource);
  changed.preconditions.paidSearchActivationStatus = "AUTHORIZED";
  assert.throws(() => run(changed), /V9 cannot authorize paid search/);
});

test("V9 cannot tune wave size to manufacture a different rollout story", () => {
  const changed = clone(v9ContractSource);
  changed.sequencingPolicy.waveSize = 10;
  assert.throws(() => run(changed), /V9 wave size drifted/);
});

test("V9 preserves the separate-authorization gate on paid search", () => {
  const changed = clone(v9ContractSource);
  changed.paidSearchGate.activationRequiresSeparateAuthorization = false;
  assert.throws(() => run(changed), /V9 paid activation must require separate authorization/);
});

test("V9 fails closed if Lic Cano Vercel or client-data protection is weakened", () => {
  const changedVercel = clone(v9ContractSource);
  changedVercel.protectedThirdPartyResources.vercelMutation = "ALLOWED";
  assert.throws(() => run(changedVercel), /V9 protected resource boundary drifted: vercelMutation/);

  const changedData = clone(v9ContractSource);
  changedData.protectedThirdPartyResources.clientDataUseAsNexusEvidence = true;
  assert.throws(() => run(changedData), /V9 cannot use Lic Cano client data as Nexus evidence/);
});
