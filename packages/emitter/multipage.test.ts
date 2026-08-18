import { describe, expect, it } from "vitest";
import { defineExperienceBrief } from "@nexus/experience/brief";
import { synthesizeAutonomousExperience } from "@nexus/experience/autonomy";
import { deriveConstrainedEmitterInput } from "./color-constraints";
import { emitExperienceCss } from "./index";
import { emitMultipageNextApp } from "./multipage";

const brief = defineExperienceBrief({
  version: 2,
  id: "client-fixture",
  brand: {
    name: "Fixture Studio",
    industry: "professional service",
    positioning: "Boutique professional service with calm clarity and authentic documentary proof.",
    personality: ["boutique", "professional", "calm", "refined"],
    audiences: ["local clients"],
  },
  commercialGoal: "Make direct contact easy after trust is established.",
  priorities: ["authentic photography", "spacious editorial story", "clear contact"],
  requiredCapabilityIds: ["contact", "gallery", "location", "media"],
  assets: [{ id: "photo", kind: "photography", status: "available", notes: "real documentary photography" }],
  references: [{ id: "ref", sourceLabel: "approved", observations: { rhythm: "calm editorial flow", whitespace: "spacious", imageRelationship: "documentary proof" }, adaptationRule: "inspire-not-copy" }],
  forbiddenPatterns: ["generic template"],
  forbiddenWords: [],
  constraints: [
    { id: "palette", statement: "Use white and elegant gray as the color family.", source: "brand", severity: "required" },
    { id: "no-gold", statement: "Absolutely no gold or dorado anywhere.", source: "brand", severity: "required" },
  ],
});

async function generate() {
  const experience = synthesizeAutonomousExperience({
    brief,
    businessProfile: { businessType: "professional service", goals: ["INQUIRE", "TRUST"], differentiators: ["documentary proof"] },
  });
  const emitted = await emitExperienceCss(deriveConstrainedEmitterInput({ dna: experience.dna, constraints: brief.constraints, projectSeed: brief.id }));
  const copy = experience.contentConstraints.requiredCopyRoles.map((role) => ({
    role,
    text: role === "headline" ? "Fixture Studio" : role === "value-proposition" ? "Professional service supported by supplied project evidence." : `Verified ${role.replaceAll("-", " ")} information from the client.`,
    sourceId: `copy:${role}`,
  }));
  const media = experience.contentConstraints.requiredPhotoRoles.map((role, index) => ({
    assetId: `asset-${index + 1}`,
    role,
    publicPath: `/media/asset-${index + 1}.jpg`,
    sourceDigest: `sha256:${String(index + 1).padStart(64, "0")}` as `sha256:${string}`,
    alt: `Documentary project evidence ${index + 1}`,
  }));
  return emitMultipageNextApp({
    projectId: brief.id,
    locale: "en-US",
    brief,
    dna: experience.dna,
    plan: experience.plan,
    contentConstraints: experience.contentConstraints,
    tokenCss: emitted.css,
    copy,
    media,
    actions: [{ capabilityId: "contact", label: "Contact", href: "https://example.com/contact", sourceId: "action:contact", emphasis: "primary" }],
  });
}

describe("DNA-constrained multipage generator", () => {
  it("emits a deterministic, provenance-bound Next.js app with multiple routes", async () => {
    const first = await generate();
    const second = await generate();
    expect(first).toEqual(second);
    expect(first.routes.length).toBeGreaterThanOrEqual(2);
    expect(first.files.some((file) => file.path === "src/app/page.tsx")).toBe(true);
    expect(first.files.some((file) => file.path.endsWith("/page.tsx") && file.path !== "src/app/page.tsx")).toBe(true);
    expect(first.files.every((file) => /^sha256:[a-f0-9]{64}$/.test(file.digest))).toBe(true);
    expect(first.provenanceIds).toContain("constraint:no-gold");
    expect(first.generationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("preserves the explicit light neutral constraint in generated CSS without a manual aesthetic patch", async () => {
    const result = await generate();
    const css = result.files.find((file) => file.path === "src/app/generated.css")?.content ?? "";
    expect(css).toContain("--nexus-surface-0");
    expect(css).toContain("98.5%");
    expect(css.toLowerCase()).not.toContain("gold");
    expect(css.toLowerCase()).not.toContain("dorado");
  });

  it("fails closed when required content is missing", async () => {
    const experience = synthesizeAutonomousExperience({ brief, businessProfile: { businessType: "professional service", goals: ["INQUIRE"], differentiators: [] } });
    const emitted = await emitExperienceCss(deriveConstrainedEmitterInput({ dna: experience.dna, constraints: brief.constraints, projectSeed: brief.id }));
    expect(() => emitMultipageNextApp({ projectId: brief.id, locale: "en-US", brief, dna: experience.dna, plan: experience.plan, contentConstraints: experience.contentConstraints, tokenCss: emitted.css, copy: [], media: [], actions: [] })).toThrow(/missing required copy role/);
  });
});
