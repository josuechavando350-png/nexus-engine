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

function validateEvidenceBindings(value, review) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("visual review envelope evidenceArtifacts must be a non-empty array");
  const bindings = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`visual review evidenceArtifacts[${index}] must be an object`);
    if (typeof item.artifactId !== "string" || !item.artifactId.trim()) throw new Error(`visual review evidenceArtifacts[${index}].artifactId is required`);
    if (typeof item.digest !== "string" || !SHA256.test(item.digest)) throw new Error(`visual review evidenceArtifacts[${index}].digest must be canonical sha256`);
    return Object.freeze({ artifactId: item.artifactId.trim(), digest: item.digest });
  });
  if (new Set(bindings.map((item) => item.artifactId)).size !== bindings.length) throw new Error("visual review evidence artifact IDs must be unique");
  if (!Array.isArray(review.evidenceArtifactIds) || review.evidenceArtifactIds.length !== bindings.length) throw new Error("visual review evidenceArtifactIds must match evidenceArtifacts exactly");
  if (review.evidenceArtifactIds.some((artifactId, index) => artifactId !== bindings[index]?.artifactId)) throw new Error("visual review evidenceArtifactIds order must match evidenceArtifacts");
  if (!Array.isArray(review.evidenceArtifactDigests) || review.evidenceArtifactDigests.length !== bindings.length) throw new Error("visual review evidenceArtifactDigests must match evidenceArtifacts exactly");
  if (review.evidenceArtifactDigests.some((digest, index) => digest !== bindings[index]?.digest)) throw new Error("visual review evidenceArtifactDigests order must match evidenceArtifacts");
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
  if (envelope.schemaVersion !== 2) throw new Error("visual review envelope schemaVersion must be 2 for digest-bound evidence");
  if (envelope.projectId !== input.projectId) throw new Error(`visual review projectId ${envelope.projectId ?? "missing"} does not match ${input.projectId}`);
  if (envelope.sourceRevision !== input.sourceRevision) throw new Error(`visual review sourceRevision ${envelope.sourceRevision ?? "missing"} does not match ${input.sourceRevision}`);
  if (!envelope.review || typeof envelope.review !== "object" || Array.isArray(envelope.review)) throw new Error("visual review envelope is missing review payload");
  const evidenceArtifacts = validateEvidenceBindings(envelope.evidenceArtifacts, envelope.review);
  return Object.freeze({ envelope, evidenceArtifacts, rawDigest: sha256Text(raw), path: reviewPath });
}

export async function evaluateDigestBoundVisualReview(input) {
  const evaluator = input.evaluator ?? judgeVisualEvidence;
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const mismatches = [];
  for (const binding of input.committed.evidenceArtifacts) {
    const artifact = artifactById.get(binding.artifactId);
    if (!artifact) mismatches.push(`${binding.artifactId}:missing`);
    else if (artifact.digest !== binding.digest) mismatches.push(`${binding.artifactId}:digest-mismatch`);
  }
  if (mismatches.length) throw new Error(`visual review is not bound to current artifact bytes: ${mismatches.join(", ")}`);
  const report = await evaluator({ artifacts: input.artifacts, review: input.committed.envelope.review });
  return Object.freeze({
    report,
    evidenceIds: Object.freeze([input.committed.rawDigest, ...input.committed.evidenceArtifacts.map((item) => item.digest)]),
  });
}
