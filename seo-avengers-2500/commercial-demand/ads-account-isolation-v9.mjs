export function validateAdsAccountIsolationV9(rawContract) {
  if (!rawContract || typeof rawContract !== "object" || Array.isArray(rawContract)) {
    throw new TypeError("V9 execution contract must be an object");
  }

  const paid = rawContract.paidSearchGate;
  if (!paid || typeof paid !== "object" || Array.isArray(paid)) {
    throw new TypeError("V9 paidSearchGate must be an object");
  }

  if (paid.connectedGoogleAdsAccountOwnership !== "THIRD_PARTY_NON_NEXUS_ACCOUNT") {
    throw new Error("V9 connected Google Ads account must remain classified as third-party and non-Nexus");
  }
  if (paid.connectedGoogleAdsAccountOwnerAlias !== "LIC") {
    throw new Error("V9 connected Google Ads account owner alias must remain LIC");
  }
  if (paid.connectedGoogleAdsPerformanceMayBeUsedAsNexusEvidence !== false) {
    throw new Error("V9 forbids using third-party Google Ads performance as Nexus first-party evidence");
  }
  if (paid.connectedGoogleAdsMutation !== "FORBIDDEN") {
    throw new Error("V9 forbids mutation of the connected third-party Google Ads account");
  }
  if (paid.keywordPlannerResearchInterpretation !== "MARKET_RESEARCH_ONLY_NOT_NEXUS_FIRST_PARTY_CAMPAIGN_PERFORMANCE") {
    throw new Error("V9 keyword-planner evidence must remain market research only");
  }
  if (rawContract.preconditions?.paidSearchActivationStatus !== "NOT_AUTHORIZED_BY_V9") {
    throw new Error("V9 cannot authorize paid search");
  }

  return Object.freeze({
    status: "THIRD_PARTY_ADS_ACCOUNT_ISOLATED",
    connectedGoogleAdsAccountOwnership: paid.connectedGoogleAdsAccountOwnership,
    connectedGoogleAdsAccountOwnerAlias: paid.connectedGoogleAdsAccountOwnerAlias,
    nexusGoogleAdsAccountAvailable: false,
    nexusFirstPartyPerformanceEvidenceEligible: false,
    connectedAccountMutationAuthorized: false,
    keywordPlannerResearchOnly: true,
  });
}
