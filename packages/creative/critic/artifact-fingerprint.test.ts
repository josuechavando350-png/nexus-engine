import { describe, expect, it } from "vitest";
import { NexusArtifactFingerprintCritic } from "./artifact-fingerprint";

const critic = new NexusArtifactFingerprintCritic();

describe("NexusArtifactFingerprintCritic", () => {
  it("fails the exact numbered-section convention when the project forbids it", () => {
    const report = critic.evaluate({
      html: `<main>
        <section><span>01</span><h2>Esto puede esperar</h2><a href="#menu">VER CARTA →</a></section>
        <section><span>02</span><h2>¿Ya te dio hambre?</h2><a href="#menu">VER LA CARTA →</a></section>
        <section><span>03</span><h2>Haz una pausa</h2><a href="#reserva">RESERVAR →</a></section>
      </main>`,
      css: ".section{display:grid}",
    }, {
      forbiddenPatterns: ["decorative 01/02/03 numbering", "gratuitous arrow glyphs"],
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.approved).toBe(false);
    expect(report.findings.map((item) => item.code)).toContain("NUMBERED_SECTIONS");
    expect(report.findings.map((item) => item.code)).toContain("DECORATIVE_ARROWS");
  });

  it("does not require the generator to self-declare its patterns", () => {
    const report = critic.evaluate({
      html: `<main><section>01 Inicio</section><section>02 Comer</section><section>03 Reservar</section></main>`,
    }, {
      forbiddenPatterns: ["decorative 01/02/03 numbering"],
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.findings.some((item) => item.code === "NUMBERED_SECTIONS" && item.severity === "BLOCK")).toBe(true);
  });

  it("fails when multiple independent generic artifact signals compound", () => {
    const report = critic.evaluate({
      html: `<header><nav>Menu</nav></header>
        <main>
          <section class="hero kicker">Hero</section>
          <section class="features kicker"><article class="card">A</article><article class="card">B</article><article class="card">C</article></section>
          <section class="gallery kicker">Gallery</section>
          <section class="contact">Contact</section>
        </main><footer>Footer</footer>`,
      css: `.features{display:grid;grid-template-columns:repeat(3,1fr)}.hero{background:linear-gradient(red,black)}.contact{background:radial-gradient(white,gray)}`,
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.approved).toBe(false);
    expect(report.findings.map((item) => item.code)).toContain("GENERIC_CARD_GRID");
    expect(report.findings.map((item) => item.code)).toContain("GENERIC_SECTION_STACK");
  });

  it("passes a sparse brand-specific artifact without generic conventions", () => {
    const report = critic.evaluate({
      html: `<main><section class="pause-opening"><h1>LA PAUSE</h1><p>Tómate diez segundos.</p></section><section class="table-memory"><h2>Esto puede esperar. El desayuno no.</h2></section></main>`,
      css: `.pause-opening{min-height:100svh}.table-memory{max-width:72rem;margin:auto}`,
    }, {
      forbiddenPatterns: ["decorative 01/02/03 numbering", "gratuitous arrow glyphs", "repeating card grids"],
    });

    expect(report.verdict).toBe("PASS");
    expect(report.approved).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("fails closed when rendered evidence is missing", () => {
    const report = critic.evaluate({ html: "" });
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("INVALID_RENDERED_ARTIFACT");
  });
});
