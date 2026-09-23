import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const goal=JSON.parse(await readFile(new URL("./organic-goal-v1.json",import.meta.url),"utf8"));
const portfolio=JSON.parse(await readFile(new URL("./organic-keyword-portfolio-v1.json",import.meta.url),"utf8"));
const market=JSON.parse(await readFile(new URL("./organic-public-market-v1.json",import.meta.url),"utf8"));

test("Round 2 portfolio has exactly 42 unique targets split 14 Top3 and 28 Top5",()=>{
  assert.equal(portfolio.keywordCount,42);
  assert.equal(portfolio.keywords.length,42);
  assert.equal(new Set(portfolio.keywords.map(x=>x.id)).size,42);
  assert.equal(new Set(portfolio.keywords.map(x=>x.query)).size,42);
  assert.deepStrictEqual(portfolio.rankBuckets,{TOP3:14,TOP5:28});
});

test("all target ranks and volumes remain unverified rather than fabricated",()=>{
  for(const row of portfolio.keywords){
    assert.equal(row.currentRankStatus,"UNVERIFIED_NO_GSC_OR_SERP_TRACKER");
    assert.equal(row.searchVolumeStatus,"UNVERIFIED_RESEARCH_QUOTA_EXHAUSTED");
  }
});

test("organic business goal is five signed clients monthly, not leads or WhatsApps",()=>{
  assert.equal(goal.acquisitionMode,"ORGANIC_FIRST");
  assert.equal(goal.businessOutcome.minimumPerCalendarMonth,5);
  assert.equal(goal.businessOutcome.leadMetricDoesNotCount,true);
  assert.equal(goal.businessOutcome.whatsappContactDoesNotCount,true);
  assert.equal(goal.certification.repeatabilityEvidence,"3_CONSECUTIVE_MONTHS_AT_OR_ABOVE_TARGET");
});

test("public-search observations explicitly refuse Google rank claims",()=>{
  assert.equal(market.evidenceClass,"PUBLIC_WEB_SEARCH_OBSERVATIONS_NOT_GOOGLE_RANK_TRACKING");
  assert.equal(market.hardLimit,"NO_POSITION_OR_VOLUME_CLAIM_FROM_PUBLIC_WEB_SEARCH");
  assert(market.observations.some(x=>x.id==="O09"&&x.status==="LIMIT"));
});

test("portfolio spans seven intended clusters and maps only Round0 survivor IDs",()=>{
  const clusters=new Set(portfolio.keywords.map(x=>x.clusterId));
  assert.equal(clusters.size,7);
  const survivors=new Set(["S01","S04","S05","S06","S09","S10","S13","S15","S18","S19","S22","S23"]);
  for(const row of portfolio.keywords)for(const id of row.candidateStrategyIds)assert(survivors.has(id));
});
