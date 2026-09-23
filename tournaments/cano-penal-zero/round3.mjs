#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../../gauss/core/common.mjs";
import { executeGaussProblem } from "../../gauss/core/problem.mjs";
import { contributeNexusQuantum } from "../../gauss/core/quantum-contributor.mjs";
import { runAxioma } from "../../gauss/axioma/run.mjs";

const here=new URL("./",import.meta.url);
const portfolioPath=new URL("./organic-keyword-portfolio-v1.json",here);
const planPath=new URL("./round3-architecture-plan-v1.json",here);

function parseArgs(argv){
  const out={round2:null,out:null};
  for(let i=0;i<argv.length;i+=2){
    const arg=argv[i],value=argv[i+1];
    if(!value)throw new Error(`missing value for ${arg}`);
    if(arg==="--round2-report")out.round2=resolve(value);
    else if(arg==="--out")out.out=resolve(value);
    else throw new Error(`unknown argument:${arg}`);
  }
  if(!out.round2)throw new Error("ROUND2_REPORT_REQUIRED");
  return out;
}

function validate(round2,portfolio,plan){
  assert.equal(round2.stage,"ROUND_2_ORGANIC_PORTFOLIO");
  assert.equal(round2.status,"PASS_STRUCTURAL_SEMIFINALISTS_NO_RANK_OR_CLIENT_CLAIM");
  assert.equal(round2.semifinalistCount,6);
  assert.deepStrictEqual(round2.semifinalistIds,plan.semifinalistInputIds);
  assert.equal(portfolio.keywordCount,42);
  assert.equal(plan.status,"PROPOSED_NOT_LIVE");
  assert.equal(plan.architectures.length,6);
  assert.equal(plan.globalRequirements.noProductionMutation,true);
  assert.equal(new Set(plan.architectures.map(x=>x.strategyId)).size,6);
  const qids=new Set(portfolio.keywords.map(x=>x.id));
  for(const arch of plan.architectures){
    assert(plan.semifinalistInputIds.includes(arch.strategyId));
    assert(Array.isArray(arch.targetQueryIds)&&arch.targetQueryIds.length>0);
    for(const id of arch.targetQueryIds)assert(qids.has(id),`unknown query id:${arch.strategyId}:${id}`);
    assert.equal(typeof arch.conversionPath,"string");
    assert(Array.isArray(arch.internalLinkPlan)&&arch.internalLinkPlan.length>0);
    assert(Array.isArray(arch.boundaries)&&arch.boundaries.length>0);
  }
}

function metrics(portfolio,plan){
  const six=plan.semifinalistInputIds;
  const leverage={S01:3,S04:2,S05:0,S09:1,S10:2,S15:2};
  return plan.architectures.map(arch=>{
    const qs=portfolio.keywords.filter(q=>arch.targetQueryIds.includes(q.id));
    const unique=qs.filter(q=>q.candidateStrategyIds.filter(id=>six.includes(id)).length===1).length;
    const top3=qs.filter(q=>q.targetRankBucket==="TOP3").length;
    const top5=qs.filter(q=>q.targetRankBucket==="TOP5").length;
    const bofu=qs.filter(q=>q.funnelStage==="BOFU").length;
    const newAssets=[arch.primaryAsset,...arch.supportingAssets].filter(x=>x.mode.startsWith("PROPOSED_NEW")||x.mode==="PROPOSED_DISTINCT_INTENT").length;
    const value=8*top3+4*bofu+2*unique+qs.length+3*leverage[arch.strategyId]-2*newAssets;
    return Object.freeze({
      id:arch.strategyId,name:arch.name,targetQueryCount:qs.length,top3TargetCount:top3,top5TargetCount:top5,
      bofuTargetCount:bofu,uniqueSemifinalQueryCount:unique,newAssetCount:newAssets,currentAssetLeverage:leverage[arch.strategyId],architectureValue:value,
      targetQueryIds:Object.freeze([...arch.targetQueryIds]),primaryAsset:arch.primaryAsset,
    });
  });
}

function problem(rows){
  const n=rows.length,k=3,A=1,B=10,C=300;
  const qsets=Object.fromEntries(rows.map(r=>[r.id,new Set(r.targetQueryIds)]));
  const overlap=(i,j)=>{let count=0;for(const id of qsets[rows[i].id])if(qsets[rows[j].id].has(id))count++;return count;};
  const points=rows.map(r=>({id:r.id,values:[r.top3TargetCount,r.bofuTargetCount,r.uniqueSemifinalQueryCount,r.targetQueryCount,r.newAssetCount]}));
  const fields=rows.map((r,i)=>{
    let overlapSum=0;for(let j=0;j<n;j++)if(i!==j)overlapSum+=overlap(Math.min(i,j),Math.max(i,j));
    return (-A*r.architectureValue/2)+(B*overlapSum/4)+(C*(n-2*k)/2);
  });
  const couplings=[];let totalOverlap=0;
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const ov=overlap(i,j);totalOverlap+=ov;couplings.push({i,j,value:(B*ov/4)+(C/2)});
  }
  const sumValue=rows.reduce((s,r)=>s+r.architectureValue,0),d=n-2*k;
  const offset=(-A*sumValue/2)+(B*totalOverlap/4)+(C*(n+d*d)/4);
  return Object.freeze({
    schemaVersion:1,problemId:"cano-round3-architecture-v1",
    objective:"Select exactly three proposed organic architectures from six semifinalists using Top3/BOFU/unique-query coverage, current-asset leverage and build cost while penalizing query overlap. No rank or client forecast.",
    tasks:[
      {taskId:"round3-architecture-pareto",layerId:"GAUSS.MATH.PARETO.002",input:{points,objectives:["MAX","MAX","MAX","MAX","MIN"]}},
      {taskId:"round3-architecture-ising",layerId:"GAUSS.PHYSICS.ISING_EXACT_GROUND.003",input:{fields,couplings,offset}},
    ],
  });
}

function axiomaSummary(report){
  assert.equal(report.registryOperators,1000);assert.equal(report.coveredOperators,1000);assert.equal(report.untestedOperators,0);
  assert.equal(report.failedValidCases,0);assert.equal(report.failedInvalidRejections,0);
  const ids=new Set();
  for(const suite of report.suites)for(const row of suite.operatorResults)if(["GAUSS.MATH.PARETO.002","GAUSS.PHYSICS.ISING_EXACT_GROUND.003"].includes(row.id))ids.add(row.id);
  assert.equal(ids.size,2);
  return Object.freeze({registryOperators:1000,coveredOperators:1000,untestedOperators:0,targetedOperatorIds:Object.freeze([...ids].sort())});
}

export async function runCanoRound3({round2Report,portfolio,plan}){
  validate(round2Report,portfolio,plan);
  const rows=metrics(portfolio,plan);
  const gaussProblem=problem(rows);
  const [gauss,axioma]=await Promise.all([
    executeGaussProblem(gaussProblem,{quantumContributor:contributeNexusQuantum}),
    Promise.resolve().then(()=>runAxioma()),
  ]);
  assert.equal(gauss.status,"PASS");
  assert.equal(gauss.quantumContribution?.status,"EXECUTED");
  assert.equal(gauss.quantumContribution?.simulation?.verdict,"PASS");
  assert.equal(gauss.quantumContribution?.simulation?.hardwareExecution,false);
  assert.equal(gauss.quantumContribution?.simulation?.quantumAdvantageClaimAllowed,false);
  const pareto=gauss.taskResults.find(x=>x.taskId==="round3-architecture-pareto");
  const ising=gauss.taskResults.find(x=>x.taskId==="round3-architecture-ising");
  assert.equal(pareto?.status,"EXECUTED");assert.equal(ising?.status,"EXECUTED");
  const finalistIds=rows.filter((_,i)=>ising.output.spins[i]===1).map(x=>x.id);
  assert.equal(finalistIds.length,3,`expected 3 finalists got ${finalistIds.length}`);
  const covered=new Set();for(const row of rows.filter(x=>finalistIds.includes(x.id)))for(const id of row.targetQueryIds)covered.add(id);
  const top3=portfolio.keywords.filter(q=>covered.has(q.id)&&q.targetRankBucket==="TOP3").length;
  const top5=portfolio.keywords.filter(q=>covered.has(q.id)&&q.targetRankBucket==="TOP5").length;
  const unsigned={
    schemaVersion:1,tournamentId:"CANO_PENAL_CDMX_ZERO",stage:"ROUND_3_ARCHITECTURE_FINALISTS",
    status:"PASS_THREE_ARCHITECTURE_FINALISTS_NO_RANK_OR_CLIENT_CLAIM",
    round2ReportSha256:round2Report.reportSha256,
    architecturePlanId:plan.planId,architecturePlanStatus:plan.status,
    candidateArchitectures:rows,finalistIds,finalistCount:3,
    finalistTargetCoverage:{queryCount:covered.size,top3TargetCount:top3,top5TargetCount:top5},
    gauss:{engineId:gauss.engineId,status:gauss.status,reportSha256:gauss.reportSha256,paretoFrontierIds:[...(pareto.output?.frontierIds??[])].sort(),paretoDominatedIds:[...(pareto.output?.dominatedIds??[])].sort(),exactIsingEnergy:ising.output.energy,exactIsingEvaluatedStates:ising.output.evaluatedStates,interpretation:"ARCHITECTURE_PORTFOLIO_SELECTION_NOT_RANKING_OR_CLIENT_FORECAST"},
    quantum:{engineId:gauss.quantumContribution.engineId,status:gauss.quantumContribution.status,sourceTaskId:gauss.quantumContribution.sourceTaskId,simulationReceiptSha256:gauss.quantumContribution.simulation.receiptSha256,hardwareExecution:false,quantumAdvantageClaimAllowed:false,interpretation:"BOUNDED_ISING_ARCHITECTURE_PORTFOLIO_RECEIPT_ONLY"},
    axioma:axiomaSummary(axioma),
    avengers:{baselineAll2500InheritedFromRound2:true,round2OrganicDeepModuleCount:round2Report.avengers.organicDeepModuleCount,round2OrganicDeepErrorCount:round2Report.avengers.organicDeepErrorCount,round2OrganicDeepSummarySha256:round2Report.avengers.organicDeepSummarySha256,interpretation:"ROUND3_CONSUMES_THE_WALLE_VERIFIED_ORGANIC_DIAGNOSTIC_GRAPH_FROM_ROUND2"},
    minimumSignedOrganicClientsPerMonth:round2Report.minimumSignedOrganicClientsPerMonth,
    rankMeasurementStatus:"INSUFFICIENT_DATA_NO_GSC_OR_AUTHORIZED_SERP_TRACKER",
    signedClientMeasurementStatus:"INSUFFICIENT_DATA_NO_ATTRIBUTED_SIGNED_CLIENT_LEDGER",
    selectedStrategyId:null,commercialWinnerStatus:"NOT_YET_ELIGIBLE",
    nextStage:"ROUND_4_FINAL_THREE_IMPLEMENTATION_AND_LIVE_MEASUREMENT_PROTOCOL",
    decisionBoundary:"PROPOSED_ARCHITECTURES_ONLY_NO_PRODUCTION_MUTATION_NO_RANKING_GUARANTEE_NO_5_CLIENT_FORECAST",
  };
  return Object.freeze({...unsigned,reportSha256:sha256Canonical(unsigned)});
}

async function main(argv){
  const args=parseArgs(argv);
  const [r2,p,a]=await Promise.all([readFile(args.round2),readFile(portfolioPath),readFile(planPath)]);
  const report=await runCanoRound3({round2Report:JSON.parse(r2),portfolio:JSON.parse(p),plan:JSON.parse(a)});
  const out=`${JSON.stringify(report,null,2)}\n`;
  if(args.out)await writeFile(args.out,out);else process.stdout.write(out);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(e=>{console.error(e?.stack??String(e));process.exitCode=1;});
