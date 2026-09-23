#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../gauss/core/common.mjs";
import { runCanoRound4 } from "../tournaments/cano-penal-zero/round4.mjs";

function parseArgs(argv){
  const out={report:null,round3:null};
  for(let i=0;i<argv.length;i+=2){
    const arg=argv[i],value=argv[i+1];
    if(!value)throw new Error(`missing value for ${arg}`);
    if(arg==="--report")out.report=resolve(value);
    else if(arg==="--round3-report")out.round3=resolve(value);
    else throw new Error(`unknown argument:${arg}`);
  }
  if(!out.report||!out.round3)throw new Error("ROUND4_REPLAY_INPUTS_REQUIRED");
  return out;
}

async function verify(argv){
  const args=parseArgs(argv);
  const root=new URL("../",import.meta.url);
  const [claimedBytes,r3Bytes,gateBytes,protocolBytes,planBytes]=await Promise.all([
    readFile(args.report),readFile(args.round3),
    readFile(new URL("tournaments/cano-penal-zero/organic-statistical-gate-v1.json",root)),
    readFile(new URL("tournaments/cano-penal-zero/round4-live-measurement-protocol-v1.json",root)),
    readFile(new URL("tournaments/cano-penal-zero/round3-architecture-plan-v1.json",root)),
  ]);
  const claimed=JSON.parse(claimedBytes);
  const {reportSha256,...unsigned}=claimed;
  assert.equal(reportSha256,sha256Canonical(unsigned),"claimed Round4 hash mismatch");
  const replay=await runCanoRound4({
    round3Report:JSON.parse(r3Bytes),
    gate:JSON.parse(gateBytes),
    protocol:JSON.parse(protocolBytes),
    plan:JSON.parse(planBytes),
    liveEvidence:null,
  });
  assert.deepStrictEqual(claimed,replay,"Round4 replay mismatch");
  assert.equal(replay.status,"BOOTSTRAP_LIVE_EVIDENCE_NOT_MATURE");
  assert.deepStrictEqual(replay.finalistIds,["S01","S10","S15"]);
  assert.equal(replay.requiredConfidence,0.999);
  assert.equal(replay.requiredComparisonPower,0.95);
  assert.equal(replay.minimumSignedOrganicClientsPerMonth,5);
  assert.equal(replay.repeatabilityMonths,3);
  assert.equal(replay.selectedStrategyId,null);
  assert.equal(replay.commercialWinnerStatus,"NOT_ELIGIBLE_MEASUREMENT_BOOTSTRAP");
  assert.equal(replay.rankingWinnerStatus,"NOT_ELIGIBLE_SEARCH_CONSOLE_BOOTSTRAP");
  assert.equal(replay.gaussStatus,"NOT_EXECUTED_NO_LIVE_BINOMIAL_INPUT");
  assert.equal(replay.quantumStatus,"NOT_APPLICABLE_NO_ROUND4_ISING_TASK");

  const receiptUnsigned={
    schemaVersion:1,
    engineId:"WALLE_CANO_TOURNAMENT_ROUND4_VERIFIER_V1",
    status:"PASS_BOOTSTRAP_AS_DESIGNED",
    round4ReportSha256:replay.reportSha256,
    round3ReportSha256:replay.round3ReportSha256,
    finalistIds:replay.finalistIds,
    requiredConfidence:replay.requiredConfidence,
    requiredComparisonPower:replay.requiredComparisonPower,
    minimumSignedOrganicClientsPerMonth:replay.minimumSignedOrganicClientsPerMonth,
    productionAuthority:false,
    adsMutationAuthority:false,
    liveEvidencePresent:false,
    consensus:"REPLAY_VERIFIED_SEARCH_CONSOLE_BOOTSTRAP_UNTIL_QUERY_LEVEL_RANK_AND_ATTRIBUTED_SIGNED_CLIENT_EVIDENCE_MATURES",
  };
  return Object.freeze({...receiptUnsigned,receiptSha256:sha256Canonical(receiptUnsigned)});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verify(process.argv.slice(2)).then(r=>process.stdout.write(`${JSON.stringify(r,null,2)}\n`)).catch(e=>{console.error(e?.stack??String(e));process.exitCode=1;});
}
