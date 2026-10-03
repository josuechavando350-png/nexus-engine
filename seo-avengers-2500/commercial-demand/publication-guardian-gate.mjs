import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const DECISIONS = new Set(["APPROVED"]);
const REVIEW_TYPES = ["editorial", "factualClaims", "policy"];
const PUBLICATION_BLOCKED = "PUBLICATION_BLOCKED";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function text(value, name) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) throw new TypeError(`${name} must be a non-empty trimmed string`);
  return value;
}
function hash(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${name} must be sha256:<64 lowercase hex>`);
  return value;
}
function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(typeof value === "string" ? value.normalize("NFC") : value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw new TypeError("guardian numbers must be safe integers"); return String(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => [k.normalize("NFC"), v]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const seen = new Set();
    return `{${entries.map(([k, v]) => { if (seen.has(k)) throw new TypeError("normalized key collision"); seen.add(k); return `${JSON.stringify(k)}:${canonicalJson(v)}`; }).join(",")}}`;
  }
  throw new TypeError("guardian values must be JSON-compatible");
}
function sha256Canonical(value) { return `sha256:${createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex")}`; }

function verifyReceipt(raw, expected, trustedReviewers) {
  const receipt = object(raw, "guardian receipt");
  const required = ["contentSha256", "decision", "expiresAt", "handoffSha256", "issuedAt", "pageId", "reviewType", "reviewerId", "scenarioSha256", "signature"];
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([...required].sort())) throw new Error("guardian receipt keys are invalid");
  const pageId = text(receipt.pageId, "receipt.pageId");
  const reviewType = text(receipt.reviewType, "receipt.reviewType");
  if (!REVIEW_TYPES.includes(reviewType)) throw new Error(`unsupported review type: ${reviewType}`);
  if (receipt.decision !== "APPROVED" || !DECISIONS.has(receipt.decision)) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${reviewType}:decision`);
  if (!HASH.test(receipt.contentSha256) || receipt.contentSha256 !== expected.contentSha256) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${reviewType}:content`);
  if (receipt.handoffSha256 !== expected.handoffSha256 || receipt.scenarioSha256 !== expected.scenarioSha256) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${reviewType}:binding`);
  const reviewerId = text(receipt.reviewerId, "receipt.reviewerId");
  const publicKeyPem = trustedReviewers[reviewerId];
  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${reviewType}:untrusted-reviewer`);
  const issuedAt = Date.parse(receipt.issuedAt), expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${reviewType}:time`);
  if (expiresAt <= Date.now()) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${reviewType}:expired`);
  const payload = { contentSha256: receipt.contentSha256, decision: receipt.decision, expiresAt: receipt.expiresAt, handoffSha256: receipt.handoffSha256, issuedAt: receipt.issuedAt, pageId, reviewType, reviewerId, scenarioSha256: receipt.scenarioSha256 };
  const signature = Buffer.from(text(receipt.signature, "receipt.signature"), "base64url");
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(canonicalJson(payload), "utf8"), createPublicKey(publicKeyPem), signature); } catch { valid = false; }
  if (!valid) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${reviewType}:signature`);
  return Object.freeze({ pageId, reviewType, reviewerId, contentSha256: receipt.contentSha256 });
}

/**
 * Fail-closed publication boundary. This function never publishes; it only
 * proves that a publisher may proceed after independently signed reviews.
 */
export function assertPublicationGuardian(handoff, pageBytes, receipts, trustedReviewers) {
  const handoffValue = object(handoff, "handoff");
  if (handoffValue.publicationAuthorized !== false || handoffValue.clientMutationAuthorized !== false) throw new Error(`${PUBLICATION_BLOCKED}:handoff-boundary`);
  const handoffSha256 = hash(handoffValue.handoffSha256, "handoff.handoffSha256");
  const scenarioSha256 = hash(handoffValue.scenarioSha256, "handoff.scenarioSha256");
  if (!Array.isArray(handoffValue.selectedPages) || handoffValue.selectedPages.length === 0) throw new Error(`${PUBLICATION_BLOCKED}:no-pages`);
  if (!Array.isArray(receipts)) throw new TypeError("receipts must be an array");
  const pageMap = new Map(pageBytes.map((row) => [text(row.pageId, "pageBytes.pageId"), row.bytes]));
  const expectedPages = new Map();
  for (const page of handoffValue.selectedPages) {
    const id = text(page.pageId, "handoff.selectedPages.pageId");
    const contentSha256 = hash(page.contentSha256, `${id}.contentSha256`);
    if (expectedPages.has(id)) throw new Error(`${PUBLICATION_BLOCKED}:${id}:duplicate-page`);
    const bytes = pageMap.get(id);
    if (!(bytes instanceof Uint8Array)) throw new Error(`${PUBLICATION_BLOCKED}:${id}:missing-bytes`);
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== contentSha256) throw new Error(`${PUBLICATION_BLOCKED}:${id}:byte-hash`);
    expectedPages.set(id, { contentSha256 });
  }
  if (pageMap.size !== expectedPages.size) throw new Error(`${PUBLICATION_BLOCKED}:unexpected-page`);
  const seen = new Set();
  const approved = new Map();
  for (const raw of receipts) {
    const expected = expectedPages.get(raw?.pageId);
    if (!expected) throw new Error(`${PUBLICATION_BLOCKED}:receipt-for-unselected-page`);
    const verified = verifyReceipt(raw, { ...expected, handoffSha256, scenarioSha256 }, trustedReviewers);
    const key = `${verified.pageId}:${verified.reviewType}`;
    if (seen.has(key)) throw new Error(`${PUBLICATION_BLOCKED}:${key}:duplicate-receipt`);
    seen.add(key);
    if (!approved.has(verified.pageId)) approved.set(verified.pageId, new Set());
    approved.get(verified.pageId).add(verified.reviewType);
  }
  for (const [pageId] of expectedPages) {
    const types = approved.get(pageId) ?? new Set();
    for (const type of REVIEW_TYPES) if (!types.has(type)) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:${type}:missing`);
  }
  for (const [pageId, types] of approved) {
    if (types.size !== REVIEW_TYPES.length) throw new Error(`${PUBLICATION_BLOCKED}:${pageId}:incomplete`);
  }
  return Object.freeze({ allowed: true, publicationAuthorized: true, clientMutationAuthorized: false, siteId: text(handoffValue.siteId, "handoff.siteId"), scenarioSha256, handoffSha256, pageCount: expectedPages.size });
}

export const __test = Object.freeze({ canonicalJson, sha256Canonical });
