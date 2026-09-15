import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildOpportunityPrioritizationReport } from "../opportunity-prioritization/prioritization-engine.mjs";

function cmp(a,b){return a<b?-1:a>b?1:0}
function canon(v){if(v===null||typeof v==="boolean"||typeof v==="string")return JSON.stringify(typeof v==="string"?v.normalize("NFC"):v);if(typeof v==="number"){if(!Number.isSafeInteger(v))throw new TypeError("safe int");return String(v)}if(Array.isArray(v))return`[${v.map(canon).join(",")}]`;if(v&&typeof v==="object"){const e=Object.entries(v).map(([k,x])=>[k.normalize("NFC"),x]).sort(([a],[b])=>cmp(a,b));const s=new Set;return`{${e.map(([k,x])=>{if(s.has(k))throw new Error("collision");s.add(k);return`${JSON.stringify(k)}:${canon(x)}`}).join(",")}}`}throw new Error("json")}
function sha(v){return`sha256:${createHash("sha256").update(Buffer.from(canon(v),"utf8")).digest("hex")}`}

const growth={schema_version:1,profile_id:"growth-test",provenance:"synthetic explicit CTR assumptions; not Google constants",click_to_session_ppm:800000,organic_funnel_source_ids:["organic"],scenarios:[
 {scenario_id:"CONSERVATIVE",target_ctr_ppm:{TOP_10:80000,TOP_3:120000,TOP_1:180000}},
 {scenario_id:"BASE",target_ctr_ppm:{TOP_10:100000,TOP_3:160000,TOP_1:240000}},
 {scenario_id:"UPSIDE",target_ctr_ppm:{TOP_10:120000,TOP_3:200000,TOP_1:300000}},
]};
const funnel=[{source_id:"organic",sessions:1000,lead_conversion_ppm:200000,close_rate_ppm:250000,average_ticket_micros:5000000000}];
const profile={schema_version:1,profile_id:"pareto-test",provenance:"synthetic deterministic multi-objective policy",scenario_id:"BASE",economic_objective:"INCREMENTAL_REVENUE_MICROS",minimum_feasibility_band:"MEDIUM",target_selection_policy:"HARDEST_UNACHIEVED_AT_OR_ABOVE_MINIMUM_FEASIBILITY",within_frontier_tie_break_policy:"ECONOMIC_THEN_FEASIBILITY_THEN_MOMENTUM_THEN_COMPETITION_THEN_IDENTITY",require_momentum_evidence:true,require_competition_evidence:true,require_positive_incremental_value:true,maximum_candidates:100,max_results:100};

function target(id,max,observed,impressions,band){return{rankTarget:id,targetPositionMaxMilli:max,observedPositionMilli:observed,gapMilli:Math.max(0,observed-max),feasibilityBand:band,evidenceStatus:"SUFFICIENT_FOR_RULE_EVALUATION",minimumImpressions:100,observedImpressions:impressions}}
function opportunity(query,{position=12000,clicks=30,impressions=1000,top10="HIGH",top3="MEDIUM",top1="LOW",momentum="STABLE",competition="MEDIUM"}={}){return{query,pageUrl:`/${query}`,observed:{clicks,impressions,ctrPpm:Math.floor(clicks*1e6/impressions),averagePositionMilli:position,sourceRowCount:1},targets:[target("TOP_10",10000,position,impressions,position<=10000?"ACHIEVED":top10),target("TOP_3",3000,position,impressions,position<=3000?"ACHIEVED":top3),target("TOP_1",1000,position,impressions,position<=1000?"ACHIEVED":top1)],momentum:{query,pageUrl:`/${query}`,momentumBand:momentum,evidenceStatus:momentum==="INSUFFICIENT_DATA"?"NO_MATCHING_HISTORY":"SUFFICIENT_FOR_TREND_EVALUATION"},competition:{keywordIdentity:query,competitionBand:competition,evidenceStatus:competition==="INSUFFICIENT_DATA"?"NO_MATCHING_COMPETITION_RECORD":"SUFFICIENT_FOR_RULE_EVALUATION"}}}
function rankReport(ops){const unsigned={schemaVersion:1,engineId:"WALLE_RANK_CONTEXT_AUTHORITY_V1",status:"RANK_CONTEXT_READY",interpretation:"RULE_BOUND_SEARCH_TREND_COMPETITION_AND_INTERNAL_AUTHORITY_CONTEXT_NOT_PROBABILITY",rankCompetitionReportSha256:"sha256:"+"2".repeat(64),authorityReportSha256:"sha256:"+"3".repeat(64),summary:{},opportunities:ops,authority:{status:"AUTHORITY_READY",authorityStrength:"MODERATE",topicCount:3,sourceAssessmentStatus:"READY",componentAverages:{coveragePpm:500000,intentCoveragePpm:500000,primaryEvidencePpm:500000,cohesionPpm:500000,centralityPpm:500000,authorityPpm:500000}},decisionBoundary:"AUTHORITY_CONTEXT_ONLY_DOES_NOT_UPGRADE_OR_DOWNGRADE_FEASIBILITY_BAND",warnings:["NO_RANK_GUARANTEE","NO_PROBABILITY_CLAIM"]};return{...unsigned,reportSha256:sha(unsigned)}}

function run(ops,p=profile){return buildOpportunityPrioritizationReport({rankAuthorityReport:rankReport(ops),revenueFunnelRecords:funnel,growthAssumptionProfile:growth,prioritizationProfile:p})}

test("no hidden weighted score appears in output",()=>{const r=run([opportunity("alpha")]);assert.equal(r.status,"PRIORITIZATION_READY");assert.equal(JSON.stringify(r).includes("priorityScorePpm"),false);assert.equal(r.decisionBoundary,"NO_HIDDEN_WEIGHTED_SCORE_AUTHORITY_REMAINS_GLOBAL_CONTEXT_WITHOUT_QUERY_TOPIC_MAPPING")});

test("hardest eligible unachieved target is selected",()=>{const r=run([opportunity("alpha",{top1:"LOW",top3:"HIGH",top10:"HIGH"})]);assert.equal(r.opportunities[0].selectedTarget.rankTarget,"TOP_3")});

test("authority remains global context and never becomes query objective",()=>{const r=run([opportunity("alpha")]);assert.equal(r.authorityContext.authorityStrength,"MODERATE");assert.equal(Object.hasOwn(r.opportunities[0],"authority"),false);assert.equal(Object.hasOwn(r.opportunities[0].objectiveVector,"authorityOrdinal"),false)});

test("Pareto dominance creates explicit layers without scalar weights",()=>{const a=opportunity("alpha",{impressions:2000,clicks:20,top1:"HIGH",momentum:"IMPROVING",competition:"LOW"});const b=opportunity("beta",{impressions:800,clicks:20,top1:"MEDIUM",momentum:"STABLE",competition:"MEDIUM"});const r=run([a,b]);const A=r.opportunities.find(x=>x.query==="alpha"),B=r.opportunities.find(x=>x.query==="beta");assert.equal(A.paretoLayer,1);assert.ok(B.paretoLayer>=1);assert.ok(A.priorityRank<B.priorityRank)});

test("tradeoffs can coexist on Pareto frontier",()=>{const economic=opportunity("economic",{impressions:3000,clicks:10,top1:"MEDIUM",momentum:"STABLE",competition:"MEDIUM"});const easy=opportunity("easy",{impressions:800,clicks:10,top1:"HIGH",momentum:"IMPROVING",competition:"LOW"});const r=run([economic,easy]);assert.equal(r.summary.paretoFrontierCount,2);assert.ok(r.opportunities.every(x=>x.paretoLayer===1))});

test("missing momentum is explicit ineligible when required",()=>{const r=run([opportunity("alpha",{momentum:"INSUFFICIENT_DATA"})]);assert.equal(r.status,"INSUFFICIENT_DATA");assert.equal(r.summary.ineligibleReasonCounts.MOMENTUM_EVIDENCE_REQUIRED,1)});

test("missing competition is explicit ineligible when required",()=>{const r=run([opportunity("alpha",{competition:"INSUFFICIENT_DATA"})]);assert.equal(r.status,"INSUFFICIENT_DATA");assert.equal(r.summary.ineligibleReasonCounts.COMPETITION_EVIDENCE_REQUIRED,1)});

test("zero incremental economic upside is not promoted",()=>{const highClicks=opportunity("alpha",{clicks:900,impressions:1000,top1:"HIGH"});const r=run([highClicks]);assert.equal(r.status,"INSUFFICIENT_DATA");assert.equal(r.summary.ineligibleReasonCounts.NON_POSITIVE_INCREMENTAL_OBJECTIVE,1)});

test("max_results truncation is explicit and hash-bound",()=>{const p={...profile,max_results:1};const r=run([opportunity("alpha"),opportunity("beta",{impressions:1100})],p);assert.equal(r.summary.returnedCount,1);assert.equal(r.summary.truncatedByExplicitMaxResults,true);assert.match(r.summary.fullCandidateSetSha256,/^sha256:[0-9a-f]{64}$/);assert.match(r.summary.returnedSetSha256,/^sha256:[0-9a-f]{64}$/)});

test("candidate count over explicit bound fails closed",()=>{const p={...profile,maximum_candidates:1,max_results:1};assert.throws(()=>run([opportunity("alpha"),opportunity("beta")],p),/maximum_candidates/)});

test("tampered rank report hash fails closed",()=>{const rr=rankReport([opportunity("alpha")]);rr.opportunities[0].observed.impressions=999;assert.throws(()=>buildOpportunityPrioritizationReport({rankAuthorityReport:rr,revenueFunnelRecords:funnel,growthAssumptionProfile:growth,prioritizationProfile:profile}),/hash mismatch/)});

test("query-level authority injection is forbidden",()=>{const o=opportunity("alpha");o.authority={strength:"STRONG"};const rr=rankReport([o]);assert.throws(()=>buildOpportunityPrioritizationReport({rankAuthorityReport:rr,revenueFunnelRecords:funnel,growthAssumptionProfile:growth,prioritizationProfile:profile}),/query-level authority is forbidden/)});

test("priority candidate set is deterministic while preserving parent provenance binding",()=>{const ops=[opportunity("zeta",{impressions:900}),opportunity("alpha",{impressions:1200}),opportunity("beta",{impressions:1000})];const a=run(ops),b=run([...ops].reverse());assert.deepEqual(a.opportunities,b.opportunities);assert.equal(a.summary.fullCandidateSetSha256,b.summary.fullCandidateSetSha256);assert.equal(a.summary.returnedSetSha256,b.summary.returnedSetSha256);assert.notEqual(a.rankAuthorityReportSha256,b.rankAuthorityReportSha256);assert.notEqual(a.reportSha256,b.reportSha256)});

test("profile policy changes alter report hash",()=>{const a=run([opportunity("alpha")]);const b=run([opportunity("alpha")],{...profile,economic_objective:"INCREMENTAL_CLIENTS_MILLI"});assert.notEqual(a.prioritizationProfile.sha256,b.prioritizationProfile.sha256);assert.notEqual(a.reportSha256,b.reportSha256)});

test("hard limit of 2000 candidates completes with explicit Pareto layers and no silent truncation",()=>{
  const ops=Array.from({length:2000},(_,i)=>opportunity(`q${String(i).padStart(4,"0")}`,{impressions:1000+i,clicks:10}));
  const p={...profile,maximum_candidates:2000,max_results:5};
  const r=run(ops,p);
  assert.equal(r.summary.eligibleCandidateCount,2000);
  assert.equal(r.summary.returnedCount,5);
  assert.equal(r.summary.truncatedByExplicitMaxResults,true);
  assert.equal(r.opportunities[0].paretoLayer,1);
  assert.equal(r.summary.paretoLayerCount,2000);
});

test("malformed funnel fails closed even when no opportunity is eligible",()=>{
  const rr=rankReport([opportunity("alpha",{top10:"LOW",top3:"LOW",top1:"LOW"})]);
  const bad=[{...funnel[0],lead_conversion_ppm:200000.5}];
  assert.throws(()=>buildOpportunityPrioritizationReport({rankAuthorityReport:rr,revenueFunnelRecords:bad,growthAssumptionProfile:growth,prioritizationProfile:profile}),/integer in range/);
});

test("malformed growth profile fails closed even when no opportunity is eligible",()=>{
  const rr=rankReport([opportunity("alpha",{top10:"LOW",top3:"LOW",top1:"LOW"})]);
  const bad={...growth,magic_google_ctr:123};
  assert.throws(()=>buildOpportunityPrioritizationReport({rankAuthorityReport:rr,revenueFunnelRecords:funnel,growthAssumptionProfile:bad,prioritizationProfile:profile}),/unexpected growth assumption profile keys/);
});

test("normalized growth and funnel evidence are explicitly hash-bound",()=>{
  const r=run([opportunity("alpha")]);
  assert.match(r.growthAssumptionProfileSha256,/^sha256:[0-9a-f]{64}$/);
  assert.match(r.normalizedRevenueFunnelRecordsSha256,/^sha256:[0-9a-f]{64}$/);
  const changed=buildOpportunityPrioritizationReport({rankAuthorityReport:rankReport([opportunity("alpha")]),revenueFunnelRecords:[{...funnel[0],average_ticket_micros:6000000000}],growthAssumptionProfile:growth,prioritizationProfile:profile});
  assert.notEqual(r.normalizedRevenueFunnelRecordsSha256,changed.normalizedRevenueFunnelRecordsSha256);
  assert.notEqual(r.reportSha256,changed.reportSha256);
});

test("contradictory target observed position fails closed",()=>{
  const o=opportunity("alpha");
  o.targets[0].observedPositionMilli=999999;
  const rr=rankReport([o]);
  assert.throws(()=>buildOpportunityPrioritizationReport({rankAuthorityReport:rr,revenueFunnelRecords:funnel,growthAssumptionProfile:growth,prioritizationProfile:profile}),/target observed position mismatch/);
});

test("evaluated momentum cannot carry insufficient evidence status",()=>{
  const o=opportunity("alpha");
  o.momentum.evidenceStatus="NO_MATCHING_HISTORY";
  const rr=rankReport([o]);
  assert.throws(()=>buildOpportunityPrioritizationReport({rankAuthorityReport:rr,revenueFunnelRecords:funnel,growthAssumptionProfile:growth,prioritizationProfile:profile}),/evaluated momentum requires sufficient evidence/);
});

test("evaluated competition cannot carry insufficient evidence status",()=>{
  const o=opportunity("alpha");
  o.competition.evidenceStatus="NO_MATCHING_COMPETITION_RECORD";
  const rr=rankReport([o]);
  assert.throws(()=>buildOpportunityPrioritizationReport({rankAuthorityReport:rr,revenueFunnelRecords:funnel,growthAssumptionProfile:growth,prioritizationProfile:profile}),/evaluated competition requires sufficient evidence/);
});
