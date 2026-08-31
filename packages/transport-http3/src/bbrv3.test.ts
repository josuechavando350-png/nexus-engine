import { describe, expect, it } from "vitest";
import { assessBbrV3, validateBbrV3Assessment, type BbrV3Observation } from "./bbrv3.js";

function observation(overrides: Partial<BbrV3Observation> = {}): BbrV3Observation {
  return {
    authority: "LIVE_OS",
    source: "linux-procfs",
    observedAt: "2026-08-30T20:00:00Z",
    observationAvailable: true,
    activeCongestionControl: "bbr",
    availableCongestionControls: ["cubic", "bbr"],
    kernelRelease: "6.8.0-nexus",
    versionMarker: "BBRv3",
    versionMarkerSource: "verified-kernel-build-attestation",
    ...overrides,
  };
}

describe("BBRv3 evidence", () => {
  it("does not claim BBRv3 from absence of evidence", () => {
    expect(assessBbrV3(null)).toMatchObject({ state: "NOT_VERIFIED", active: false });
  });

  it("reports tooling/runtime unavailability without inventing a pass", () => {
    expect(assessBbrV3(observation({
      observationAvailable: false,
      activeCongestionControl: null,
      availableCongestionControls: [],
      kernelRelease: null,
      versionMarker: null,
      versionMarkerSource: null,
    }))).toMatchObject({ state: "UNAVAILABLE", active: false });
  });

  it("refuses to infer v3 merely because generic BBR is active", () => {
    const result = assessBbrV3(observation({ versionMarker: null, versionMarkerSource: null }));
    expect(result.state).toBe("NOT_VERIFIED");
    expect(result.active).toBe(false);
    expect(result.reason).toMatch(/generic BBR is active/);
  });

  it("only reports OBSERVED when live OS evidence identifies v3 and bbr is active", () => {
    const result = assessBbrV3(observation());
    expect(result).toMatchObject({ state: "OBSERVED", active: true });
    expect(() => validateBbrV3Assessment(result)).not.toThrow();
  });

  it("reports supported rather than active when verified v3 is available but not selected", () => {
    const result = assessBbrV3(observation({ activeCongestionControl: "cubic" }));
    expect(result).toMatchObject({ state: "SUPPORTED", active: false });
  });

  it("never promotes synthetic evidence to OBSERVED", () => {
    const result = assessBbrV3(observation({ authority: "SYNTHETIC_TEST" }));
    expect(result).toMatchObject({ state: "NOT_VERIFIED", active: false });
  });

  it("treats contradictory v3 evidence as not verified", () => {
    const result = assessBbrV3(observation({ activeCongestionControl: "cubic", availableCongestionControls: ["cubic"] }));
    expect(result.state).toBe("NOT_VERIFIED");
    expect(result.reason).toMatch(/contradictory/);
  });

  it("detects replay tampering", () => {
    const original = assessBbrV3(observation());
    expect(() => validateBbrV3Assessment({ ...original, active: false })).toThrow(/replay mismatch/);
  });

  it("rejects malformed version marker provenance", () => {
    expect(() => assessBbrV3(observation({ versionMarkerSource: null }))).toThrow(/version marker requires/);
  });
});
