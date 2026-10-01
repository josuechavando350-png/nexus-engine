import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { InteriorCta, InteriorHero, EditorialParagraphs } from "../InteriorSections";

export const metadata: Metadata = {
  title: "Orden de aprehensión en CDMX | Defensa penal",
  description: "Qué hacer ante una orden de aprehensión o riesgo de ejecución. Defensa penal estratégica en CDMX.",
  alternates: { canonical: "https://canopenal.com/orden-aprehension" },
};

const paragraphs = [
  "Una orden de aprehensión no se analiza únicamente por su existencia. Importan la autoridad que la emitió, el delito atribuido, la etapa procesal, la forma en que pretende ejecutarse y la evidencia que sostiene la solicitud.",
  "La primera decisión debe evitar movimientos improvisados que compliquen la defensa. Antes de actuar conviene reconstruir qué autoridad interviene, qué antecedentes existen y qué vías procesales están realmente disponibles.",
  "Cuando el asunto lo permite, la estrategia puede involucrar comparecencia, defensa en audiencia, revisión de legalidad, medidas cautelares y, según el caso concreto, mecanismos de control constitucional."
] as const;

export default function ArrestWarrantPage() {
  return <PageShell>
    <InteriorHero eyebrow="Orden de aprehensión" title="Una orden cambia el tiempo de la defensa." lead="La prioridad es entender qué existe realmente, quién la emitió y qué puede ocurrir después." marker="DEFENSA" />
    <section className="cp-page"><div className="cp-wrap cp-page-copy"><EditorialParagraphs paragraphs={paragraphs} /></div></section>
    <InteriorCta title="No conviene reaccionar sin conocer el expediente y la etapa." copy="Comparte únicamente la información general necesaria para identificar el escenario procesal y definir el siguiente paso." />
  </PageShell>;
}
