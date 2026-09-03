import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineExperienceBrief } from "@nexus/experience/brief";
import { synthesizeAutonomousExperience } from "@nexus/experience/autonomy";
import { deriveConstrainedEmitterInput } from "./color-constraints";
import { augmentExperienceFeatures } from "./experience-features";
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

async function expectGeneratedSourcesToCompile(generation: Awaited<ReturnType<typeof generate>>): Promise<void> {
  const root = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "nexus-generated-contract-"));
  try {
    await symlink(join(root, "apps/pipeline-probe/node_modules"), join(directory, "node_modules"), "dir");
    for (const file of generation.files) {
      const target = join(directory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    await writeFile(join(directory, "tsconfig.json"), `${JSON.stringify({
      extends: join(root, "apps/pipeline-probe/tsconfig.json"),
      compilerOptions: { incremental: false, noEmit: true },
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [],
    }, null, 2)}\n`, "utf8");
    execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(directory, "tsconfig.json"), "--pretty", "false"], { cwd: root, stdio: "pipe" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

  it("preserves the complete locale in the generated document language", async () => {
    const result = await generate();
    const layout = result.files.find((file) => file.path === "src/app/layout.tsx")?.content ?? "";
    expect(layout).toContain('<html lang="en-US">');
  });

  it("compiles generated feature sources with an empty review collection", async () => {
    const result = augmentExperienceFeatures({ generation: await generate(), locale: "en-US", constraints: [], location: { address: "123 Fixture Street", sourceId: "client:location" }, reviews: [] });
    await expectGeneratedSourcesToCompile(result);
  });

  it("compiles generated feature sources with evidence-bound reviews", async () => {
    const result = augmentExperienceFeatures({ generation: await generate(), locale: "en-US", constraints: [], reviews: [{ text: "Verified review.", sourceId: "google:review:1", provider: "GOOGLE_MAPS", author: "Reviewer", rating: 5 }] });
    await expectGeneratedSourcesToCompile(result);
  });

  it("compiles routes whose capability arrays contain different capability IDs", async () => {
    const result = augmentExperienceFeatures({ generation: await generate(), locale: "en-US", constraints: ["WhatsApp must be green."], reviews: [] });
    expect(new Set(result.routes.map((route) => route.capabilityIds.join(","))).size).toBeGreaterThan(1);
    await expectGeneratedSourcesToCompile(result);
  });

  it("compiles generated feature sources without a location", async () => {
    const result = augmentExperienceFeatures({ generation: await generate(), locale: "en-US", constraints: [], reviews: [] });
    await expectGeneratedSourcesToCompile(result);
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
