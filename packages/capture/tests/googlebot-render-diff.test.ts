import { describe, expect, it } from "vitest";
import {
  diffGooglebotRenderEvidence,
  normalizeGooglebotRenderSnapshot,
  validateGooglebotRenderDiffResult,
  type GooglebotRenderSnapshot,
} from "../googlebot-render-diff.js";

const sha = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;

function snapshot(overrides: Partial<GooglebotRenderSnapshot> = {}): GooglebotRenderSnapshot {
  return {
    source: "SIMULATED_BROWSER",
    status: "SIMULATED_RENDER",
    url: "https://example.com/page#fragment",
    observedAt: "2026-08-31T05:00:00.000Z",
    userAgent: "Mozilla/5.0 Nexus Googlebot Simulation",
    toolVersion: "nexus-capture/10.0.0",
    htmlDigest: sha("a"),
    textDigest: sha("b"),
    screenshotDigest: sha("c"),
    metadata: { browser: "chromium" },
    ...overrides,
  };
}

describe("Googlebot render evidence model", () => {
  it("keeps simulated browser evidence explicitly simulated", () => {
    const normalized = normalizeGooglebotRenderSnapshot(snapshot());
    expect(normalized.status).toBe("SIMULATED_RENDER");
    expect(normalized.source).toBe("SIMULATED_BROWSER");
    expect(normalized.url).toBe("https://example.com/page");
  });

  it("rejects forged Google API observation from simulated evidence", () => {
    expect(() => normalizeGooglebotRenderSnapshot(snapshot({ status: "GOOGLE_API_OBSERVED" }))).toThrow(/GOOGLE_API_OBSERVED requires/);
  });

  it("accepts Search Console API evidence only with matching authority", () => {
    const normalized = normalizeGooglebotRenderSnapshot(snapshot({
      source: "GOOGLE_SEARCH_CONSOLE_API",
      status: "GOOGLE_API_OBSERVED",
      userAgent: "Google Search Console URL Inspection API",
      screenshotDigest: null,
      metadata: { inspectionResultLink: "available-in-adapter-evidence" },
    }));
    expect(normalized.status).toBe("GOOGLE_API_OBSERVED");
  });

  it("requires fail-closed reason and no artifact digests when unavailable", () => {
    expect(() => normalizeGooglebotRenderSnapshot(snapshot({ status: "UNAVAILABLE" }))).toThrow(/cannot contain observed artifact digests/);
    const unavailable = normalizeGooglebotRenderSnapshot(snapshot({
      source: "GOOGLE_SEARCH_CONSOLE_API",
      status: "UNAVAILABLE",
      htmlDigest: null,
      textDigest: null,
      screenshotDigest: null,
      reason: "Search Console credentials not configured",
    }));
    expect(unavailable.reason).toMatch(/credentials/);
  });

  it("rejects credential-bearing URLs", () => {
    expect(() => normalizeGooglebotRenderSnapshot(snapshot({ url: "https://user:secret@example.com/" }))).toThrow(/credential-bearing/);
  });

  it("diffs artifact digests deterministically and marks external verification only from Google API evidence", () => {
    const result = diffGooglebotRenderEvidence({
      scope: { tenantId: "tenant-a", brandId: "brand-a" },
      expectedUrl: "https://example.com/page",
      baseline: snapshot(),
      candidate: snapshot({
        source: "GOOGLE_SEARCH_CONSOLE_API",
        status: "GOOGLE_API_OBSERVED",
        userAgent: "Google Search Console URL Inspection API",
        screenshotDigest: null,
        textDigest: sha("d"),
      }),
    });
    expect(result.comparisons).toEqual({ html: "MATCH", text: "DIFFERENT", screenshot: "UNASSESSED" });
    expect(result.externallyVerified).toBe(true);
    expect(result.resultDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(() => validateGooglebotRenderDiffResult(result)).not.toThrow();
  });

  it("does not call simulated-vs-observed-fetch evidence externally verified by Google", () => {
    const result = diffGooglebotRenderEvidence({
      scope: { tenantId: "tenant-a", brandId: "brand-a" },
      expectedUrl: "https://example.com/page",
      baseline: snapshot(),
      candidate: snapshot({ source: "OBSERVED_HTTP_FETCH", status: "OBSERVED_FETCH", userAgent: "Googlebot" }),
    });
    expect(result.externallyVerified).toBe(false);
  });

  it("rejects URL scope drift between evidence and requested target", () => {
    expect(() => diffGooglebotRenderEvidence({
      scope: { tenantId: "tenant-a", brandId: "brand-a" },
      expectedUrl: "https://example.com/page",
      baseline: snapshot(),
      candidate: snapshot({ url: "https://example.com/other" }),
    })).toThrow(/does not match expectedUrl/);
  });

  it("detects replay tampering", () => {
    const result = diffGooglebotRenderEvidence({
      scope: { tenantId: "tenant-a", brandId: "brand-a" },
      expectedUrl: "https://example.com/page",
      baseline: snapshot(),
      candidate: snapshot(),
    });
    expect(() => validateGooglebotRenderDiffResult({ ...result, externallyVerified: true })).toThrow(/external verification replay mismatch/);
  });

  it("rejects malformed digests and non-canonical timestamps", () => {
    expect(() => normalizeGooglebotRenderSnapshot(snapshot({ htmlDigest: "sha256:nope" }))).toThrow(/htmlDigest/);
    expect(() => normalizeGooglebotRenderSnapshot(snapshot({ observedAt: "2026-08-31T05:00:00Z" }))).toThrow(/canonical ISO-8601 UTC/);
  });
});
