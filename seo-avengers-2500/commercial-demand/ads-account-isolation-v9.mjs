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
  if (paid.newConnectedGoogleAdsApiCalls !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids new calls to the connected Google Ads account without explicit user authorization");
  }
  if (paid.historicalKeywordPlannerSnapshotInterpretation !== "STATIC_MARKET_RESEARCH_ONLY_NOT_NEXUS_FIRST_PARTY_CAMPAIGN_PERFORMANCE") {
    throw new Error("V9 historical keyword-planner snapshots must remain static market research only");
  }
  if (rawContract.preconditions?.paidSearchActivationStatus !== "NOT_AUTHORIZED_BY_V9") {
    throw new Error("V9 cannot authorize paid search");
  }

  const protectedResources = rawContract.protectedThirdPartyResources;
  if (!protectedResources || typeof protectedResources !== "object" || Array.isArray(protectedResources)) {
    throw new TypeError("V9 protectedThirdPartyResources must be an object");
  }
  if (protectedResources.protectedClientAlias !== "LIC_CANO") {
    throw new Error("V9 protected third-party client alias must remain LIC_CANO");
  }
  if (protectedResources.clientDataAccess !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids Lic Cano client-data access without explicit user authorization");
  }
  if (protectedResources.clientDataUseAsNexusEvidence !== false) {
    throw new Error("V9 forbids using Lic Cano client data as Nexus evidence");
  }
  if (protectedResources.googleAdsAccountAccess !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids Lic Cano Google Ads access without explicit user authorization");
  }
  if (protectedResources.googleAdsMutation !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids Lic Cano Google Ads mutation without explicit user authorization");
  }
  if (protectedResources.vercelAccess !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids Lic Cano Vercel access without explicit user authorization");
  }
  if (protectedResources.vercelMutation !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids Lic Cano Vercel mutation without explicit user authorization");
  }
  if (protectedResources.vercelDeployment !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids Lic Cano Vercel deployment without explicit user authorization");
  }
  if (protectedResources.otherClientTenantMutation !== "FORBIDDEN_UNTIL_EXPLICIT_USER_AUTHORIZATION") {
    throw new Error("V9 forbids other Lic Cano tenant mutation without explicit user authorization");
  }

  return Object.freeze({
    status: "THIRD_PARTY_CLIENT_RESOURCES_ISOLATED",
    protectedClientAlias: protectedResources.protectedClientAlias,
    connectedGoogleAdsAccountOwnership: paid.connectedGoogleAdsAccountOwnership,
    connectedGoogleAdsAccountOwnerAlias: paid.connectedGoogleAdsAccountOwnerAlias,
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
}
