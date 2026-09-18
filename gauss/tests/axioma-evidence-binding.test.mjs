import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Canonical } from "../core/common.mjs";
import { executeGaussProblem } from "../core/problem.mjs";
import { contributeNexusQuantum } from "../core/quantum-contributor.mjs";
import { createAxiomaEvidence, verifyAxiomaEvidence } from "../../walle/axioma-evidence.mjs";
import { verifyGaussEvidenceFile } from "../../walle/gauss-evidence-verify.mjs";

const problemPath = new URL("../fixtures/gauss-1000-selftest.json", import.meta.url);
const problem = JSON.parse(await (await import("node:fs/promises")).readFile(problemPath, "utf8"));
const report = JSON.parse(JSON.stringify(await executeGaussProblem(problem, { quantumContributor: contributeNexusQuantum })));
const authentic = createAxiomaEvidence(report.reportSha256);

function rehash(evidence) {
  evidence.axiomaReportSha256 = sha256Canonical(evidence.axiomaReport);
  const { evidenceSha256: previous, ...unsigned } = evidence;
  void previous;
  evidence.evidenceSha256 = sha256Canonical(unsigned);
  return evidence;
}

test("WALLE full GAUSS certification requires matching source-bound AXIOMA and replays the real bank", async () => {
  const directory = await mkdtemp(join(tmpdir(), "walle-axioma-test-"));
  const gaussPath = join(directory, "gauss.json");
  const axiomaPath = join(directory, "axioma.json");
  const symlinkPath = join(directory, "axioma-link.json");
  try {
    await writeFile(gaussPath, JSON.stringify(report));
    await writeFile(axiomaPath, JSON.stringify(authentic));
    await symlink(axiomaPath, symlinkPath);
    await assert.rejects(
      verifyGaussEvidenceFile(gaussPath, problemPath),
      /AXIOMA evidence required/u,
    );
    await assert.rejects(
      verifyGaussEvidenceFile(gaussPath, problemPath, symlinkPath),
      /non-symlink file/u,
    );
    const result = await verifyGaussEvidenceFile(gaussPath, problemPath, axiomaPath);
    assert.equal(result.certifiedFullCatalog, true);
    assert.equal(result.executedLayerCount, 1000);
    assert.equal(result.axiomaEvidenceSha256, authentic.evidenceSha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WALLE rejects missing, cross-report, stale source and forged AXIOMA coverage", () => {
  assert.throws(() => verifyAxiomaEvidence({ evidence: null, gaussReportSha256: report.reportSha256 }), /AXIOMA evidence required/u);
  assert.throws(() => verifyAxiomaEvidence({ evidence: authentic, gaussReportSha256: `sha256:${"0".repeat(64)}` }), /GAUSS report binding mismatch/u);
  const stale = rehash({ ...structuredClone(authentic), sourceRevision: "0".repeat(40) });
  assert.throws(() => verifyAxiomaEvidence({ evidence: stale, gaussReportSha256: report.reportSha256 }), /source revision mismatch/u);
  const missing = structuredClone(authentic);
  missing.axiomaReport.coveredOperators = 999;
  missing.axiomaReport.untestedOperators = 1;
  rehash(missing);
  assert.throws(() => verifyAxiomaEvidence({ evidence: missing, gaussReportSha256: report.reportSha256 }), /AXIOMA missing operators/u);
  const forged = structuredClone(authentic);
  forged.axiomaReport.suites[0].operatorResults[0].passed = 0;
  rehash(forged);
  assert.throws(() => verifyAxiomaEvidence({ evidence: forged, gaussReportSha256: report.reportSha256 }), /independent replay differs/u);
});
