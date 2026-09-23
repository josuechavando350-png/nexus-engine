import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { runCanoRound4 } from "./round4.mjs";

const gate=JSON.parse(await readFile(new URL("./organic-statistical-gate-v1.json",import.meta.url),"utf8"));
const protocol=JSON.parse(await readFile(new URL("./round4-live-measurement-protocol-v1.json",import.meta.url),"utf8"));
const plan=JSON.parse(await readFile(new URL("./round3-architecture-plan-v1.json",import.meta.url),"utf8"));

const round3={
  schemaVersion:1,tournamentId:"CANO_PENAL_CDMX_ZERO",stage:"ROUND_3_ARCHITECTURE_FINALISTS",
  status:"PASS_THREE_ARCHITECTURE_FINALISTS_NO_RANK_OR_CLIENT_CLAIM",
  finalistIds:["S01","S10","S15"],finalistCount:3,commercialWinnerStatus:"NOT_YET_ELIGIBLE",
  reportSha256:"sha256:fixture"
};

test("Round 4 starts blocked rather than inventing a winner without live evidence",async()=>{
  const report=await runCanoRound4({round3Report:round3,gate,protocol,plan,liveEvidence:null});
  assert.equal(report.status,"BLOCKED_LIVE_EVIDENCE_REQUIRED");
  assert.deepStrictEqual(report.finalistIds,["S01","S10","S15"]);
  assert.equal(report.selectedStrategyId,null);
  assert.equal(report.commercialWinnerStatus,"NOT_ELIGIBLE_LIVE_EVIDENCE_MISSING");
  assert.equal(report.requiredConfidence,0.999);
  assert.equal(report.requiredComparisonPower,0.95);
});

test("Round 4 requires exactly five signed clients as monthly commercial threshold",async()=>{
  const report=await runCanoRound4({round3Report:round3,gate,protocol,plan,liveEvidence:null});
  assert.equal(report.minimumSignedOrganicClientsPerMonth,5);
  assert.equal(report.repeatabilityMonths,3);
});

test("blocked Round 4 preserves the scenario matrix including 735 sessions at two percent",async()=>{
  const report=await runCanoRound4({round3Report:round3,gate,protocol,plan,liveEvidence:null});
  const row=report.scenarioMatrix.find((x)=>x.ratePercent===2);
  assert.equal(row.organicSessionsForAtLeast5With999Probability,735);
});
