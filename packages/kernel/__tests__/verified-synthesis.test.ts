import { describe, expect, it } from "vitest";
import {
  GovernedSynthesisRuntime,
  SmtLibAdapter,
  SyGuSAdapter,
  digest,
  equalitySaturate,
  evaluate,
  synthesizeVerified,
  validateProgram,
  verifySynthesisProof,
  type CounterexampleOracle,
  type TypedProgram,
} from "../verified-synthesis.js";

const addZero: TypedProgram = {
  version: 1,
  programId: "candidate.add-zero",
  tenantId: "tenant-a",
  scopeId: "scope-a",
  outputType: "NUMBER",
  expression: {
    kind: "add",
    left: { kind: "var", name: "x", valueType: "NUMBER" },
    right: { kind: "const", value: 0 },
  },
};

describe("Motor #6 verified synthesis kernel", () => {
  it("validates typed IR, evaluates deterministically, and extracts the lowest-cost e-class member", () => {
    validateProgram(addZero);
    expect(evaluate(addZero, { x: 7 })).toBe(7);
    const saturation = equalitySaturate(addZero.expression);
    expect(saturation.status).toBe("SATURATED");
    expect(saturation.canonical).toEqual({ kind: "var", name: "x", valueType: "NUMBER" });
    expect(saturation.explored).toBeGreaterThan(0);
    expect(saturation.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("runs bounded CEGIS with browser counterexamples and emits tamper-verifiable proof", async () => {
    let calls = 0;
    const oracle: CounterexampleOracle = {
      kind: "BROWSER",
      async findCounterexample(program) {
        calls += 1;
        if (program.programId === "candidate.bad") {
          return { inputs: { x: 2 }, expected: 2, source: "BROWSER", sourceDigest: digest({ screenshot: "fixture", x: 2 }) };
        }
        return null;
      },
    };
    const bad: TypedProgram = { ...addZero, programId: "candidate.bad", expression: { kind: "const", value: 1 } };
    const good: TypedProgram = { ...addZero, programId: "candidate.good" };
    const result = await synthesizeVerified({ tenantId: "tenant-a", scopeId: "scope-a", candidates: [bad, good], examples: [{ inputs: { x: 1 }, expected: 1 }], oracles: [oracle] });
    expect(result.status).toBe("VERIFIED");
    expect(result.program?.programId).toBe("candidate.good");
    expect(result.counterexamples).toHaveLength(1);
    expect(calls).toBe(2);
    expect(result.proof.tenantId).toBe("tenant-a");
    expect(result.proof.scopeId).toBe("scope-a");
    verifySynthesisProof(result, { tenantId: "tenant-a", scopeId: "scope-a" });
    expect(() => verifySynthesisProof({ ...result, examples: [{ inputs: { x: 999 }, expected: 999 }] })).toThrow(/linkage/u);
    expect(result.events.every((event) => Object.keys(event).sort().join(",") === "index,type")).toBe(true);
  });

  it("fails closed on cross-tenant candidates, forged oracle authority, and invalid bounds", async () => {
    await expect(synthesizeVerified({ tenantId: "tenant-b", scopeId: "scope-a", candidates: [addZero], examples: [] })).rejects.toThrow(/Cross-tenant/u);
    expect(() => validateProgram({ ...addZero, outputType: "BOOLEAN" })).toThrow(/output type/u);
    await expect(synthesizeVerified({ tenantId: "tenant-a", scopeId: "scope-a", candidates: Array.from({ length: 129 }, () => addZero), examples: [] })).rejects.toThrow(/Candidate count/u);
    const forged: CounterexampleOracle = { kind: "RUNTIME", async findCounterexample() { return { inputs: { x: 1 }, expected: 1, source: "BROWSER", sourceDigest: digest("forged") }; } };
    await expect(synthesizeVerified({ tenantId: "tenant-a", scopeId: "scope-a", candidates: [addZero], examples: [], oracles: [forged] })).rejects.toThrow(/source/u);
  });

  it("reports absent SMT and SyGuS tooling honestly instead of fabricating solver success", async () => {
    for (const adapter of [new SmtLibAdapter("nexus-definitely-missing-z3"), new SyGuSAdapter("nexus-definitely-missing-cvc5")]) {
      const result = await synthesizeVerified({
        tenantId: "tenant-a",
        scopeId: "scope-a",
        candidates: [addZero],
        examples: [{ inputs: { x: 1 }, expected: 1 }],
        solvers: [{ adapter, input: adapter.kind === "SMT" ? "(set-logic QF_LIA)\n(check-sat)\n" : "(set-logic LIA)\n(check-synth)\n" }],
        budget: { timeoutMs: 500 },
      });
      expect(result.status).toBe("UNAVAILABLE");
      expect(result.solverResults[0]?.status).toBe("UNAVAILABLE");
      expect(result.proof.stopReason).toBe("SOLVER_UNAVAILABLE");
      verifySynthesisProof(result, { tenantId: "tenant-a", scopeId: "scope-a" });
      const solver = result.solverResults[0];
      if (!solver) throw new Error("missing solver result");
      expect(() => verifySynthesisProof({ ...result, solverResults: [{ ...solver, status: "SAT" }] })).toThrow(/Solver result digest/u);
    }
  });

  it("honors cancellation and never upgrades an aborted oracle run to VERIFIED", async () => {
    const controller = new AbortController();
    const oracle: CounterexampleOracle = {
      kind: "RUNTIME",
      async findCounterexample(_program, signal) {
        controller.abort();
        expect(signal.aborted).toBe(true);
        return null;
      },
    };
    const result = await synthesizeVerified({ tenantId: "tenant-a", scopeId: "scope-a", candidates: [addZero], examples: [], oracles: [oracle], signal: controller.signal });
    expect(result.status).toBe("NOT_VERIFIED");
    expect(result.proof.stopReason).toBe("CANCELLED");
    expect(result.program).toBeNull();
    verifySynthesisProof(result, { tenantId: "tenant-a", scopeId: "scope-a" });
  });

  it("binds the operational runtime to one tenant/scope and rejects replay across boundaries", async () => {
    const runtime = new GovernedSynthesisRuntime("tenant-a", "scope-a");
    const result = await runtime.execute({ candidates: [addZero], examples: [{ inputs: { x: 3 }, expected: 3 }] });
    runtime.verify(result);
    const other = new GovernedSynthesisRuntime("tenant-b", "scope-a");
    expect(() => other.verify(result)).toThrow(/expected scope/u);
  });
});
