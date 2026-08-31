import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SnarkjsGroth16ConsentVerifier,
  requireVerifiedZkConsent,
  zkConsentBindingSignal,
  type ReplayGuard,
  type VerificationKeyPolicy,
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

function keyPolicy(authorize = true): VerificationKeyPolicy {
  return { authorize: vi.fn(async () => authorize) };
}

function verifier(overrides: { replayGuard?: ReplayGuard; verificationKeyPolicy?: VerificationKeyPolicy } = {}) {
  return new SnarkjsGroth16ConsentVerifier({
    executable: "definitely-missing-snarkjs",
    replayGuard: overrides.replayGuard ?? guard(),
    verificationKeyPolicy: overrides.verificationKeyPolicy ?? keyPolicy(),
  });
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

  it("rejects a forged public binding before policy or tool execution", async () => {
    const replayGuard = guard();
    const verificationKeyPolicy = keyPolicy();
    const evidence = await verifier({ replayGuard, verificationKeyPolicy }).verify(request({ publicSignalsJson: JSON.stringify(["123"]) }));
    expect(evidence.status).toBe("INVALID_BINDING");
    expect(verificationKeyPolicy.authorize).not.toHaveBeenCalled();
    expect(replayGuard.consume).not.toHaveBeenCalled();
  });

  it("rejects attacker-supplied verifier keys before tool execution", async () => {
    const replayGuard = guard();
    const verificationKeyPolicy = keyPolicy(false);
    const evidence = await verifier({ replayGuard, verificationKeyPolicy }).verify(request());
    expect(evidence.status).toBe("UNTRUSTED_VERIFIER");
    expect(replayGuard.consume).not.toHaveBeenCalled();
    expect(verificationKeyPolicy.authorize).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      scope: "checkout",
      action: "purchase",
    }));
  });

  it("reports an absent native toolchain honestly as UNAVAILABLE", async () => {
    const evidence = await verifier().verify(request());
    expect(evidence.status).toBe("UNAVAILABLE");
    expect(evidence.toolchainVersion).toBeNull();
  });

  it("does not consume a nonce when the native verifier rejects the proof", async () => {
    const replayGuard = guard();
    const sut = new SnarkjsGroth16ConsentVerifier({
      executable: process.execPath,
      replayGuard,
      verificationKeyPolicy: keyPolicy(),
    });
    const evidence = await sut.verify(request());
    expect(evidence.status).toBe("NOT_VERIFIED");
    expect(replayGuard.consume).not.toHaveBeenCalled();
  });

  it("fails closed and never executes the runtime operation without VERIFIED evidence", async () => {
    const operation = vi.fn(async () => "mutated");
    const outcome = await requireVerifiedZkConsent(verifier(), request(), operation);
    expect(outcome.evidence.status).toBe("UNAVAILABLE");
    expect(outcome.value).toBeUndefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized inputs before execution", async () => {
    const sut = verifier();
    await expect(sut.verify(request({ payloadDigest: "bad" }))).rejects.toThrow(/sha256/u);
    await expect(sut.verify(request({ proofJson: "{" }))).rejects.toThrow(/valid JSON/u);
    await expect(sut.verify(request({ proofJson: JSON.stringify({ x: "a".repeat(300_000) }) }))).rejects.toThrow(/exceeds/u);
  });

  it("supports cancellation without calling the toolchain", async () => {
    const controller = new AbortController();
    controller.abort();
    const evidence = await verifier().verify(request(), controller.signal);
    expect(evidence.status).toBe("CANCELLED");
  });
});
