export interface HomeHeroExperience {
  readonly id: "default" | "paid-search";
  readonly lineOne: string;
  readonly lineTwo: string;
  readonly lead: string;
  readonly primaryCta: string;
  readonly secondaryCta: string;
}

const DEFAULT_HERO: HomeHeroExperience = Object.freeze({
  id: "default",
  lineOne: "Conozco cómo investiga la autoridad.",
  lineTwo: "Trabajé dentro de ella.",
  lead: "20 años defendiendo exclusivamente en materia penal. Dirigí investigaciones en la Procuraduría Fiscal de la Federación. Hoy uso esa experiencia para defenderte.",
  primaryCta: "Hablemos de tu caso",
  secondaryCta: "Diagnóstico y estrategia — $2,500",
});

const PAID_SEARCH_HERO: HomeHeroExperience = Object.freeze({
  id: "paid-search",
  lineOne: "Defensa penal especializada.",
  lineTwo: "Experiencia desde dentro de la autoridad.",
  lead: "Atención personal en materia penal en CDMX. 20 años defendiendo exclusivamente en materia penal y experiencia previa dirigiendo investigaciones en la Procuraduría Fiscal de la Federación.",
  primaryCta: "Hablar con Eduardo Cano",
  secondaryCta: "Diagnóstico y estrategia — $2,500",
});

export function homeHeroForAdExperience(value: string | null | undefined): HomeHeroExperience {
  return value === PAID_SEARCH_HERO.id ? PAID_SEARCH_HERO : DEFAULT_HERO;
}
