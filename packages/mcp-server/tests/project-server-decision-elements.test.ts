import { describe, expect, it } from "vitest";
import { parseRenderedNexusElementIds } from "../src/project-server.js";

describe("rendered NEXUS decision element inventory", () => {
  it("extracts a canonical unique inventory from rendered HTML", () => {
    const ids = parseRenderedNexusElementIds(`
      <main>
        <section data-nexus-element="hero"></section>
        <a data-nexus-element='hero-contact-cta'>Contact</a>
        <section data-nexus-element="practice-areas"></section>
      </main>
    `);
    expect(ids).toEqual(["hero", "hero-contact-cta", "practice-areas"]);
  });

  it("fails closed on duplicate rendered identities", () => {
    expect(() => parseRenderedNexusElementIds(`
      <section data-nexus-element="hero"></section>
      <aside data-nexus-element="hero"></aside>
    `)).toThrow(/duplicate data-nexus-element ids: hero/);
  });

  it("fails closed on malformed or missing identities", () => {
    expect(() => parseRenderedNexusElementIds(`<section data-nexus-element="Hero Main"></section>`)).toThrow(/invalid rendered data-nexus-element id/);
    expect(() => parseRenderedNexusElementIds(`<main><section>no audit marker</section></main>`)).toThrow(/contains no data-nexus-element markers/);
  });
});
