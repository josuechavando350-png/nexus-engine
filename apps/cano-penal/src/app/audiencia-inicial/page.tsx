import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { StrategicLanding } from "../StrategicLanding";

export const metadata: Metadata = {
  title: "Audiencia inicial en CDMX | Defensa penal",
  description: "Defensa en audiencia inicial: revisión de detención, imputación, vinculación y medidas cautelares según el caso concreto.",
  alternates: { canonical: "https://canopenal.com/audiencia-inicial" },
};

export default function InitialHearingPage() {
  return <PageShell><StrategicLanding
    eyebrow="Audiencia inicial"
    title="La audiencia inicial concentra decisiones que pueden cambiar todo el proceso."
    lead="Legalidad de la detención, imputación, vinculación y medidas cautelares requieren una defensa preparada antes de entrar a sala."
    marker="AUDIENCIA"
    context={[
      "La estrategia depende de cómo llegó el asunto a audiencia, qué datos presenta el Ministerio Público y qué antecedentes puede aportar la defensa.",
      "No existe una respuesta universal: el análisis debe ajustarse al expediente, al delito atribuido y a la situación personal de quien enfrenta el proceso."
    ]}
    scenarios={[
      { title: "Control de detención", copy: "Revisión de legalidad, temporalidad y circunstancias en que ocurrió la detención." },
      { title: "Imputación y vinculación", copy: "Análisis de hechos atribuidos, datos de prueba y teoría del caso presentada por la autoridad." },
      { title: "Medidas cautelares", copy: "Preparación de información y argumentos relevantes para discutir las medidas solicitadas." }
    ]}
    related={[
      { label: "Detenido en CDMX", href: "/detenido-cdmx" },
      { label: "Carpeta de investigación", href: "/carpeta-investigacion" },
      { label: "Orden de aprehensión", href: "/orden-aprehension" }
    ]}
    ctaTitle="La preparación debe ocurrir antes de que empiece la audiencia."
  /></PageShell>;
}
