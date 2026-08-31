import { describe, expect, it } from "vitest";
import { assessBbrV3, validateBbrV3Assessment } from "./bbrv3.js";
import { collectLiveBbrV3Observation } from "./bbrv3-runtime.js";

describe("live BBR runtime evidence", () => {
  it("collects bounded OS evidence without upgrading generic BBR to BBRv3", () => {
    const observation = collectLiveBbrV3Observation(() => new Date("2026-08-31T00:00:00.000Z"));
    expect(observation.authority).toBe("LIVE_OS");
    expect(observation.observedAt).toBe("2026-08-31T00:00:00.000Z");
    expect(observation.versionMarker).toBeNull();
    expect(observation.versionMarkerSource).toBeNull();

    const assessment = assessBbrV3(observation);
    expect(assessment.state).not.toBe("OBSERVED");
    expect(assessment.active).toBe(false);
    expect(() => validateBbrV3Assessment(assessment)).not.toThrow();
  });
});
