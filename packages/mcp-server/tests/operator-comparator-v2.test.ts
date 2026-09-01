import { beforeEach, describe, expect, it, vi } from "vitest";

const { comparator, gates, passport } = vi.hoisted(() => ({
  comparator: vi.fn(),
  gates: vi.fn(),
  passport: vi.fn(),
}));

const sourceSha = "a".repeat(40);

function toolResult(tool: "nexus_gates" | "nexus_passport" | "nexus_comparator") {
  return {
    schemaVersion: "1" as const,
    tool,
    requestId: `${tool}-request`,
    status: "PASS" as const,
    repository: "josuechavando350-png/nexus-engine",
    branch: "main",
    sourceSha,
    startedAt: "2026-09-01T18:00:00.000Z",
    finishedAt: "2026-09-01T18:00:00.000Z",
    data: {},
    evidence: [{ kind: "git" as const, locator: `git:${sourceSha}` }],
    errors: [],
  };
}

vi.mock("../src/tools.js", () => ({
  nexusBuild: vi.fn(),
  nexusCapture: vi.fn(),
  nexusGates: gates,
  nexusPassport: passport,
  nexusProjectNew: vi.fn(),
  nexusProjects: vi.fn(),
  nexusStatus: vi.fn(),
}));

vi.mock("../src/comparator.js", () => ({
  nexusComparatorV2: comparator,
}));

const { NEXUS_OPERATOR_AUTHORITY, NexusOperatorRuntime } = await import("../src/operator-gateway.js");

describe("operator AUDIT comparator V2 binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gates.mockResolvedValue(toolResult("nexus_gates"));
    passport.mockResolvedValue(toolResult("nexus_passport"));
    comparator.mockResolvedValue(toolResult("nexus_comparator"));
  });

  function command(payload: Record<string, unknown>) {
    return {
      scope: {
        tenantId: "tenant-a",
        organizationId: "org-a",
        brandId: "brand-a",
        repository: "josuechavando350-png/nexus-engine",
      },
      sourceSha,
      idempotencyKey: "audit-v2-1",
      requestedAt: "2026-09-01T17:59:50.000Z",
      intentSummary: "Run the governed exact-SHA quality audit against an explicitly approved visual baseline.",
      action: "AUDIT" as const,
      payload,
    };
  }

  const dependencies = {
    root: "/repo",
    repository: "josuechavando350-png/nexus-engine",
    git: async () => ({ branch: "main", headSha: sourceSha, detached: false, clean: true, changedPaths: [], remoteUrl: null }),
  };

  const context = {
    authority: NEXUS_OPERATOR_AUTHORITY,
    authenticated: true as const,
    writeAuthorized: false,
    authorizationExpiresAt: "2026-09-01T18:10:00.000Z",
    enabledTools: new Set(["nexus_gates", "nexus_passport", "nexus_comparator"] as const),
    clock: () => new Date("2026-09-01T18:00:00.000Z"),
  };

  it("rejects AUDIT before dispatch when no approved baseline manifest is supplied", async () => {
    const runtime = new NexusOperatorRuntime(command({ target: "reference-alfil", baselineManifestPath: "baselines/alfil.json" }).scope);
    await expect(runtime.execute(command({ target: "reference-alfil" }), dependencies, context)).rejects.toThrow();
    expect(gates).not.toHaveBeenCalled();
    expect(passport).not.toHaveBeenCalled();
    expect(comparator).not.toHaveBeenCalled();
  });

  it("dispatches the exact baseline path to Comparator V2 and preserves it in the governed three-stage audit", async () => {
    const runtime = new NexusOperatorRuntime(command({ target: "reference-alfil", baselineManifestPath: "baselines/alfil.json" }).scope);
    const result = await runtime.execute(command({ target: "reference-alfil", baselineManifestPath: "baselines/alfil.json" }), dependencies, context);
    expect(result.status).toBe("PASS");
    expect(result.stages.map((stage) => stage.tool)).toEqual(["nexus_gates", "nexus_passport", "nexus_comparator"]);
    expect(comparator).toHaveBeenCalledTimes(1);
    expect(comparator).toHaveBeenCalledWith({ target: "reference-alfil", sourceSha, baselineManifestPath: "baselines/alfil.json" }, dependencies);
    runtime.verifyAuditTrail();
  });
});
