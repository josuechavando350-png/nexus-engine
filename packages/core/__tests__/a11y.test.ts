import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOCUS_VISIBLE_CSS,
  FOCUS_VISIBLE_SELECTOR,
  HOVER_HOVER_QUERY,
  HOVER_NONE_QUERY,
  POINTER_COARSE_QUERY,
  POINTER_FINE_QUERY,
  REDUCED_DATA_QUERY,
  REDUCED_MOTION_CSS,
  REDUCED_MOTION_QUERY,
  SKIP_LINK_CLASS,
  SKIP_LINK_CSS,
  SR_ONLY_CLASS,
  SR_ONLY_CSS,
  assertiveLiveRegion,
  focusRingDeclaration,
  hasCoarsePointer,
  hasHoverCapability,
  politeLiveRegion,
  prefersReducedMotion,
  skipLinkProps
} from "../a11y";

const a11yDir = fileURLToPath(new URL("..", import.meta.url)) + "a11y";

describe("Accessibility contracts", () => {
  it("FOCUS_VISIBLE_SELECTOR targets :focus-visible", () => {
    expect(FOCUS_VISIBLE_SELECTOR).toBe(":focus-visible");
  });

  it("focusRingDeclaration is driven by Foundation tokens, not hardcoded colors", () => {
    const declaration = focusRingDeclaration();
    expect(declaration.outline).toContain("var(--focus-ring)");
    expect(declaration.outlineOffset).toBe("var(--focus-offset)");
    expect(declaration.outline).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("FOCUS_VISIBLE_CSS is a global rule driven by the same tokens", () => {
    expect(FOCUS_VISIBLE_CSS).toContain(FOCUS_VISIBLE_SELECTOR);
    expect(FOCUS_VISIBLE_CSS).toContain("var(--focus-ring)");
    expect(FOCUS_VISIBLE_CSS).toContain("var(--focus-offset)");
    expect(FOCUS_VISIBLE_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("exposes a non-empty sr-only class and matching CSS", () => {
    expect(SR_ONLY_CLASS.length).toBeGreaterThan(0);
    expect(SR_ONLY_CSS).toContain(`.${SR_ONLY_CLASS}`);
    expect(SR_ONLY_CSS).toContain("clip: rect(0, 0, 0, 0)");
  });

  it("SKIP_LINK_CSS is non-empty, uses fixed positioning, and has no legacy token refs", () => {
    expect(SKIP_LINK_CSS).toContain(`.${SKIP_LINK_CLASS}`);
    expect(SKIP_LINK_CSS).toContain("position: fixed");
    expect(SKIP_LINK_CSS).toContain("var(--space-md)");
    expect(SKIP_LINK_CSS).not.toMatch(/--space-\d/);
    expect(SKIP_LINK_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("live region helpers return correct aria attributes", () => {
    expect(politeLiveRegion()).toEqual({
      "aria-live": "polite",
      "aria-atomic": "true"
    });
    expect(assertiveLiveRegion()).toEqual({
      "aria-live": "assertive",
      "aria-atomic": "true"
    });
  });

  it("reduced motion query and CSS are well-formed", () => {
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
    expect(REDUCED_MOTION_CSS).toContain(REDUCED_MOTION_QUERY);
    expect(REDUCED_MOTION_CSS).toContain("animation-duration");
  });

  it("prefersReducedMotion is SSR-safe and defaults to false without window", () => {
    expect(typeof window).toBe("undefined");
    expect(prefersReducedMotion()).toBe(false);
  });

  it("skipLinkProps points to the target id and default sr class", () => {
    expect(skipLinkProps()).toEqual({
      href: "#main-content",
      className: SKIP_LINK_CLASS
    });
    expect(skipLinkProps("content")).toEqual({
      href: "#content",
      className: SKIP_LINK_CLASS
    });
  });

  it("capability signal queries are well-formed and SSR-safe", () => {
    expect(POINTER_COARSE_QUERY).toBe("(pointer: coarse)");
    expect(POINTER_FINE_QUERY).toBe("(pointer: fine)");
    expect(HOVER_NONE_QUERY).toBe("(hover: none)");
    expect(HOVER_HOVER_QUERY).toBe("(hover: hover)");
    expect(REDUCED_DATA_QUERY).toBe("(prefers-reduced-data: reduce)");
    expect(typeof window).toBe("undefined");
    expect(hasCoarsePointer()).toBe(false);
    expect(hasHoverCapability()).toBe(false);
  });

  it("does not infer capability from unreliable hardware/network signals", () => {
    const source = readFileSync(join(a11yDir, "index.ts"), "utf8");
    // Strip comments first — the file legitimately DOCUMENTS why these
    // are excluded, which would otherwise trip a bare substring check
    // (the exact false-positive pattern already found once in V1.1).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("deviceMemory");
    expect(code).not.toContain("navigator.connection");
  });

  it("the physical a11y.css file stays in sync with the exported CSS strings", () => {
    const cssPath = join(a11yDir, "a11y.css");
    const physicalCss = readFileSync(cssPath, "utf8");
    const rules = physicalCss.replace(/\/\*[\s\S]*?\*\//g, "");

    // Presence of each exported block's defining rule/selector.
    expect(rules).toContain(`.${SR_ONLY_CLASS}`);
    expect(rules).toContain("clip: rect(0, 0, 0, 0)");
    expect(rules).toContain(`.${SKIP_LINK_CLASS}`);
    expect(rules).toContain("position: fixed");
    expect(rules).toContain(FOCUS_VISIBLE_SELECTOR);
    expect(rules).toContain("var(--focus-ring)");
    expect(rules).toContain(REDUCED_MOTION_QUERY);

    // The exact bug this test exists to catch: no legacy token references
    // in actual rules (the comment block above is allowed to describe the
    // historical bug in prose — that is not a live reference).
    expect(rules).not.toMatch(/--space-\d/);
    expect(rules).toContain("var(--space-md)");
  });
});
