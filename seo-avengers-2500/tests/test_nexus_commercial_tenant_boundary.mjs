import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertTournamentTenantEvidenceBoundary } from "../commercial-demand/tenant-evidence-boundary.mjs";

const fixture = JSON.parse(await readFile(fileURLToPath(new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url)), "utf8"));
const manifest = JSON.parse(await readFile(fileURLToPath(new URL("../commercial-demand/nexus-commercial-demand-v2.tenant-manifest.json", import.meta.url)), "utf8"));
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
