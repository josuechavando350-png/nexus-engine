import { describe, expect, it } from "vitest";
import {
  motionTransition,
  NEXUS_MOTION_CSS
} from "../motion/css/index";

describe("NEXUS Motion CSS", () => {
  it("creates a transition from semantic motion tokens", () => {
    expect(motionTransition()).toBe(
      "all var(--motion-duration-base) var(--motion-easing-standard)"
    );
  });

  it("supports explicit duration, easing and property", () => {
    expect(
      motionTransition({
        property: "opacity",
        duration: "fast",
        easing: "decelerate"
      })
    ).toBe(
      "opacity var(--motion-duration-fast) var(--motion-easing-decelerate)"
    );
  });

  it("includes reduced-motion protection", () => {
    expect(NEXUS_MOTION_CSS).toContain(
      "@media (prefers-reduced-motion: reduce)"
    );
  });

  it("provides the stable motion roles", () => {
    expect(NEXUS_MOTION_CSS).toContain(
      '[data-nexus-motion="feedback"]'
    );
    expect(NEXUS_MOTION_CSS).toContain(
      '[data-nexus-motion="transition"]'
    );
    expect(NEXUS_MOTION_CSS).toContain(
      '[data-nexus-motion="enter"]'
    );
    expect(NEXUS_MOTION_CSS).toContain(
      '[data-nexus-motion="exit"]'
    );
    expect(NEXUS_MOTION_CSS).toContain(
      '[data-nexus-motion="emphasis"]'
    );
  });
});
