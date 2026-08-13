import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokenName, tokenRoles, tokenVar } from "../foundation/tokens";

describe("Foundation tokens", () => {
  it("tokenVar returns a var() reference for every role", () => {
    for (const role of tokenRoles) {
      expect(tokenVar(role)).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  it("tokenName returns the raw custom property name for every role", () => {
    for (const role of tokenRoles) {
      const name = tokenName(role);
      expect(name.startsWith("--")).toBe(true);
      expect(tokenVar(role)).toBe(`var(${name})`);
    }
  });

  it("covers the required semantic categories", () => {
    const categories = [
      "surface",
      "content",
      "accent",
      "border",
      "feedback",
      "focus",
      "space",
      "container",
      "radius",
      "shadow",
      "z-index",
      "motion.duration",
      "motion.easing"
    ];

    for (const category of categories) {
      expect(tokenRoles.some((role) => role.startsWith(category))).toBe(true);
    }
  });

  it("does NOT include an opacity category (DEFERRED in spec v0.3)", () => {
    expect(tokenRoles.some((role) => role.startsWith("opacity"))).toBe(false);
  });

  it("tokens.css contains no hardcoded brand colors (hex/rgb)", () => {
    const cssPath = fileURLToPath(
      new URL("../foundation/tokens/tokens.css", import.meta.url)
    );
    const css = readFileSync(cssPath, "utf8");

    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgb(a)?\(/i);
  });
});
