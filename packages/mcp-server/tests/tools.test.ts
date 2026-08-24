import { describe, expect, it } from "vitest";
import type { GitState, ProjectState } from "../src/contracts.js";
import { nexusProjects, nexusStatus } from "../src/tools.js";

const git: GitState = { branch: "feature/read", headSha: "a".repeat(40), detached: false, clean: true, changedPaths: [], remoteUrl: "https://github.com/example/repo.git" };
const clock = () => new Date("2026-08-24T00:00:00.000Z");

it("returns NOT_TESTED rather than inventing GitHub state when authentication is absent", async () => {
  const result = await nexusStatus({}, { root: "/repo", git: async () => git, clock, requestId: () => "request-1" });
  expect(result.status).toBe("NOT_TESTED");
  expect(result.data?.git.headSha).toBe(git.headSha);
  expect(result.data?.pullRequests).toEqual([]);
  expect(result.errors).toEqual([{ code: "GITHUB_AUTH_FAILED", message: "NEXUS_GITHUB_TOKEN is not configured", retryable: false }]);
});

it("returns real PR check failures when the GitHub adapter succeeds", async () => {
  const result = await nexusStatus({}, {
    root: "/repo", git: async () => git, githubToken: "secret", clock, requestId: () => "request-2",
    pullRequests: async () => [{ number: 7, title: "Change", url: "https://github.com/example/repo/pull/7", headBranch: "change", headSha: "b".repeat(40), baseBranch: "main", draft: false, state: "OPEN", mergeable: "MERGEABLE", ci: "FAIL", checks: [{ name: "test", status: "FAIL", conclusion: "failure", url: "https://github.com/run" }], redChecks: ["test"] }],
  });
  expect(result.status).toBe("PASS");
  expect(result.data?.pullRequests[0]?.redChecks).toEqual(["test"]);
  expect(result.evidence.some((item) => item.kind === "github")).toBe(true);
});

describe("nexus_projects", () => {
  it("returns evidence-bound project classifications", async () => {
    const projects: ProjectState[] = [{ slug: "client", path: "apps/client", packageName: "@nexus/client", workspaceMember: true, kind: "CLIENT", clientProject: true, evidence: { packageJsonPath: "apps/client/package.json", clientProjectDeclaration: true, classificationRule: "discoverClientApps" } }];
    const result = await nexusProjects({}, { root: "/repo", git: async () => git, projects: async () => projects, clock, requestId: () => "request-3" });
    expect(result.status).toBe("PASS");
    expect(result.data?.projects).toEqual(projects);
    expect(result.evidence).toContainEqual({ kind: "file", locator: "apps/client/package.json" });
  });

  it("fails loudly when project discovery cannot be verified", async () => {
    const result = await nexusProjects({}, { root: "/repo", git: async () => git, projects: async () => { throw new Error("invalid package.json"); }, clock, requestId: () => "request-4" });
    expect(result.status).toBe("FAIL");
    expect(result.data).toBeNull();
    expect(result.errors[0]?.code).toBe("PROJECT_MANIFEST_INVALID");
  });
});
