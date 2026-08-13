import { describe, expect, it } from "vitest";
import {
  NEXUS_CSP_BASE,
  NEXUS_CSP_DIRECTIVES_BASE,
  NEXUS_SECURITY_HEADERS_BASE,
  buildCsp
} from "../foundation/config";

describe("Foundation security", () => {
  it("keeps the approved base security headers", () => {
    const keys = NEXUS_SECURITY_HEADERS_BASE.map((h) => h.key);
    expect(keys).toEqual([
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy"
    ]);
  });

  it("exposes a generic CSP baseline with no client-specific directives", () => {
    expect(NEXUS_CSP_BASE).toContain("default-src 'self'");
    expect(NEXUS_CSP_BASE).not.toMatch(/https?:\/\//);
    expect(NEXUS_CSP_BASE).not.toContain("unsafe-inline");
  });

  it("buildCsp() with no extensions equals the precomputed baseline", () => {
    expect(buildCsp()).toBe(NEXUS_CSP_BASE);
  });

  it("buildCsp() extensions are additive and never remove a base source", () => {
    const extended = buildCsp({ "connect-src": ["https://maps.googleapis.com"] });

    // Base directives remain fully present.
    for (const [directive, sources] of Object.entries(NEXUS_CSP_DIRECTIVES_BASE)) {
      expect(extended).toContain(directive);
      for (const source of sources) {
        expect(extended).toContain(source);
      }
    }

    // The extension was actually added.
    expect(extended).toContain("connect-src https://maps.googleapis.com");
  });

  it("buildCsp() merges multiple sources for the same directive without duplication", () => {
    const extended = buildCsp({
      "connect-src": ["https://maps.googleapis.com", "https://maps.googleapis.com"]
    });
    const matches = extended.match(/https:\/\/maps\.googleapis\.com/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
