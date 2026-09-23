#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../gauss/core/common.mjs";
import { runCanoRound0 } from "../tournaments/cano-penal-zero/round0.mjs";

const RANGE_SPECS = Object.freeze([
  ["M001-M200", 1, 200, "m001-m200.json"],
  ["M201-M400", 201, 400, "m201-m400.json"],
  ["M401-M600", 401, 600, "m401-m600.json"],
  ["M601-M800", 601, 800, "m601-m800.json"],
  ["M801-M1000", 801, 1000, "m801-m1000.json"],
  ["M1001-M2500", 1001, 2500, "m1001-m2500.json"],
]);

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function moduleNumber(id) {
  assert.match(id, /^M[1-9][0-9]*$/);
  return Number(id.slice(1));
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!["--report", "--audit", "--manifest", "--avengers-summary", "--evidence-dir"].includes(arg)) {
      throw new Error(`unknown argument:${arg}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    result[arg.slice(2)] = resolve(value);
    i += 1;
  }
  for (const key of ["report", "audit", "manifest", "avengers-summary", "evidence-dir"]) {
    if (!result[key]) throw new Error(`missing required --${key}`);
  }
  return result;
}

function verifySummary(summary, auditSha256) {
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.engineId, "SEO_AVENGERS_2500_CANO_ROUND0");
  assert.equal(summary.siteId, "cano-penal");
  assert.equal(summary.auditSha256, auditSha256);
  assert.equal(summary.moduleCount, 2500);
  assert.equal(summary.receiptCount, 2500);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.productionMutation, "FORBIDDEN");
  assert.equal(summary.rankingGuarantee, "FORBIDDEN");
  assert.equal(summary.clientOutcomeForecast, "FORBIDDEN");
  const { summarySha256, ...unsigned } = summary;
  assert.equal(summarySha256, sha256Canonical(unsigned), "Avengers summary SHA-256 mismatch");
  assert.equal(summary.ranges.length, RANGE_SPECS.length);
  return summarySha256;
}

async function verifyRanges(evidenceDir, summary, auditSha256) {
  let receiptCount = 0;
  let successCount = 0;
  let insufficientDataCount = 0;
  let errorCount = 0;
  const summaryByRange = new Map(summary.ranges.map((row) => [row.range, row]));

  for (const [label, start, end, filename] of RANGE_SPECS) {
    const bytes = await readFile(join(evidenceDir, filename));
    const evidence = JSON.parse(bytes.toString("utf8"));
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.range, label);
    assert.equal(evidence.siteId, "cano-penal");
    assert.equal(evidence.auditSha256, auditSha256);
    assert.equal(evidence.receiptCount, end - start + 1);
    assert.equal(evidence.errorCount, 0, `${label} contains runtime errors`);
    const ids = Object.keys(evidence.receipts).sort((a, b) => moduleNumber(a) - moduleNumber(b));
    assert.deepStrictEqual(ids, Array.from({ length: end - start + 1 }, (_, index) => `M${start + index}`));
    for (const id of ids) {
      const row = evidence.receipts[id];
      assert(["SUCCESS", "INSUFFICIENT_DATA"].includes(row.status), `${label} invalid status:${id}:${row.status}`);
      assert.match(row.receiptSha256, /^sha256:[0-9a-f]{64}$/);
    }
    const { rangeSha256, ...unsigned } = evidence;
    assert.equal(rangeSha256, sha256Canonical(unsigned), `${label} range SHA-256 mismatch`);
    const declared = summaryByRange.get(label);
    assert(declared, `summary missing range:${label}`);
    assert.equal(declared.rangeSha256, rangeSha256);
    assert.equal(declared.receiptCount, evidence.receiptCount);
    assert.equal(declared.successCount, evidence.successCount);
    assert.equal(declared.insufficientDataCount, evidence.insufficientDataCount);
    assert.equal(declared.errorCount, evidence.errorCount);
    receiptCount += evidence.receiptCount;
    successCount += evidence.successCount;
    insufficientDataCount += evidence.insufficientDataCount;
    errorCount += evidence.errorCount;
  }

  assert.equal(receiptCount, 2500);
  assert.equal(successCount, summary.successCount);
  assert.equal(insufficientDataCount, summary.insufficientDataCount);
  assert.equal(errorCount, 0);
  assert.equal(errorCount, summary.errorCount);
  return Object.freeze({ receiptCount, successCount, insufficientDataCount, errorCount });
}

export async function verifyCanoRound0({ reportPath, auditPath, manifestPath, avengersSummaryPath, evidenceDir }) {
  const [reportBytes, auditBytes, manifestBytes, summaryBytes, identityBytes] = await Promise.all([
    readFile(reportPath),
    readFile(auditPath),
    readFile(manifestPath),
    readFile(avengersSummaryPath),
    readFile(new URL("../tournaments/cano-penal-zero/identity.json", import.meta.url)),
  ]);
  const report = JSON.parse(reportBytes.toString("utf8"));
  const audit = JSON.parse(auditBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const summary = JSON.parse(summaryBytes.toString("utf8"));
  const identity = JSON.parse(identityBytes.toString("utf8"));
  const auditSha256 = sha256Bytes(auditBytes);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.tournamentId, "CANO_PENAL_CDMX_ZERO");
  assert.equal(manifest.siteId, "cano-penal");
  assert.equal(manifest.siteHostname, "canopenal.com");
  assert.equal(manifest.evidenceSha256, auditSha256, "audit manifest byte binding mismatch");
  assert.equal(audit.tournamentId, manifest.tournamentId);
  assert.equal(audit.siteId, manifest.siteId);
  assert.equal(audit.siteHostname, manifest.siteHostname);

  const avengersSummarySha256 = verifySummary(summary, auditSha256);
  const rangeTotals = await verifyRanges(evidenceDir, summary, auditSha256);

  const replay = await runCanoRound0({
    identity,
    auditBytes,
    audit,
    auditManifest: manifest,
    avengersSummary: summary,
  });
  assert.deepStrictEqual(report, replay, "WALLE replay differs from claimed Round 0 report");
  assert.equal(report.reportSha256, sha256Canonical(Object.fromEntries(Object.entries(report).filter(([key]) => key !== "reportSha256"))));
  assert.equal(report.status, "PASS");
  assert.equal(report.strategyCount, 24);
  assert.equal(report.structuralShortlistCount, 12);
  assert.equal(report.selectedStrategyId, null);
  assert.equal(report.commercialWinnerStatus, "NOT_YET_ELIGIBLE");
  assert.equal(report.gauss.status, "PASS");
  assert.equal(report.quantum.status, "EXECUTED");
  assert.equal(report.axioma.registryOperators, 1000);
  assert.equal(report.axioma.coveredOperators, 1000);
  assert.equal(report.axioma.untestedOperators, 0);
  assert.equal(report.axioma.failedValidCases, 0);
  assert.equal(report.axioma.failedInvalidRejections, 0);
  assert.equal(report.avengers.receiptCount, 2500);
  assert.equal(report.avengers.errorCount, 0);

  const receiptUnsigned = {
    schemaVersion: 1,
    engineId: "WALLE_CANO_TOURNAMENT_ROUND0_VERIFY_V1",
    status: "PASS",
    siteId: "cano-penal",
    auditSha256,
    round0ReportSha256: report.reportSha256,
    round0ArtifactSha256: sha256Bytes(reportBytes),
    avengersSummarySha256,
    avengersArtifactSha256: sha256Bytes(summaryBytes),
    avengersReceiptCount: rangeTotals.receiptCount,
    avengersInsufficientDataCount: rangeTotals.insufficientDataCount,
    gaussReportSha256: report.gauss.reportSha256,
    quantumSimulationReceiptSha256: report.quantum.simulationReceiptSha256,
    axiomaCoveredOperators: report.axioma.coveredOperators,
    strategyCount: report.strategyCount,
    structuralShortlistCount: report.structuralShortlistCount,
    selectedStrategyId: null,
    productionAuthority: false,
    interpretation: "REPLAY_VERIFIED_ROUND0_NOT_COMMERCIAL_WINNER_OR_DEPLOYMENT_AUTHORIZATION",
  };
  return Object.freeze({ ...receiptUnsigned, receiptSha256: sha256Canonical(receiptUnsigned) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  verifyCanoRound0({
    reportPath: args.report,
    auditPath: args.audit,
    manifestPath: args.manifest,
    avengersSummaryPath: args["avengers-summary"],
    evidenceDir: args["evidence-dir"],
  }).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  }).catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
