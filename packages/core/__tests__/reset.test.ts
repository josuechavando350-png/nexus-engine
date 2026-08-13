import { describe, expect, it } from "vitest";
import { NEXUS_RESET_CSS } from "../foundation/reset";

describe("NEXUS_RESET_CSS", () => {
  it("is non-empty and normalizes the box model", () => {
    expect(NEXUS_RESET_CSS.length).toBeGreaterThan(0);
    expect(NEXUS_RESET_CSS).toContain("box-sizing: border-box");
  });

  it("references Experience-specific colors only via tokens, never literals", () => {
    expect(NEXUS_RESET_CSS).toContain("var(--surface-base)");
    expect(NEXUS_RESET_CSS).toContain("var(--content-primary)");
    expect(NEXUS_RESET_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(NEXUS_RESET_CSS).not.toMatch(/\brgb(a)?\(/i);
    expect(NEXUS_RESET_CSS).not.toMatch(/\bhsl(a)?\(/i);
  });

  it("contains no brand font-family declaration", () => {
    expect(NEXUS_RESET_CSS).not.toMatch(/font-family\s*:/);
  });

  it("sets no hardcoded color fallback that could become a de facto default", () => {
    // The exact mistake found in the retired _template-client: fallback
    // values baked into var() declarations become the unspoken default.
    expect(NEXUS_RESET_CSS).not.toMatch(/var\(--surface-base,\s*#/);
    expect(NEXUS_RESET_CSS).not.toMatch(/var\(--content-primary,\s*#/);
  });
});
