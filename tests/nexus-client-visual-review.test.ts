import { describe, expect, it, vi } from "vitest";
import { evaluateDigestBoundVisualReview, loadCommittedVisualReview } from "../scripts/nexus-client-visual-review.mjs";

const SHA = "a".repeat(40);
const BLOB = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 3,
    projectId: "client",
    evidenceScreenshots: [{ browser: "chromium", viewport: "mobile-390", digest: DIGEST }],
    review: {
      reviewerType: "HUMAN",
      reviewerId: "director-1",
      rubricVersion: "rubric-v1",
      rubricDigest: `sha256:${"d".repeat(64)}`,
      verdict: "PASS",
      findings: [],
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

function screenshot(artifactId: string, digest = DIGEST) {
  return {
    artifactId,
    capability: "SCREENSHOT",
    digest,
    metadata: { browser: "chromium", viewport: "mobile-390" },
  };
}

describe("committed visual review evidence", () => {
  it("loads a clean schema-v3 envelope whose stable screenshot binding is committed in the active revision", async () => {
    const committed = await loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => envelope(),
    });
    expect(committed.evidenceScreenshots).toEqual([{ browser: "chromium", viewport: "mobile-390", digest: DIGEST, key: "chromium::mobile-390" }]);
    expect(committed.sourceRevision).toBe(SHA);
    expect(committed.blobSha).toBe(BLOB);
    expect(committed.rawDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("rejects schema-v2 transient artifact-id envelopes instead of preserving the circular contract", async () => {
    await expect(loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => envelope({ schemaVersion: 2 }),
    })).rejects.toThrow(/schemaVersion must be 3/);
  });

  it("rejects self-declared sourceRevision because commit identity is verified externally", async () => {
    await expect(loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => envelope({ sourceRevision: SHA }),
    })).rejects.toThrow(/must not self-declare sourceRevision/);
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

  it("rejects persisted transient artifact vectors inside schema-v3 review payloads", async () => {
    const parsed = JSON.parse(envelope());
    parsed.review.evidenceArtifactIds = ["old-run-shot"];
    parsed.review.evidenceArtifactDigests = [DIGEST];
    await expect(loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => JSON.stringify(parsed),
    })).rejects.toThrow(/must not persist transient artifact IDs/);
  });

  it("remaps a stable reviewed screenshot to a fresh artifact ID when browser, viewport and bytes are identical", async () => {
    const committed = await loadCommittedVisualReview({
      root: "/repo",
      relativePath: "evidence/client-review.json",
      projectId: "client",
      sourceRevision: SHA,
      readOnly: readOnlyWithBlobs(),
      reader: async () => envelope(),
    });
    const evaluator = vi.fn(async ({ review }: { review: { evidenceArtifactIds: readonly string[]; evidenceArtifactDigests: readonly string[] } }) => ({
      authority: "NEXUS_VISUAL_JUDGE",
      verdict: "PASS",
      approved: true,
      integrityVerdict: "PASS",
      reviewVerdict: "PASS",
      findings: [],
      verifiedArtifactIds: review.evidenceArtifactIds,
    }));
    const result = await evaluateDigestBoundVisualReview({
      committed,
      artifacts: [screenshot("fresh-run-shot")],
      evaluator,
    });
    expect(result.report.verdict).toBe("PASS");
    expect(evaluator).toHaveBeenCalledWith(expect.objectContaining({
      review: expect.objectContaining({
        evidenceArtifactIds: ["fresh-run-shot"],
        evidenceArtifactDigests: [DIGEST],
      }),
    }));
  });

  it("does not call the judge when current screenshot bytes no longer match the committed stable binding", async () => {
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
      artifacts: [screenshot("fresh-run-shot", `sha256:${"9".repeat(64)}`)],
      evaluator,
    })).rejects.toThrow(/not bound to current screenshot bytes/);
    expect(evaluator).not.toHaveBeenCalled();
  });
});
