import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const p=JSON.parse(await readFile(new URL("./round4-live-measurement-protocol-v1.json",import.meta.url),"utf8"));

test("Round 4 cannot start before a WALLE-verified Round 3",()=>{
  assert.equal(p.status,"READY_WHEN_ROUND3_WALLE_PASSES");
  assert.equal(p.inputRequirement,"WALLE_VERIFIED_ROUND3_THREE_FINALISTS");
});
test("winner requires attributable signed clients rather than impressions or leads",()=>{
  assert.equal(p.decisionRules.minimumSignedOrganicClientsPerMonth,5);
  assert(p.winnerBoundary.includes("NO_WINNER_FROM_IMPRESSIONS_ONLY"));
  assert(p.winnerBoundary.includes("NO_WINNER_FROM_WHATSAPP_OR_LEAD_COUNT_ONLY"));
});
test("statistical preference is 99.9 percent confidence with 95 percent power",()=>{
  assert.equal(p.decisionRules.highConfidenceProbability,0.999);
  assert.equal(p.decisionRules.comparisonPower,0.95);
});
test("Search Console average position is not treated as exact Top3 certification",()=>{
  assert.equal(p.googleMeasurement.averagePositionInterpretation,"AGGREGATED_AVERAGE_NOT_FIXED_RANK_CERTIFICATION");
  assert.match(p.googleMeasurement.exactPortfolioRankEvidence,/QUERY_LEVEL/);
});
test("two percent scenario requires 735 organic sessions for 99.9 percent probability of at least five clients",()=>{
  const row=p.scenarioReference.rows.find(x=>x.signedClientRatePercent===2);
  assert.equal(row.sessionsFor99_9ProbabilityOfAtLeast5,735);
});


test("month two and three live operating ramp requires signed clients",()=>{
  assert.equal(p.operatingRamp.month2.minimumSignedOrganicClients,1);
  assert.equal(p.operatingRamp.month2.zeroClientAction,"IMMEDIATE_DIAGNOSIS");
  assert.equal(p.operatingRamp.month3.minimumSignedOrganicClients,1);
  assert.equal(p.operatingRamp.month3.targetSignedOrganicClients,5);
});
