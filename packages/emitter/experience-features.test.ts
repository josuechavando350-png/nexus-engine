import { describe, expect, it } from "vitest";
import { augmentExperienceFeatures } from "./experience-features";
import type { MultipageGenerationResult } from "./multipage";

const digest = `sha256:${"a".repeat(64)}` as const;
const base: MultipageGenerationResult = {
  authority: "NEXUS_MULTIPAGE_GENERATOR_V1",
  projectId: "fixture",
  routes: [
    { path: "/", navLabel: "Inicio", purpose: "home", capabilityIds: ["whatsapp"], copyRoles: [], mediaRoles: [] },
    { path: "/proof", navLabel: "Confianza", purpose: "proof", capabilityIds: ["reviews"], copyRoles: [], mediaRoles: [] },
    { path: "/visit", navLabel: "Ubicación", purpose: "visit", capabilityIds: ["location"], copyRoles: [], mediaRoles: [] },
  ],
  files: [
    { path: "src/app/ExperiencePage.tsx", content: "old component", digest, provenanceIds: [] },
    { path: "src/app/generated.css", content: ":root{}", digest, provenanceIds: [] },
  ],
  provenanceIds: [],
  generationDigest: digest,
};

const reviews = [
  { text: "Servicio verificado uno.", sourceId: "google-review:1", provider: "GOOGLE_MAPS" as const, author: "Persona 1", rating: 5 },
  { text: "Servicio verificado dos.", sourceId: "google-review:2", provider: "GOOGLE_MAPS" as const, author: "Persona 2", rating: 5 },
];

describe("experience feature augmenter", () => {
  it("binds green WhatsApp semantics, map address and exact Google Maps reviews into generated sources", () => {
    const result = augmentExperienceFeatures({
      generation: base,
      locale: "es-MX",
      constraints: ["El botón de WhatsApp debe ser verde."],
      location: { address: "Avenida Ejemplo 123, Polanco, CDMX", sourceId: "client:address" },
      reviews,
      minimumReviewItems: 2,
    });
    const component = result.files.find((file) => file.path === "src/app/ExperiencePage.tsx")?.content ?? "";
    const css = result.files.find((file) => file.path === "src/app/generated.css")?.content ?? "";
    const features = result.files.find((file) => file.path === "src/app/features-data.ts")?.content ?? "";
    expect(component).toContain("data-semantic-tone");
    expect(css).toContain('data-semantic-tone="green"');
    expect(features).toContain("Avenida Ejemplo 123");
    expect(features).toContain("google-review:1");
    expect(features).toContain("Servicio verificado dos.");
    expect(result.provenanceIds).toContain("client:address");
    expect(result.provenanceIds).toContain("google-review:2");
  });

  it("fails closed when a required Google Maps review minimum is not met", () => {
    expect(() => augmentExperienceFeatures({ generation: base, locale: "es-MX", constraints: [], reviews: [], minimumReviewItems: 10 })).toThrow(/at least 10 Google Maps review item/);
  });

  it("rejects review text that is not explicitly sourced from Google Maps", () => {
    expect(() => augmentExperienceFeatures({
      generation: base,
      locale: "es-MX",
      constraints: [],
      reviews: [{ text: "No permitido", sourceId: "other:1", provider: "OTHER" as never }],
      minimumReviewItems: 1,
    })).toThrow(/GOOGLE_MAPS provider provenance/);
  });

  it("does not invent a map when no evidence-bound location is supplied", () => {
    const result = augmentExperienceFeatures({ generation: base, locale: "es-MX", constraints: [], reviews: [], minimumReviewItems: 0 });
    const features = result.files.find((file) => file.path === "src/app/features-data.ts")?.content ?? "";
    expect(features).toContain('"location": null');
  });
});
