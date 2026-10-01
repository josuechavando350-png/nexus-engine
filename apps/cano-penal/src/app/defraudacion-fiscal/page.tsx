import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { InteriorCta, InteriorHero, EditorialParagraphs } from "../InteriorSections";

export const metadata: Metadata = {
  title: "Defraudación fiscal | Defensa penal fiscal CDMX",
  description: "Defensa penal en investigaciones y procedimientos relacionados con defraudación fiscal, con experiencia institucional en delitos fiscales y financieros.",
  alternates: { canonical: "https://canopenal.com/defraudacion-fiscal" },
};

const paragraphs = [
  "Un asunto de defraudación fiscal exige leer simultáneamente hechos, contabilidad, actos de autoridad y consecuencias penales. La defensa no puede limitarse a repetir la discusión tributaria.",
  "Importa distinguir quién tomó decisiones, quién produjo o recibió información, qué documentación respalda las operaciones y cómo se construyó la hipótesis de la autoridad.",
  "Eduardo Cano inició su trayectoria profesional en el área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación y posteriormente dirigió investigaciones en esa materia. Esa experiencia institucional forma parte del enfoque actual de defensa."
] as const;

export default function TaxFraudDefensePage() {
  return <PageShell>
    <InteriorHero eyebrow="Defraudación fiscal" title="El expediente penal empieza mucho antes de la imputación." lead="Fiscal, financiero y penal deben leerse como un solo problema cuando la investigación converge." marker="PENAL FISCAL" />
    <section className="cp-page"><div className="cp-wrap cp-page-copy"><EditorialParagraphs paragraphs={paragraphs} /></div></section>
    <InteriorCta eyebrow="Evaluación penal-fiscal" title="Primero hay que reconstruir qué está sosteniendo la autoridad." />
  </PageShell>;
}
