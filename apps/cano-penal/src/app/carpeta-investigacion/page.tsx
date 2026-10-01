import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { InteriorCta, InteriorHero, EditorialParagraphs } from "../InteriorSections";

export const metadata: Metadata = {
  title: "Carpeta de investigación en CDMX | Defensa penal",
  description: "Defensa y estrategia ante una carpeta de investigación en CDMX. Análisis de etapa, actos de investigación y riesgos procesales.",
  alternates: { canonical: "https://canopenal.com/carpeta-investigacion" },
};

const paragraphs = [
  "Una carpeta de investigación puede encontrarse en momentos muy distintos. Saber que existe no significa conocer todavía su alcance, la calidad de los datos de prueba o la posición procesal de cada persona involucrada.",
  "La estrategia parte de identificar autoridad, hechos atribuidos, actos ya practicados, diligencias pendientes y riesgos inmediatos. Esa reconstrucción permite separar lo urgente de lo importante.",
  "La defensa temprana puede cambiar qué información se obtiene, qué diligencias se solicitan y cómo se llega a una eventual audiencia. Cada decisión depende del expediente y no de una fórmula general."
] as const;

export default function InvestigationFilePage() {
  return <PageShell>
    <InteriorHero eyebrow="Carpeta de investigación" title="La defensa empieza antes de la audiencia." lead="Entender el expediente temprano permite decidir con información, no con suposiciones." marker="INVESTIGACIÓN" />
    <section className="cp-page"><div className="cp-wrap cp-page-copy"><EditorialParagraphs paragraphs={paragraphs} /></div></section>
    <InteriorCta title="Primero hay que saber qué está investigando realmente la autoridad." />
  </PageShell>;
}
