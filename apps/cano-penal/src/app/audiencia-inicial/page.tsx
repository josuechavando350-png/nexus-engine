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
    title="La audiencia inicial concentra decisiones que pueden marcar el resto del proceso."
    lead="Control de detención, imputación, vinculación y medidas cautelares exigen llegar a sala con el expediente, los riesgos y la estrategia previamente trabajados."
    marker="AUDIENCIA"
    context={[
      "La estrategia depende de cómo llegó el asunto a audiencia, qué sostiene el Ministerio Público y qué antecedentes puede aportar la defensa para controvertir o contextualizar esa versión.",
      "No existe una respuesta universal: cada decisión debe ajustarse al expediente, al delito atribuido, a la evidencia disponible y a la situación personal de quien enfrenta el proceso."
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
    ctaTitle="La audiencia no es el lugar para empezar a improvisar la defensa."
  /></PageShell>;
}
