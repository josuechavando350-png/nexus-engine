import type { Metadata } from "next";
import { InteriorCta, InteriorHero } from "../InteriorSections";
import { PageShell } from "../SiteChrome";
import { cases } from "../content";

export const metadata: Metadata = {
  title: "Casos y experiencia aplicada | CANO Estrategia Penal",
  description: "Selección de asuntos de defensa penal presentada con contexto, estrategia y advertencia expresa de que cada caso depende de sus propios hechos.",
  alternates: { canonical: "https://canopenal.com/casos" },
};

export default function CasesPage() {
  return (
    <PageShell>
      <InteriorHero
        eyebrow="Experiencia aplicada"
        title="Casos"
        lead="Una selección de asuntos que muestra cómo cambia la estrategia cuando cambian los hechos, la evidencia y la posición procesal."
      />

      <section className="cp-interior-body">
        <div className="cp-wrap">
          <div className="cp-cases-premium">
            {cases.map(([title, body]) => (
              <article className="cp-case-premium" key={title}>
                <p className="cp-eyebrow">Asunto publicado</p>
                <h2>{title}</h2>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <div className="cp-case-disclaimer">
            <strong>Sobre estos casos</strong>
            <p>Los resultados anteriores no garantizan resultados futuros. Cada asunto depende de sus hechos, evidencia, etapa procesal y decisiones de las autoridades. Antes de ampliar cualquier caso con nombres, documentos, montos o detalles identificables debe verificarse que su publicación sea jurídicamente y éticamente procedente.</p>
          </div>
        </div>
      </section>

      <InteriorCta
        eyebrow="Cada asunto es distinto"
        title="Tu caso no debe tratarse como una plantilla."
        copy="La estrategia depende de la evidencia, del momento procesal y de lo que ya hizo la autoridad. Empecemos por revisar eso."
      />
    </PageShell>
  );
}
