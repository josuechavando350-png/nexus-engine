import { Link } from "@nexus/core";
import { InteriorCta, InteriorHero } from "./InteriorSections";

export function StrategicLanding({
  eyebrow,
  title,
  lead,
  marker,
  context,
  scenarios,
  related,
  ctaTitle,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  marker: string;
  context: readonly string[];
  scenarios: readonly { title: string; copy: string }[];
  related: readonly { label: string; href: string }[];
  ctaTitle: string;
}) {
  return (
    <>
      <InteriorHero eyebrow={eyebrow} title={title} lead={lead} marker={marker} />
      <section className="cp-page">
        <div className="cp-wrap cp-strategic-landing">
          <div className="cp-strategic-context">
            <p className="cp-eyebrow">Qué cambia el análisis</p>
            {context.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>
          <div className="cp-strategic-scenarios">
            {scenarios.map((item) => (
              <article key={item.title}>
                <h2>{item.title}</h2>
                <p>{item.copy}</p>
              </article>
            ))}
          </div>
          <div className="cp-strategic-related">
            <p className="cp-eyebrow">Información relacionada</p>
            {related.map((item) => <Link key={item.href} href={item.href} data-nexus-signal="strategic-related-link">{item.label} ↗</Link>)}
          </div>
        </div>
      </section>
      <InteriorCta eyebrow="Evaluación" title={ctaTitle} copy="Comparte únicamente el contexto general necesario para identificar la etapa, la autoridad y el riesgo inmediato. Los documentos sensibles se revisan por el canal adecuado." />
    </>
  );
}
