import { describe, expect, test } from "vitest";
import { addWorkspaceImporterFromSeed, compileProjectSources, parseProjectSpecification } from "../scripts/project-spec-contract.mjs";

const fixture = (overrides = {}) => ({
  schemaVersion: 1,
  slug: "audit-fixture-client",
  business: {
    name: "Audit Fixture",
    industry: "Hospitality",
    location: "Mérida, Yucatán",
    contact: { email: "hello@example.com", website: "https://example.com/" },
    confirmedServices: [{ name: "Reservations", description: "Direct reservations" }, { name: "Events" }],
  },
  artDirection: {
    palette: [
      { hex: "#111111", role: "surface", rationale: "Dark base" },
      { hex: "#F2EBDD", role: "accent", rationale: "Warm contrast" },
    ],
    typography: { display: "Editorial serif", body: "Humanist sans", rationale: "Editorial hierarchy" },
    heroComposition: { direction: "Asymmetric split", rationale: "Prioritize the business identity" },
    sectionRhythm: { direction: "Open and spacious", rationale: "Measured pacing" },
    motion: { direction: "Short reveals", reducedMotionBehavior: "No transforms", rationale: "Preserve orientation" },
    prohibitions: ["No invented reviews"],
  },
  ...overrides,
});

describe("strict NEXUS project specification compiler", () => {
  test("compiles factual project data into a complete non-placeholder client bootstrap", () => {
    const spec = parseProjectSpecification(fixture(), "audit-fixture-client");
    const compiled = compileProjectSources(spec);
    expect(compiled.specDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(compiled.design.compositionMode).toBe("SPLIT");
    expect(compiled.design.rhythmMode).toBe("SPACIOUS");
    expect(compiled.design.theme["surface.base"]).toBe("#111111");
    expect(compiled.design.theme["accent.default"]).toBe("#F2EBDD");
    const page = compiled.files.get("src/app/page.tsx");
    const layout = compiled.files.get("src/app/layout.tsx");
    const data = compiled.files.get("src/app/project-data.ts");
    expect(page).toContain("projectData.business.confirmedServices");
    expect(page).not.toMatch(/\[\s*(?:Marca|Título|Acción|Contenido|Pie|Enlace)/u);
    expect(layout).toContain("title: projectData.business.name");
    expect(data).toContain("Audit Fixture");
    expect(data).toContain("No invented reviews");
  });

  test("rejects unknown fields, malformed external URLs, duplicate roles and oversized input", () => {
    expect(() => parseProjectSpecification({ ...fixture(), unexpected: true }, "audit-fixture-client")).toThrow(/unknown or missing fields/);
    const badUrl = fixture();
    badUrl.business.contact.website = "javascript:alert(1)";
    expect(() => parseProjectSpecification(badUrl, "audit-fixture-client")).toThrow(/HTTP\(S\)/);
    const duplicate = fixture();
    duplicate.artDirection.palette[1].role = "SURFACE";
    expect(() => parseProjectSpecification(duplicate, "audit-fixture-client")).toThrow(/roles must be unique/);
    const oversized = fixture();
    oversized.business.name = "x".repeat(241);
    expect(() => parseProjectSpecification(oversized, "audit-fixture-client")).toThrow(/exceeds 240/);
  });

  test("keeps untrusted business text as data rather than executable page source", () => {
    const hostile = fixture();
    hostile.business.name = "</script><script>globalThis.pwned=true</script>";
    const compiled = compileProjectSources(parseProjectSpecification(hostile, "audit-fixture-client"));
    expect(compiled.files.get("src/app/page.tsx")).not.toContain("globalThis.pwned");
    expect(compiled.files.get("src/app/layout.tsx")).not.toContain("globalThis.pwned");
    expect(compiled.files.get("src/app/project-data.ts")).toContain("globalThis.pwned");
  });

  test("adds an exact client importer by cloning the seed importer and refuses duplicates", () => {
    const lock = "lockfileVersion: '9.0'\n\nimporters:\n\n  apps/_experience-seed:\n    dependencies:\n      '@nexus/core':\n        specifier: workspace:*\n        version: link:../../packages/core\n\n  packages/core: {}\n";
    const next = addWorkspaceImporterFromSeed(lock, "audit-fixture-client");
    expect(next).toContain("  apps/audit-fixture-client:\n    dependencies:\n      '@nexus/core':");
    expect(() => addWorkspaceImporterFromSeed(next, "audit-fixture-client")).toThrow(/already contains/);
  });
});
