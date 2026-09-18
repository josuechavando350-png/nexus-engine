import { readTenantControl } from "../control-plane/tenant-control.mjs";
import { readTenantEvidenceSnapshot } from "../evidence/tenant-evidence.mjs";
import { canonicalProviderRecordsSha256 } from "../evidence/authorized-provider-snapshot.mjs";
import { assertTournamentTenantEvidenceBoundary } from "./tenant-evidence-boundary.mjs";

// The local evidence store verifies tenant control and snapshot integrity. It does
// NOT attest that a human/operator authenticated with Google or owns the property.
// That provider-level proof must be supplied by a separately audited connector.
export async function assertTournamentTenantSnapshotBinding({ controlRoot, evidenceRoot, scenario, manifest }) {
  const declaration = assertTournamentTenantEvidenceBoundary(scenario, manifest);
  if (typeof controlRoot !== "string" || !controlRoot.trim()
      || typeof evidenceRoot !== "string" || !evidenceRoot.trim()) {
    throw new Error("CUSTOM_SCENARIO_REQUIRES_TENANT_CONTROL_AND_EVIDENCE_ROOTS");
  }

  const before = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: declaration.siteId });
  if (before.status !== "READY" || !before.integrityOk || !before.manifestHash) {
    throw new Error(`TENANT_EVIDENCE_NOT_READY:${before.status}:${before.reason}`);
  }
  const rows = before.datasets.search_performance_records;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("INSUFFICIENT_DATA:SEARCH_PERFORMANCE_RECORDS_MISSING");
  }
  const provenance = before.datasets.upstream_evidence;
  if (!Array.isArray(provenance)) throw new Error("TENANT_SEARCH_PROVENANCE_MISSING");
  const searchSources = provenance.filter((entry) => entry?.dataset_key === "search_performance_records");
  if (searchSources.length !== 1 || searchSources[0].provider !== "GOOGLE_SEARCH_CONSOLE"
      || searchSources[0].source_id !== "GOOGLE_SEARCH_CONSOLE:search_performance_records"
      || searchSources[0].record_count !== rows.length
      || searchSources[0].records_sha256 !== canonicalProviderRecordsSha256(rows)) {
    throw new Error("TENANT_SEARCH_PROVENANCE_UNBOUND");
  }

  let clicks = 0;
  let impressions = 0;
  for (const row of rows) {
    let url;
    try {
      url = new URL(row.page_url);
    } catch {
      throw new Error("CROSS_TENANT_SEARCH_PAGE_URL_INVALID");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port
        || ![declaration.siteHostname, `www.${declaration.siteHostname}`].includes(url.hostname)) {
      throw new Error("CROSS_TENANT_SEARCH_PAGE_HOST_MISMATCH");
    }
    if (!Number.isSafeInteger(row.clicks) || !Number.isSafeInteger(row.impressions)
        || row.clicks < 0 || row.impressions < row.clicks) {
      throw new Error("TENANT_SEARCH_COUNTERS_INVALID");
    }
    clicks += row.clicks;
    impressions += row.impressions;
    if (!Number.isSafeInteger(clicks) || !Number.isSafeInteger(impressions)) {
      throw new Error("TENANT_SEARCH_COUNTERS_OVERFLOW");
    }
  }
  if (impressions === 0) throw new Error("INSUFFICIENT_DATA:SEARCH_IMPRESSIONS_MISSING");
  if (scenario.observedSearch.aggregate?.clicks !== clicks
      || scenario.observedSearch.aggregate?.impressions !== impressions) {
    throw new Error("CROSS_TENANT_SEARCH_AGGREGATE_MISMATCH");
  }

  const controlAfter = await readTenantControl({ controlRoot, siteId: declaration.siteId });
  const after = await readTenantEvidenceSnapshot({ controlRoot, evidenceRoot, siteId: declaration.siteId });
  if (!controlAfter.authorized || !controlAfter.integrityOk
      || controlAfter.generation !== before.controlGeneration
      || after.status !== "READY" || !after.integrityOk
      || after.controlGeneration !== before.controlGeneration
      || after.manifestHash !== before.manifestHash) {
    throw new Error("STALE_TENANT_CONTROL_OR_SEARCH_EVIDENCE");
  }
  return Object.freeze({
    siteId: declaration.siteId,
    evidenceManifestHash: before.manifestHash,
    controlGeneration: before.controlGeneration,
    evidenceStatus: "TENANT_SNAPSHOT_BOUND_PROVIDER_OWNERSHIP_NOT_VERIFIED",
    salesClaimStatus: "NOT_VALIDATED_FOR_SALES_CLAIMS",
  });
}
