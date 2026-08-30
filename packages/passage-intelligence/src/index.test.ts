import { describe, expect, it } from "vitest";
import { assessPage, createPage, validateAssessment, validatePage, type PassagePageInput } from "./index.js";

function page(overrides: Partial<PassagePageInput> = {}): PassagePageInput {
  return {
    url: "https://example.com/fiscal",
    indexable: true,
    crawlAllowed: true,
    evidence: [{ id: "e1", source: "https://example.com/source", description: "Primary supporting material for the section." }],
    passages: [{
      id: "preventive-planning",
      heading: "Planeación fiscal preventiva",
      intent: "explicar planeación fiscal preventiva y sus controles",
      text: "La planeación fiscal preventiva documenta riesgos, supuestos y controles antes de ejecutar una decisión. El análisis vincula cada afirmación importante con evidencia verificable y explica las entidades involucradas dentro de la misma sección. Así, la persona puede entender el propósito, los límites y el soporte de la estrategia sin depender de otra parte de la página.",
      entityNames: ["planeación fiscal preventiva"],
      claimIds: ["c1"],
      evidenceIds: ["e1"],
    }],
    ...overrides,
  };
}

describe("passage intelligence", () => {
  it("creates replay-verifiable readiness diagnostics", () => {
    const model = createPage(page());
    const result = assessPage(model);
    expect(result.status).toBe("READY");
    expect(() => validatePage(model)).not.toThrow();
    expect(() => validateAssessment(model, result)).not.toThrow();
    expect(result.nonClaim).toBe("INTERNAL_PASSAGE_DIAGNOSTIC_NOT_INDEXING_EVIDENCE");
  });

  it("blocks page-level crawl/index ineligibility", () => {
    expect(assessPage(createPage(page({ indexable: false }))).status).toBe("BLOCKED");
    expect(assessPage(createPage(page({ crawlAllowed: false }))).status).toBe("BLOCKED");
  });

  it("flags ambiguous local references and missing evidence", () => {
    const model = createPage(page({ passages: [{ id: "p", heading: "Defensa fiscal", intent: "explicar defensa fiscal", text: "Esto permite reducir contingencias, pero lo anterior depende de información que no se define dentro de este breve fragmento.", claimIds: ["c"], evidenceIds: [] }] }));
    const passage = assessPage(model).passages[0]!;
    expect(passage.issues.map((issue) => issue.code)).toContain("AMBIGUOUS_LOCAL_REFERENCE");
    expect(passage.issues.map((issue) => issue.code)).toContain("CLAIM_WITHOUT_LOCAL_EVIDENCE");
  });

  it("binds recommendations to stable passage ids instead of digests", () => {
    const model = createPage(page({ passages: [{ id: "stable-passage", heading: "Defensa fiscal", intent: "explicar defensa fiscal", text: "Esto es breve y depende de contexto externo.", claimIds: ["c"], evidenceIds: [] }] }));
    const result = assessPage(model);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((item) => item.passageIds.includes("stable-passage"))).toBe(true);
    expect(result.recommendations.some((item) => item.passageIds.includes(model.passages[0]!.passageDigest))).toBe(false);
  });

  it("detects semantic duplication without creating doorway recommendations", () => {
    const text = "Una sección suficientemente extensa explica el proceso, sus límites, el contexto local y la evidencia relevante para que una persona pueda entender la respuesta sin depender de otra sección del documento.";
    const model = createPage(page({ passages: [
      { id: "a", heading: "Proceso documentado", intent: "explicar proceso documentado", text: `${text} ${text}` },
      { id: "b", heading: "Proceso documentado alterno", intent: "explicar proceso documentado", text: `${text} ${text}` },
    ] }));
    const result = assessPage(model);
    expect(result.duplicatePairs).toHaveLength(1);
    expect(result.recommendations.some((item) => item.kind === "DEDUPLICATE")).toBe(true);
  });

  it("rejects dangling evidence, duplicates and unsafe URLs", () => {
    expect(() => createPage(page({ passages: [{ id: "x", heading: "X", intent: "X", text: "Contenido suficientemente descriptivo para la prueba de referencia local dentro del pasaje.", evidenceIds: ["missing"] }] }))).toThrow(/unknown evidence/);
    expect(() => createPage(page({ passages: [
      { id: "dup", heading: "A", intent: "A", text: "Texto suficientemente descriptivo para una primera sección del documento." },
      { id: "dup", heading: "B", intent: "B", text: "Texto suficientemente descriptivo para una segunda sección del documento." },
    ] }))).toThrow(/duplicate ids/);
    expect(() => createPage(page({ url: "javascript:alert(1)" }))).toThrow(/HTTP/);
  });

  it("rejects tampered pages and forged assessments", () => {
    const model = createPage(page());
    expect(() => validatePage({ ...model, indexable: false })).toThrow(/digest mismatch/);
    const result = assessPage(model);
    const forged = { ...result, status: "BLOCKED" as const, assessmentDigest: "f".repeat(64) };
    expect(() => validateAssessment(model, forged)).toThrow(/replay mismatch/);
  });

  it("enforces passage budgets", () => {
    const passages = Array.from({ length: 251 }, (_, index) => ({ id: `p${index}`, heading: `Heading ${index}`, intent: `Intent ${index}`, text: "A bounded passage body with enough content for construction." }));
    expect(() => createPage(page({ passages }))).toThrow(/exceeds 250/);
  });
});
