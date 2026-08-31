import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InMemoryReplayStore,
  createSignal,
  decide,
  digestValue,
  normalizeJa3,
  normalizeJa4,
  parseTrustedRuntimeSignalJson,
  signEnvelope,
  subjectToken,
  validateDecision,
  validateSignal,
  verifyEnvelope,
  type EdgeEnvelopePayload,
} from "./index.js";

const JA3 = "0123456789abcdef0123456789abcdef";
const JA4 = "t13d1516h2_8daaf6152771_02713d6af862";

function signal(overrides: Record<string, unknown> = {}) {
  return createSignal({
    provider: "CLOUDFLARE",
    trust: "RUNTIME_BOUNDARY",
    observedAt: "2030-01-01T00:00:00Z",
    method: "GET",
    path: "/",
    ja3: null,
    ja4: null,
    botScore: null,
    verifiedBot: false,
    signedAgent: false,
    heuristicRatio: null,
    browserRatio: null,
    requestQuantile: null,
    curatedReputationMatch: false,
    ...overrides,
  });
}

function edgePayload(overrides: Partial<EdgeEnvelopePayload> = {}): EdgeEnvelopePayload {
  const edgeSignal = createSignal({
    provider: "SIGNED_EDGE",
    trust: "HMAC_VERIFIED",
    observedAt: "2030-01-01T00:00:00Z",
    method: "GET",
    path: "/private",
    ja4: JA4,
    botScore: 10,
    requestQuantile: 0.95,
  });
  return {
    authority: "NEXUS_SIGNED_BOT_EDGE_PAYLOAD_V1",
    keyId: "edge-v1",
    nonce: "abcdefghijklmnop1234",
    issuedAt: "2030-01-01T00:00:00Z",
    expiresAt: "2030-01-01T00:00:30Z",
    method: "GET",
    path: "/private",
    signal: edgeSignal,
    subjectTokenDigest: null,
    ...overrides,
  };
}

describe("passive bot defense", () => {
  it("treats missing fingerprints as zero risk rather than suspicion", () => {
    const input = signal();
    const decision = decide(input);
    expect(decision.action).toBe("ALLOW");
    expect(decision.riskScore).toBe(0);
    expect(decision.fingerprintPresent).toBe(false);
    validateDecision(input, decision);
  });

  it("does not treat a JA3 or JA4 value as identity or blocking evidence by itself", () => {
    const decision = decide(signal({ ja3: JA3, ja4: JA4 }));
    expect(decision.action).toBe("ALLOW");
    expect(decision.riskScore).toBe(0);
    expect(decision.nonClaim).toBe("PASSIVE_TLS_FINGERPRINTS_ARE_SIGNALS_NOT_IDENTITIES");
  });

  it("defaults to RATE_LIMIT even for high composed risk and requires explicit deny opt-in", () => {
    const hostile = signal({ botScore: 0, heuristicRatio: 1, requestQuantile: 1, browserRatio: 0, curatedReputationMatch: true });
    expect(decide(hostile).action).toBe("RATE_LIMIT");
    const denied = decide(hostile, { denyEnabled: true });
    expect(denied.action).toBe("DENY");
    expect(new Set(denied.contributions.map((item) => item.family)).size).toBeGreaterThanOrEqual(2);
  });

  it("verified legitimate automation bypasses heuristic mitigation", () => {
    const legitimate = signal({ verifiedBot: true, botScore: 0, heuristicRatio: 1, requestQuantile: 1, curatedReputationMatch: true });
    expect(decide(legitimate, { denyEnabled: true }).action).toBe("ALLOW");
  });

  it("rejects malformed fingerprints, ratios, paths and fake signed-edge authority", () => {
    expect(() => normalizeJa3("not-ja3")).toThrow(/JA3/);
    expect(() => normalizeJa4("not-ja4")).toThrow(/JA4/);
    expect(() => signal({ requestQuantile: 2 })).toThrow(/requestQuantile/);
    expect(() => signal({ path: "https://evil.example/" })).toThrow(/origin-relative/);
    expect(() => createSignal({ provider: "SIGNED_EDGE", trust: "RUNTIME_BOUNDARY", observedAt: "2030-01-01T00:00:00Z", method: "GET", path: "/" })).toThrow(/HMAC_VERIFIED/);
  });

  it("rejects raw SIGNED_EDGE JSON and unknown public fields", () => {
    expect(() => parseTrustedRuntimeSignalJson(JSON.stringify({ provider: "SIGNED_EDGE", trust: "HMAC_VERIFIED", observedAt: "2030-01-01T00:00:00Z", method: "GET", path: "/" }))).toThrow(/verifyEnvelope/);
    expect(() => parseTrustedRuntimeSignalJson(JSON.stringify({ provider: "CLOUDFLARE", trust: "RUNTIME_BOUNDARY", observedAt: "2030-01-01T00:00:00Z", method: "GET", path: "/", xJa4: JA4 }))).toThrow(/unknown runtime signal field/);
  });

  it("replays signal and decision digests instead of trusting rehashed enums", () => {
    const input = signal({ botScore: 0, requestQuantile: 1 });
    validateSignal(input);
    expect(() => validateSignal({ ...input, botScore: 100 })).toThrow(/digest mismatch/);
    const decision = decide(input);
    expect(() => validateDecision(input, { ...decision, action: "ALLOW", decisionDigest: digestValue({ ...decision, action: "ALLOW" }) })).toThrow();
  });

  it("rotates pseudonymous subjects without persisting raw IP in decisions", () => {
    const secret = "s".repeat(64);
    const first = subjectToken("203.0.113.1", JA4, "2030-01-01", secret);
    const second = subjectToken("203.0.113.1", JA4, "2030-01-02", secret);
    expect(first).not.toBe(second);
    expect(JSON.stringify(decide(signal({ ja4: JA4 })))).not.toContain("203.0.113.1");
    expect(() => subjectToken("not-ip", JA4, "day", secret)).toThrow(/IP address/);
    expect(() => subjectToken("203.0.113.1", JA4, "day", "short")).toThrow(/32 bytes/);
  });

  it("binds signed edge evidence to signature, key, method, path, TTL and nonce replay", async () => {
    const secret = "s".repeat(64);
    const signed = signEnvelope(edgePayload(), secret);
    const store = new InMemoryReplayStore();
    await expect(verifyEnvelope({ ...signed, secret, now: "2030-01-01T00:00:10Z", expectedMethod: "POST", expectedPath: "/private", replayStore: store })).rejects.toThrow(/binding/);
    await expect(verifyEnvelope({ ...signed, secret, now: "2030-01-01T00:00:10Z", expectedMethod: "GET", expectedPath: "/private", replayStore: store })).resolves.toMatchObject({ nonce: "abcdefghijklmnop1234" });
    await expect(verifyEnvelope({ ...signed, secret, now: "2030-01-01T00:00:11Z", expectedMethod: "GET", expectedPath: "/private", replayStore: store })).rejects.toThrow(/replayed/);
    await expect(verifyEnvelope({ ...signed, keyId: "wrong", secret, now: "2030-01-01T00:00:10Z", expectedMethod: "GET", expectedPath: "/private", replayStore: new InMemoryReplayStore() })).rejects.toThrow(/keyId/);
    await expect(verifyEnvelope({ ...signed, signature: `${signed.signature.slice(0, -1)}A`, secret, now: "2030-01-01T00:00:10Z", expectedMethod: "GET", expectedPath: "/private", replayStore: new InMemoryReplayStore() })).rejects.toThrow(/signature/);
    await expect(verifyEnvelope({ ...signed, secret, now: "2030-01-01T00:00:31Z", expectedMethod: "GET", expectedPath: "/private", replayStore: new InMemoryReplayStore() })).rejects.toThrow(/expired/);
    expect(() => signEnvelope(edgePayload({ expiresAt: "2030-01-01T00:02:00Z" }), secret)).toThrow(/TTL/);
  });

  it("rejects attacker-reissued envelopes carrying unknown fields", async () => {
    const secret = "s".repeat(64);
    const payload = { ...edgePayload(), surprise: true };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
    await expect(verifyEnvelope({ encoded, signature, keyId: "edge-v1", secret, now: "2030-01-01T00:00:10Z", expectedMethod: "GET", expectedPath: "/private", replayStore: new InMemoryReplayStore() })).rejects.toThrow(/unknown envelope field/);
  });
});
