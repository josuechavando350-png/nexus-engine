import { describe, expect, it } from "vitest";
import {
  createTransportPolicy,
  curlHttp3OnlyCommand,
  isCurlHttp3Unavailable,
  serializeLinkHeader,
  validateLiveTransportVerification,
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
    targetUrl: "https://example.com/",
    observedProtocol: "HTTP/3",
    observedInterimStatuses: [103],
    earlyHintLinks: [link],
    finalStatus: 200,
    finalLinks: [link],
    probeAvailable: true,
    probeAuthority: "CONTROLLED_TEST" as const,
    probeExitCode: 0,
    probeErrorCode: null,
  };
}

describe("transport HTTP/3 + Early Hints", () => {
  it("requires observed HTTP/3, 103, expected hints and a successful final response", () => {
    const p = policy();
    const verification = verifyTransportObservation(p, passingObservation());
    expect(verification.status).toBe("PASS");
    expect(() => validateTransportVerification(p, verification)).not.toThrow();
  });

  it("binds transport evidence to the policy host", () => {
    const result = verifyTransportObservation(policy(), { ...passingObservation(), targetUrl: "https://attacker.example/" });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("probe target does not match policy host");
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

  it("fails closed when curl parses headers but exits unsuccessfully", () => {
    const result = verifyTransportObservation(policy(), { ...passingObservation(), probeExitCode: 28, probeErrorCode: "ETIMEDOUT" });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("probe process did not complete successfully");
  });

  it("rejects a matching href with mismatched Link semantics", () => {
    const observation = passingObservation();
    const result = verifyTransportObservation(policy(), {
      ...observation,
      earlyHintLinks: ["</app.css>; rel=preload; as=script, <https://fonts.example.com/>; rel=preconnect"],
    });
    expect(result.status).toBe("FAIL");
    expect(result.reasons).toContain("early hint missing or mismatched /app.css");
  });

  it("accepts equivalent quoted Link parameter values", () => {
    const observation = passingObservation();
    const result = verifyTransportObservation(policy(), {
      ...observation,
      earlyHintLinks: ["</app.css>; rel=\"preload\"; as=\"style\", <https://fonts.example.com/>; rel=\"preconnect\""],
    });
    expect(result.status).toBe("PASS");
  });

  it("parses commas in URI references and semicolons in quoted parameter values", () => {
    const p = createTransportPolicy({
      host: "example.com",
      hints: [{ href: "/asset,a.css", rel: "preload", as: "style", type: "text/css; charset=utf-8" }],
    });
    const link = serializeLinkHeader(p);
    const result = verifyTransportObservation(p, {
      ...passingObservation(),
      earlyHintLinks: [link],
      finalLinks: [link],
    });
    expect(result.status).toBe("PASS");
  });

  it("does not require final Link duplication unless policy explicitly requests parity", () => {
    expect(verifyTransportObservation(policy(), { ...passingObservation(), finalLinks: [] }).status).toBe("PASS");
    const strict = policy(true);
    const result = verifyTransportObservation(strict, { ...passingObservation(), finalLinks: [] });
    expect(result.status).toBe("FAIL");
    expect(result.reasons.some((reason) => reason.startsWith("final response Link missing"))).toBe(true);
  });

  it("reports unavailable rather than fabricating PASS without usable HTTP/3 tooling", () => {
    const result = verifyTransportObservation(policy(), {
      ...passingObservation(),
      probeAvailable: false,
      observedProtocol: null,
      finalStatus: null,
      probeExitCode: null,
      probeErrorCode: "ENOENT",
    });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.reasons).toEqual(["probe unavailable"]);
  });

  it("recognizes unsupported curl HTTP/3 tooling without hiding ordinary transport failures", () => {
    expect(isCurlHttp3Unavailable({
      errorCode: null,
      stderr: "curl: option --http3-only: the installed libcurl version does not support this",
    })).toBe(true);
    expect(isCurlHttp3Unavailable({ errorCode: "ENOENT", stderr: "" })).toBe(true);
    expect(isCurlHttp3Unavailable({ errorCode: null, stderr: "curl: (7) Failed to connect" })).toBe(false);
  });

  it("does not downgrade a mismatched target to UNAVAILABLE", () => {
    const result = verifyTransportObservation(policy(), {
      ...passingObservation(),
      targetUrl: "https://attacker.example/",
      probeAvailable: false,
      observedProtocol: null,
      finalStatus: null,
      probeExitCode: null,
      probeErrorCode: "ENOENT",
    });
    expect(result.status).toBe("FAIL");
  });

  it("rejects control/header injection and ambiguous or credential-bearing hint URIs", () => {
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "/x\r\nX-Bad: 1", rel: "preload", as: "script" }] })).toThrow(/control/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "//attacker.example/x.js", rel: "preload", as: "script" }] })).toThrow(/protocol-relative/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "https://user:pass@example.net/x", rel: "preload", as: "script" }] })).toThrow(/credential-free/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "/x>y.js", rel: "preload", as: "script" }] })).toThrow(/unsafe URI/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "http://example.net", rel: "preconnect" }] })).toThrow(/https/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [{ href: "/x.js", rel: "preload" }] })).toThrow(/requires as/);
  });

  it("rejects duplicated or conflicting hints and invalid host names", () => {
    expect(() => createTransportPolicy({ host: "bad host", hints: [] })).toThrow(/invalid DNS host/);
    expect(() => createTransportPolicy({ host: "example.com", hints: [
      { href: "/x.css", rel: "preload", as: "style" },
      { href: "/x.css", rel: "preload", as: "script" },
    ] })).toThrow(/conflicting/);
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

  it("separates controlled-test verification from live network authority", () => {
    const p = policy();
    const controlled = verifyTransportObservation(p, passingObservation());
    expect(controlled.status).toBe("PASS");
    expect(() => validateLiveTransportVerification(p, controlled)).toThrow(/live network authority/);

    const live = verifyTransportObservation(p, { ...passingObservation(), probeAuthority: "LIVE_NETWORK" });
    expect(live.status).toBe("PASS");
    expect(() => validateLiveTransportVerification(p, live)).not.toThrow();
  });

  it("detects evidence tampering by replay", () => {
    const p = policy();
    const original = verifyTransportObservation(p, passingObservation());
    expect(() => validateTransportVerification(p, { ...original, status: "FAIL" })).toThrow(/replay mismatch/);
  });
});
