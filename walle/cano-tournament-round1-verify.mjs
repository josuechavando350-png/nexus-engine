#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../gauss/core/common.mjs";
import { runCanoRound1 } from "../tournaments/cano-penal-zero/round1.mjs";

function parseArgs(argv) {
  const out = { report: null, round0Report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--report","--round0-report"].includes(arg)) throw new Error(`unknown argument:${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    if (arg === "--report") out.report = resolve(value);
    if (arg === "--round0-report") out.round0Report = resolve(value);
    i += 1;
  }
  if (!out.report || !out.round0Report) throw new Error("ROUND1_REPORT_AND_ROUND0_REPORT_REQUIRED");
  return out;
}

async function verify(argv) {
  const args = parseArgs(argv);
  const root = new URL("../", import.meta.url);
  const adsPath = new URL("tournaments/cano-penal-zero/ads-evidence-v1.json", root);
  const manifestPath = new URL("tournaments/cano-penal-zero/ads-evidence-manifest-v1.json", root);
  const [claimedBytes, round0Bytes, adsBytes, manifestBytes] = await Promise.all([
    readFile(args.report), readFile(args.round0Report), readFile(adsPath), readFile(manifestPath),
  ]);
  const claimed = JSON.parse(claimedBytes.toString("utf8"));
  const { reportSha256, ...unsigned } = claimed;
  assert.equal(reportSha256, sha256Canonical(unsigned), "claimed Round 1 report hash mismatch");

  const replay = await runCanoRound1({
    round0Report: JSON.parse(round0Bytes.toString("utf8")),
    adsEvidence: JSON.parse(adsBytes.toString("utf8")),
    adsBytes,
    adsManifest: JSON.parse(manifestBytes.toString("utf8")),
  });
  assert.deepStrictEqual(claimed, replay, "Round 1 replay differs from claimed report");
  assert.equal(replay.status, "PASS_WITH_ONE_UNRESOLVED_SLOT");
  assert.equal(replay.advancedCount, 5);
  assert.deepStrictEqual(replay.advancedCandidateIds, ["S01","S05","S10","S15","S23"]);
  assert.deepStrictEqual(replay.unresolvedFamilyIds, ["F5_ACCOUNTANT_BUSINESS_CHANNEL"]);
  assert.equal(replay.quantum.status, "NOT_APPLICABLE");
  assert.equal(replay.adsReadOnly, true);
  assert.equal(replay.providerReplayInCi, false);
  assert.equal(replay.selectedStrategyId, null);
  assert.equal(replay.commercialWinnerStatus, "NOT_YET_ELIGIBLE");

  const receiptUnsigned = {
    schemaVersion: 1,
    engineId: "WALLE_CANO_TOURNAMENT_ROUND1_VERIFIER_V1",
    status: "PASS",
    round1ReportSha256: replay.reportSha256,
    round0ReportSha256: replay.round0ReportSha256,
    adsEvidenceSha256: replay.adsEvidenceSha256,
    gaussReportSha256: replay.gauss.reportSha256,
    axiomaCoveredOperators: replay.axioma.coveredOperators,
    quantumStatus: replay.quantum.status,
    advancedCandidateCount: replay.advancedCount,
    unresolvedFamilyIds: replay.unresolvedFamilyIds,
    productionAuthority: false,
    adsMutationAuthority: false,
    providerReplayClaim: false,
    consensus: "REPLAY_VERIFIED_FIRST_PARTY_ADS_SNAPSHOT_IS_INTEGRITY_BOUND_NOT_PROVIDER_REPLAYED_NO_COMMERCIAL_WINNER",
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
