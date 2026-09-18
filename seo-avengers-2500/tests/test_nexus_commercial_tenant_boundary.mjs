import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertTournamentTenantEvidenceBoundary } from "../commercial-demand/tenant-evidence-boundary.mjs";
import { buildCommercialDemandScenarioV3 } from "../commercial-demand/tournament-v3-scenario.mjs";
import { runCommercialDemandTournamentV3 } from "../commercial-demand/tournament-engine-v3.mjs";
import { runCommercialDemandTournamentV4 } from "../commercial-demand/tournament-engine-v4.mjs";

const load = async (path) => JSON.parse(await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
const fixture = await load("../commercial-demand/nexus-commercial-demand-v2.json");
const manifest = await load("../commercial-demand/nexus-commercial-demand-v2.tenant-manifest.json");
const v3Evidence = await load("../commercial-demand/service-intent-evidence-v3.json");
const v4Evidence = await load("../commercial-demand/software-intent-evidence-v4.json");
const clone = (data) => structuredClone(data);

test("real NEXUS fixture binds by declared tenant, GSC property, market and research snapshots", () => {
  const result = assertTournamentTenantEvidenceBoundary(fixture, manifest);
  assert.equal(result.siteId, "nexus-bot-studio");
  assert.equal(result.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
  assert.equal(result.evidenceStatus, "DECLARATION_BOUND_PROVIDER_OWNERSHIP_NOT_VERIFIED");
});

test("reject CANO scenario with transplanted NEXUS Search Console property", () => {
  const scenario = clone(fixture);
  scenario.siteId = "cano-penal";
  const expected = clone(manifest);
  expected.siteId = "cano-penal";
  expected.siteHostname = "canopenal.com";
  expected.observedSearchAccount = "sc-domain:canopenal.com";
  assert.throws(() => assertTournamentTenantEvidenceBoundary(scenario, expected), /CROSS_TENANT_SEARCH_CONSOLE_ACCOUNT_MISMATCH/);
});

test("reject site ID mismatch before running a different company's scenario", () => {
  assert.throws(() => assertTournamentTenantEvidenceBoundary(fixture, {...manifest, siteId: "cano-penal"}), /CROSS_TENANT_SITE_ID_MISMATCH/);
});

test("reject declared domain not belonging to declared Search Console property", () => {
  assert.throws(() => assertTournamentTenantEvidenceBoundary(fixture, {...manifest, siteHostname: "canopenal.com"}), /property does not match/);
});

test("reject borrowed keyword research snapshot even if GSC matches", () => {
  const scenario = clone(fixture);
  scenario.keywordResearch.snapshots[0].resultId = "BORROWED_FROM_ANOTHER_TENANT";
  assert.throws(() => assertTournamentTenantEvidenceBoundary(scenario, manifest), /CROSS_TENANT_RESEARCH_SNAPSHOT_MISMATCH/);
});

test("reject market mismatch and forged provider-authorization claim", () => {
  assert.throws(() => assertTournamentTenantEvidenceBoundary(fixture, {...manifest, market: { country: "Chile", language: "Spanish" }}), /CROSS_TENANT_MARKET_COUNTRY_MISMATCH/);
  assert.throws(() => assertTournamentTenantEvidenceBoundary(fixture, {...manifest, evidenceClass: "FIRST_PARTY_AUTHORIZED"}), /must not claim provider authorization/);
});

test("reject commercial claims and empty or repeated allowlisted snapshots", () => {
  assert.throws(() => assertTournamentTenantEvidenceBoundary(fixture, {...manifest, commercialBoundary: "GUARANTEED_15_CLIENTS"}), /must not claim sales validation/);
  assert.throws(() => assertTournamentTenantEvidenceBoundary(fixture, {...manifest, researchSnapshotResultIds: []}), /non-empty/);
  assert.throws(() => assertTournamentTenantEvidenceBoundary(fixture, {...manifest, researchSnapshotResultIds: ["same", "same"]}), /duplicate/);
});

test("V3 native builder and engine reject CANO label on NEXUS baseline", () => {
  const swapped = clone(fixture);
  swapped.siteId = "cano-penal";
  assert.throws(() => buildCommercialDemandScenarioV3(swapped), /NEXUS_COMMERCIAL_TOURNAMENT_CROSS_TENANT_BASELINE/);
  assert.throws(() => runCommercialDemandTournamentV3(swapped, v3Evidence), /NEXUS_COMMERCIAL_TOURNAMENT_CROSS_TENANT_BASELINE/);
});

test("V4 native engine rejects CANO label even when inherited NEXUS GSC account remains", () => {
  const swapped = clone(fixture);
  swapped.siteId = "cano-penal";
  assert.throws(() => runCommercialDemandTournamentV4(swapped, v3Evidence, v4Evidence), /NEXUS_COMMERCIAL_TOURNAMENT_CROSS_TENANT_BASELINE/);
});

test("native V3/V4 reject relabeled Search Console account and market", () => {
  const gsc = clone(fixture);
  gsc.observedSearch.account = "sc-domain:canopenal.com";
  assert.throws(() => buildCommercialDemandScenarioV3(gsc), /NEXUS_COMMERCIAL_TOURNAMENT_CROSS_TENANT_BASELINE/);
  assert.throws(() => runCommercialDemandTournamentV4(gsc, v3Evidence, v4Evidence), /NEXUS_COMMERCIAL_TOURNAMENT_CROSS_TENANT_BASELINE/);
  const market = clone(fixture);
  market.market.country = "Colombia";
  assert.throws(() => buildCommercialDemandScenarioV3(market), /NEXUS_COMMERCIAL_TOURNAMENT_MARKET_MISMATCH/);
});

test("native V3/V4 preserve the named Nexus-only software tournament", () => {
  assert.equal(buildCommercialDemandScenarioV3(fixture).siteId, "nexus-bot-studio");
  const v3 = runCommercialDemandTournamentV3(fixture, v3Evidence);
  const v4 = runCommercialDemandTournamentV4(fixture, v3Evidence, v4Evidence);
  assert.equal(v3.selectedStrategyId, "SERVICE_FRONTIER_FULL_VALIDATED_32");
  assert.equal(v4.selectedStrategyId, "SOFTWARE_BUYER_FRONTIER_FULL_VALIDATED_36");
  assert.equal(v4.targetSupportVerdict, "EXPAND_VALIDATED_DEMAND_AND_OR_CHANNELS_BEFORE_FLOOR_CLAIM");
});
