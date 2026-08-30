import { describe, expect, it, vi } from "vitest";
import {
  createTransportHttp3Policy,
  parseCurlHeaderTranscript,
  transportEarlyHintsLinkHeader,
  validateTransportHttp3Policy,
  verifyTransportHttp3Observation,
  writeNodeEarlyHints,
} from "./transport-http3";

describe("transport HTTP/3 evidence", () => {
  it("canonicalizes policy and binds its digest", () => {
    const policy = createTransportHttp3Policy({
      host: "EXAMPLE.com",
      hints: [
        { href: "/app.js", rel: "preload", as: "script" },
        { href: "/app.css", rel: "preload", as: "style" },
      ],
    });
    expect(policy.host).toBe("example.com");
    expect(policy.enableZeroRtt).toBe(false);
    expect(policy.hints.map((hint) => hint.href)).toEqual(["/app.css", "/app.js"]);
    expect(validateTransportHttp3Policy(policy)).toBe(true);
    expect(policy.policyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects header injection and unsafe preconnect targets", () => {
    expect(() => createTransportHttp3Policy({ host: "example.com", hints: [{ href: "/x\r\nX-Evil: yes", rel: "preload", as: "script" }] })).toThrow(/control characters/);
    expect(() => createTransportHttp3Policy({ host: "example.com", hints: [{ href: "https://cdn.example.com/path", rel: "preconnect" }] })).toThrow(/origin/);
  });

  it("rejects duplicate hints instead of silently collapsing them", () => {
    expect(() => createTransportHttp3Policy({
      host: "example.com",
      hints: [
        { href: "/app.css", rel: "preload", as: "style" },
        { href: "/app.css", rel: "preload", as: "style" },
      ],
    })).toThrow(/duplicate/);
  });

  it("does not trust a forged policy digest", () => {
    const policy = createTransportHttp3Policy({ host: "example.com" });
    expect(validateTransportHttp3Policy({ ...policy, policyDigest: "f".repeat(64) })).toBe(false);
  });

  it("emits Node Early Hints only through a valid policy", () => {
    const writeEarlyHints = vi.fn();
    const policy = createTransportHttp3Policy({ host: "example.com", hints: [{ href: "/font.woff2", rel: "preload", as: "font", type: "font/woff2" }] });
    writeNodeEarlyHints({ writeEarlyHints }, policy);
    expect(writeEarlyHints).toHaveBeenCalledWith({ link: expect.stringContaining("crossorigin=anonymous") });
    expect(transportEarlyHintsLinkHeader(policy)).toContain("type=\"font/woff2\"");
  });

  it("parses a real curl-style 103 followed by an HTTP/3 final response", () => {
    const transcript = [
      "HTTP/3 103",
      "link: </app.css>; rel=preload; as=style",
      "",
      "HTTP/3 200",
      "content-type: text/html",
      "",
    ].join("\r\n");
    const observation = parseCurlHeaderTranscript("https://example.com/", transcript, 0, "");
    expect(observation.httpVersion).toBe("3");
    expect(observation.interimStatuses).toEqual([103]);
    expect(observation.earlyHintLinks).toEqual(["</app.css>; rel=preload; as=style"]);
    expect(observation.finalStatus).toBe(200);
  });

  it("passes only when HTTP/3, 103, final success and every expected hint are observed", () => {
    const policy = createTransportHttp3Policy({ host: "example.com", hints: [{ href: "/app.css", rel: "preload", as: "style" }] });
    const observation = parseCurlHeaderTranscript(
      "https://example.com/",
      "HTTP/3 103\r\nlink: </app.css>; rel=preload; as=style\r\n\r\nHTTP/3 200\r\ncontent-type: text/html\r\n\r\n",
      0,
      "",
    );
    const evidence = verifyTransportHttp3Observation(policy, observation);
    expect(evidence.verdict).toBe("PASS");
    expect(evidence.reasons).toEqual([]);
    expect(evidence.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when curl falls back to HTTP/2 or no 103 is observed", () => {
    const policy = createTransportHttp3Policy({ host: "example.com", hints: [{ href: "/app.css", rel: "preload", as: "style" }] });
    const observation = parseCurlHeaderTranscript(
      "https://example.com/",
      "HTTP/2 200\r\nlink: </app.css>; rel=preload; as=style\r\n\r\n",
      0,
      "",
    );
    const evidence = verifyTransportHttp3Observation(policy, observation);
    expect(evidence.verdict).toBe("FAIL");
    expect(evidence.reasons).toContain("final response was not observed over HTTP/3");
    expect(evidence.reasons).toContain("103 Early Hints was not observed");
  });

  it("marks missing curl as UNAVAILABLE instead of PASS", () => {
    const policy = createTransportHttp3Policy({ host: "example.com" });
    const observation = parseCurlHeaderTranscript("https://example.com/", "", 127, "curl unavailable");
    const evidence = verifyTransportHttp3Observation(policy, observation);
    expect(evidence.verdict).toBe("UNAVAILABLE");
    expect(evidence.reasons[0]).toMatch(/unavailable/);
  });
});
