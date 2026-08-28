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
      checks: [{ id: "build", status: "PASS", detail: "build real" }],
      verdict: "PASS",
      passportHash: "c".repeat(64),
    });

    expect(html).toContain("Certificado de entrega");
    expect(html).toContain("1440 × 1200");
    expect(html).toContain("Archivos:</strong> 1");
    expect(html).toContain("c".repeat(64));
    expect(html).not.toContain("private/build.js");
  });

  it("escapes passport-provided content", () => {
    expect(buildPassportHtml({ projectId: "<script>", checks: [], artifactHashes: {} })).not.toContain("<script>");
  });
});
