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
    title="Un citatorio no debe contestarse sin entender por qué te están llamando."
    lead="Antes de comparecer conviene identificar el carácter de la citación, la autoridad, la etapa y la información que ya puede existir en la investigación."
    marker="FGR"
    context={[
      "El mismo documento puede tener consecuencias distintas dependiendo de si la persona comparece como testigo, víctima, imputado u otra calidad procesal.",
      "La primera revisión debe centrarse en el documento, el plazo, la autoridad que lo emite y los antecedentes conocidos."
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
    ctaTitle="Antes de comparecer conviene entender exactamente qué está pidiendo la autoridad."
  /></PageShell>;
}
