import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SnarkjsGroth16ConsentVerifier,
  requireVerifiedZkConsent,
  zkConsentBindingSignal,
  type ReplayGuard,
  type ZkConsentRequest,
} from "../zk-consent.js";

const payloadDigest = createHash("sha256").update("payload").digest("hex");

function request(overrides: Partial<ZkConsentRequest> = {}): ZkConsentRequest {
  const base: ZkConsentRequest = {
    tenantId: "tenant-a",
    scope: "checkout",
    action: "purchase",
    nonce: "nonce-1",
    payloadDigest,
    proofJson: JSON.stringify({ pi_a: ["1", "2", "1"] }),
    publicSignalsJson: "[]",
    verificationKeyJson: JSON.stringify({ protocol: "groth16", curve: "bn128" }),
  };
  const merged = { ...base, ...overrides };
  return { ...merged, publicSignalsJson: overrides.publicSignalsJson ?? JSON.stringify([zkConsentBindingSignal(merged)]) };
}

function guard(consume = true): ReplayGuard {
  return { consume: vi.fn(async () => consume) };
}

describe("ZK consent binding", () => {
  it("changes across tenant, scope, action, nonce, and payload", () => {
    const base = request();
    const signal = zkConsentBindingSignal(base);
    expect(zkConsentBindingSignal({ ...base, tenantId: "tenant-b" })).not.toBe(signal);
    expect(zkConsentBindingSignal({ ...base, scope: "refund" })).not.toBe(signal);
    expect(zkConsentBindingSignal({ ...base, action: "refund" })).not.toBe(signal);
    expect(zkConsentBindingSignal({ ...base, nonce: "nonce-2" })).not.toBe(signal);
    expect(zkConsentBindingSignal({ ...base, payloadDigest: "0".repeat(64) })).not.toBe(signal);
  });

  it("rejects a proof before tool execution when the public binding is forged", async () => {
    const replayGuard = guard();
    const verifier = new SnarkjsGroth16ConsentVerifier({ executable: "definitely-missing-snarkjs", replayGuard });
    const evidence = await verifier.verify(request({ publicSignalsJson: JSON.stringify(["123"]) }));
    expect(evidence.status).toBe("INVALID_BINDING");
    expect(replayGuard.consume).not.toHaveBeenCalled();
  });

  it("reports an absent native toolchain honestly as UNAVAILABLE", async () => {
    const verifier = new SnarkjsGroth16ConsentVerifier({ executable: "definitely-missing-snarkjs", replayGuard: guard() });
    const evidence = await verifier.verify(request());
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.toolchainVersion).toBeNull();
  });

  it("fails closed and never executes the runtime operation without VERIFIED evidence", async () => {
    const operation = vi.fn(async () => "mutated");
    const verifier = new SnarkjsGroth16ConsentVerifier({ executable: "definitely-missing-snarkjs", replayGuard: guard() });
    const outcome = await requireVerifiedZkConsent(verifier, request(), operation);
    expect(outcome.evidence.status).toBe("UNAVAILABLE");
    expect(outcome.value).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized inputs before execution", async () => {
    const verifier = new SnarkjsGroth16ConsentVerifier({ executable: "definitely-missing-snarkjs", replayGuard: guard() });
    await expect(verifier.verify(request({ payloadDigest: "bad" }))).rejects.toThrow(/sha256/u);
    await expect(verifier.verify(request({ proofJson: "{" }))).rejects.toThrow(/valid JSON/u);
    await expect(verifier.verify(request({ proofJson: JSON.stringify({ x: "a".repeat(300_000) }) }))).rejects.toThrow(/exceeds/u);
  });

  it("supports cancellation without calling the toolchain", async () => {
    const controller = new AbortController();
    controller.abort();
    const verifier = new SnarkjsGroth16ConsentVerifier({ executable: "definitely-missing-snarkjs", replayGuard: guard() });
    const evidence = await verifier.verify(request(), controller.signal);
    expect(evidence.status).toBe("CANCELLED");
  });
});
