import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV4 } from "../commercial-demand/tournament-engine-v4.mjs";
import { buildStrategyPageHandoff } from "../commercial-demand/strategy-page-handoff.mjs";

const fixtures = await Promise.all([
  "nexus-commercial-demand-v2.json",
  "service-intent-evidence-v3.json",
  "software-intent-evidence-v4.json",
].map((name) => readFile(new URL(`../commercial-demand/${name}`, import.meta.url), "utf8").then(JSON.parse)));
const report = runCommercialDemandTournamentV4(...fixtures.map((fixture) => structuredClone(fixture)));
const expected = {
  siteId: report.demandTournament.siteId,
  scenarioSha256: report.scenarioSha256,
  reportSha256: report.reportSha256,
};

function proposals() {
  return report.demandTournament.tournament.selectedStrategy.pageIds.map((pageId) => ({
    pageId,
    action: "IMPROVE",
    // Test identifiers only, NOT verified page bytes or real editorial receipts.
    contentSha256: `sha256:${createHash("sha256").update(`SYNTHETIC_TEST_ONLY:${pageId}`).digest("hex")}`,
    review: { editorial: "APPROVED", factualClaims: "APPROVED", policy: "APPROVED" },
  }));
}

function handoff(rows = proposals(), trusted = expected, source = report) {
  return buildStrategyPageHandoff(source, trusted, rows);
}

test("real V4 tournament winner binds exact page IDs without ever granting publication", () => {
  const result = handoff();
  assert.equal(result.selectedStrategyId, report.selectedStrategyId);
  assert.deepEqual(result.selectedPages.map((page) => page.pageId), report.demandTournament.tournament.selectedStrategy.pageIds);
  assert.equal(result.status, "REQUIRES_INDEPENDENT_GUARDIAN_EVIDENCE");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.clientMutationAuthorized, false);
  assert.match(result.handoffSha256, /^sha256:[0-9a-f]{64}$/);
});

test("missing winner page fails closed", () => {
  const rows = proposals();
  const missing = rows.pop();
  const result = handoff(rows);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.includes(`SELECTED_PAGE_MISSING:${missing.pageId}`));
  assert.equal(result.publicationAuthorized, false);
});

test("extra page not selected by tournament fails closed", () => {
  const rows = proposals();
  const unselected = report.demandTournament.architecture.pages.find((row) => !rows.some((item) => item.pageId === row.id));
  assert.ok(unselected, "fixture must have unselected catalog pages");
  rows.push({ ...rows[0], pageId: unselected.id, contentSha256: `sha256:${"f".repeat(64)}` });
  assert.ok(handoff(rows).blockers.includes(`PAGE_NOT_SELECTED:${unselected.id}`));
});

test("identical page content digests block the handoff", () => {
  const rows = proposals();
  rows[1].contentSha256 = rows[0].contentSha256;
  assert.ok(handoff(rows).blockers.includes(`IDENTICAL_CONTENT:${rows[0].pageId}:${rows[1].pageId}`));
});

test("missing, pending or rejected declared review blocks the handoff", () => {
  const rows = proposals();
  delete rows[0].review;
  rows[1].review.policy = "REJECTED";
  rows[2].review.editorial = "PENDING";
  const result = handoff(rows);
  for (const row of rows.slice(0, 3)) assert.ok(result.blockers.includes(`REVIEW_NOT_APPROVED:${row.pageId}`));
});

test("duplicate IDs and absent content digest are blockers", () => {
  const rows = proposals();
  rows.push({ ...rows[0], contentSha256: "missing" });
  const result = handoff(rows);
  assert.ok(result.blockers.includes(`DUPLICATE_PAGE_ID:${rows[0].pageId}`));
  assert.ok(result.blockers.includes(`MISSING_CONTENT_DIGEST:${rows[0].pageId}`));
});

test("wrong site or scenario cannot reuse a tournament result", () => {
  assert.throws(() => handoff(proposals(), { ...expected, siteId: "different-client" }), /site or scenario/);
  assert.throws(() => handoff(proposals(), { ...expected, scenarioSha256: `sha256:${"0".repeat(64)}` }), /site or scenario/);
});

test("a modified tournament winner cannot pass the trusted report digest", () => {
  const changed = structuredClone(report);
  changed.demandTournament.tournament.selectedStrategy.pageIds.pop();
  assert.throws(() => handoff(proposals(), expected, changed), /digest mismatch/);
  assert.throws(() => handoff(proposals(), { ...expected, reportSha256: `sha256:${"0".repeat(64)}` }), /untrusted tournament report digest/);
});

test("no input can grant publication permission through this planning API", () => {
  const blocked = handoff([]);
  const reviewed = handoff();
  for (const result of [blocked, reviewed]) {
    assert.equal(result.publicationAuthorized, false);
    assert.equal(result.clientMutationAuthorized, false);
  }
});
