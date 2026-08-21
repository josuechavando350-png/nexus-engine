import { describe, expect, it } from "vitest";
import { assertDesignDnaApproved, validateProjectDesignDna, type ProjectDesignDna } from "../design-dna";

const fixture: ProjectDesignDna = {
  schemaVersion: 1,
  projectId: "fixture-client",
  revision: 1,
  intent: "Editorial mobile-first legal experience",
  typography: {
    displayFamily: "Newsreader Variable",
    bodyFamily: "Inter Variable",
    detailFamily: "Caveat Variable",
    displayWeightRange: [300, 700],
    bodyWeightRange: [400, 650],
    fluidScaleRatio: 1.2,
    opticalSizing: "AUTO",
    headingWrap: "BALANCE",
    bodyWrap: "PRETTY",
  },
  composition: {
    alignment: "ASYMMETRIC",
    density: "AIRY",
    sectionRhythm: "IRREGULAR",
    imageBehavior: ["editorial crops", "no generic full-bleed hero"],
    requiredPatterns: ["mobile-first composition"],
    forbiddenPatterns: ["centered hero plus four cards", "decorative 01 02 03 numbering"],
  },
  geometry: {
    cornerLanguage: "SHARP",
    maximumRepeatedCardColumns: 2,
    borderLanguage: ["hairline editorial separators"],
    shapeLanguage: ["asymmetric image windows"],
  },
  motion: {
    profileId: "fixture-motion-v1",
    intensity: "CONTROLLED",
    reducedMotionRequired: true,
    scrollDrivenAllowed: true,
    viewTransitionsAllowed: true,
  },
  approval: {
    authority: "HUMAN_ART_DIRECTOR",
    approvedBy: "art-director",
    approvedAt: "2026-08-21T06:00:00.000Z",
  },
};

describe("Project Design DNA", () => {
  it("accepts a human-approved deterministic project contract", () => {
    const validated = validateProjectDesignDna(fixture);
    expect(validated.projectId).toBe("fixture-client");
    expect(() => assertDesignDnaApproved(validated)).not.toThrow();
  });

  it("rejects disabled reduced-motion support", () => {
    const invalid = { ...fixture, motion: { ...fixture.motion, reducedMotionRequired: false } } as unknown as ProjectDesignDna;
    expect(() => validateProjectDesignDna(invalid)).toThrow(/reducedMotionRequired/);
  });

  it("rejects duplicate structural patterns", () => {
    const invalid = { ...fixture, composition: { ...fixture.composition, forbiddenPatterns: ["cards", "cards"] } };
    expect(() => validateProjectDesignDna(invalid)).toThrow(/duplicates/);
  });
});
