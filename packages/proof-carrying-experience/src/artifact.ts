import { createHash } from "node:crypto";
import { digestValue } from "@nexus/visual-algebra";
import type { ExperienceArtifact } from "./types.js";

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} cannot be empty`);
}

export function assertSourceRevision(value: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("sourceRevision must be a full lowercase git SHA-1");
}

export function artifactDigest(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createExperienceArtifact(input: {
  readonly subject: string;
  readonly mediaType: string;
  readonly sourceRevision: string;
  readonly content: string | Uint8Array;
}): ExperienceArtifact {
  nonEmpty(input.subject, "artifact subject");
  nonEmpty(input.mediaType, "artifact mediaType");
  assertSourceRevision(input.sourceRevision);
  const base = Object.freeze({
    authority: "NEXUS_EXPERIENCE_ARTIFACT_V1" as const,
    version: 1 as const,
    subject: input.subject,
    mediaType: input.mediaType,
    sourceRevision: input.sourceRevision,
    artifactDigest: artifactDigest(input.content),
  });
  return Object.freeze({ ...base, descriptorDigest: digestValue(base) });
}

export function validateExperienceArtifact(artifact: ExperienceArtifact): void {
  if (artifact.authority !== "NEXUS_EXPERIENCE_ARTIFACT_V1" || artifact.version !== 1) throw new Error("Unsupported experience artifact authority/version");
  nonEmpty(artifact.subject, "artifact subject");
  nonEmpty(artifact.mediaType, "artifact mediaType");
  assertSourceRevision(artifact.sourceRevision);
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.artifactDigest)) throw new Error("artifactDigest must be SHA-256");
  const { descriptorDigest, ...base } = artifact;
  if (!/^[a-f0-9]{64}$/.test(descriptorDigest) || digestValue(base) !== descriptorDigest) throw new Error("Experience artifact descriptor digest mismatch");
}
