import { describe, expect, it } from "vitest";
import type { DnaContentConstraints } from "../content-constraints";
import { synthesizeGroundedCopy, type GroundedFact } from "../grounded-copy";

const constraints: DnaContentConstraints = {
  authority: "NEXUS_DNA_CONTENT_CONSTRAINTS_V1",
  subject: "Example",
  businessType: "professional service",
  requiredCopyRoles: ["headline", "value-proposition", "primary-cta", "proof", "qualification-and-contact", "credentials-and-proof", "location-and-hours"],
  requiredPhotoRoles: [],
  maximumPrimaryCtaOccurrences: 2,
  minimumProofItems: 2,
  constraints: [],
};

const facts: GroundedFact[] = [
  { id: "name", kind: "BRAND_NAME", value: "Example", sourceId: "client:name" },
  { id: "type", kind: "BUSINESS_TYPE", value: "Clínica dental", sourceId: "client:type" },
  { id: "location", kind: "LOCATION", value: "Polanco, Ciudad de México", sourceId: "client:address" },
  { id: "address", kind: "ADDRESS", value: "Avenida Ejemplo 123, Polanco", sourceId: "client:address" },
  { id: "phone", kind: "PHONE", value: "55 0000 0000", sourceId: "client:phone" },
  { id: "rating", kind: "RATING", value: "5.0", sourceId: "google-place:verified", provider: "Google Maps" },
  { id: "reviews", kind: "REVIEW_COUNT", value: "51", sourceId: "google-place:verified", provider: "Google Maps" },
  { id: "cta", kind: "PRIMARY_ACTION_LABEL", value: "Escríbenos por WhatsApp", sourceId: "client:cta" },
];

describe("grounded copy synthesis", () => {
  it("produces every required role from supplied facts and records source evidence", () => {
    const result = synthesizeGroundedCopy({ constraints, facts, locale: "es-MX" });
    expect(result.items.map((item) => item.role)).toEqual(constraints.requiredCopyRoles);
    expect(result.items.find((item) => item.role === "proof")?.text).toContain("Google Maps");
    expect(result.items.find((item) => item.role === "proof")?.text).toContain("51 reseñas");
    expect(result.items.every((item) => item.evidenceIds.length > 0)).toBe(true);
    expect(result.synthesisDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("does not invent hours when no HOURS fact exists", () => {
    const result = synthesizeGroundedCopy({ constraints, facts, locale: "es-MX" });
    const location = result.items.find((item) => item.role === "location-and-hours")?.text ?? "";
    expect(location).toBe("Ubicación: Avenida Ejemplo 123, Polanco.");
    expect(location).not.toContain("Horario");
  });

  it("fails closed when a required factual role lacks evidence", () => {
    const withoutPhone = facts.filter((fact) => fact.kind !== "PHONE");
    expect(() => synthesizeGroundedCopy({ constraints, facts: withoutPhone, locale: "es-MX" })).toThrow(/missing PHONE fact/);
  });

  it("fails closed when the proof minimum cannot be grounded", () => {
    const weak = facts.filter((fact) => fact.kind !== "REVIEW_COUNT");
    expect(() => synthesizeGroundedCopy({ constraints, facts: weak, locale: "es-MX" })).toThrow(/at least 2 distinct proof fact/);
  });
});
