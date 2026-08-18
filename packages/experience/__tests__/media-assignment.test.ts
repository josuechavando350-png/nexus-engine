import { describe, expect, it } from "vitest";
import { assignMediaRoles, type MediaAssignmentCandidate } from "../media-assignment";

const candidates: MediaAssignmentCandidate[] = [
  { assetId: "wide-interior", filePath: "/tmp/wide.jpg", publicPath: "/media/wide.jpg", sourceDigest: `sha256:${"1".repeat(64)}`, source: "client", rights: "CLIENT_SUPPLIED", observedContent: "wide bright interior environment and real service context", width: 1600, height: 900 },
  { assetId: "work-detail", filePath: "/tmp/detail.jpg", publicPath: "/media/detail.jpg", sourceDigest: `sha256:${"2".repeat(64)}`, source: "client", rights: "CLIENT_SUPPLIED", observedContent: "working process with equipment and technology detail", width: 1400, height: 1100 },
  { assetId: "entrance", filePath: "/tmp/entrance.jpg", publicPath: "/media/entrance.jpg", sourceDigest: `sha256:${"3".repeat(64)}`, source: "client", rights: "CLIENT_SUPPLIED", observedContent: "entrance signage and location context", width: 900, height: 1400 },
  { assetId: "action-wide", filePath: "/tmp/action.jpg", publicPath: "/media/action.jpg", sourceDigest: `sha256:${"4".repeat(64)}`, source: "client", rights: "CLIENT_SUPPLIED", observedContent: "wide action process in the real interior environment", width: 1600, height: 1000 },
];

describe("autonomous media role assignment", () => {
  it("assigns distinct authorized assets from generic semantic evidence and is deterministic", () => {
    const requiredRoles = ["hero-media", "proof-media", "documentary-context", "cinematic-sequence"];
    const first = assignMediaRoles({ requiredRoles, candidates });
    const second = assignMediaRoles({ requiredRoles, candidates });
    expect(first).toEqual(second);
    expect(first.assignments.map((item) => item.assetId).length).toBe(new Set(first.assignments.map((item) => item.assetId)).size);
    expect(first.assignments.find((item) => item.role === "proof-media")?.assetId).toBe("work-detail");
    expect(first.assignments.find((item) => item.role === "documentary-context")?.assetId).toBe("entrance");
    expect(first.assignmentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails closed when there are fewer authorized candidates than required distinct roles", () => {
    expect(() => assignMediaRoles({ requiredRoles: ["hero-media", "proof-media"], candidates: candidates.slice(0, 1) })).toThrow(/requires 2 distinct assets/);
  });

  it("does not infer rights or provenance for a malformed candidate", () => {
    expect(() => assignMediaRoles({ requiredRoles: ["hero-media"], candidates: [{ ...candidates[0]!, sourceDigest: "sha256:not-real" as `sha256:${string}` }] })).toThrow(/canonical sourceDigest/);
  });
});
