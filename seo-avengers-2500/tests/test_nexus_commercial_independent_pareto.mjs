import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runCommercialDemandTournamentV2 } from "../commercial-demand/tournament-engine-v2.mjs";
import { auditCommercialGaussAxiomaWalle } from "../commercial-demand/gauss-axioma-walle-audit.mjs";
import { independentlyVerifyCommercialPareto } from "../commercial-demand/independent-pareto-verifier.mjs";

const scenario = JSON.parse(await readFile(fileURLToPath(new URL("../commercial-demand/nexus-commercial-demand-v2.json", import.meta.url)), "utf8"));
const objectives = ["MAX", "MAX", "MAX", "MAX", "MIN"];
const points = [
  { id: "alpha", values: [3, 4, 5, 6, 2] },
  { id: "beta", values: [2, 4, 5, 6, 3] },
  { id: "gamma", values: [4, 3, 5, 6, 1] },
];

test("actual Avengers V2 strategies pass real GAUSS, independent AXIOMA and WALLE mathematical proofs", async () => {
  const report = runCommercialDemandTournamentV2(scenario);
  const audit = await auditCommercialGaussAxiomaWalle(report);
  assert.equal(audit.status, "PASS");
  assert.equal(audit.axiomaStatus, "PASS_BOUNDED_PARETO_OPERATOR_CASES");
  assert.equal(audit.walleStatus, "PASS");
  assert.equal(audit.sourceTournamentReportSha256, report.reportSha256);
  assert.match(audit.axiomaCaseDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(audit.walleReplayInputSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(audit.salesClaimStatus, "NOT_VALIDATED_FOR_SALES_CLAIMS");
});

test("WALLE replay detects fabricated frontier and does not trust GAUSS's claimed partition", () => {
  const trueClaim = { frontierIds: ["alpha", "gamma"], dominatedIds: ["beta"] };
  const first = independentlyVerifyCommercialPareto(points, objectives, trueClaim);
  const second = independentlyVerifyCommercialPareto(points, objectives, trueClaim);
  assert.deepEqual(first, second);
  assert.throws(() => independentlyVerifyCommercialPareto(points, objectives,
    { frontierIds: ["alpha", "beta", "gamma"], dominatedIds: [] }), /WALLE_PARETO_REPLAY_MISMATCH/);
  assert.throws(() => independentlyVerifyCommercialPareto(points, objectives,
    { frontierIds: ["alpha", "alpha"], dominatedIds: ["beta"] }), /WALLE_PARETO_REPLAY_MISMATCH/);
});

test("WALLE rejects malformed points before replay", () => {
  assert.throws(() => independentlyVerifyCommercialPareto([...points, points[0]], objectives,
    { frontierIds: ["alpha", "gamma"], dominatedIds: ["beta"] }), /WALLE_PARETO_INVALID_POINT/);
  assert.throws(() => independentlyVerifyCommercialPareto(points, ["UNKNOWN", ...objectives.slice(1)],
    { frontierIds: ["alpha", "gamma"], dominatedIds: ["beta"] }), /WALLE_PARETO_INVALID_INPUT/);
  assert.throws(() => independentlyVerifyCommercialPareto(points, objectives,
    { frontierIds: ["alpha"], dominatedIds: null }), /WALLE_PARETO_CLAIM_REQUIRED/);
});
