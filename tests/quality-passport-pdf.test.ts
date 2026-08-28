import { describe, expect, it } from "vitest";
import { buildPassportHtml } from "../scripts/quality-passport-pdf.mjs";

describe("quality passport PDF", () => {
  it("renders the certificate fields without listing artifact paths", () => {
    const html = buildPassportHtml({
      projectId: "cano-penal",
      engineVersion: "6.0.0",
      sourceRevision: "a".repeat(40),
      generatedAt: "2026-08-28T00:00:00.000Z",
      viewport: { width: 1440, height: 1200 },
      artifactHashes: { "private/build.js": "b".repeat(64) },
      checks: [{ id: "build", status: "PASS", detail: "build command exited successfully" }],
      verdict: "PASS",
      passportHash: "c".repeat(64),
    }, { clientName: "CANO Estrategia Penal", siteUrl: "https://example.test" });

    expect(html).toContain("Certificado de entrega");
    expect(html).toContain("1440 × 1200");
    expect(html).toContain("Archivos:</strong> 1");
    expect(html).toContain("c".repeat(64));
    expect(html).not.toContain("private/build.js");
    expect(html).toContain("Compilación del sitio");
    expect(html).toContain("El sitio compila sin errores");
    expect(html).toContain("CANO Estrategia Penal");
    expect(html).toContain("https://example.test");
    expect(html).toContain("Emitido por Nexus Bot Studio.");
  });

  it("escapes passport-provided content", () => {
    expect(buildPassportHtml({ projectId: "<script>", checks: [], artifactHashes: {} })).not.toContain("<script>");
  });

  it("omits optional presentation fields and preserves unknown checks", () => {
    const html = buildPassportHtml({ projectId: "fixture", checks: [{ id: "future-check", status: "PASS", detail: "future detail" }], artifactHashes: {} });
    expect(html).toContain("future-check");
    expect(html).toContain("future detail");
    expect(html).not.toContain("<dt>Cliente</dt>");
    expect(html).not.toContain("<dt>Sitio</dt>");
  });
});
