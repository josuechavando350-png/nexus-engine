#!/usr/bin/env node
/* Full GAUSS certification requires independently replayed AXIOMA evidence for the same source and report. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { sha256Canonical } from "../gauss/core/common.mjs";
import { runAxioma } from "../gauss/axioma/run.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HASH = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 10_000 }).trim();
}

export function sourceIdentity() {
  assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "", "AXIOMA source tree must be clean");
  const sourceRevision = git("rev-parse", "HEAD");
  const sourceTree = git("rev-parse", "HEAD^{tree}");
  assert.match(sourceRevision, REVISION);
  assert.match(sourceTree, REVISION);
  return Object.freeze({ sourceRevision, sourceTree });
}

function assertPassingReport(report) {
  assert.equal(report?.schemaVersion, 1, "AXIOMA evidence schema mismatch");
  assert.equal(report?.bank, "AXIOMA", "AXIOMA bank identity mismatch");
  assert.equal(report.registryOperators, 1000, "AXIOMA registry mismatch");
  assert.equal(report.coveredOperators, 1000, "AXIOMA missing operators");
  assert.equal(report.untestedOperators, 0, "AXIOMA untested operators");
  assert.equal(report.validCases, 100_000, "AXIOMA valid case count mismatch");
  assert.equal(report.passedValidCases, 100_000, "AXIOMA valid cases did not all pass");
  assert.equal(report.failedValidCases, 0, "AXIOMA valid failures");
  assert.equal(report.invalidCases, 3000, "AXIOMA invalid case count mismatch");
  assert.equal(report.passedInvalidRejections, 3000, "AXIOMA invalid cases not all rejected");
  assert.equal(report.failedInvalidRejections, 0, "AXIOMA invalid rejection failures");
}

export function createAxiomaEvidence(gaussReportSha256) {
  assert.match(gaussReportSha256, HASH, "GAUSS report digest required");
  const source = sourceIdentity();
  const axiomaReport = runAxioma();
  assertPassingReport(axiomaReport);
  assert.deepStrictEqual(sourceIdentity(), source, "AXIOMA source changed during execution");
  const unsigned = {
    schemaVersion: 1,
    ...source,
    gaussReportSha256,
    axiomaReportSha256: sha256Canonical(axiomaReport),
    axiomaReport,
  };
  return Object.freeze({ ...unsigned, evidenceSha256: sha256Canonical(unsigned) });
}

export function verifyAxiomaEvidence({ evidence, gaussReportSha256 }) {
  assert(evidence && typeof evidence === "object" && !Array.isArray(evidence), "AXIOMA evidence required");
  const { evidenceSha256, ...unsigned } = evidence;
  assert.deepStrictEqual(Object.keys(unsigned).sort(), [
    "schemaVersion", "sourceRevision", "sourceTree", "gaussReportSha256", "axiomaReportSha256", "axiomaReport",
  ].sort(), "AXIOMA evidence shape mismatch");
  assert.equal(evidence.schemaVersion, 1, "AXIOMA evidence schema mismatch");
  assert.equal(evidence.gaussReportSha256, gaussReportSha256, "AXIOMA GAUSS report binding mismatch");
  assert.match(evidenceSha256, HASH, "AXIOMA evidence digest required");
  assert.equal(evidenceSha256, sha256Canonical(unsigned), "AXIOMA evidence hash mismatch");
  assert.equal(evidence.axiomaReportSha256, sha256Canonical(evidence.axiomaReport), "AXIOMA report digest mismatch");
  const source = sourceIdentity();
  assert.equal(evidence.sourceRevision, source.sourceRevision, "AXIOMA source revision mismatch");
  assert.equal(evidence.sourceTree, source.sourceTree, "AXIOMA source tree mismatch");
  assertPassingReport(evidence.axiomaReport);
  const replay = runAxioma();
  assertPassingReport(replay);
  assert.deepStrictEqual(evidence.axiomaReport, replay, "AXIOMA independent replay differs from claimed evidence");
  assert.deepStrictEqual(sourceIdentity(), source, "AXIOMA source changed during verification");
  return Object.freeze({
    evidenceSha256,
    axiomaReportSha256: evidence.axiomaReportSha256,
    sourceRevision: source.sourceRevision,
    coveredOperators: replay.coveredOperators,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  if (process.argv.length !== 5 || process.argv[2] !== "create") {
    throw new Error("Usage: node walle/axioma-evidence.mjs create <gauss-report.json> <axioma-evidence.json>");
  }
  const report = JSON.parse(await readFile(process.argv[3], "utf8"));
  const { reportSha256, ...unsigned } = report;
  assert.equal(reportSha256, sha256Canonical(unsigned), "GAUSS report digest mismatch");
  assert.equal(report.status, "PASS", "GAUSS report did not pass");
  assert.equal(report.executedLayerCount, 1000, "AXIOMA requires the full GAUSS fixture");
  const evidence = createAxiomaEvidence(reportSha256);
  await writeFile(process.argv[4], `${JSON.stringify(evidence)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`WALLE_AXIOMA_EVIDENCE_SHA256=${evidence.evidenceSha256}`);
  console.log(`WALLE_AXIOMA_SOURCE_REVISION=${evidence.sourceRevision}`);
}
