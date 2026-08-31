import { describe, expect, it } from "vitest";
import { saturateExpression, sha256 } from "./egraph.js";
import { VerifiedSynthesisKernel, verifySynthesisResult } from "./kernel.js";
import { CommandCounterexampleOracle } from "./oracle.js";
import { ExternalSmtLibSolver, InternalBoundedSolver } from "./solver.js";
import type { CandidateAssignment, CounterexampleOracle, OracleResult, SynthesisProblem } from "./types.js";

function problem(overrides: Partial<SynthesisProblem> = {}): SynthesisProblem {
  return {
    authority: "NEXUS_VERIFIED_SYNTHESIS_PROBLEM_V1",
    scope: { tenantId: "tenant-a", organizationId: "org-a", projectId: "project-a" },
    problemId: "motor6-test",
    variables: [{ name: "x", min: 0, max: 5 }],
    constraints: [
      { id: "min-x", left: { kind: "var", name: "x" }, relation: "GE", right: { kind: "const", value: 3 } },
    ],
    budgets: {
      maxIterations: 8,
      maxCandidates: 100,
      maxCounterexamples: 8,
      maxEGraphIterations: 8,
      maxEGraphNodes: 128,
      solverTimeoutMs: 5_000,
      oracleTimeoutMs: 5_000,
    },
    ...overrides,
  };
}

class TighteningRuntimeOracle implements CounterexampleOracle {
  readonly authority = "RUNTIME" as const;
  calls = 0;
  async check(_problem: SynthesisProblem, candidate: CandidateAssignment): Promise<OracleResult> {
    this.calls += 1;
    if ((candidate.x ?? -1) >= 4) {
      return { status: "PASS", durationMs: 0, evidenceDigest: sha256({ fixture: "runtime-pass", candidate }) };
    }
    const constraint = { id: "runtime-min-x", left: { kind: "var", name: "x" } as const, relation: "GE" as const, right: { kind: "const", value: 4 } as const };
    const evidenceDigest = sha256({ fixture: "runtime-counterexample", candidate, constraint });
    return {
      status: "COUNTEREXAMPLE",
      durationMs: 0,
      evidenceDigest,
      counterexample: { id: "runtime-ce-1", authority: "RUNTIME", constraint, evidenceDigest },
    };
  }
}

describe("Motor #6 verified synthesis kernel", () => {
  it("verifies a bounded candidate and emits recomputable proof-carrying output", async () => {
    const kernel = new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver() });
    const result = await kernel.synthesize(problem());
    expect(result.status).toBe("VERIFIED");
    expect(result.candidate?.x).toBe(3);
    expect(result.evaluations?.every((entry) => entry.status === "PASS")).toBe(true);
    expect(result.proof.authority).toBe("NEXUS_VERIFIED_SYNTHESIS_PROOF_V1");
    expect(() => verifySynthesisResult(result)).not.toThrow();
  });

  it("runs a real bounded CEGIS loop and incorporates a runtime counterexample", async () => {
    const oracle = new TighteningRuntimeOracle();
    const kernel = new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver(), oracles: [oracle] });
    const result = await kernel.synthesize(problem({ constraints: [] }));
    expect(result.status).toBe("VERIFIED");
    expect(result.candidate?.x).toBe(4);
    expect(result.counterexamples).toHaveLength(1);
    expect(result.iterations).toHaveLength(2);
    expect(oracle.calls).toBe(2);
    expect(() => verifySynthesisResult(result)).not.toThrow();
  });

  it("reports UNSAT only after exhausting the bounded search space", async () => {
    const kernel = new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver() });
    const result = await kernel.synthesize(problem({
      constraints: [
        { id: "min-x", left: { kind: "var", name: "x" }, relation: "GE", right: { kind: "const", value: 4 } },
        { id: "max-x", left: { kind: "var", name: "x" }, relation: "LE", right: { kind: "const", value: 2 } },
      ],
    }));
    expect(result.status).toBe("UNSAT");
    expect(result.candidate).toBeUndefined();
  });

  it("does not convert candidate-budget exhaustion into UNSAT", async () => {
    const kernel = new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver() });
    const result = await kernel.synthesize(problem({
      variables: [{ name: "x", min: 0, max: 100 }],
      constraints: [{ id: "x-is-100", left: { kind: "var", name: "x" }, relation: "EQ", right: { kind: "const", value: 100 } }],
      budgets: { ...problem().budgets, maxCandidates: 2 },
    }));
    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.iterations[0]?.solver.status).toBe("UNKNOWN");
  });

  it("reports absent SMT and SyGuS toolchains honestly as UNAVAILABLE", async () => {
    for (const kind of ["SMT", "SYGUS"] as const) {
      const kernel = new VerifiedSynthesisKernel({ solver: new ExternalSmtLibSolver({ executable: "/definitely-not-installed/nexus-solver", kind }) });
      const result = await kernel.synthesize(problem());
      expect(result.status).toBe("UNAVAILABLE");
      expect(result.iterations[0]?.solver.solverKind).toBe(kind);
    }
  });

  it("fails closed when a configured runtime counterexample oracle is unavailable", async () => {
    const oracle = new CommandCounterexampleOracle({ authority: "RUNTIME", executable: "/definitely-not-installed/nexus-runtime-oracle" });
    const kernel = new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver(), oracles: [oracle] });
    const result = await kernel.synthesize(problem());
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.candidate?.x).toBe(3);
  });

  it("uses bounded equality saturation without changing expression semantics", () => {
    const expression = { kind: "add", left: { kind: "var", name: "x" }, right: { kind: "const", value: 0 } } as const;
    const saturated = saturateExpression(expression, { maxEGraphIterations: 8, maxEGraphNodes: 64 });
    expect(saturated.expression).toEqual({ kind: "var", name: "x" });
    expect(saturated.exploredNodes).toBeLessThanOrEqual(64);
  });

  it("rejects unknown fields and unbounded variable ranges", async () => {
    const kernel = new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver() });
    await expect(kernel.synthesize({ ...problem(), admin: true } as never)).rejects.toThrow(/unknown synthesis problem field/u);
    await expect(kernel.synthesize(problem({ variables: [{ name: "x", min: 0, max: 20_000 }] }))).rejects.toThrow(/excessive range/u);
  });

  it("detects proof, candidate and counterexample tampering", async () => {
    const oracle = new TighteningRuntimeOracle();
    const result = await new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver(), oracles: [oracle] }).synthesize(problem({ constraints: [] }));
    expect(() => verifySynthesisResult({ ...result, candidate: { x: 5 } })).toThrow();
    expect(() => verifySynthesisResult({ ...result, proof: { ...result.proof, proofDigest: "0".repeat(64) } })).toThrow(/proof/u);
    expect(() => verifySynthesisResult({ ...result, counterexamples: [{ ...result.counterexamples[0]!, evidenceDigest: "0".repeat(64) }] })).toThrow();
  });

  it("honors cancellation without fabricating a verified result", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const result = await new VerifiedSynthesisKernel({ solver: new InternalBoundedSolver() }).synthesize(problem(), controller.signal);
    expect(result.status).toBe("ERROR");
    expect(result.candidate).toBeUndefined();
  });
});
