import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * These tests protect exactly one boundary: `_experience-seed` must stay
 * neutral. They do NOT police design decisions inside a real Experience —
 * per the V1.1 correction, NEXUS does not test for or restrict legitimate
 * art direction. Nothing here would apply to, or should ever be copied
 * onto, an actual client app.
 */

const root = process.cwd();
const seedRoot = join(root, "apps/_experience-seed");
const seedSrc = join(seedRoot, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const seedFiles = existsSync(seedSrc) ? walk(seedSrc) : [];
const seedSourceFiles = seedFiles.filter((f) => /\.(ts|tsx)$/.test(f));
const seedCssFiles = seedFiles.filter((f) => f.endsWith(".css"));

describe("NEXUS Experience Seed boundaries", () => {
  it("exists with the expected minimal file set", () => {
    expect(existsSync(seedRoot)).toBe(true);
    expect(existsSync(join(seedRoot, "package.json"))).toBe(true);
  });

  it("does not reintroduce the retired _template-client composition vocabulary", () => {
    // Exact classnames that only ever meant one specific, opinionated
    // composition. Their reappearance here would mean the seed drifted
    // back into being a template.
    const retiredClassNames = [
      "nexus-eyebrow",
      "nexus-hero-title",
      "nexus-hero-copy",
      "nexus-primary-action",
      "nexus-secondary-action",
      "nexus-capability-card",
      "nexus-card-eyebrow",
      "nexus-section-label",
      "nexus-section-title",
      "nexus-statement",
      "nexus-site-header",
      "nexus-brand",
      "nexus-nav-cta",
      "nexus-site-footer",
      "nexus-footer-brand",
      "nexus-footer-copy",
      "nexus-footer-links",
      "nexus-footer-meta"
    ];

    const allSource = [...seedSourceFiles, ...seedCssFiles]
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    const found = retiredClassNames.filter((name) => allSource.includes(name));
    expect(found).toEqual([]);
  });

  it("does not define marketing-pattern components", () => {
    // Matches actual declarations/usage (function/const/class/JSX tag), not
    // prose or comments that merely discuss why these are absent — the
    // seed's own docs legitimately need to say "no Hero here" in plain
    // English without tripping this check.
    const forbidden = "Hero|Features|CTA|Navbar|Pricing|Testimonials|Gallery";
    const declarationPattern = new RegExp(
      `(?:function|const|class|type|interface)\\s+(?:${forbidden})\\b|<(?:${forbidden})\\b`
    );

    for (const file of seedSourceFiles) {
      const source = readFileSync(file, "utf8");
      expect(declarationPattern.test(source)).toBe(false);
    }
  });

  it("does not hardcode color literals outside the theme layer", () => {
    // theme.ts is the one file allowed to hold concrete values (the
    // required, non-brand baseline). Every other source/CSS file in the
    // seed must have none.
    const nonThemeFiles = [...seedSourceFiles, ...seedCssFiles].filter(
      (f) => !f.endsWith(`${join("app", "theme.ts")}`)
    );

    const offenders: string[] = [];
    for (const file of nonThemeFiles) {
      const content = readFileSync(file, "utf8");
      if (/#[0-9a-fA-F]{3,8}\b/.test(content)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it("required theme roles stay free of experience-specific roles", () => {
    const contract = readFileSync(
      join(seedSrc, "app/theme-contract.ts"),
      "utf8"
    );
    const theme = readFileSync(join(seedSrc, "app/theme.ts"), "utf8");

    // The seed's theme.ts must never set any of these — that is the whole
    // point of the REQUIRED vs EXPERIENCE_SPECIFIC split.
    const experienceOnlyRoles = [
      "surface.base",
      "content.primary",
      "accent.default",
      "border.subtle",
      "radius.md"
    ];

    for (const role of experienceOnlyRoles) {
      expect(theme).not.toContain(`"${role}"`);
    }

    // Sanity check the contract file actually classifies these as
    // experience-specific, so this test fails loudly if the contract
    // itself is edited to move a role between categories.
    expect(contract).toContain("EXPERIENCE_SPECIFIC_TOKEN_ROLES");
  });
});
