import { describe, expect, it } from "vitest";
import type { GroundedStructuredDataArtifact } from "../07-recomendacion-de-dios/index.js";
import { EntityGraphInterleaver, detectGoogleIndexingEligibility } from "./runtime.js";

function artifact(graph: readonly Readonly<Record<string, unknown>>[], pageUrl = "https://example.test/jobs/1"): GroundedStructuredDataArtifact {
  const jsonLd = { "@context": "https://schema.org" as const, "@graph": graph };
  return {
    status: "READY_FOR_RICH_RESULTS_TEST",
    googleAppearanceGuaranteed: false,
    pageUrl,
    jsonLd,
    serializedJsonLd: JSON.stringify(jsonLd),
    receipt: { receiptDigest: `sha256:${"a".repeat(64)}` },
  } as unknown as GroundedStructuredDataArtifact;
}

describe("EntityGraphInterleaver", () => {
  it("injects one idempotent application/ld+json block from a #7 artifact", () => {
    const interleaver = new EntityGraphInterleaver("https://example.test");
    const input = artifact([{ "@type": "JobPosting", name: "Senior Engineer" }]);
    const first = interleaver.inject("<!doctype html><html><head></head><body>Job</body></html>", input);
    const second = interleaver.inject(first.html, input);
    expect(second.html.match(/data-nexus-semantic="v1"/gu)).toHaveLength(1);
    expect(second.html).toContain('type="application/ld+json"');
    expect(second.indexingEligibility).toEqual(["JOB_POSTING"]);
  });

  it("escapes script-breaking text inside JSON-LD", () => {
    const interleaver = new EntityGraphInterleaver("https://example.test");
    const result = interleaver.inject("<html><head></head><body></body></html>", artifact([{ "@type": "JobPosting", description: "</script><script>alert(1)</script>" }]));
    expect(result.html).not.toContain("</script><script>alert(1)</script>");
    expect(result.html).toContain("\\u003c/script\\u003e");
  });

  it("detects BroadcastEvent only when nested in a VideoObject", () => {
    const standalone = { "@context": "https://schema.org" as const, "@graph": [{ "@type": "BroadcastEvent" }] };
    expect(detectGoogleIndexingEligibility(standalone)).toEqual([]);
    const embedded = { "@context": "https://schema.org" as const, "@graph": [{ "@type": "VideoObject", publication: { "@type": "BroadcastEvent" } }] };
    expect(detectGoogleIndexingEligibility(embedded)).toEqual(["LIVESTREAM_BROADCAST_EVENT"]);
  });

  it("rejects a certified-looking artifact from another origin", () => {
    const interleaver = new EntityGraphInterleaver("https://example.test");
    expect(() => interleaver.inject("<html><head></head><body></body></html>", artifact([{ "@type": "JobPosting" }], "https://evil.example/jobs/1")))
      .toThrow(/origin must match/u);
  });
});
