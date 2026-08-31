import { describe, expect, it, vi } from "vitest";
import {
  NEXUS_OPERATOR_AUTHORITY,
  NexusOperatorRuntime,
  operatorDigest,
  type OperatorRequestContext,
  type OperatorScope,
} from "../src/operator-gateway.js";
import type { ProjectState } from "../src/contracts.js";
import type { NexusToolName } from "../src/policy.js";
import type { ToolDependencies } from "../src/tools.js";

const sourceSha = "a".repeat(40);
const scope: OperatorScope = {
  tenantId: "tenant-a",
  organizationId: "org-a",
  brandId: "brand-a",
  repository: "josuechavando350-png/nexus-engine",
};
const now = new Date("2026-08-31T18:30:00.000Z");
const project: ProjectState = {
  slug: "reference-alfil",
  path: "apps/reference-alfil",
  packageName: "@nexus/reference-alfil",
  workspaceMember: true,
  kind: "REFERENCE",
  clientProject: false,
  evidence: { packageJsonPath: "apps/reference-alfil/package.json", clientProjectDeclaration: false, classificationRule: "test" },
};

function dependencies(overrides: Partial<ToolDependencies> = {}): ToolDependencies {
  return {
    root: "/repo",
    repository: scope.repository,
    requestId: () => "operator-test-request",
    clock: () => new Date(now),
    git: async () => ({ branch: "main", headSha: sourceSha, detached: false, clean: true, changedPaths: [], remoteUrl: "https://github.com/josuechavando350-png/nexus-engine.git" }),
    projects: async () => [project],
    ...overrides,
  };
}

function context(enabledTools: readonly NexusToolName[], overrides: Partial<OperatorRequestContext> = {}): OperatorRequestContext {
  return {
    authority: NEXUS_OPERATOR_AUTHORITY,
    authenticated: true,
    writeAuthorized: false,
    authorizationExpiresAt: "2026-08-31T18:40:00.000Z",
    enabledTools: new Set(enabledTools),
    clock: () => new Date(now),
    ...overrides,
  };
}

function planCommand(idempotencyKey = "plan-1") {
  return {
    scope,
    sourceSha,
    idempotencyKey,
    requestedAt: "2026-08-31T18:29:50.000Z",
    intentSummary: "Plan the governed website delivery path for the existing reference project.",
    action: "PLAN" as const,
    payload: { objective: "WEBSITE_DELIVERY" as const, target: "reference-alfil" },
  };
}

function createCommand(idempotencyKey = "create-1") {
  return {
    scope,
    sourceSha,
    idempotencyKey,
    requestedAt: "2026-08-31T18:29:50.000Z",
    intentSummary: "Create a governed client project from confirmed business facts and art direction.",
    action: "CREATE_PROJECT" as const,
    payload: {
      spec: {
        slug: "client-alpha",
        business: {
          name: "Client Alpha",
          industry: "Professional services",
          location: "Colima, Mexico",
          contact: { email: "contact@example.com" },
          confirmedServices: [{ name: "Consulting", description: "Confirmed service." }],
        },
        artDirection: {
          palette: [
            { hex: "#111111", role: "primary", rationale: "Primary field." },
            { hex: "#F5F2EA", role: "secondary", rationale: "Secondary field." },
          ],
          typography: { display: "Serif", body: "Sans", rationale: "Editorial hierarchy." },
          heroComposition: { direction: "Editorial split composition.", rationale: "Supports the confirmed content." },
          sectionRhythm: { direction: "Measured vertical rhythm.", rationale: "Keeps the page calm." },
          motion: { direction: "Restrained reveal motion.", reducedMotionBehavior: "Disable non-essential transitions.", rationale: "Preserves clarity." },
          prohibitions: ["Do not invent client claims."],
        },
      },
    },
  };
}

function approvedContext(): OperatorRequestContext {
  return context(["nexus_project_new"], {
    writeAuthorized: true,
    mutationApproval: {
      status: "APPROVED",
      expiresAt: "2026-08-31T18:35:00.000Z",
      evidenceDigest: operatorDigest({ channel: "test-write-authority" }),
    },
  });
}

function projectCreation() {
  return {
    project: {
      slug: "client-alpha",
      path: "apps/client-alpha",
      packageName: "@nexus/client-alpha",
      workspaceMember: true,
      kind: "CLIENT" as const,
      clientProject: true,
      evidence: { packageJsonPath: "apps/client-alpha/package.json", clientProjectDeclaration: true, classificationRule: "test" },
    },
    branch: { name: "nexus-mcp/client-alpha", baseSha: sourceSha, headSha: "b".repeat(40), remoteUrl: "https://github.com/josuechavando350-png/nexus-engine.git" },
    commit: { sha: "b".repeat(40), message: "feat(client): initialize client-alpha" },
    files: ["apps/client-alpha/package.json"],
    validation: [
      { command: "pnpm --filter @nexus/client-alpha lint", exitCode: 0 as const, status: "PASS" as const },
      { command: "pnpm --filter @nexus/client-alpha typecheck", exitCode: 0 as const, status: "PASS" as const },
      { command: "pnpm --filter @nexus/client-alpha build", exitCode: 0 as const, status: "PASS" as const },
    ],
  };
}

describe("NEXUS operator gateway", () => {
  it("turns a bounded user-style plan command into a SHA-bound canonical execution plan", async () => {
    const runtime = new NexusOperatorRuntime(scope);
    const result = await runtime.execute(planCommand(), dependencies(), context(["nexus_projects"]));
    expect(result.status).toBe("PASS");
    expect(result.writerAuthority).toBe("NEXUS_OPENAI_OPERATOR");
    expect(result.sourceSha).toBe(sourceSha);
    expect(result.stages.map((stage) => stage.tool)).toEqual(["nexus_projects", "operator_plan"]);
    expect(result.stages[1]?.data).toMatchObject({ target: "reference-alfil", projectExists: true });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/u);
    runtime.verifyAuditTrail();
  });

  it("rejects advisor/operator impersonation and unknown command fields before dispatch", async () => {
    const runtime = new NexusOperatorRuntime(scope);
    await expect(runtime.execute({ ...planCommand(), provider: "ANTHROPIC_CLAUDE" }, dependencies(), context(["nexus_projects"]))).rejects.toThrow();
    await expect(runtime.execute({ ...planCommand(), writerAuthority: "ANTHROPIC_CLAUDE" }, dependencies(), context(["nexus_projects"]))).rejects.toThrow();
  });

  it("blocks cross-tenant scope before any canonical tool runs", async () => {
    const projects = vi.fn(async () => [project]);
    const runtime = new NexusOperatorRuntime(scope);
    await expect(runtime.execute({ ...planCommand(), scope: { ...scope, tenantId: "tenant-b" } }, dependencies({ projects }), context(["nexus_projects"]))).rejects.toThrow(/scope mismatch/u);
    expect(projects).not.toHaveBeenCalled();
  });

  it("fails closed when the requested capability is not enabled", async () => {
    const runtime = new NexusOperatorRuntime(scope);
    const result = await runtime.execute({
      ...planCommand("build-capability"),
      action: "BUILD" as const,
      intentSummary: "Build the exact reference target.",
      payload: { target: "reference-alfil", clean: true as const },
    }, dependencies(), context(["nexus_projects"]));
    expect(result.status).toBe("REJECTED");
    expect(result.stages).toHaveLength(0);
  });

  it("blocks mutation when write authorization or authoritative approval is absent", async () => {
    const creator = vi.fn(async () => projectCreation());
    const runtime = new NexusOperatorRuntime(scope);
    const denied = await runtime.execute(createCommand(), dependencies({ projects: async () => [], projectCreator: creator }), context(["nexus_project_new"]));
    expect(denied.status).toBe("REJECTED");
    expect(creator).not.toHaveBeenCalled();
  });

  it("blocks expired mutation approval before project creation", async () => {
    const creator = vi.fn(async () => projectCreation());
    const runtime = new NexusOperatorRuntime(scope);
    const expired = approvedContext();
    const result = await runtime.execute(createCommand(), dependencies({ projects: async () => [], projectCreator: creator }), {
      ...expired,
      mutationApproval: { status: "APPROVED", expiresAt: "2026-08-31T18:29:59.000Z", evidenceDigest: operatorDigest("expired") },
    });
    expect(result.status).toBe("REJECTED");
    expect(creator).not.toHaveBeenCalled();
  });

  it("coalesces concurrent identical mutation commands and preserves terminal idempotency", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const creator = vi.fn(async () => { await wait; return projectCreation(); });
    const runtime = new NexusOperatorRuntime(scope);
    const deps = dependencies({ projects: async () => [], projectCreator: creator });
    const command = createCommand("coalesce-1");
    const first = runtime.execute(command, deps, approvedContext());
    const second = runtime.execute(command, deps, approvedContext());
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.status).toBe("COMMITTED");
    expect(creator).toHaveBeenCalledTimes(1);
    const replay = await runtime.execute(command, deps, approvedContext());
    expect(replay).toEqual(a);
    expect(creator).toHaveBeenCalledTimes(1);
    runtime.verifyAuditTrail();
  });

  it("rejects an idempotency key reused for different intent", async () => {
    const runtime = new NexusOperatorRuntime(scope);
    await runtime.execute(planCommand("conflict-key"), dependencies(), context(["nexus_projects"]));
    await expect(runtime.execute({ ...planCommand("conflict-key"), intentSummary: "Different bounded intent." }, dependencies(), context(["nexus_projects"]))).rejects.toThrow(/idempotency key conflict/u);
  });

  it("returns CANCELLED without dispatch when the caller is already aborted", async () => {
    const projects = vi.fn(async () => [project]);
    const controller = new AbortController();
    controller.abort();
    const runtime = new NexusOperatorRuntime(scope);
    const result = await runtime.execute(planCommand("cancelled"), dependencies({ projects }), context(["nexus_projects"]), controller.signal);
    expect(result.status).toBe("CANCELLED");
    expect(projects).not.toHaveBeenCalled();
  });

  it("returns TIMEOUT when the server-owned authorization lease is expired", async () => {
    const projects = vi.fn(async () => [project]);
    const runtime = new NexusOperatorRuntime(scope);
    const result = await runtime.execute(planCommand("expired-lease"), dependencies({ projects }), context(["nexus_projects"], { authorizationExpiresAt: "2026-08-31T18:29:59.000Z" }));
    expect(result.status).toBe("TIMEOUT");
    expect(projects).not.toHaveBeenCalled();
  });

  it("rejects shell and arbitrary mutation smuggling inside strict project input", async () => {
    const runtime = new NexusOperatorRuntime(scope);
    const command = createCommand("smuggle");
    await expect(runtime.execute({
      ...command,
      payload: { spec: { ...command.payload.spec, shell: "rm -rf /", githubMutation: "force-push" } },
    }, dependencies({ projects: async () => [] }), approvedContext())).rejects.toThrow();
  });
});
