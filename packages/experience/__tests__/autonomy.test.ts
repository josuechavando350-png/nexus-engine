import { describe, expect, it } from "vitest";
import { defineExperienceBrief, type ExperienceBrief } from "../brief";
import { autonomousExperienceDigest, synthesizeAutonomousExperience, synthesizeExperienceDNA } from "../autonomy";
import type { ExperienceDNA } from "../dna";

const boutiqueBrief = defineExperienceBrief({
  version: 2,
  id: "boutique-service",
  brand: {
    name: "Example Atelier",
    industry: "professional service",
    positioning: "A boutique, professional and calm service built around trust, clarity and authentic proof.",
    personality: ["boutique", "professional", "refined", "calm"],
    audiences: ["people evaluating a high-trust service"],
  },
  commercialGoal: "Make direct inquiry easy after enough trust and documentary evidence exists.",
  priorities: ["authentic photography as proof", "spacious editorial storytelling", "clear direct contact"],
  requiredCapabilityIds: ["contact", "gallery", "location", "media"],
  assets: [
    { id: "photo-a", kind: "photography", status: "available", notes: "real documentary photography" },
    { id: "copy-a", kind: "copy", status: "available", notes: "verified business facts" },
  ],
  references: [{
    id: "ref-editorial",
    sourceLabel: "approved principle reference",
    observations: {
      rhythm: "calm continuous editorial rhythm",
      whitespace: "spacious and restrained",
      imageRelationship: "documentary photography carries authentic proof",
      hierarchy: "expressive editorial hierarchy with clear orientation",
      density: "quiet rather than dense",
    },
    adaptationRule: "inspire-not-copy",
  }],
  forbiddenPatterns: ["generic card grid"],
  forbiddenWords: [],
  constraints: [{ id: "truth", statement: "Use only verified facts and supplied evidence.", source: "legal", severity: "required" }],
});

const operationalBrief = defineExperienceBrief({
  version: 2,
  id: "operational-system",
  brand: {
    name: "Example Operations",
    industry: "software",
    positioning: "A technical, systematic and operational product for fast comparison and precise decisions.",
    personality: ["technical", "systematic", "precise", "efficient"],
    audiences: ["operators comparing structured information"],
  },
  commercialGoal: "Let visitors scan, compare and find detailed information quickly.",
  priorities: ["dense structured information", "fast scanning", "precise angular organization"],
  requiredCapabilityIds: ["search", "catalog", "analytics"],
  assets: [{ id: "data-a", kind: "data", status: "available", notes: "structured comparison data" }],
  references: [{
    id: "ref-index",
    sourceLabel: "approved principle reference",
    observations: {
      architecture: "dense index with systematic comparison",
      geometry: "precise angular and structured",
      density: "compact information-dense scanning",
      hierarchy: "clear technical hierarchy",
      interaction: "direct efficient utility",
    },
    adaptationRule: "inspire-not-copy",
  }],
  forbiddenPatterns: ["marketing hero"],
  forbiddenWords: [],
  constraints: [{ id: "access", statement: "Information must remain directly accessible.", source: "accessibility", severity: "required" }],
});

function rationaleEvidence(dna: ExperienceDNA): readonly (readonly string[])[] {
  return [
    dna.composition.asymmetry.rationale.evidence ?? [],
    dna.composition.gridDiscipline.rationale.evidence ?? [],
    dna.composition.overlap.rationale.evidence ?? [],
    dna.composition.continuity.rationale.evidence ?? [],
    dna.composition.dominantFlow.rationale.evidence ?? [],
    dna.density.information.rationale.evidence ?? [],
    dna.density.whitespace.rationale.evidence ?? [],
    dna.density.compression.rationale.evidence ?? [],
    dna.geometry.angularity.rationale.evidence ?? [],
    dna.geometry.regularity.rationale.evidence ?? [],
    dna.geometry.boundaryVisibility.rationale.evidence ?? [],
    dna.geometry.dominantShape.rationale.evidence ?? [],
    dna.typography.scaleContrast.rationale.evidence ?? [],
    dna.typography.hierarchyRigidity.rationale.evidence ?? [],
    dna.typography.expressiveType.rationale.evidence ?? [],
    dna.typography.voice.rationale.evidence ?? [],
    dna.media.dominance.rationale.evidence ?? [],
    dna.media.continuity.rationale.evidence ?? [],
    dna.media.documentaryVsAbstract.rationale.evidence ?? [],
    dna.media.role.rationale.evidence ?? [],
    dna.navigation.persistence.rationale.evidence ?? [],
    dna.navigation.visibility.rationale.evidence ?? [],
    dna.navigation.topology.rationale.evidence ?? [],
    dna.interaction.discoverability.rationale.evidence ?? [],
    dna.interaction.directness.rationale.evidence ?? [],
    dna.interaction.spatiality.rationale.evidence ?? [],
    dna.interaction.language.rationale.evidence ?? [],
    dna.cta.prominence.rationale.evidence ?? [],
    dna.cta.repetition.rationale.evidence ?? [],
    dna.cta.grammar.rationale.evidence ?? [],
    dna.motion.intensity.rationale.evidence ?? [],
    dna.motion.continuity.rationale.evidence ?? [],
    dna.motion.choreography.rationale.evidence ?? [],
    dna.editoriality.rationale.evidence ?? [],
    dna.cinematicity.rationale.evidence ?? [],
    dna.ornamentation.rationale.evidence ?? [],
  ];
}

function withIndustry(brief: ExperienceBrief, industry: string): ExperienceBrief {
  return defineExperienceBrief({ ...brief, brand: { ...brief.brand, industry } });
}

describe("autonomous ExperienceDNA synthesis", () => {
  it("binds every DNA rationale to traceable project evidence", () => {
    const result = synthesizeAutonomousExperience({
      brief: boutiqueBrief,
      businessProfile: { businessType: "professional service", goals: ["INQUIRE", "TRUST", "VISIT"], differentiators: ["documentary proof"] },
    });
    const ids = new Set(result.evidence.map((signal) => signal.id));
    for (const evidenceIds of rationaleEvidence(result.dna)) {
      expect(evidenceIds.length).toBeGreaterThan(0);
      for (const id of evidenceIds) expect(ids.has(id)).toBe(true);
    }
    expect(autonomousExperienceDigest(result)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("produces structurally distinct plans when supplied evidence asks for distinct experience behavior", () => {
    const boutique = synthesizeAutonomousExperience({
      brief: boutiqueBrief,
      businessProfile: { businessType: "professional service", goals: ["INQUIRE", "TRUST"], differentiators: ["documentary proof"] },
    });
    const operational = synthesizeAutonomousExperience({
      brief: operationalBrief,
      businessProfile: { businessType: "operational product", goals: ["INQUIRE"], differentiators: ["structured comparison"] },
    });
    expect(boutique.recipe.id).not.toBe(operational.recipe.id);
    expect(boutique.plan.originalitySeed.stageSequence).not.toEqual(operational.plan.originalitySeed.stageSequence);
    expect(boutique.dna.density.compression.value).toBeLessThan(operational.dna.density.compression.value);
  });

  it("does not attach a hidden industry aesthetic when evidence is otherwise identical", () => {
    const first = synthesizeExperienceDNA(withIndustry(boutiqueBrief, "dentistry"));
    const second = synthesizeExperienceDNA(withIndustry(boutiqueBrief, "architecture"));
    expect({ ...first, subject: "same" }).toEqual({ ...second, subject: "same" });
  });

  it("is deterministic for identical evidence", () => {
    expect(synthesizeExperienceDNA(boutiqueBrief)).toEqual(synthesizeExperienceDNA(boutiqueBrief));
  });
});
