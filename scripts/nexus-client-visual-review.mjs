import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { runReadOnly } from "../packages/mcp-server/src/process.ts";
import { judgeVisualEvidence } from "../packages/quality/visual-judge.ts";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function repositoryPath(root, candidate, label) {
  const absolute = resolve(root, candidate);
  const normalizedRoot = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(normalizedRoot)) throw new Error(`${label} must stay inside repository root`);
  return { absolute, relative: absolute.slice(normalizedRoot.length).split(sep).join("/") };
}

export function sha256Text(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function evidenceKey(browser, viewport) {
  return `${browser.trim().toLowerCase()}::${viewport.trim().toLowerCase()}`;
}

function validateEvidenceBindings(value, review) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("visual review envelope evidenceScreenshots must be a non-empty array");
  const bindings = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`visual review evidenceScreenshots[${index}] must be an object`);
    const browser = nonEmpty(item.browser, `visual review evidenceScreenshots[${index}].browser`);
    const viewport = nonEmpty(item.viewport, `visual review evidenceScreenshots[${index}].viewport`);
    if (typeof item.digest !== "string" || !SHA256.test(item.digest)) throw new Error(`visual review evidenceScreenshots[${index}].digest must be canonical sha256`);
    return Object.freeze({ browser, viewport, digest: item.digest, key: evidenceKey(browser, viewport) });
  });
  if (new Set(bindings.map((item) => item.key)).size !== bindings.length) throw new Error("visual review evidence screenshot browser/viewport pairs must be unique");
  if (review.evidenceArtifactIds !== undefined || review.evidenceArtifactDigests !== undefined) {
    throw new Error("visual review schema-v3 must not persist transient artifact IDs or artifact digest vectors inside review");
  }
  return Object.freeze(bindings);
}

export async function loadCommittedVisualReview(input) {
  const readOnly = input.readOnly ?? runReadOnly;
  const reader = input.reader ?? ((path) => readFile(path, "utf8"));
  const reviewPath = repositoryPath(input.root, input.relativePath, "visual review file");
  const dirtyReview = (await readOnly("git", ["status", "--porcelain", "--", reviewPath.relative], input.root)).trim();
  if (dirtyReview) throw new Error("visual review evidence must be committed before it can be bound to sourceRevision");
  const committedBlob = (await readOnly("git", ["rev-parse", `${input.sourceRevision}:${reviewPath.relative}`], input.root)).trim();
  const workingBlob = (await readOnly("git", ["hash-object", "--", reviewPath.relative], input.root)).trim();
  if (!/^[a-f0-9]{40}$/.test(committedBlob) || committedBlob !== workingBlob) throw new Error("visual review bytes are not identical to the declared sourceRevision blob");
  const raw = await reader(reviewPath.absolute);
  const envelope = JSON.parse(raw);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("visual review envelope must be an object");
  if (envelope.schemaVersion !== 3) throw new Error("visual review envelope schemaVersion must be 3 for stable digest-bound evidence");
  if (envelope.projectId !== input.projectId) throw new Error(`visual review projectId ${envelope.projectId ?? "missing"} does not match ${input.projectId}`);
  if (Object.hasOwn(envelope, "sourceRevision")) throw new Error("visual review schema-v3 must not self-declare sourceRevision; commit identity is supplied by the verified repository revision");
  if (!envelope.review || typeof envelope.review !== "object" || Array.isArray(envelope.review)) throw new Error("visual review envelope is missing review payload");
  const evidenceScreenshots = validateEvidenceBindings(envelope.evidenceScreenshots, envelope.review);
  return Object.freeze({ envelope, evidenceScreenshots, rawDigest: sha256Text(raw), path: reviewPath, blobSha: committedBlob, sourceRevision: input.sourceRevision });
}

function currentScreenshotIndex(artifacts) {
  const byKey = new Map();
  for (const artifact of artifacts) {
    if (artifact.capability !== "SCREENSHOT") continue;
    const browser = artifact.metadata?.browser;
    const viewport = artifact.metadata?.viewport;
    if (!browser || !viewport) throw new Error(`screenshot artifact ${artifact.artifactId} is missing browser/viewport metadata`);
    if (typeof artifact.digest !== "string" || !SHA256.test(artifact.digest)) throw new Error(`screenshot artifact ${artifact.artifactId} has a non-canonical digest`);
    const key = evidenceKey(browser, viewport);
    if (byKey.has(key)) throw new Error(`current capture contains duplicate screenshot evidence for ${key}`);
    byKey.set(key, artifact);
  }
  return byKey;
}

export async function evaluateDigestBoundVisualReview(input) {
  const evaluator = input.evaluator ?? judgeVisualEvidence;
  const screenshots = currentScreenshotIndex(input.artifacts);
  const matched = [];
  const mismatches = [];
  for (const binding of input.committed.evidenceScreenshots) {
    const artifact = screenshots.get(binding.key);
    if (!artifact) mismatches.push(`${binding.key}:missing`);
    else if (artifact.digest !== binding.digest) mismatches.push(`${binding.key}:digest-mismatch`);
    else matched.push(artifact);
  }
  if (mismatches.length) throw new Error(`visual review is not bound to current screenshot bytes: ${mismatches.join(", ")}`);

  const review = Object.freeze({
    ...input.committed.envelope.review,
    evidenceArtifactIds: Object.freeze(matched.map((artifact) => artifact.artifactId)),
    evidenceArtifactDigests: Object.freeze(matched.map((artifact) => artifact.digest)),
  });
  const report = await evaluator({ artifacts: input.artifacts, review });
  return Object.freeze({
    report,
    evidenceIds: Object.freeze([input.committed.rawDigest, ...input.committed.evidenceScreenshots.map((item) => item.digest)]),
  });
}
