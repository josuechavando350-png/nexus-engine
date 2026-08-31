import { describe, expect, it } from "vitest";
import { assessLiveBbrV3, collectLiveBbrV3Observation, validateBbrV3Assessment } from "./bbrv3-runtime.js";

describe("live BBR runtime evidence", () => {
  it("collects bounded OS evidence without upgrading generic BBR to BBRv3", () => {
    const now = () => new Date("2026-08-31T00:00:00.000Z");
    const observation = collectLiveBbrV3Observation(now);
    expect(observation.authority).toBe("LIVE_OS");
    expect(observation.observedAt).toBe("2026-08-31T00:00:00.000Z");
    expect(observation.versionMarker).toBeNull();
    expect(observation.versionMarkerSource).toBeNull();

    const assessment = assessLiveBbrV3(now);
    expect(assessment.state).not.toBe("OBSERVED");
    expect(assessment.active).toBe(false);
    expect(() => validateBbrV3Assessment(assessment)).not.toThrow();
  });
});
