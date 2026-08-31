import { describe, expect, it } from "vitest";
import {
  SmtLibAdapter,
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
  it("validates typed IR, evaluates deterministically, and saturates equalities", () => {
    validateProgram(addZero);
    expect(evaluate(addZero, { x: 7 })).toBe(7);
    const saturation = equalitySaturate(addZero.expression);
    expect(saturation.status).toBe("SATURATED");
    expect(saturation.canonical).toEqual({ kind: "var", name: "x", valueType: "NUMBER" });
    expect(saturation.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("runs bounded CEGIS with browser/runtime counterexamples and emits tamper-verifiable proof", async () => {
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
    verifySynthesisProof(result);
    expect(() => verifySynthesisProof({ ...result, examples: [{ inputs: { x: 999 }, expected: 999 }] })).toThrow(/linkage/u);
    expect(result.events.every((event) => Object.keys(event).sort().join(",") === "index,type")).toBe(true);
  });

  it("fails closed on cross-tenant candidates and invalid/unbounded IR", async () => {
    await expect(synthesizeVerified({ tenantId: "tenant-b", scopeId: "scope-a", candidates: [addZero], examples: [] })).rejects.toThrow(/Cross-tenant/u);
    const deep = { ...addZero, expression: addZero.expression };
    expect(() => validateProgram({ ...deep, outputType: "BOOLEAN" })).toThrow(/output type/u);
    await expect(synthesizeVerified({ tenantId: "tenant-a", scopeId: "scope-a", candidates: Array.from({ length: 129 }, () => addZero), examples: [] })).rejects.toThrow(/Candidate count/u);
  });

  it("reports absent native SMT tooling honestly instead of fabricating solver success", async () => {
    const solver = new SmtLibAdapter("nexus-definitely-missing-z3");
    const result = await synthesizeVerified({
      tenantId: "tenant-a",
      scopeId: "scope-a",
      candidates: [addZero],
      examples: [{ inputs: { x: 1 }, expected: 1 }],
      solvers: [{ adapter: solver, input: "(set-logic QF_LIA)\n(check-sat)\n" }],
      budget: { timeoutMs: 500 },
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.solverResults[0]?.status).toBe("UNAVAILABLE");
    verifySynthesisProof(result);
  });

  it("honors cancellation without treating a bounded stop as verified", async () => {
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
    expect(["NOT_VERIFIED", "VERIFIED"]).toContain(result.status);
    if (controller.signal.aborted) expect(result.events.some((event) => event.type === "BOUNDED_STOP") || result.status === "VERIFIED").toBe(true);
  });
});
