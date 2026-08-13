import { describe, expect, it } from "vitest";
import { typographyRoles, typographyVar } from "../foundation/typography";

describe("Foundation typography", () => {
  it("exposes exactly the approved role contract", () => {
    expect([...typographyRoles]).toEqual([
      "display",
      "heading.1",
      "heading.2",
      "heading.3",
      "heading.4",
      "body.default",
      "body.small",
      "caption",
      "mono"
    ]);
  });

  it("no longer exposes body.large or body.base", () => {
    expect(typographyRoles).not.toContain("body.large");
    expect(typographyRoles).not.toContain("body.base");
  });

  it("typographyVar returns a var() reference for role + property", () => {
    expect(typographyVar("heading.1", "fontSize")).toBe(
      "var(--typography-heading-1-font-size)"
    );
    expect(typographyVar("body.default", "lineHeight")).toBe(
      "var(--typography-body-default-line-height)"
    );
  });

  it("covers every role with every property without concrete values", () => {
    const properties = [
      "fontFamily",
      "fontSize",
      "lineHeight",
      "fontWeight",
      "letterSpacing"
    ] as const;

    for (const role of typographyRoles) {
      for (const property of properties) {
        const result = typographyVar(role, property);
        expect(result).toMatch(/^var\(--typography-[a-z0-9-]+\)$/);
      }
    }
  });
});
