// Fail-closed declaration binding for the V2 executable. This is NOT provider
// authorization: the upstream tenant-evidence reader must prove access/ownership.
const EVIDENCE_CLASS = "TENANT_SOURCE_DECLARATION_NOT_PROVIDER_AUTHORIZATION";
const COMMERCIAL_BOUNDARY = "PLANNING_ONLY_NOT_VALIDATED_FOR_SALES_CLAIMS";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.normalize("NFC").trim();
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`${name} has missing or unexpected fields`);
  }
}

export function assertTournamentTenantEvidenceBoundary(rawScenario, rawManifest) {
  const scenario = object(rawScenario, "scenario");
  const manifest = object(rawManifest, "tenant manifest");
  exactKeys(manifest, [
    "schemaVersion", "evidenceClass", "siteId", "siteHostname",
    "observedSearchAccount", "market", "researchSnapshotResultIds", "commercialBoundary",
  ], "tenant manifest");
  if (manifest.schemaVersion !== 1) throw new Error("unsupported tenant manifest schemaVersion");
  if (manifest.evidenceClass !== EVIDENCE_CLASS) throw new Error("tenant declaration must not claim provider authorization");
  if (manifest.commercialBoundary !== COMMERCIAL_BOUNDARY) throw new Error("tenant declaration must not claim sales validation");

  const siteId = text(manifest.siteId, "manifest.siteId");
  const siteHostname = text(manifest.siteHostname, "manifest.siteHostname");
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(siteHostname)
      || !siteHostname.includes(".") || siteHostname.includes("..")
      || new URL(`https://${siteHostname}/`).hostname !== siteHostname) {
    throw new Error("manifest.siteHostname must be a normalized domain hostname");
  }
  const observedSearchAccount = text(manifest.observedSearchAccount, "manifest.observedSearchAccount");
  if (observedSearchAccount !== `sc-domain:${siteHostname}`) {
    throw new Error("manifest Search Console property does not match the declared site hostname");
  }
  if (text(scenario.siteId, "scenario.siteId") !== siteId) {
    throw new Error("CROSS_TENANT_SITE_ID_MISMATCH");
  }
  if (text(object(scenario.observedSearch, "scenario.observedSearch").account, "scenario.observedSearch.account") !== observedSearchAccount) {
    throw new Error("CROSS_TENANT_SEARCH_CONSOLE_ACCOUNT_MISMATCH");
  }
  if (scenario.observedSearch.evidenceClass !== "FIRST_PARTY_OBSERVED_CARRIED_FORWARD_FROM_V1") {
    throw new Error("observed Search Console evidence cannot be promoted from an assumption");
  }
  const actualMarket = object(scenario.market, "scenario.market");
  const expectedMarket = object(manifest.market, "manifest.market");
  exactKeys(expectedMarket, ["country", "language"], "manifest.market");
  for (const key of ["country", "language"]) {
    if (text(actualMarket[key], `scenario.market.${key}`) !== text(expectedMarket[key], `manifest.market.${key}`)) {
      throw new Error(`CROSS_TENANT_MARKET_${key.toUpperCase()}_MISMATCH`);
    }
  }

  const allowed = manifest.researchSnapshotResultIds;
  if (!Array.isArray(allowed) || allowed.length === 0) throw new Error("tenant research snapshot allowlist must be non-empty");
  const declaredIds = allowed.map((id) => text(id, "manifest.researchSnapshotResultIds entry"));
  if (new Set(declaredIds).size !== declaredIds.length) throw new Error("duplicate tenant research snapshot resultId");
  const research = object(scenario.keywordResearch, "scenario.keywordResearch");
  if (research.evidenceClass !== "RESEARCH_ESTIMATE_NOT_FIRST_PARTY_OUTCOME") {
    throw new Error("keyword research must not be promoted to observed outcomes");
  }
  if (!Array.isArray(research.snapshots) || research.snapshots.length === 0) {
    throw new Error("scenario keyword research snapshots must be non-empty");
  }
  const snapshotIds = research.snapshots.map((row) => text(object(row, "research snapshot").resultId, "research snapshot.resultId"));
  if (new Set(snapshotIds).size !== snapshotIds.length) throw new Error("duplicate scenario research snapshot resultId");
  if (JSON.stringify(snapshotIds.sort()) !== JSON.stringify(declaredIds.sort())) {
    throw new Error("CROSS_TENANT_RESEARCH_SNAPSHOT_MISMATCH");
  }
  return Object.freeze({
    siteId,
    siteHostname,
    observedSearchAccount,
    evidenceStatus: "DECLARATION_BOUND_PROVIDER_OWNERSHIP_NOT_VERIFIED",
    salesClaimStatus: "NOT_VALIDATED_FOR_SALES_CLAIMS",
  });
}
