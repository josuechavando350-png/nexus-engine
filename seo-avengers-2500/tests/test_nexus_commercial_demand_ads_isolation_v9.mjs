import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateAdsAccountIsolationV9 } from "../commercial-demand/ads-account-isolation-v9.mjs";

const CONTRACT_URL = new URL("../commercial-demand/execution-sequence-contract-v9.json", import.meta.url);
const source = JSON.parse(await readFile(CONTRACT_URL, "utf8"));

function clone(value) {
  return structuredClone(value);
}

test("V9 isolates the connected Google Ads account from Nexus first-party evidence", () => {
  const result = validateAdsAccountIsolationV9(clone(source));
  assert.deepEqual(result, {
    status: "THIRD_PARTY_ADS_ACCOUNT_ISOLATED",
    connectedGoogleAdsAccountOwnership: "THIRD_PARTY_NON_NEXUS_ACCOUNT",
    nexusFirstPartyPerformanceEvidenceEligible: false,
    connectedAccountMutationAuthorized: false,
    keywordPlannerResearchOnly: true,
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

test("V9 keeps planner forecasts as market research rather than campaign performance", () => {
  const changed = clone(source);
  changed.paidSearchGate.keywordPlannerResearchInterpretation = "NEXUS_CAMPAIGN_PERFORMANCE";
  assert.throws(
    () => validateAdsAccountIsolationV9(changed),
    /keyword-planner evidence must remain market research only/,
  );
});

test("V9 cannot activate paid search while the connected account is third-party", () => {
  const changed = clone(source);
  changed.preconditions.paidSearchActivationStatus = "AUTHORIZED";
  assert.throws(() => validateAdsAccountIsolationV9(changed), /V9 cannot authorize paid search/);
});
