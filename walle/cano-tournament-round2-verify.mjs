#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../gauss/core/common.mjs";
import { runCanoRound2 } from "../tournaments/cano-penal-zero/round2.mjs";

function parseArgs(argv){
  const out={report:null,round0:null,round1:null,avengers:null};
  for(let i=0;i<argv.length;i+=2){
    const arg=argv[i],value=argv[i+1];
    if(!value)throw new Error(`missing value for ${arg}`);
    if(arg==="--report")out.report=resolve(value);
    else if(arg==="--round0-report")out.round0=resolve(value);
    else if(arg==="--round1-report")out.round1=resolve(value);
    else if(arg==="--avengers-organic")out.avengers=resolve(value);
    else throw new Error(`unknown argument:${arg}`);
  }
  if(!out.report||!out.round0||!out.round1||!out.avengers)throw new Error("ROUND2_REPLAY_INPUTS_REQUIRED");
  return out;
}

async function verify(argv){
  const args=parseArgs(argv);
  const root=new URL("../",import.meta.url);
  const [claimedBytes,r0Bytes,r1Bytes,goalBytes,portfolioBytes,marketBytes,avengersBytes]=await Promise.all([
    readFile(args.report),readFile(args.round0),readFile(args.round1),
    readFile(new URL("tournaments/cano-penal-zero/organic-goal-v1.json",root)),
    readFile(new URL("tournaments/cano-penal-zero/organic-keyword-portfolio-v1.json",root)),
    readFile(new URL("tournaments/cano-penal-zero/organic-public-market-v1.json",root)),
    readFile(args.avengers),
  ]);
  const claimed=JSON.parse(claimedBytes);
  const {reportSha256,...unsigned}=claimed;
  assert.equal(reportSha256,sha256Canonical(unsigned),"claimed Round2 hash mismatch");
  const replay=await runCanoRound2({
    round0Report:JSON.parse(r0Bytes),round1Report:JSON.parse(r1Bytes),
    goal:JSON.parse(goalBytes),portfolio:JSON.parse(portfolioBytes),market:JSON.parse(marketBytes),
    avengersOrganic:JSON.parse(avengersBytes),
  });
  assert.deepStrictEqual(claimed,replay,"Round2 replay mismatch");
  assert.equal(replay.status,"PASS_STRUCTURAL_SEMIFINALISTS_NO_RANK_OR_CLIENT_CLAIM");
  assert.equal(replay.semifinalistCount,6);
  assert.equal(replay.minimumSignedOrganicClientsPerMonth,5);
  assert.equal(replay.avengers.baselineModuleCount,2500);
  assert.equal(replay.avengers.organicDeepModuleCount,1500);
  assert.equal(replay.avengers.organicDeepErrorCount,0);
  assert.equal(replay.quantum.status,"EXECUTED");
  assert.equal(replay.quantum.hardwareExecution,false);
  assert.equal(replay.quantum.quantumAdvantageClaimAllowed,false);
  assert.equal(replay.axioma.coveredOperators,1000);
  assert.equal(replay.selectedStrategyId,null);
  assert.equal(replay.commercialWinnerStatus,"NOT_YET_ELIGIBLE");
  assert.equal(replay.organicClientOutcomeStatus,"INSUFFICIENT_DATA_NO_ATTRIBUTED_SIGNED_CLIENT_LEDGER");

  const receiptUnsigned={
    schemaVersion:1,engineId:"WALLE_CANO_TOURNAMENT_ROUND2_ORGANIC_V1",status:"PASS",
    round2ReportSha256:replay.reportSha256,round1ReportSha256:replay.round1ReportSha256??JSON.parse(r1Bytes).reportSha256,
    round0ReportSha256:JSON.parse(r0Bytes).reportSha256,semifinalistIds:replay.semifinalistIds,
    keywordTargetCount:replay.keywordPortfolio.targetQueryCount,minimumSignedOrganicClientsPerMonth:5,
    gaussReportSha256:replay.gauss.reportSha256,axiomaCoveredOperators:replay.axioma.coveredOperators,
    quantumStatus:replay.quantum.status,productionAuthority:false,adsMutationAuthority:false,
    consensus:"REPLAY_VERIFIED_ORGANIC_SEMIFINALISTS_NO_RANK_OR_CLIENT_CLAIM",
  };
  return Object.freeze({...receiptUnsigned,receiptSha256:sha256Canonical(receiptUnsigned)});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verify(process.argv.slice(2)).then(r=>process.stdout.write(`${JSON.stringify(r,null,2)}\n`)).catch(e=>{console.error(e?.stack??String(e));process.exitCode=1;});
}
