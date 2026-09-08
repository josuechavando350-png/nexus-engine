import { describe, expect, it } from "vitest";
import { fingerprintPublicTechnology } from "./technology-fingerprint.js";

describe("fingerprintPublicTechnology", () => {
  it("detects only passive public technology signals and produces a stable digest", () => {
    const input = {
      status: 200,
      finalUrl: "https://candidate.example/",
      headers: { "CF-RAY": "abc123", "x-powered-by": "Next.js" },
      html: '<html><head><meta name="generator" content="WordPress 6"><script src="/_next/static/chunk.js"></script></head><body><img src="/wp-content/a.png"></body></html>',
    };
    const first = fingerprintPublicTechnology(input);
    const second = fingerprintPublicTechnology(input);
    expect(first).toEqual(second);
    expect(first.technologies.map((item) => item.name)).toEqual(["Cloudflare", "Next.js", "WordPress"]);
    expect(first.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("does not infer technologies from arbitrary marketing prose", () => {
    const result = fingerprintPublicTechnology({
      status: 200,
      finalUrl: "https://candidate.example/",
      headers: {},
      html: "<html><body>We migrate WordPress, Shopify and React sites.</body></html>",
    });
    expect(result.technologies).toEqual([]);
  });

  it("rejects evidence bodies above the passive probe bound", () => {
    expect(() => fingerprintPublicTechnology({
      status: 200,
      finalUrl: "https://candidate.example/",
      headers: {},
      html: "x".repeat(1_048_577),
    })).toThrow(/bounds/u);
  });
});
