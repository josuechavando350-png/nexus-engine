import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import test from "node:test";
import { assertPublicationGuardian, __test as guardianTools } from "../commercial-demand/publication-guardian-gate.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const trustedReviewers = { reviewer_editorial: publicKeyPem, reviewer_factual: publicKeyPem, reviewer_policy: publicKeyPem };
const bytes = new TextEncoder().encode("pagina legal unica y verificable");
const contentSha256 = `sha256:${(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex")}`;
const handoffBase = { publicationAuthorized: false, clientMutationAuthorized: false, siteId: "fixture-site", scenarioSha256: guardianTools.sha256Canonical({ scenario: "fixture" }), selectedPages: [{ pageId: "page-1", contentSha256 }] };
const handoff = Object.freeze({ ...handoffBase, handoffSha256: guardianTools.sha256Canonical(handoffBase) });

function receipt(pageId, reviewType, reviewerId) {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const payload = { contentSha256, decision: "APPROVED", expiresAt, handoffSha256: handoff.handoffSha256, issuedAt, pageId, reviewType, reviewerId, scenarioSha256: handoff.scenarioSha256 };
  const signature = signPayload(null, Buffer.from(guardianTools.canonicalJson(payload), "utf8"), privateKey).toString("base64url");
  return { ...payload, signature };
}
function allReceipts() {
  return [receipt("page-1", "editorial", "reviewer_editorial"), receipt("page-1", "factualClaims", "reviewer_factual"), receipt("page-1", "policy", "reviewer_policy")];
}

test("allows a complete, independently signed three-review set", () => {
  const result = assertPublicationGuardian(handoff, [{ pageId: "page-1", bytes }], allReceipts(), trustedReviewers);
  assert.equal(result.allowed, true);
  assert.equal(result.publicationAuthorized, true);
  assert.equal(result.clientMutationAuthorized, false);
});

test("fails closed when bytes diverge from the approved digest", () => {
  const altered = new TextEncoder().encode("pagina legal modificada");
  assert.throws(() => assertPublicationGuardian(handoff, [{ pageId: "page-1", bytes: altered }], allReceipts(), trustedReviewers), /byte-hash/);
});

test("fails closed when any review type is missing", () => {
  const receipts = allReceipts().slice(0, 2);
  assert.throws(() => assertPublicationGuardian(handoff, [{ pageId: "page-1", bytes }], receipts, trustedReviewers), /policy:missing/);
});

test("fails closed for an untrusted reviewer", () => {
  const receipts = allReceipts();
  receipts[0] = { ...receipts[0], reviewerId: "unknown" };
  assert.throws(() => assertPublicationGuardian(handoff, [{ pageId: "page-1", bytes }], receipts, trustedReviewers), /untrusted-reviewer/);
});

test("fails closed for a signature over different content", () => {
  const receipts = allReceipts();
  receipts[1] = { ...receipts[1], contentSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
  assert.throws(() => assertPublicationGuardian(handoff, [{ pageId: "page-1", bytes }], receipts, trustedReviewers), /content/);
});
