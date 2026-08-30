import { describe, expect, it } from "vitest";
import {
  createTransportPolicy,
  curlHttp3OnlyCommand,
  serializeLinkHeader,
  validateTransportVerification,
  verifyTransportObservation,
  writeNodeEarlyHints,
} from "./index.js";

function policy(requireFinalLinkParity = false) {
  return createTransportPolicy({
    host: "example.com",
    hints: [
      { href: "/app.css", rel: "preload", as: "style" },
      { href: "https://fonts.example.com", rel: "preconnect" },
    ],
    requireFinalLinkParity,
  });
}

function passingObservation() {
  const link = serializeLinkHeader(policy());
  return {
    observedProtocol: "HTTP/3",
    observedInterimStatuses: [103],
    earlyHintLinks: [link],
    finalStatus: 200,
    finalLinks: [link],
    probeAvailable: true,
    probeAuthority: "CONTROLLED_TEST" as const,
  };
}

describe("transport HTTP/3 + Early Hints", () => {
  it("requires observed HTTP/3, 103, expected hints and a successful final response", () => {
    const p = policy();
    const verification = verifyTransportObservation(p, passingObservation());
    expect(verification.status).toBe("PASS");
    expect(() => validateTransportVerification(p, verification)).not.toThrow();
  });

  it("does not accept HTTP/2 fallback as HTTP/3", () => {
    const result = verifyTransportObservation(policy(), { ...passingObservation(), observedProtocol: "2" });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("HTTP/3 not observed");
  });

  it("fails when 103 is absent even if final Link headers are correct", () => {
    const result = verifyTransportObservation(policy(), { ...passingObservation(), observedInterimStatuses: [] });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("103 Early Hints not observed");
  });

  it("does not require final Link duplication unless policy explicitly requests parity", () => {
    expect(verifyTransportObservation(policy(), { ...passingObservation(), finalLinks: [] }).status).toBe("PASS");
    const strict = policy(true);
    const result = verifyTransportObservation(strict, { ...passingObservation(), finalLinks: [] });
    expect(result.status).toBe("FAIL");
    expect(result.reasons.some((reason) => reason.startsWith("final response Link missing"))).toBe(true);
  });

  it("reports unavailable rather than fabricating PASS without a live probe", () => {
    const result = verifyTransportObservation(policy(), { ...passingObservation(), probeAvailable: false, observedProtocol: null, finalStatus: null });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.reasons).toEqual(["probe unavailable"]);
  });

  it("rejects control-character/header-injection inputs and malformed hint semantics", () => {
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "/x\r\nX-Bad: 1", rel: "preload", as: "script" }] })).toThrow(/control/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "http://example.net", rel: "preconnect" }] })).toThrow(/https/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "/x.js", rel: "preload" }] })).toThrow(/requires as/);
  });

  it("rejects duplicated hints and invalid host names", () => {
    expect(() => createTransportPolicy({ host: "bad host", hints: [] })).toThrow(/invalid DNS host/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [
      { href: "/x.css", rel: "preload", as: "style" },
      { href: "/x.css", rel: "preload", as: "style" },
    ] })).toThrow(/duplicate/);
  });

  it("emits Node early hints as Link header values", () => {
    const calls: Array<Record<string, string | string[]>> = [];
    writeNodeEarlyHints({ writeEarlyHints: (value) => calls.push(value) }, policy());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.link).toEqual(expect.arrayContaining([expect.stringContaining("/app.css")]));
  });

  it("uses curl HTTP/3-only so a transport probe cannot silently fallback", () => {
    expect(curlHttp3OnlyCommand("https://example.com/")).toContain("--http3-only");
    expect(() => curlHttp3OnlyCommand("http://example.com/")).toThrow(/https/);
  });

  it("detects evidence tampering by replay", () => {
    const p = policy();
    const original = verifyTransportObservation(p, passingObservation());
    expect(() => validateTransportVerification(p, { ...original, status: "FAIL" })).toThrow(/replay mismatch/);
  });
});
