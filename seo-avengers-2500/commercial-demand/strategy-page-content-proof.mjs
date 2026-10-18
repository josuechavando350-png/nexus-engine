import { createHash } from "node:crypto";

import { __test as tournamentTools } from "./tournament-engine-v2.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PAGES = 200;
const HANDOFF_BOUNDARY = "DECLARED_REVIEWS_AND_CONTENT_DIGESTS_ARE_NOT_VERIFIED_RECEIPTS_OR_CONTENT_BYTES";

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function hash(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${name} must be a sha256 digest`);
  return value;
}

/**
 * Byte-equality proof ONLY. `trusted` must be supplied independently of the
 * artifact producer, and `artifacts[].bytes` must come from the actual files to
 * be reviewed. A SHA-256 match cannot establish editorial originality, source
 * provenance, a genuine Avengers/guardian receipt, or publication readiness.
 * This function has no filesystem/network/publisher side effects.
 */
export function verifyStrategyPageContent(rawHandoff, rawTrusted, rawArtifacts) {
  const handoff = object(rawHandoff, "handoff");
  const trusted = object(rawTrusted, "trusted");
  const unsignedHandoff = { ...handoff };
  delete unsignedHandoff.handoffSha256;
  const handoffSha256 = hash(handoff.handoffSha256, "handoff.handoffSha256");
  if (tournamentTools.sha256Canonical(unsignedHandoff) !== handoffSha256) {
    throw new Error("handoff digest mismatch");
  }
  if (handoff.schemaVersion !== 1 || handoff.status !== "REQUIRES_INDEPENDENT_GUARDIAN_EVIDENCE"
    || !Array.isArray(handoff.blockers) || handoff.blockers.length !== 0
    || handoff.publicationAuthorized !== false || handoff.clientMutationAuthorized !== false
    || handoff.boundary !== HANDOFF_BOUNDARY) {
    throw new Error("handoff is blocked, mutated or has an unsupported contract");
  }
  if (handoffSha256 !== hash(trusted.handoffSha256, "trusted.handoffSha256")
    || text(handoff.siteId, "handoff.siteId") !== text(trusted.siteId, "trusted.siteId")
    || hash(handoff.tournamentReportSha256, "handoff.tournamentReportSha256")
      !== hash(trusted.tournamentReportSha256, "trusted.tournamentReportSha256")) {
    throw new Error("handoff does not match independently retained decision");
  }

  const selected = handoff.selectedPages;
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > MAX_PAGES) {
    throw new Error("invalid selected page set");
  }
  const selectedById = new Map();
  for (const rawPage of selected) {
    const page = object(rawPage, "selected page");
    const id = text(page.pageId, "selected page ID");
    if (selectedById.has(id)) throw new Error("duplicate selected page ID");
    selectedById.set(id, hash(page.contentSha256, `handoff content digest: ${id}`));
  }
  const selectedIds = [...selectedById.keys()];
  const selectedSet = new Set(selectedIds);
  const expectedDigests = object(trusted.contentSha256ByPageId, "trusted.contentSha256ByPageId");
  const expectedIds = Object.keys(expectedDigests);
  if (expectedIds.length !== selectedIds.length || expectedIds.some((id) => !selectedSet.has(id))) {
    throw new Error("trusted content digest set does not match selected pages");
  }
  for (const id of selectedIds) {
    if (!Object.hasOwn(expectedDigests, id)) throw new Error(`missing trusted content digest: ${id}`);
    if (hash(expectedDigests[id], `trusted content digest: ${id}`) !== selectedById.get(id)) {
      throw new Error(`trusted content digest differs from declared handoff: ${id}`);
    }
  }

  if (!Array.isArray(rawArtifacts)) throw new TypeError("artifacts must be an array");
  const blockers = [];
  const seen = new Set();
  const seenDigests = new Map();
  const actual = new Map();
  let totalBytes = 0;
  for (const rawArtifact of rawArtifacts) {
    const artifact = object(rawArtifact, "artifact");
    const id = text(artifact.pageId, "artifact.pageId");
    if (seen.has(id)) {
      blockers.push(`DUPLICATE_PAGE_ID:${id}`);
      continue;
    }
    seen.add(id);
    if (!selectedSet.has(id)) {
      blockers.push(`PAGE_NOT_SELECTED:${id}`);
      continue;
    }
    if (!Buffer.isBuffer(artifact.bytes) || artifact.bytes.length === 0) {
      blockers.push(`MISSING_PAGE_BYTES:${id}`);
      continue;
    }
    if (artifact.bytes.length > MAX_PAGE_BYTES || totalBytes + artifact.bytes.length > MAX_TOTAL_BYTES) {
      blockers.push(`PAGE_BYTES_LIMIT_EXCEEDED:${id}`);
      continue;
    }
    totalBytes += artifact.bytes.length;
    const contentSha256 = `sha256:${createHash("sha256").update(artifact.bytes).digest("hex")}`;
    const previousId = seenDigests.get(contentSha256);
    if (previousId) blockers.push(`IDENTICAL_CONTENT:${previousId}:${id}`);
    seenDigests.set(contentSha256, id);
    if (contentSha256 !== expectedDigests[id]) {
      blockers.push(`CONTENT_BYTES_DIGEST_MISMATCH:${id}`);
      continue;
    }
    actual.set(id, { pageId: id, contentSha256, byteLength: artifact.bytes.length });
  }
  for (const id of selectedIds) if (!seen.has(id)) blockers.push(`SELECTED_PAGE_BYTES_MISSING:${id}`);

  const result = {
    schemaVersion: 1,
    status: blockers.length ? "BLOCKED" : "VERIFIED_BYTES_REQUIRES_INDEPENDENT_GUARDIAN_EVIDENCE",
    siteId: handoff.siteId,
    handoffSha256,
    tournamentReportSha256: handoff.tournamentReportSha256,
    verifiedPages: selectedIds.flatMap((id) => actual.has(id) ? [actual.get(id)] : []),
    blockers,
    guardianReceiptsVerified: false,
    publicationAuthorized: false,
    clientMutationAuthorized: false,
    boundary: "MATCHED_SUPPLIED_CONTENT_BYTES_ONLY_NOT_SOURCE_PROVENANCE_EDITORIAL_APPROVAL_OR_PUBLISHER_AUTHORIZATION",
  };
  return Object.freeze({ ...result, contentProofSha256: tournamentTools.sha256Canonical(result) });
}
