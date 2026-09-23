#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../../gauss/core/common.mjs";
import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { runAxioma } from "../../gauss/axioma/run.mjs";

const here = new URL("./", import.meta.url);
const goalPath = new URL("./organic-goal-v1.json", here);
const portfolioPath = new URL("./organic-keyword-portfolio-v1.json", here);
const marketPath = new URL("./organic-public-market-v1.json", here);

const ROLE = Object.freeze({
  S01:"DIRECT", S04:"DIRECT", S05:"DIRECT_PRODUCT", S06:"SUPPORT_RETENTION",
  S09:"DIRECT", S10:"DIRECT", S13:"SUPPORT_TRUST", S15:"DIRECT_CONVERSION",
  S18:"AUTHORITY_ACQUISITION", S19:"DIRECT_PARTNER", S22:"DIRECT_CONVERSION", S23:"SUPPORT_CONVERSION",
});
const ELIGIBLE = new Set(["DIRECT","DIRECT_PRODUCT","DIRECT_CONVERSION","AUTHORITY_ACQUISITION","DIRECT_PARTNER"]);

function parseArgs(argv) {
  const out={round0:null,round1:null,avengers:null,out:null};
  for(let i=0;i<argv.length;i+=2){
    const arg=argv[i], value=argv[i+1];
    if(!value) throw new Error(`missing value for ${arg}`);
    if(arg==="--round0-report") out.round0=resolve(value);
    else if(arg==="--round1-report") out.round1=resolve(value);
    else if(arg==="--avengers-organic") out.avengers=resolve(value);
    else if(arg==="--out") out.out=resolve(value);
    else throw new Error(`unknown argument:${arg}`);
  }
  if(!out.round0||!out.round1||!out.avengers) throw new Error("ROUND2_INPUTS_REQUIRED");
  return out;
}

function validate(round0,round1,goal,portfolio,market,avengers){
  assert.equal(round0.status,"PASS");
  assert.equal(round0.structuralShortlistCount,12);
  assert.equal(round0.avengers.moduleCount,2500);
  assert.equal(round0.avengers.errorCount,0);
  assert.equal(round1.status,"PASS_WITH_ONE_UNRESOLVED_SLOT");
  assert.equal(round1.round0ReportSha256,round0.reportSha256);
  assert.equal(goal.goalId,"CANO_ORGANIC_CLIENT_ENGINE_V1");
  assert.equal(goal.acquisitionMode,"ORGANIC_FIRST");
  assert.equal(goal.businessOutcome.minimumPerCalendarMonth,5);
  assert.equal(goal.certification.repeatabilityEvidence,"3_CONSECUTIVE_MONTHS_AT_OR_ABOVE_TARGET");
  assert.equal(portfolio.portfolioId,"CANO_ORGANIC_KEYWORD_PORTFOLIO_V1");
  assert.equal(portfolio.keywordCount,42);
  assert.equal(portfolio.rankBuckets.TOP3,14);
  assert.equal(portfolio.rankBuckets.TOP5,28);
  assert.equal(portfolio.keywords.length,42);
  assert.equal(new Set(portfolio.keywords.map(x=>x.id)).size,42);
  for(const row of portfolio.keywords){
    assert.equal(row.currentRankStatus,"UNVERIFIED_NO_GSC_OR_SERP_TRACKER");
    assert.equal(row.searchVolumeStatus,"UNVERIFIED_RESEARCH_QUOTA_EXHAUSTED");
  }
  assert.equal(market.evidenceId,"CANO_ORGANIC_PUBLIC_MARKET_V1");
  assert.equal(market.hardLimit,"NO_POSITION_OR_VOLUME_CLAIM_FROM_PUBLIC_WEB_SEARCH");
  assert.equal(avengers.engineId,"SEO_AVENGERS_1500_CANO_ROUND2_ORGANIC");
  assert.equal(avengers.moduleCount,1500);
  assert.equal(avengers.errorCount,0);
  assert.equal(avengers.currentRankClaim,"FORBIDDEN");
  return round0.structuralShortlistIds;
}

function buildMetrics(shortlist, portfolio){
  const eligibleIds=shortlist.filter(id=>ELIGIBLE.has(ROLE[id]));
  const byId=new Map(shortlist.map(id=>[id,{id,role:ROLE[id],target:[],top3:0,top5:0,bofu:0,clusters:new Set()}]));
  for(const q of portfolio.keywords){
    for(const id of q.candidateStrategyIds){
      const m=byId.get(id);
      if(!m) continue;
      m.target.push(q.id);
      if(q.targetRankBucket==="TOP3")m.top3++;else m.top5++;
      if(q.funnelStage==="BOFU")m.bofu++;
      m.clusters.add(q.clusterId);
    }
  }
  for(const id of eligibleIds){
    const m=byId.get(id);
    m.unique=m.target.filter(qid=>{
      const q=portfolio.keywords.find(x=>x.id===qid);
      return q.candidateStrategyIds.filter(cid=>eligibleIds.includes(cid)).length===1;
    }).length;
    const existing=["S01","S15","S22"].includes(id)?1:0;
    const ops=["S05","S18","S19"].includes(id)?1:0;
    m.value=6*m.top3+3*m.bofu+2*m.clusters.size+m.target.length+4*m.unique+3*existing-2*ops;
  }
  return {
    eligibleIds,
    rows:shortlist.map(id=>{
      const m=byId.get(id);
      return {
        id,role:m.role,directOrganicEligible:eligibleIds.includes(id),
        targetQueryCount:m.target.length,targetQueryIds:m.target,
        top3TargetCount:m.top3,top5TargetCount:m.top5,bofuTargetCount:m.bofu,
        clusterCount:m.clusters.size,clusterIds:[...m.clusters].sort(),
        uniqueEligibleQueryCount:m.unique??0,organicValue:m.value??0,
      };
    })
  };
}

function buildProblem(metrics){
  const rows=metrics.rows.filter(x=>x.directOrganicEligible);
  const n=rows.length,k=6,A=1,B=8,C=200;
  assert(n>=6&&n<=12);
  const overlap=(i,j)=>{
    const a=new Set(rows[i].targetQueryIds);
    return rows[j].targetQueryIds.filter(id=>a.has(id)).length;
  };
  const points=metrics.rows.map(r=>({id:r.id,values:[r.top3TargetCount,r.targetQueryCount,r.bofuTargetCount,r.uniqueEligibleQueryCount,r.directOrganicEligible?0:1]}));
  const fields=rows.map((r,i)=>{
    let sum=0;for(let j=0;j<n;j++)if(i!==j)sum+=overlap(Math.min(i,j),Math.max(i,j));
    return (-A*r.organicValue/2)+(B*sum/4)+(C*(n-2*k)/2);
  });
  const couplings=[];let overlapSum=0;
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const ov=overlap(i,j);overlapSum+=ov;
    couplings.push({i,j,value:(B*ov/4)+(C/2)});
  }
  const sumValue=rows.reduce((s,r)=>s+r.organicValue,0),d=n-2*k;
  const offset=(-A*sumValue/2)+(B*overlapSum/4)+(C*(n+d*d)/4);
  return {
    rows,
    problem:{
      schemaVersion:1,
      problemId:"cano-penal-cdmx-round2-organic-v1",
      objective:"Select exactly six organic-first semifinalists from the 12 structural survivors using target-query coverage and overlap penalties. No ranking or client forecast.",
      tasks:[
        {taskId:"round2-organic-pareto",layerId:"GAUSS.MATH.PARETO.002",input:{points,objectives:["MAX","MAX","MAX","MAX","MIN"]}},
        {taskId:"round2-organic-ising",layerId:"GAUSS.PHYSICS.ISING_EXACT_GROUND.003",input:{fields,couplings,offset}},
      ],
    }
  };
}

function axiomaSummary(report){
  assert.equal(report.registryOperators,1000);
  assert.equal(report.coveredOperators,1000);
  assert.equal(report.untestedOperators,0);
  assert.equal(report.failedValidCases,0);
  assert.equal(report.failedInvalidRejections,0);
  const ids=new Set();
  for(const suite of report.suites)for(const row of suite.operatorResults){
    if(["GAUSS.MATH.PARETO.002","GAUSS.PHYSICS.ISING_EXACT_GROUND.003"].includes(row.id))ids.add(row.id);
  }
  assert.equal(ids.size,2);
  return {registryOperators:1000,coveredOperators:1000,untestedOperators:0,targetedOperatorIds:[...ids].sort()};
}

export async function runCanoRound2({round0Report,round1Report,goal,portfolio,market,avengersOrganic}){
  const shortlist=validate(round0Report,round1Report,goal,portfolio,market,avengersOrganic);
  const metrics=buildMetrics(shortlist,portfolio);
  const {rows,problem}=buildProblem(metrics);
  const [gauss,axioma]=await Promise.all([
    executeGaussProblem(problem,{quantumContributor:contributeNexusQuantum}),
    Promise.resolve().then(()=>runAxioma()),
  ]);
  assert.equal(gauss.status,"PASS");
  assert.equal(gauss.quantumContribution?.status,"EXECUTED");
  assert.equal(gauss.quantumContribution?.simulation?.verdict,"PASS");
  assert.equal(gauss.quantumContribution?.simulation?.hardwareExecution,false);
  assert.equal(gauss.quantumContribution?.simulation?.quantumAdvantageClaimAllowed,false);
  const pareto=gauss.taskResults.find(x=>x.taskId==="round2-organic-pareto");
  const ising=gauss.taskResults.find(x=>x.taskId==="round2-organic-ising");
  assert.equal(pareto?.status,"EXECUTED");
  assert.equal(ising?.status,"EXECUTED");
  const semifinalistIds=rows.filter((_,i)=>ising.output.spins[i]===1).map(x=>x.id);
  assert.equal(semifinalistIds.length,6,`expected six semifinalists, got ${semifinalistIds.length}`);
  const queryIds=new Set();
  for(const m of metrics.rows.filter(x=>semifinalistIds.includes(x.id)))for(const id of m.targetQueryIds)queryIds.add(id);
  const top3=portfolio.keywords.filter(x=>queryIds.has(x.id)&&x.targetRankBucket==="TOP3").length;
  const top5=portfolio.keywords.filter(x=>queryIds.has(x.id)&&x.targetRankBucket==="TOP5").length;
  const unsigned={
    schemaVersion:1,tournamentId:"CANO_PENAL_CDMX_ZERO",stage:"ROUND_2_ORGANIC_PORTFOLIO",
    status:"PASS_STRUCTURAL_SEMIFINALISTS_NO_RANK_OR_CLIENT_CLAIM",
    objectiveReset:"ORGANIC_FIRST_FROM_ROUND2_REEVALUATES_ALL_12_ROUND0_SURVIVORS",
    goalId:goal.goalId,minimumSignedOrganicClientsPerMonth:5,repeatabilityTarget:goal.certification.repeatabilityEvidence,
    keywordPortfolio:{portfolioId:portfolio.portfolioId,targetQueryCount:42,targetTop3Count:14,targetTop5Count:28,currentRankEvidenceStatus:"INSUFFICIENT_DATA_NO_GSC_OR_AUTHORIZED_SERP_TRACKER",searchVolumeEvidenceStatus:"INSUFFICIENT_DATA_RESEARCH_QUOTA_EXHAUSTED"},
    candidateMetrics:metrics.rows,eligibleCandidateIds:metrics.eligibleIds,semifinalistIds,semifinalistCount:6,
    semifinalTargetCoverage:{queryCount:queryIds.size,top3TargetCount:top3,top5TargetCount:top5},
    sharedSupportStrategyIds:metrics.rows.filter(x=>!x.directOrganicEligible).map(x=>x.id),
    gauss:{engineId:gauss.engineId,status:gauss.status,reportSha256:gauss.reportSha256,paretoFrontierIds:[...(pareto.output?.frontierIds??[])].sort(),paretoDominatedIds:[...(pareto.output?.dominatedIds??[])].sort(),exactIsingEnergy:ising.output.energy,exactIsingEvaluatedStates:ising.output.evaluatedStates,interpretation:"STRUCTURAL_ORGANIC_PORTFOLIO_OPTIMIZATION_NOT_RANKING_OR_REVENUE_FORECAST"},
    quantum:{engineId:gauss.quantumContribution.engineId,status:gauss.quantumContribution.status,sourceTaskId:gauss.quantumContribution.sourceTaskId,simulationReceiptSha256:gauss.quantumContribution.simulation.receiptSha256,hardwareExecution:false,quantumAdvantageClaimAllowed:false,interpretation:"BOUNDED_ISING_PORTFOLIO_RECEIPT_ONLY"},
    axioma:axiomaSummary(axioma),
    avengers:{baselineAll2500FromRound0:true,baselineModuleCount:round0Report.avengers.moduleCount,baselineErrorCount:round0Report.avengers.errorCount,organicDeepEngineId:avengersOrganic.engineId,organicDeepModuleRange:avengersOrganic.moduleRange,organicDeepModuleCount:1500,organicDeepSuccessCount:avengersOrganic.successCount,organicDeepInsufficientDataCount:avengersOrganic.insufficientDataCount,organicDeepErrorCount:0,organicDeepSummarySha256:avengersOrganic.summarySha256,interpretation:"ALL_2500_PARTICIPATED_IN_BASELINE; M1001_M2500_RECEIVED_ROUND2_PORTFOLIO_AND_PUBLIC_CONTENT_EVIDENCE"},
    selectedStrategyId:null,commercialWinnerStatus:"NOT_YET_ELIGIBLE",organicClientOutcomeStatus:"INSUFFICIENT_DATA_NO_ATTRIBUTED_SIGNED_CLIENT_LEDGER",
    nextStage:"ROUND_3_QUERY_TO_ASSET_ARCHITECTURE_FOR_SIX_SEMIFINALISTS",
    decisionBoundary:"NO_PRODUCTION_MUTATION_NO_RANKING_GUARANTEE_NO_5_CLIENT_FORECAST_NO_PAID_DEPENDENCY",
  };
  return Object.freeze({...unsigned,reportSha256:sha256Canonical(unsigned)});
}

async function main(argv){
  const args=parseArgs(argv);
  const [r0,r1,g,p,m,a]=await Promise.all([readFile(args.round0),readFile(args.round1),readFile(goalPath),readFile(portfolioPath),readFile(marketPath),readFile(args.avengers)]);
  const report=await runCanoRound2({round0Report:JSON.parse(r0),round1Report:JSON.parse(r1),goal:JSON.parse(g),portfolio:JSON.parse(p),market:JSON.parse(m),avengersOrganic:JSON.parse(a)});
  const out=`${JSON.stringify(report,null,2)}\n`;
  if(args.out)await writeFile(args.out,out);else process.stdout.write(out);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{console.error(e?.stack??String(e));process.exitCode=1;});
