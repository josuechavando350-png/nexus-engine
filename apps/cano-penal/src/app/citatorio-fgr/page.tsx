import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { StrategicLanding } from "../StrategicLanding";

export const metadata: Metadata = {
  title: "Citatorio de la FGR | Qué revisar antes de comparecer",
  description: "Orientación y defensa penal ante un citatorio de la Fiscalía General de la República. Revisión de autoridad, carácter y etapa antes de comparecer.",
  alternates: { canonical: "https://canopenal.com/citatorio-fgr" },
};

export default function FgrSummonsPage() {
  return <PageShell><StrategicLanding
    eyebrow="Citatorio FGR"
    title="Un citatorio no debe atenderse sin entender por qué te están llamando."
    lead="Antes de comparecer conviene identificar en qué carácter se solicita tu presencia, qué autoridad interviene, en qué etapa está el asunto y qué información puede existir ya en la investigación."
    marker="FGR"
    context={[
      "El mismo documento puede exigir decisiones distintas según la calidad en la que se solicita la comparecencia y el momento procesal del asunto.",
      "La primera revisión debe centrarse en el documento, el plazo, la autoridad que lo emite y los antecedentes que permitan entender el contexto antes de comparecer."
    ]}
    scenarios={[
      { title: "Calidad procesal", copy: "Determinar en qué carácter se solicita la comparecencia y qué derechos corresponden." },
      { title: "Preparación", copy: "Definir qué documentación revisar y qué decisiones no deben improvisarse antes de acudir." },
      { title: "Riesgo federal", copy: "Identificar si existen antecedentes fiscales, financieros, empresariales u otros que cambien la lectura del asunto." }
    ]}
    related={[
      { label: "Citatorio del Ministerio Público", href: "/citatorio-ministerio-publico-cdmx" },
      { label: "Carpeta de investigación", href: "/carpeta-investigacion" },
      { label: "Defensa penal fiscal", href: "/defensa-penal-fiscal" }
    ]}
    ctaTitle="Antes de comparecer, conviene entender qué solicita la autoridad, en qué contexto y qué decisiones deben prepararse."
  /></PageShell>;
}
