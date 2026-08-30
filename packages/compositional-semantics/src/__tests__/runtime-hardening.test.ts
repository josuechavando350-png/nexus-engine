import { describe, expect, test } from "vitest";
import {
  createSemanticState,
  createSemanticVerificationCertificate,
  validateSemanticComposition,
  validateSemanticFormula,
  validateVerificationResult,
  verifyComposition,
} from "../index.js";
import type { SemanticComposition, SemanticFormula, VerificationResult } from "../index.js";

describe("runtime verification hardening", () => {
  test("rejects a forged verification status even when TypeScript is bypassed", () => {
    const result = verifyComposition({
      planId: "runtime-status",
      subject: "client/home",
      initialState: createSemanticState(),
      composition: { kind: "step", id: "noop", effects: [] },
    });

    const forged = Object.freeze({
      ...result,
      status: "UNKNOWN" as never,
      certificate: Object.freeze({ ...result.certificate, status: "UNKNOWN" as never }),
    });

    expect(() => validateVerificationResult(forged)).toThrow(/Unsupported semantic verification status/);
  });

  test("rejects a forged VERIFIED result even when every outer certificate hash is reissued", () => {
    const result = verifyComposition({
      planId: "replay-status",
      subject: "client/home",
      initialState: createSemanticState(),
      composition: {
        kind: "step",
        id: "blocked",
        effects: [],
        contract: {
          id: "blocked.contract",
          requires: [{ id: "never", formula: { op: "false" } }],
        },
      },
    });
    expect(result.status).toBe("REJECTED");

    const issues = Object.freeze([]);
    const trace = Object.freeze([]);
    const certificate = createSemanticVerificationCertificate({
      planId: result.certificate.planId,
      subject: result.certificate.subject,
      compositionDigest: result.compositionDigest,
      initialStateDigest: result.initialState.digest,
      finalStateDigest: result.finalState.digest,
      status: "VERIFIED",
      policy: result.policy,
      issues,
      trace,
    });
    const forged: VerificationResult = Object.freeze({
      ...result,
      status: "VERIFIED",
      issues,
      trace,
      certificate,
    });

    expect(() => validateVerificationResult(forged)).toThrow(/status does not match deterministic replay/);
  });

  test("rejects a forged final state even when the attacker reissues the certificate", () => {
    const result = verifyComposition({
      planId: "replay-state",
      subject: "client/home",
      initialState: createSemanticState(),
      composition: { kind: "step", id: "set", effects: [{ kind: "set_fact", name: "ok", value: true }] },
    });
    const forgedState = createSemanticState({ facts: { ok: false } });
    const certificate = createSemanticVerificationCertificate({
      planId: result.certificate.planId,
      subject: result.certificate.subject,
      compositionDigest: result.compositionDigest,
      initialStateDigest: result.initialState.digest,
      finalStateDigest: forgedState.digest,
      status: result.status,
      policy: result.policy,
      issues: result.issues,
      trace: result.trace,
    });
    const forged: VerificationResult = Object.freeze({ ...result, finalState: forgedState, certificate });

    expect(() => validateVerificationResult(forged)).toThrow(/final state does not match deterministic replay/);
  });

  test("requires the exact carried composition instead of trusting a digest label", () => {
    const result = verifyComposition({
      planId: "carried-composition",
      subject: "client/home",
      initialState: createSemanticState(),
      composition: { kind: "step", id: "set", effects: [{ kind: "set_fact", name: "ok", value: true }] },
    });
    const forged = Object.freeze({ ...result, composition: undefined as never });
    expect(() => validateVerificationResult(forged)).toThrow(/composition node must be an object/);
  });

  test("rejects prototype-pollution keys at the semantic-state boundary", () => {
    const facts = Object.fromEntries([["__proto__", "owned"]]) as Record<string, string>;
    expect(() => createSemanticState({ facts })).toThrow(/reserved object key/);
    expect(Object.prototype).not.toHaveProperty("owned");
  });

  test("bounds formula breadth and composition node count", () => {
    const wideFormula: SemanticFormula = {
      op: "and",
      formulas: Array.from({ length: 4_097 }, () => ({ op: "true" as const })),
    };
    expect(() => validateSemanticFormula(wideFormula)).toThrow(/maximum node count/);

    const children = Array.from({ length: 4_097 }, (_, index) => ({
      kind: "step" as const,
      id: `step-${index}`,
      effects: [],
    }));
    const wideComposition: SemanticComposition = { kind: "sequence", id: "root", children };
    expect(() => validateSemanticComposition(wideComposition)).toThrow(/exceeds 4096 nodes/);
  });
});
