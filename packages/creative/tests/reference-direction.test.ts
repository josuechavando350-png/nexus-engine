import { describe, expect, it } from "vitest";
import { ReferenceGroundedArtDirectionEngine } from "../reference-direction";
import type { DirectionCandidate } from "../direction";
import type { GalleryEntry } from "../gallery";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });

function reference(entryId: string, tags: readonly string[], techniques: readonly string[]): GalleryEntry {
  return {
    schemaVersion: 1,
    entryId,
    scope,
    kind: "SITE",
    title: `${tags.join(" ")} reference`,
    description: `${techniques.join(" ")} composition research`,
    source: {
      sourceId: `source-${entryId}`,
      sourceType: "REFERENCE",
      sourceUri: `https://example.com/${entryId}`,
      capturedAt: "2026-08-16T00:00:00Z",
      licenseIds: [],
    },
    tags,
    intents: ["experience"],
    techniques,
    relatedEntryIds: [],
    createdAt: "2026-08-16T00:00:00Z",
  };
}

const brief = {
  briefId: "brief-a",
  scope,
  subjectId: "subject-a",
  objective: "Create a differentiated hospitality experience",
  keywords: ["ritual", "spatial", "hospitality"],
  constraints: ["mobile-first"],
} as const;

const directionConfig = {
  weights: { BRIEF: 0.4, BRAND: 0.3, MEMORY: 0, CONSTRAINTS: 0.3 },
  minimumCandidateConfidence: 0.5,
  rejectConflictedEvidence: true,
} as const;

const candidates: readonly DirectionCandidate[] = [
  {
    directionId: "ritual-space",
    label: "Ritual spatial direction",
    keywords: ["ritual", "spatial", "hospitality"],
    brandSignals: ["ritual", "hospitality"],
    satisfiesConstraints: ["mobile-first"],
    confidence: 0.9,
  },
  {
    directionId: "generic-saas",
    label: "Generic SaaS cards",
    keywords: ["dashboard", "cards"],
    brandSignals: ["software"],
    satisfiesConstraints: ["mobile-first"],
    confidence: 0.95,
  },
];

describe("ReferenceGroundedArtDirectionEngine", () => {
  it("uses private Gallery/Vault reference signals to constrain eligible directions", () => {
    const references = [
      reference("ref-a", ["ritual", "hospitality"], ["spatial"]),
      reference("ref-b", ["hospitality", "editorial"], ["spatial", "continuity"]),
    ];
    const result = new ReferenceGroundedArtDirectionEngine().propose({
      brief,
      candidates,
      memory: [],
      references,
      directionConfig,
      groundingConfig: { minimumReferences: 2, minimumReferenceSupport: 0.1 },
    });
    expect(result.proposal.recommendedDirectionId).toBe("ritual-space");
    expect(result.referenceEntryIds).toEqual(["ref-a", "ref-b"]);
    expect(result.referenceSupport.find((item) => item.directionId === "generic-saas")?.score).toBe(0);
  });

  it("refuses to propose direction without enough private references", () => {
    expect(() => new ReferenceGroundedArtDirectionEngine().propose({
      brief,
      candidates,
      memory: [],
      references: [reference("ref-a", ["ritual"], ["spatial"])],
      directionConfig,
      groundingConfig: { minimumReferences: 2, minimumReferenceSupport: 0.1 },
    })).toThrow(/at least 2 unique Creative Gallery\/Vault references/);
  });

  it("refuses a direction set that has no support in the supplied references", () => {
    const references = [
      reference("ref-a", ["brutalist"], ["shader"]),
      reference("ref-b", ["experimental"], ["webgl"]),
    ];
    expect(() => new ReferenceGroundedArtDirectionEngine().propose({
      brief,
      candidates,
      memory: [],
      references,
      directionConfig,
      groundingConfig: { minimumReferences: 2, minimumReferenceSupport: 0.1 },
    })).toThrow(/no art-direction candidate is grounded/);
  });
});
