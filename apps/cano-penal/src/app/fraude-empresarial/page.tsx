import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { InteriorCta, InteriorHero, EditorialParagraphs } from "../InteriorSections";

export const metadata: Metadata = {
  title: "Fraude empresarial en CDMX | Defensa penal estratégica",
  description: "Defensa y estrategia penal en investigaciones por fraude empresarial, administración fraudulenta y conflictos patrimoniales complejos.",
  alternates: { canonical: "https://canopenal.com/fraude-empresarial" },
};

const paragraphs = [
  "En un conflicto empresarial, una acusación de fraude puede convivir con disputas societarias, contables, contractuales y patrimoniales. La defensa penal exige separar esos planos antes de adoptar una posición.",
  "La reconstrucción documental suele ser central: flujos de dinero, facultades de decisión, comunicaciones, autorizaciones, contabilidad y participación real de cada persona pueden modificar por completo la lectura de los hechos.",
  "La estrategia debe distinguir responsabilidad individual, exposición de administradores y efectos para la empresa. No todo incumplimiento comercial constituye fraude, y no toda intervención corporativa implica la misma responsabilidad penal."
] as const;

export default function CorporateFraudPage() {
  return <PageShell>
    <InteriorHero eyebrow="Fraude empresarial" title="Cuando el conflicto corporativo entra al terreno penal." lead="La prioridad es reconstruir hechos, decisiones, dinero y participación real." marker="EMPRESA" />
    <section className="cp-page"><div className="cp-wrap cp-page-copy"><EditorialParagraphs paragraphs={paragraphs} /></div></section>
    <InteriorCta eyebrow="Evaluación empresarial" title="Una acusación corporativa no debe analizarse como un asunto penal aislado." copy="Identificamos el contexto general y, si el asunto es atendible, definimos el canal adecuado para revisar documentación y estrategia." />
  </PageShell>;
}
