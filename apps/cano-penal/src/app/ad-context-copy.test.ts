import { describe, expect, it } from "vitest";
import { homeHeroForAdExperience } from "./ad-context-copy";

describe("CANO governed ad-context copy", () => {
  it("preserves the production hero for direct or unknown traffic", () => {
    expect(homeHeroForAdExperience("default")).toEqual({
      id: "default",
      lineOne: "Conozco cómo investiga la autoridad.",
      lineTwo: "Trabajé dentro de ella.",
      lead: "20 años defendiendo exclusivamente en materia penal. Dirigí investigaciones en la Procuraduría Fiscal de la Federación. Hoy uso esa experiencia para defenderte.",
      primaryCta: "Hablemos de tu caso",
      secondaryCta: "Diagnóstico y estrategia — $2,500",
    });
    expect(homeHeroForAdExperience("attacker-controlled-value").id).toBe("default");
  });

  it("uses only the fixed paid-search experience for the allowlisted internal ID", () => {
    const paid = homeHeroForAdExperience("paid-search");
    expect(paid.id).toBe("paid-search");
    expect(paid.lineOne).toBe("Defensa penal especializada.");
    expect(JSON.stringify(paid)).not.toContain("gclid");
    expect(JSON.stringify(paid)).not.toContain("utm_");
  });
});
