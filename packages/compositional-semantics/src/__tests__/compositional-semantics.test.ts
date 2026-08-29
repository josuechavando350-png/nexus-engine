import { describe, expect, test } from "vitest";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import { synthesizeTermCertified } from "@nexus/topology";
import {
  createSemanticState,
  evaluateSemanticFormula,
  semanticCompositionDigest,
  semanticStateFromEngines,
  validateSemanticComposition,
  validateVerificationResult,
  verifyComposition,
} from "../index.js";
import type { SemanticComposition, SemanticFormula, SemanticOperand } from "../index.js";

const metric = (name: string) => ({ kind: "metric", name } as const);
const fact = (name: string) => ({ kind: "fact", name } as const);
const literal = (value: string | number | boolean | null) => ({ kind: "literal", value } as const);
const compare = (left: SemanticOperand, comparator: "eq" | "gte" | "lte", right: SemanticOperand): SemanticFormula =>
  ({ op: "compare", left, comparator, right });

describe("semantic state and formulas", () => {
  test("state digest is independent of insertion order", () => {
    const a = createSemanticState({ facts: { b: true, a: "x" }, metrics: { y: 2, x: 1 } });
    const b = createSemanticState({ facts: { a: "x", b: true }, metrics: { x: 1, y: 2 } });
    expect(a.digest).toBe(b.digest);
  });

  test("evaluates exists, comparisons and implication without eval", () => {
    const state = createSemanticState({ facts: { ready: true }, metrics: { score: 0.8 } });
    expect(evaluateSemanticFormula(state, { op: "exists", operand: fact("ready") })).toBe(true);
    expect(evaluateSemanticFormula(state, compare(metric("score"), "gte", literal(0.7)))).toBe(true);
    expect(evaluateSemanticFormula(state, {
      op: "implies",
      antecedent: compare(fact("ready"), "eq", literal(true)),
      consequent: compare(metric("score"), "gte", literal(0.7)),
    })).toBe(true);
    expect(evaluateSemanticFormula(state, compare(fact("missing"), "eq", literal(null)))).toBe(false);
  });

  test("rejects empty logical operators, malformed runtime values, and literal exists", () => {
    expect(() => evaluateSemanticFormula(createSemanticState(), { op: "and", formulas: [] })).toThrow(/at least one/);
    expect(() => createSemanticState({ metrics: { bad: Number.POSITIVE_INFINITY } })).toThrow(/finite/);
    expect(() => createSemanticState({ facts: { bad: { nested: true } as never } })).toThrow(/scalar semantic value/);
    expect(() => evaluateSemanticFormula(createSemanticState(), { op: "exists", operand: literal(true) } as never)).toThrow(/cannot target a literal/);
  });
});

describe("contract verification", () => {
  test("rejects preconditions without applying effects", () => {
    const initial = createSemanticState({ metrics: { score: 0.4 } });
    const composition: SemanticComposition = {
      kind: "step", id: "raise", effects: [{ kind: "set_metric", name: "score", value: 0.9 }],
      contract: { id: "raise.contract", requires: [{ id: "ready", formula: compare(fact("ready"), "eq", literal(true)) }] },
    };
    const result = verifyComposition({ planId: "p", subject: "s", initialState: initial, composition });
    expect(result.status).toBe("REJECTED");
    expect(result.finalState.digest).toBe(initial.digest);
    expect(result.issues[0]?.code).toBe("PRECONDITION_FAILED");
  });

  test("sequence applies ordered effects and verifies final invariant", () => {
    const composition: SemanticComposition = {
      kind: "sequence", id: "seq",
      contract: {
        id: "seq.contract",
        invariants: [{ id: "final-nonnegative", formula: compare(metric("balance"), "gte", literal(0)) }],
        ensures: [{ id: "final", formula: compare(metric("balance"), "eq", literal(5)) }],
      },
      children: [
        { kind: "step", id: "debit", effects: [{ kind: "add_metric", name: "balance", value: -15 }] },
        { kind: "step", id: "credit", effects: [{ kind: "add_metric", name: "balance", value: 10 }] },
      ],
    };
    const result = verifyComposition({ planId: "sequence", subject: "s", initialState: createSemanticState({ metrics: { balance: 10 } }), composition });
    expect(result.status).toBe("VERIFIED");
    expect(result.finalState.metrics.balance).toBe(5);
  });

  test("nest detects a transient invariant violation after a child", () => {
    const composition: SemanticComposition = {
      kind: "nest", id: "nested",
      contract: { id: "nested.contract", invariants: [{ id: "nonnegative", formula: compare(metric("balance"), "gte", literal(0)) }] },
      children: [
        { kind: "step", id: "debit", effects: [{ kind: "add_metric", name: "balance", value: -15 }] },
        { kind: "step", id: "credit", effects: [{ kind: "add_metric", name: "balance", value: 10 }] },
      ],
    };
    const result = verifyComposition({ planId: "nest", subject: "s", initialState: createSemanticState({ metrics: { balance: 10 } }), composition });
    expect(result.status).toBe("REJECTED");
    expect(result.finalState.metrics.balance).toBe(-5);
    expect(result.issues.some((issue) => issue.code === "INVARIANT_FAILED")).toBe(true);
  });

  test("parallel merges disjoint writes and is child-order invariant", () => {
    const children = [
      { kind: "step", id: "a", effects: [{ kind: "set_fact", name: "left", value: true }] },
      { kind: "step", id: "b", effects: [{ kind: "set_metric", name: "score", value: 0.9 }] },
    ] as const;
    const first: SemanticComposition = { kind: "parallel", id: "parallel", children };
    const second: SemanticComposition = { kind: "parallel", id: "parallel", children: [children[1], children[0]] };
    const initial = createSemanticState();
    const a = verifyComposition({ planId: "parallel", subject: "s", initialState: initial, composition: first });
    const b = verifyComposition({ planId: "parallel", subject: "s", initialState: initial, composition: second });
    expect(a.status).toBe("VERIFIED");
    expect(a.finalState.digest).toBe(b.finalState.digest);
    expect(a.certificate.certificateDigest).toBe(b.certificate.certificateDigest);
    expect(semanticCompositionDigest(first)).toBe(semanticCompositionDigest(second));
  });

  test("parallel rejects conflicting writes but allows identical writes", () => {
    const conflict: SemanticComposition = { kind: "parallel", id: "p", children: [
      { kind: "step", id: "a", effects: [{ kind: "set_fact", name: "mode", value: "a" }] },
      { kind: "step", id: "b", effects: [{ kind: "set_fact", name: "mode", value: "b" }] },
    ] };
    expect(verifyComposition({ planId: "conflict", subject: "s", initialState: createSemanticState(), composition: conflict }).issues[0]?.code).toBe("PARALLEL_CONFLICT");

    const same: SemanticComposition = { kind: "parallel", id: "p2", children: [
      { kind: "step", id: "a2", effects: [{ kind: "set_fact", name: "mode", value: "same" }] },
      { kind: "step", id: "b2", effects: [{ kind: "set_fact", name: "mode", value: "same" }] },
    ] };
    expect(verifyComposition({ planId: "same", subject: "s", initialState: createSemanticState(), composition: same }).status).toBe("VERIFIED");
  });

  test("arithmetic effects require an existing metric", () => {
    const composition: SemanticComposition = { kind: "step", id: "add", effects: [{ kind: "add_metric", name: "missing", value: 1 }] };
    const result = verifyComposition({ planId: "missing", subject: "s", initialState: createSemanticState(), composition });
    expect(result.status).toBe("REJECTED");
    expect(result.issues[0]?.code).toBe("MISSING_METRIC");
  });

  test("rejects duplicate node ids and excessive depth", () => {
    expect(() => validateSemanticComposition({ kind: "sequence", id: "root", children: [
      { kind: "step", id: "same", effects: [] },
      { kind: "step", id: "same", effects: [] },
    ] })).toThrow(/Duplicate composition node id/);

    const deep: SemanticComposition = { kind: "sequence", id: "root", children: [{ kind: "step", id: "leaf", effects: [] }] };
    expect(() => validateSemanticComposition(deep, { maxDepth: 1 })).toThrow(/maximum depth/);
  });

  test("certificate is deterministic and rejects tampering", () => {
    const composition: SemanticComposition = { kind: "step", id: "set", effects: [{ kind: "set_fact", name: "ok", value: true }] };
    const input = { planId: "cert", subject: "s", initialState: createSemanticState(), composition } as const;
    const first = verifyComposition(input); const second = verifyComposition(input);
    expect(first.certificate.certificateDigest).toBe(second.certificate.certificateDigest);
    expect(first.certificate.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    validateVerificationResult(first);
    const tampered = Object.freeze({ ...first, certificate: Object.freeze({ ...first.certificate, finalStateDigest: "0".repeat(64) }) });
    expect(() => validateVerificationResult(tampered)).toThrow(/linkage mismatch/);
  });

  test("binds verifier policy into the certificate", () => {
    const composition: SemanticComposition = { kind: "step", id: "policy", effects: [] };
    const initialState = createSemanticState();
    const normal = verifyComposition({ planId: "policy", subject: "s", initialState, composition });
    const failFast = verifyComposition({ planId: "policy", subject: "s", initialState, composition, failFast: true });
    expect(normal.finalState.digest).toBe(failFast.finalState.digest);
    expect(normal.certificate.policyDigest).not.toBe(failFast.certificate.policyDigest);
    expect(normal.certificate.certificateDigest).not.toBe(failFast.certificate.certificateDigest);
  });
});

describe("engine adapters", () => {
  test("imports Visual Algebra and Topology evidence with provenance", () => {
    const term = createTerm({
      subject: "client/home",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [
        definePrimitive({ id: "a", kind: "rectangle", bounds: { x: 0, y: 0, width: 0, height: 0 } }),
        definePrimitive({ id: "b", kind: "rectangle", bounds: { x: 20, y: 0, width: 0, height: 0 } }),
      ],
    });
    const topology = synthesizeTermCertified({ planId: "topology", term });
    const state = semanticStateFromEngines({ visual: term, topology });
    expect(state.facts["visual.termDigest"]).toBe(term.digest);
    expect(state.facts["topology.sourceTermDigest"]).toBe(term.digest);
    expect(state.metrics["visual.gridRegularity"]).toBeDefined();
    expect(state.metrics["topology.componentCount"]).toBe(1);

    const tamperedTerm = Object.freeze({ ...term, subject: "tampered" });
    expect(() => semanticStateFromEngines({ visual: tamperedTerm })).toThrow(/term digest mismatch/);
  });
});
