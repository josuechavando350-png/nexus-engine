import { describe, expect, test } from "vitest";
import {
  createSemanticState,
  validateVerificationResult,
  verifyComposition,
} from "../index.js";

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
});
