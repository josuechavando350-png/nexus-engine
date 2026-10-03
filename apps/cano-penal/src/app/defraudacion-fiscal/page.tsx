import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { InteriorCta, InteriorHero, EditorialParagraphs } from "../InteriorSections";

export const metadata: Metadata = {
  title: "Defraudación fiscal | Defensa penal fiscal CDMX",
  description: "Defensa penal en investigaciones y procedimientos relacionados con defraudación fiscal, con experiencia institucional en delitos fiscales y financieros.",
  alternates: { canonical: "https://canopenal.com/defraudacion-fiscal" },
};

const paragraphs = [
  "Un asunto de defraudación fiscal exige leer, al mismo tiempo, los hechos, la contabilidad, los actos de autoridad y su posible dimensión penal. La defensa pierde precisión cuando se limita a repetir la discusión tributaria.",
  "La reconstrucción debe distinguir quién decidió, quién produjo o recibió información, qué documentación respalda las operaciones y sobre qué elementos se construye la hipótesis de la autoridad.",
  "Inicié mi trayectoria profesional en el área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación y posteriormente dirigí investigaciones en esa materia. Hoy esa experiencia institucional forma parte de mi manera de leer y defender un expediente penal-fiscal."
] as const;

export default function TaxFraudDefensePage() {
  return <PageShell>
    <InteriorHero eyebrow="Defraudación fiscal" title="El expediente penal empieza mucho antes de la imputación." lead="Cuando una investigación converge, lo fiscal, lo financiero y lo penal deben leerse como partes de un mismo problema, sin confundir sus reglas ni sus consecuencias." marker="PENAL FISCAL" />
    <section className="cp-page"><div className="cp-wrap cp-page-copy"><EditorialParagraphs paragraphs={paragraphs} /></div></section>
    <InteriorCta eyebrow="Evaluación penal-fiscal" title="Antes de reaccionar, hay que reconstruir con precisión qué sostiene la autoridad y sobre qué evidencia." />
  </PageShell>;
}
