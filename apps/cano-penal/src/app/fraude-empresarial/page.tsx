import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { InteriorCta, InteriorHero, EditorialParagraphs } from "../InteriorSections";

export const metadata: Metadata = {
  title: "Fraude empresarial en CDMX | Defensa penal estratégica",
  description: "Defensa y estrategia penal en investigaciones por fraude empresarial, administración fraudulenta y conflictos patrimoniales complejos.",
  alternates: { canonical: "https://canopenal.com/fraude-empresarial" },
};

const paragraphs = [
  "En un conflicto empresarial, una acusación de fraude puede coexistir con disputas societarias, contables, contractuales y patrimoniales. Una defensa seria exige separar cada plano antes de fijar una posición penal.",
  "La reconstrucción documental suele ser decisiva: flujos de dinero, facultades de decisión, comunicaciones, autorizaciones, contabilidad y participación efectiva pueden cambiar por completo la lectura de los hechos.",
  "La estrategia debe distinguir responsabilidad individual, exposición de administradores y consecuencias para la empresa. Un incumplimiento comercial no equivale, por sí mismo, a fraude; tampoco una intervención corporativa implica automáticamente la misma responsabilidad penal."
] as const;

export default function CorporateFraudPage() {
  return <PageShell>
    <InteriorHero eyebrow="Fraude empresarial" title="Cuando el conflicto corporativo entra al terreno penal." lead="La prioridad es reconstruir hechos, decisiones, flujos de dinero y participación real antes de asumir una narrativa." marker="EMPRESA" />
    <section className="cp-page"><div className="cp-wrap cp-page-copy"><EditorialParagraphs paragraphs={paragraphs} /></div></section>
    <InteriorCta eyebrow="Evaluación empresarial" title="Una acusación corporativa no debe analizarse como un asunto penal aislado." copy="Primero identifico el contexto, la etapa y la exposición real. Si el asunto requiere intervención, la documentación se revisa después por un canal adecuado y confidencial." />
  </PageShell>;
}
