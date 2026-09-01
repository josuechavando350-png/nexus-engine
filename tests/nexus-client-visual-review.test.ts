import { describe, expect, it, vi } from "vitest";
import { evaluateDigestBoundVisualReview, loadCommittedVisualReview } from "../scripts/nexus-client-visual-review.mjs";

const SHA = "a".repeat(40);
const BLOB = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    projectId: "client",
    sourceRevision: SHA,
    evidenceArtifacts: [{ artifactId: "shot-1", digest: DIGEST }],
    review: {
      reviewerType: "HUMAN",
      reviewerId: "director-1",
      rubricVersion: "rubric-v1",
      rubricDigest: `sha256:${"d".repeat(64)}`,
      verdict: "PASS",
      findings: [],
      evidenceArtifactIds: ["shot-1"],
      evidenceArtifactDigests: [DIGEST],
      reviewedAt: "2026-09-01T00:00:00.000Z",
    },
    ...overrides,
  });
}

function readOnlyWithBlobs(committed = BLOB, working = BLOB) {
  return async (_command: string, args: readonly string[]) => {
    if (args[0] === "status") return "";
    if (args[0] === "rev-parse") return committed;
    if (args[0] === "hash-object") return working;
    return "";
  };
}

describe("committed visual review evidence", () => {
  it("loads only a clean schema-v2 envelope whose working bytes equal the declared revision blob", async () => {
    const committed = await loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => envelope(),
    });
    expect(committed.evidenceArtifacts).toEqual([{ artifactId: "shot-1", digest: DIGEST }]);
    expect(committed.rawDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects legacy ID-only review envelopes instead of silently upgrading them", async () => {
    await expect(loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => envelope({ schemaVersion: 1 }),
    })).rejects.toThrow(/schemaVersion must be 2/);
  });

  it("rejects a working review file that differs from the blob in sourceRevision", async () => {
    await expect(loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(BLOB, "e".repeat(40)),
      reader: async () => envelope(),
    })).rejects.toThrow(/not identical to the declared sourceRevision blob/);
  });

  it("rejects an envelope whose review digest vector does not match its evidence bindings", async () => {
    const parsed = JSON.parse(envelope());
    parsed.review.evidenceArtifactDigests = [`sha256:${"f".repeat(64)}`];
    await expect(loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => JSON.stringify(parsed),
    })).rejects.toThrow(/evidenceArtifactDigests order must match/);
  });

  it("does not call the judge when current bytes no longer match the committed review digest", async () => {
    const committed = await loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => envelope(),
    });
    const evaluator = vi.fn();
    await expect(evaluateDigestBoundVisualReview({
      committed,
      artifacts: [{ artifactId: "shot-1", digest: `sha256:${"9".repeat(64)}` }],
      evaluator,
    })).rejects.toThrow(/not bound to current artifact bytes/);
    expect(evaluator).not.toHaveBeenCalled();
  });
});
