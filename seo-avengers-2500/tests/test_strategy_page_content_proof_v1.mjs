import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCommercialDemandTournamentV4 } from "../commercial-demand/tournament-engine-v4.mjs";
import { buildStrategyPageHandoff } from "../commercial-demand/strategy-page-handoff.mjs";
import { verifyStrategyPageContent } from "../commercial-demand/strategy-page-content-proof.mjs";

const sources = await Promise.all([
  "nexus-commercial-demand-v2.json",
  "service-intent-evidence-v3.json",
  "software-intent-evidence-v4.json",
].map((name) => readFile(new URL(`../commercial-demand/${name}`, import.meta.url), "utf8").then(JSON.parse)));
const tournament = runCommercialDemandTournamentV4(...sources.map((source) => structuredClone(source)));
const decision = {
  siteId: tournament.demandTournament.siteId,
  scenarioSha256: tournament.scenarioSha256,
  reportSha256: tournament.reportSha256,
};
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixture() {
  // Synthetic content only. None of these bytes or declarations is a real client
  // page, independent approval, or genuine Avengers/guardian receipt.
  const artifacts = tournament.demandTournament.tournament.selectedStrategy.pageIds.map((pageId) => ({
    pageId, bytes: Buffer.from(`SYNTHETIC_TEST_PAGE_ONLY\n${pageId}\n`, "utf8"),
  }));
  const proposals = artifacts.map(({ pageId, bytes }) => ({
    pageId,
    action: "IMPROVE",
    contentSha256: digest(bytes),
    review: { editorial: "APPROVED", factualClaims: "APPROVED", policy: "APPROVED" },
  }));
  const handoff = buildStrategyPageHandoff(tournament, decision, proposals);
  const contentSha256ByPageId = Object.fromEntries(artifacts.map(({ pageId, bytes }) => [pageId, digest(bytes)]));
  const trusted = {
    handoffSha256: handoff.handoffSha256,
    siteId: decision.siteId,
    tournamentReportSha256: decision.reportSha256,
    contentSha256ByPageId,
  };
  return { artifacts, proposals, handoff, trusted };
}

test("actual supplied bytes match independently retained selected-page digests; no guardian or publish permission", () => {
  const { handoff, trusted, artifacts } = fixture();
  const result = verifyStrategyPageContent(handoff, trusted, artifacts);
  assert.equal(result.status, "VERIFIED_BYTES_REQUIRES_INDEPENDENT_GUARDIAN_EVIDENCE");
  assert.equal(result.verifiedPages.length, handoff.selectedPages.length);
  assert.deepEqual(result.verifiedPages.map(({ pageId }) => pageId), handoff.selectedPages.map(({ pageId }) => pageId));
  assert.deepEqual(result.blockers, []);
  assert.equal(result.guardianReceiptsVerified, false);
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.clientMutationAuthorized, false);
  assert.match(result.contentProofSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(result).includes("SYNTHETIC_TEST_PAGE_ONLY"), false);
});

test("one byte changes after the planning snapshot: fail closed", () => {
  const { handoff, trusted, artifacts } = fixture();
  artifacts[0].bytes = Buffer.from(artifacts[0].bytes);
  artifacts[0].bytes[0] ^= 1;
  const result = verifyStrategyPageContent(handoff, trusted, artifacts);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.includes(`CONTENT_BYTES_DIGEST_MISMATCH:${artifacts[0].pageId}`));
  assert.equal(result.publicationAuthorized, false);
});

test("missing, extra and duplicate artifact identities fail closed", () => {
  const { handoff, trusted, artifacts } = fixture();
  const missing = artifacts.pop();
  artifacts.push({ pageId: "UNSELECTED_TEST_PAGE", bytes: Buffer.from("extra") });
  artifacts.push({ ...artifacts[0] });
  const result = verifyStrategyPageContent(handoff, trusted, artifacts);
  assert.ok(result.blockers.includes(`SELECTED_PAGE_BYTES_MISSING:${missing.pageId}`));
  assert.ok(result.blockers.includes("PAGE_NOT_SELECTED:UNSELECTED_TEST_PAGE"));
  assert.ok(result.blockers.includes(`DUPLICATE_PAGE_ID:${artifacts[0].pageId}`));
});

test("identical bytes cannot be disguised by separate page IDs", () => {
  const { handoff, trusted, artifacts } = fixture();
  artifacts[1].bytes = Buffer.from(artifacts[0].bytes);
  const result = verifyStrategyPageContent(handoff, trusted, artifacts);
  assert.ok(result.blockers.includes(`IDENTICAL_CONTENT:${artifacts[0].pageId}:${artifacts[1].pageId}`));
  assert.ok(result.blockers.includes(`CONTENT_BYTES_DIGEST_MISMATCH:${artifacts[1].pageId}`));
});

test("missing bytes, non-buffer contents and excessive page bytes are blockers", () => {
  const { handoff, trusted, artifacts } = fixture();
  artifacts[0].bytes = Buffer.alloc(0);
  artifacts[1].bytes = "this is not source bytes";
  artifacts[2].bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  const result = verifyStrategyPageContent(handoff, trusted, artifacts);
  assert.ok(result.blockers.includes(`MISSING_PAGE_BYTES:${artifacts[0].pageId}`));
  assert.ok(result.blockers.includes(`MISSING_PAGE_BYTES:${artifacts[1].pageId}`));
  assert.ok(result.blockers.includes(`PAGE_BYTES_LIMIT_EXCEEDED:${artifacts[2].pageId}`));
});

test("trusted content digest set must match the strategy exactly", () => {
  const { handoff, trusted, artifacts } = fixture();
  delete trusted.contentSha256ByPageId[artifacts[0].pageId];
  assert.throws(() => verifyStrategyPageContent(handoff, trusted, artifacts), /trusted content digest set/);
  trusted.contentSha256ByPageId[artifacts[0].pageId] = "sha256:bad";
  assert.throws(() => verifyStrategyPageContent(handoff, trusted, artifacts), /trusted content digest/);
});

test("no stale, cross-site, tampered or blocked handoff may be verified", () => {
  const { handoff, trusted, artifacts } = fixture();
  assert.throws(() => verifyStrategyPageContent(handoff, { ...trusted, siteId: "another-tenant" }, artifacts), /independently retained/);
  assert.throws(() => verifyStrategyPageContent(handoff, { ...trusted, handoffSha256: `sha256:${"0".repeat(64)}` }, artifacts), /independently retained/);
  assert.throws(() => verifyStrategyPageContent({ ...handoff, publicationAuthorized: true }, trusted, artifacts), /digest mismatch/);
  const blocked = buildStrategyPageHandoff(tournament, decision, []);
  assert.throws(() => verifyStrategyPageContent(blocked, { ...trusted, handoffSha256: blocked.handoffSha256 }, artifacts), /blocked, mutated/);
});

test("passing bytes with declared approvals still never supplies an authentic guardian receipt", () => {
  const { handoff, trusted, artifacts } = fixture();
  const result = verifyStrategyPageContent(handoff, trusted, artifacts);
  assert.equal(result.status, "VERIFIED_BYTES_REQUIRES_INDEPENDENT_GUARDIAN_EVIDENCE");
  assert.equal(result.guardianReceiptsVerified, false);
  assert.equal(result.publicationAuthorized, false);
});
