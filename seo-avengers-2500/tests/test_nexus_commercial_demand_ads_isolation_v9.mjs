import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateAdsAccountIsolationV9 } from "../commercial-demand/ads-account-isolation-v9.mjs";

const CONTRACT_URL = new URL("../commercial-demand/execution-sequence-contract-v9.json", import.meta.url);
const source = JSON.parse(await readFile(CONTRACT_URL, "utf8"));

function clone(value) {
  return structuredClone(value);
}

test("V9 isolates Lic Cano Ads, client data, and Vercel from Nexus execution", () => {
  const result = validateAdsAccountIsolationV9(clone(source));
  assert.deepEqual(result, {
    status: "THIRD_PARTY_CLIENT_RESOURCES_ISOLATED",
    protectedClientAlias: "LIC_CANO",
    connectedGoogleAdsAccountOwnership: "THIRD_PARTY_NON_NEXUS_ACCOUNT",
    connectedGoogleAdsAccountOwnerAlias: "LIC",
    nexusGoogleAdsAccountAvailable: false,
    nexusFirstPartyPerformanceEvidenceEligible: false,
    connectedAccountMutationAuthorized: false,
    newConnectedGoogleAdsApiCallsAuthorized: false,
    clientDataAccessAuthorized: false,
    clientDataUseAsNexusEvidenceEligible: false,
    vercelAccessAuthorized: false,
    vercelMutationAuthorized: false,
    vercelDeploymentAuthorized: false,
    historicalKeywordPlannerResearchOnly: true,
  });
});

test("V9 cannot relabel the connected third-party Ads account as Nexus", () => {
  const changed = clone(source);
  changed.paidSearchGate.connectedGoogleAdsAccountOwnership = "NEXUS_ACCOUNT";
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /connected Google Ads account must remain classified as third-party and non-Nexus/,
  );
});

test("V9 cannot relabel the connected Ads account owner away from LIC", () => {
  const changed = clone(source);
  changed.paidSearchGate.connectedGoogleAdsAccountOwnerAlias = "NEXUS";
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /connected Google Ads account owner alias must remain LIC/,
  );
});

test("V9 cannot use third-party Ads performance as Nexus first-party evidence", () => {
  const changed = clone(source);
  changed.paidSearchGate.connectedGoogleAdsPerformanceMayBeUsedAsNexusEvidence = true;
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /forbids using third-party Google Ads performance as Nexus first-party evidence/,
  );
});

test("V9 cannot mutate the connected third-party Ads account", () => {
  const changed = clone(source);
  changed.paidSearchGate.connectedGoogleAdsMutation = "ALLOWED";
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /forbids mutation of the connected third-party Google Ads account/,
  );
});

test("V9 cannot make new connected Google Ads API calls without explicit authorization", () => {
  const changed = clone(source);
  changed.paidSearchGate.newConnectedGoogleAdsApiCalls = "ALLOWED";
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /forbids new calls to the connected Google Ads account without explicit user authorization/,
  );
});

test("V9 keeps historical planner snapshots static and non-first-party", () => {
  const changed = clone(source);
  changed.paidSearchGate.historicalKeywordPlannerSnapshotInterpretation = "NEXUS_CAMPAIGN_PERFORMANCE";
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /historical keyword-planner snapshots must remain static market research only/,
  );
});

test("V9 cannot access or use Lic Cano client data without explicit authorization", () => {
  const changedAccess = clone(source);
  changedAccess.protectedThirdPartyResources.clientDataAccess = "ALLOWED";
  assert.throws(
    () => validateAdsAccountIsolationV9(changedAccess),
    /forbids Lic Cano client-data access without explicit user authorization/,
  );

  const changedEvidence = clone(source);
  changedEvidence.protectedThirdPartyResources.clientDataUseAsNexusEvidence = true;
  assert.throws(
    () => validateAdsAccountIsolationV9(changedEvidence),
    /forbids using Lic Cano client data as Nexus evidence/,
  );
});

test("V9 cannot access, mutate, or deploy Lic Cano Vercel without explicit authorization", () => {
  for (const key of ["vercelAccess", "vercelMutation", "vercelDeployment"]) {
    const changed = clone(source);
    changed.protectedThirdPartyResources[key] = "ALLOWED";
    assert.throws(
      () => validateAdsAccountIsolationV9(changed),
      /forbids Lic Cano Vercel (access|mutation|deployment) without explicit user authorization/,
    );
  }
});

test("V9 cannot mutate other Lic Cano tenant resources without explicit authorization", () => {
  const changed = clone(source);
  changed.protectedThirdPartyResources.otherClientTenantMutation = "ALLOWED";
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /forbids other Lic Cano tenant mutation without explicit user authorization/,
  );
});

test("V9 cannot activate paid search while the connected account is third-party", () => {
  const changed = clone(source);
  changed.preconditions.paidSearchActivationStatus = "AUTHORIZED";
  assert.throws(() => validateAdsAccountIsolationV9(changed), /V9 cannot authorize paid search/);
});
