import type { Metadata } from "next";
import { InteriorCta, InteriorHero } from "../InteriorSections";
import { PageShell } from "../SiteChrome";
import { cases } from "../content";

export const metadata: Metadata = {
  title: "Casos — abogado penalista CDMX",
  description: "Casos de defensa penal en CDMX, incluidos homicidio, delito fiscal, abuso sexual, despojo y corrupción."
};

export default function CasesPage() {
  return (
    <PageShell>
      <InteriorHero
        eyebrow="Experiencia aplicada"
        title="Casos"
        lead="Una selección de asuntos que muestra cómo cambia la estrategia cuando cambian los hechos, la evidencia y la posición procesal."
        marker="06"
      />

      <section className="cp-interior-body">
        <div className="cp-wrap">
          <div className="cp-cases-premium">
            {cases.map(([title, body], index) => (
              <article className="cp-case-premium" key={title}>
                <span className="cp-case-premium-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <h2>{title}</h2>
                <p>{body}</p>
              </article>
            ))}
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
