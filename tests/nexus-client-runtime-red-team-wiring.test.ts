import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceClientRuntimeAdapters } from "../scripts/nexus-client-runtime.mjs";

const SHA = "a".repeat(40);
const project = {
  slug: "client",
  path: "apps/client",
  packageName: "@nexus/client",
  workspaceMember: true,
  kind: "CLIENT",
  clientProject: true,
  evidence: { packageJsonPath: "apps/client/package.json", clientProjectDeclaration: true, classificationRule: "test" },
};

function baseOptions(root: string) {
  return {
    root,
    projects: async () => [project],
    git: async () => ({ branch: "audit", headSha: SHA, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
    readOnly: async () => "",
    prepareCapture: async () => undefined,
  };
}

describe("client runtime Red Team wiring", () => {
  it("does not expose a Red Team adapter without an explicit evidence file", async () => {
    const root = "/repo";
    const adapters = await createWorkspaceClientRuntimeAdapters({
      projectId: "client",
      sourceRevision: SHA,
      outputDir: join(root, "apps/client"),
      runtime: { target: "client" },
    }, baseOptions(root));
    expect(adapters.redTeam).toBeUndefined();
  });

  it("exposes the production Red Team adapter only for an admitted exact-SHA CLIENT with configured evidence", async () => {
    const root = "/repo";
    const adapters = await createWorkspaceClientRuntimeAdapters({
      projectId: "client",
      sourceRevision: SHA,
      outputDir: join(root, "apps/client"),
      runtime: { target: "client", redTeamEvidenceFile: "evidence/client-red-team.json" },
    }, baseOptions(root));
    expect(adapters.redTeam).toBeTypeOf("function");
  });
});
