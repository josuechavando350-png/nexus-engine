import { describe, expect, test } from "vitest";
import { createSemanticState, verifyComposition } from "@nexus/compositional-semantics";
import { projectCompositionalSemanticsMeasurement } from "./compositional-semantics.js";

describe("compositional semantics measurement integration", () => {
  test("projects verified semantics with certificate linkage", () => {
    const result = verifyComposition({
      planId: "measurement",
      subject: "client/home",
      initialState: createSemanticState(),
      composition: {
        kind: "step",
        id: "ready",
        effects: [{ kind: "set_fact", name: "ready", value: true }],
        contract: {
          id: "ready.contract",
          ensures: [{
            id: "ready-true",
            formula: {
              op: "compare",
              left: { kind: "fact", name: "ready" },
              comparator: "eq",
              right: { kind: "literal", value: true },
            },
          }],
        },
      },
    });
    const projection = projectCompositionalSemanticsMeasurement(result);
    expect(projection.authority).toBe("NEXUS_COMPOSITIONAL_SEMANTICS_MEASUREMENT_V1");
    expect(projection.status).toBe("VERIFIED");
    expect(projection.certificateDigest).toBe(result.certificate.certificateDigest);
    expect(projection.samples).toHaveLength(5);
    expect(projection.samples.every((sample) => Number.isFinite(sample.value))).toBe(true);

    const tampered = Object.freeze({
      ...result,
      certificate: Object.freeze({ ...result.certificate, finalStateDigest: "0".repeat(64) }),
    });
    expect(() => projectCompositionalSemanticsMeasurement(tampered)).toThrow(/linkage mismatch/);
  });
});
