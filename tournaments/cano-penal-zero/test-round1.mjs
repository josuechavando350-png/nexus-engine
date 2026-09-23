import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildStrategyField, structuralShortlist } from "./strategy-field.mjs";

const audit = JSON.parse(await readFile(new URL("./audit-evidence.json", import.meta.url), "utf8"));
const adsBytes = await readFile(new URL("./ads-evidence-v1.json", import.meta.url));
const ads = JSON.parse(adsBytes.toString("utf8"));
const adsManifest = JSON.parse(await readFile(new URL("./ads-evidence-manifest-v1.json", import.meta.url), "utf8"));

test("Google Ads snapshot is byte-bound and explicitly read-only", () => {
  const digest = `sha256:${createHash("sha256").update(adsBytes).digest("hex")}`;
  assert.equal(adsManifest.evidenceSha256, digest);
  assert.equal(ads.source.accessMode, "READ_ONLY_CONNECTED_ACCOUNT");
  assert.equal(ads.source.providerReplayInCi, false);
  assert(ads.interpretationBoundaries.includes("NO_BID_OR_BUDGET_CHANGE_AUTHORIZED"));
});

test("campaign metrics preserve primary conversion semantics instead of treating all conversions as leads", () => {
  assert.equal(ads.campaign90d.clicks, 2841);
  assert.equal(ads.campaign90d.primaryConversions, 2);
  assert.equal(ads.campaign90d.allConversions, 2160);
  assert.equal(ads.primaryConversionSemantics.observedPrimaryActions90d.length, 1);
  assert.equal(ads.primaryConversionSemantics.observedPrimaryActions90d[0].action, "WhatsApp - canopenal");
  assert.equal(ads.primaryConversionSemantics.observedPrimaryActions90d[0].primaryConversions, 2);
});

test("observed broad-keyword and institutional leakage is explicit and has zero primary conversions", () => {
  assert.equal(ads.broadKeywordConcentration90d.combinedPrimaryConversions, 0);
  assert(ads.broadKeywordConcentration90d.shareOfCampaignCostPpm > 900000);
  assert.equal(ads.institutionalLeakage90d.fiscaliaTerms.primaryConversions, 0);
  assert.equal(ads.institutionalLeakage90d.ministerioPublicoTerms.primaryConversions, 0);
  assert.equal(ads.institutionalLeakage90d.configuredPositiveCriterion.keyword, "ministerio público");
  assert.equal(ads.institutionalLeakage90d.configuredPositiveCriterion.matchType, "BROAD");
});

test("current campaign does not get misread as proof of total penal-fiscal demand", () => {
  const taxRows = ads.intentSlices90d.trueTaxFiscalObservedTerms;
  assert.equal(taxRows.reduce((sum, row) => sum + row.impressions, 0), 2);
  assert.equal(taxRows.reduce((sum, row) => sum + row.clicks, 0), 0);
  assert(ads.interpretationBoundaries.includes("CURRENT_CAMPAIGN_EXPOSURE_IS_NOT_TOTAL_MARKET_DEMAND"));
  assert(ads.interpretationBoundaries.includes("TINY_PENAL_FISCAL_EXPOSURE_DOES_NOT_PROVE_TINY_PENAL_FISCAL_MARKET"));
});

test("Round 1 receives the exact twelve structural survivors from canonical strategy field", () => {
  const field = buildStrategyField(audit);
  const ids = structuralShortlist([...field]).map((row) => row.id);
  assert.deepStrictEqual(ids, ["S01","S04","S05","S06","S09","S10","S13","S15","S18","S19","S22","S23"]);
});

test("all active Search ad rows reconcile to the campaign and point to the homepage", () => {
  const rows = ads.adDestinations90d.activeCampaignAdRows;
  assert.equal(ads.adDestinations90d.allActiveSearchAdFinalUrlsAreHomepage, true);
  assert(rows.every((row) => row.finalUrls.length === 1 && row.finalUrls[0] === "https://www.canopenal.com/"));
  assert.equal(rows.reduce((sum, row) => sum + row.clicks, 0), ads.campaign90d.clicks);
  assert.equal(rows.reduce((sum, row) => sum + row.impressions, 0), ads.campaign90d.impressions);
  assert.equal(rows.reduce((sum, row) => sum + row.costMxnMicros, 0), ads.campaign90d.costMxnMicros);
  assert.equal(rows.reduce((sum, row) => sum + row.primaryConversions, 0), ads.campaign90d.primaryConversions);
});
