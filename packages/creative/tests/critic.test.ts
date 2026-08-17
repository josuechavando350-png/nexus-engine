import { describe, expect, it } from "vitest";
import { NexusCreativeCritic, type CreativeExecutionContract } from "../critic";
import type { GalleryEntry } from "../gallery";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });

function reference(entryId: string, kind: GalleryEntry["kind"] = "SITE"): GalleryEntry {
  return {
    schemaVersion: 1,
    entryId,
    scope,
    kind,
    title: `Reference ${entryId}`,
    description: "Reference retained for compositional principle analysis, not surface copying",
    source: {
      sourceId: `source-${entryId}`,
      sourceType: "REFERENCE",
      sourceUri: `https://example.com/${entryId}`,
      capturedAt: "2026-08-16T00:00:00Z",
      licenseIds: [],
    },
    tags: ["art-direction"],
    intents: ["experience"],
    techniques: ["composition"],
    relatedEntryIds: [],
    createdAt: "2026-08-16T00:00:00Z",
  };
}

const refs = [reference("ref-a"), reference("ref-b", "MOTION")];

function base(overrides: Partial<CreativeExecutionContract> = {}): CreativeExecutionContract {
  return {
    schemaVersion: 1,
    projectId: "project-a",
    scope,
    visualThesis: "The experience behaves like the business ritual itself, changing pace as the customer moves through it.",
    signatureMechanic: "A business-specific spatial mechanic changes scale and role across the full customer journey.",
    compositionGrammar: ["ritual controls rhythm", "objects cross section boundaries", "content density follows service pace"],
    businessSpecificSignals: ["service ritual", "physical object", "customer cadence"],
    referenceEntryIds: ["ref-a", "ref-b"],
    referencePrinciples: ["use spatial continuity rather than stacked sections", "motion should expose hierarchy rather than decorate"],
    conventionalPatterns: ["NAV"],
    genericPatternsRejected: ["generic photo hero", "repetitive feature cards"],
    desktopArtDirection: "Desktop uses a continuous spatial field with business objects controlling hierarchy and depth.",
    mobileArtDirection: "Mobile becomes a vertical ritual sequence with deliberate interruptions and object-led transitions.",
    mobileTransformationSignals: ["sequence changes", "signature object changes scale"],
    motionPurpose: ["show progression", "connect spatial states"],
    signatureMechanicPlacements: ["entry", "decision", "conversion"],
    adversarial: { brandSwapVerdict: "PASS", crossIndustryReuseReasons: [] },
    ...overrides,
  };
}

describe("NEXUS Creative Critic", () => {
  it("approves a reference-grounded, business-specific execution contract", () => {
    const report = new NexusCreativeCritic().evaluate(base(), refs);
    expect(report.approved).toBe(true);
    expect(report.verdict).toBe("PASS");
    expect(report).not.toHaveProperty("score");
    expect(report.referenceEntryIds).toEqual(["ref-a", "ref-b"]);
  });

  it("rejects a La Pause-style polished editorial template that survives a brand swap", () => {
    const report = new NexusCreativeCritic().evaluate(base({
      visualThesis: "Editorial premium restaurant page with large type and food photography.",
      signatureMechanic: "Red vertical stripe with round photos.",
      compositionGrammar: ["large editorial headline", "red vertical axis", "floating content boxes"],
      businessSpecificSignals: ["food photography"],
      conventionalPatterns: ["NAV", "HERO_OVERLAY", "TEXT_IMAGE_SPLIT", "FEATURE_CARDS", "CONTACT_FOOTER"],
      signatureMechanicPlacements: ["hero"],
      adversarial: {
        brandSwapVerdict: "FAIL",
        crossIndustryReuseReasons: ["replace food photography and copy", "same editorial grid works for fashion or hospitality"],
      },
    }), refs);
    expect(report.approved).toBe(false);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "BUSINESS_SPECIFICITY_LOW",
      "SIGNATURE_MECHANIC_WEAK",
      "GENERIC_PATTERN_DOMINANCE",
      "BRAND_SWAP_PORTABILITY_HIGH",
    ]));
  });

  it("rejects a Coff & Breiq-style pill-nav/photo-hero/split-section recipe", () => {
    const report = new NexusCreativeCritic().evaluate(base({
      visualThesis: "Warm premium cafe experience with photography and concise copy.",
      signatureMechanic: "Warm photography treatment.",
      compositionGrammar: ["photo hero", "alternating split sections", "small rounded controls"],
      businessSpecificSignals: ["coffee"],
      conventionalPatterns: ["PILL_NAV", "HERO_OVERLAY", "TEXT_IMAGE_SPLIT", "CTA_BAND"],
      signatureMechanicPlacements: ["hero"],
      adversarial: {
        brandSwapVerdict: "FAIL",
        crossIndustryReuseReasons: ["replace cafe photos with hotel photos", "same split layout works for restaurant or real estate"],
      },
    }), refs);
    expect(report.approved).toBe(false);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.map((item) => item.code)).toContain("CONVENTIONAL_STACK");
    expect(report.findings.map((item) => item.code)).toContain("BRAND_SWAP_PORTABILITY_HIGH");
  });

  it("blocks approval when brand-swap testing was not executed", () => {
    const report = new NexusCreativeCritic().evaluate(base({
      adversarial: { brandSwapVerdict: "NOT_TESTED", crossIndustryReuseReasons: [] },
    }), refs);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.map((item) => item.code)).toContain("BRAND_SWAP_NOT_TESTED");
  });

  it("rejects creative approval when the private Gallery/Vault evidence is missing", () => {
    const report = new NexusCreativeCritic().evaluate(base(), [refs[0]!]);
    expect(report.approved).toBe(false);
    expect(report.findings.map((item) => item.code)).toContain("REFERENCE_EVIDENCE_MISSING");
  });

  it("rejects references from another tenant or brand", () => {
    const foreign = { ...refs[1]!, scope: { tenantId: "tenant-b", brandId: "brand-a" } };
    const report = new NexusCreativeCritic().evaluate(base(), [refs[0]!, foreign]);
    expect(report.approved).toBe(false);
    expect(report.findings.map((item) => item.code)).toContain("REFERENCE_SCOPE_MISMATCH");
  });
});
