import { describe, expect, it } from "vitest";
import { RobotsPolicy } from "./robots.js";

describe("RobotsPolicy", () => {
  it("uses exact product-token groups before wildcard and lets Allow win an equal-specificity tie", () => {
    const policy = new RobotsPolicy(`
User-agent: *
Disallow: /private

User-agent: NexusProcurementBot
Disallow: /tenders/*
Allow: /tenders/public$
`);
    expect(policy.decide("NexusProcurementBot", new URL("https://buyer.test/tenders/public")).allowed).toBe(true);
    expect(policy.decide("NexusProcurementBot", new URL("https://buyer.test/tenders/secret")).allowed).toBe(false);
    expect(policy.decide("OtherBot", new URL("https://buyer.test/private/a")).allowed).toBe(false);
  });

  it("normalizes percent octets without decoding reserved separators", () => {
    const policy = new RobotsPolicy("User-agent: *\nDisallow: /procurement/%70rivate\nDisallow: /literal/%2Fadmin\n");
    expect(policy.decide("NexusProcurementBot", new URL("https://buyer.test/procurement/private")).allowed).toBe(false);
    expect(policy.decide("NexusProcurementBot", new URL("https://buyer.test/literal/%2fadmin")).allowed).toBe(false);
  });

  it("treats a partial user-agent token as non-matching", () => {
    const policy = new RobotsPolicy("User-agent: Nexus\nDisallow: /blocked\nUser-agent: *\nAllow: /\n");
    expect(policy.decide("NexusProcurementBot", new URL("https://buyer.test/blocked")).allowed).toBe(true);
  });
});
