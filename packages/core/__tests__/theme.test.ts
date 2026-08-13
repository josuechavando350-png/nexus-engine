import { describe, expect, it } from "vitest";
import {
  themeToCssVariables,
  type NexusTheme
} from "../foundation/theme/index";

describe("NEXUS Theme Bridge", () => {
  it("converts semantic token roles into CSS custom properties", () => {
    const theme: NexusTheme = {
      "surface.base": "#ffffff",
      "content.primary": "#111111"
    };

    expect(themeToCssVariables(theme)).toEqual({
      "--surface-base": "#ffffff",
      "--content-primary": "#111111"
    });
  });

  it("ignores undefined values", () => {
    const theme: NexusTheme = {
      "surface.base": undefined,
      "content.primary": "#111111"
    };

    expect(themeToCssVariables(theme)).toEqual({
      "--content-primary": "#111111"
    });
  });

  it("allows partial themes", () => {
    const theme: NexusTheme = {
      "accent.default": "rebeccapurple"
    };

    expect(themeToCssVariables(theme)).toEqual({
      "--accent-default": "rebeccapurple"
    });
  });
});
