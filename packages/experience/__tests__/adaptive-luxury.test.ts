import { describe, expect, it } from "vitest";
import { resolveLuxuryProfile } from "../adaptive-luxury";

describe("Adaptive Luxury V2", () => {
  it("honors reduced motion/data and preserves explicit fallbacks", () => {
    const profile = resolveLuxuryProfile({
      requested: ["cinematic-video", "view-transitions", "high-end-typography"],
      signals: { reducedMotion: true, reducedData: true, hover: false, precisePointer: false },
      budget: { js: "minimal-interaction", gpu: "css-only", network: "standard" }
    });

    expect(profile.allowed).toEqual(["high-end-typography"]);
    expect(profile.denied.map((item) => item.id)).toEqual(["cinematic-video", "view-transitions"]);
  });

  it("does not model deviceMemory or navigator.connection", () => {
    const source = resolveLuxuryProfile.toString();
    expect(source).not.toMatch(/deviceMemory|navigator\.connection/);
  });
});
