#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../gauss/core/common.mjs";
import { runCanoRound3 } from "../tournaments/cano-penal-zero/round3.mjs";

function parseArgs(argv){
  const out={report:null,round2:null};
  for(let i=0;i<argv.length;i+=2){
    const arg=argv[i],value=argv[i+1];
    if(!value)throw new Error(`missing value for ${arg}`);
    if(arg==="--report")out.report=resolve(value);
    else if(arg==="--round2-report")out.round2=resolve(value);
    else throw new Error(`unknown argument:${arg}`);
  }
  if(!out.report||!out.round2)throw new Error("ROUND3_REPLAY_INPUTS_REQUIRED");
  return out;
}

async function verify(argv){
  const args=parseArgs(argv);
  const root=new URL("../",import.meta.url);
  const [claimedBytes,r2Bytes,pBytes,aBytes]=await Promise.all([
    readFile(args.report),readFile(args.round2),
    readFile(new URL("tournaments/cano-penal-zero/organic-keyword-portfolio-v1.json",root)),
    readFile(new URL("tournaments/cano-penal-zero/round3-architecture-plan-v1.json",root)),
  ]);
  const claimed=JSON.parse(claimedBytes);
  const {reportSha256,...unsigned}=claimed;
  assert.equal(reportSha256,sha256Canonical(unsigned),"claimed Round3 hash mismatch");
  const replay=await runCanoRound3({
    round2Report:JSON.parse(r2Bytes),
    portfolio:JSON.parse(pBytes),
    plan:JSON.parse(aBytes),
  });
  assert.deepStrictEqual(claimed,replay,"Round3 replay mismatch");
  assert.equal(replay.status,"PASS_THREE_ARCHITECTURE_FINALISTS_NO_RANK_OR_CLIENT_CLAIM");
  assert.equal(replay.finalistCount,3);
  assert.deepStrictEqual(replay.finalistIds,["S01","S10","S15"]);
  assert.equal(replay.minimumSignedOrganicClientsPerMonth,5);
  assert.equal(replay.quantum.status,"EXECUTED");
  assert.equal(replay.quantum.hardwareExecution,false);
  assert.equal(replay.quantum.quantumAdvantageClaimAllowed,false);
  assert.equal(replay.axioma.coveredOperators,1000);
  assert.equal(replay.avengers.baselineAll2500InheritedFromRound2,true);
  assert.equal(replay.selectedStrategyId,null);
  assert.equal(replay.commercialWinnerStatus,"NOT_YET_ELIGIBLE");
  assert.equal(replay.rankMeasurementStatus,"INSUFFICIENT_DATA_NO_GSC_OR_AUTHORIZED_SERP_TRACKER");
  assert.equal(replay.signedClientMeasurementStatus,"INSUFFICIENT_DATA_NO_ATTRIBUTED_SIGNED_CLIENT_LEDGER");

  const receiptUnsigned={
    schemaVersion:1,engineId:"WALLE_CANO_TOURNAMENT_ROUND3_VERIFIER_V1",status:"PASS",
    round3ReportSha256:replay.reportSha256,round2ReportSha256:replay.round2ReportSha256,
    finalistIds:replay.finalistIds,finalistCount:replay.finalistCount,
    gaussReportSha256:replay.gauss.reportSha256,axiomaCoveredOperators:replay.axioma.coveredOperators,
    quantumStatus:replay.quantum.status,minimumSignedOrganicClientsPerMonth:5,
    productionAuthority:false,adsMutationAuthority:false,
    consensus:"REPLAY_VERIFIED_THREE_ORGANIC_ARCHITECTURE_FINALISTS_NO_RANK_OR_CLIENT_CLAIM",
  };
  return Object.freeze({...receiptUnsigned,receiptSha256:sha256Canonical(receiptUnsigned)});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verify(process.argv.slice(2)).then(r=>process.stdout.write(`${JSON.stringify(r,null,2)}\n`)).catch(e=>{console.error(e?.stack??String(e));process.exitCode=1;});
}
