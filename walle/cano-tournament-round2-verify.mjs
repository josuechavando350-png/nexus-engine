#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../gauss/core/common.mjs";
import { runCanoRound2 } from "../tournaments/cano-penal-zero/round2.mjs";

function parseArgs(argv) {
  const out = { report: null, round0Report: null, round1Report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--report","--round0-report","--round1-report"].includes(arg)) throw new Error(`unknown argument:${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--report") out.report = resolve(value);
    if (arg === "--round0-report") out.round0Report = resolve(value);
    if (arg === "--round1-report") out.round1Report = resolve(value);
    i += 1;
  }
  if (!out.report || !out.round0Report || !out.round1Report) throw new Error("ROUND2_REPORT_AND_PRIOR_REPORTS_REQUIRED");
  return out;
}

async function verify(argv) {
  const args = parseArgs(argv);
  const publicPath = new URL("../tournaments/cano-penal-zero/round2-public-evidence-v1.json", import.meta.url);
  const [claimedBytes, round0Bytes, round1Bytes, publicBytes] = await Promise.all([
    readFile(args.report), readFile(args.round0Report), readFile(args.round1Report), readFile(publicPath),
  ]);
  const claimed = JSON.parse(claimedBytes.toString("utf8"));
  const { reportSha256, ...unsigned } = claimed;
  assert.equal(reportSha256, sha256Canonical(unsigned), "claimed Round 2 report hash mismatch");

  const replay = await runCanoRound2({
    round0Report: JSON.parse(round0Bytes.toString("utf8")),
    round1Report: JSON.parse(round1Bytes.toString("utf8")),
    publicEvidence: JSON.parse(publicBytes.toString("utf8")),
  });
  assert.deepStrictEqual(claimed, replay, "Round 2 replay differs from claimed report");
  assert.equal(replay.status, "PASS");
  assert.deepStrictEqual(replay.finalistIds, ["S01","S05","S23"]);
  assert.deepStrictEqual(replay.reserveCandidateIds, ["S10","S15","S18"]);
  assert.equal(replay.finalistCount, 3);
  assert.equal(replay.avengers.moduleCount, 2500);
  assert.equal(replay.avengers.errorCount, 0);
  assert.equal(replay.quantum.status, "EXECUTED");
  assert.equal(replay.quantum.hardwareExecution, false);
  assert.equal(replay.quantum.quantumAdvantageClaimAllowed, false);
  assert.equal(replay.axioma.coveredOperators, 1000);
  assert.equal(replay.selectedStrategyId, null);
  assert.equal(replay.commercialWinnerStatus, "NOT_YET_ELIGIBLE");
  assert.equal(replay.publicSourceReplayInCi, false);

  const receiptUnsigned = {
    schemaVersion: 1,
    engineId: "WALLE_CANO_TOURNAMENT_ROUND2_VERIFIER_V1",
    status: "PASS",
    round2ReportSha256: replay.reportSha256,
    round1ReportSha256: replay.round1ReportSha256,
    round0ReportSha256: replay.round0ReportSha256,
    publicEvidenceSha256: replay.publicEvidenceSha256,
    gaussReportSha256: replay.gauss.reportSha256,
    axiomaCoveredOperators: replay.axioma.coveredOperators,
    quantumStatus: replay.quantum.status,
    finalistIds: replay.finalistIds,
    productionAuthority: false,
    adsMutationAuthority: false,
    publicSourceReplayClaim: false,
    consensus: "REPLAY_VERIFIED_THREE_ROLE_DIVERSE_FINALISTS_NO_COMMERCIAL_WINNER",
  };
  return Object.freeze({ ...receiptUnsigned, receiptSha256: sha256Canonical(receiptUnsigned) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify(process.argv.slice(2)).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
