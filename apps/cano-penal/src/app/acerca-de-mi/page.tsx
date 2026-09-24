import type { Metadata } from "next";
import { InteriorCta, InteriorHero } from "../InteriorSections";
import { PageShell } from "../SiteChrome";
import { academics, trajectory } from "../content";

export const metadata: Metadata = {
  title: "Acerca de mí — abogado penalista CDMX",
  description: "Trayectoria de Eduardo Cano, abogado penalista CDMX con experiencia en delitos fiscales y defensa penal."
};

export default function AboutPage() {
  return (
    <PageShell>
      <InteriorHero
        eyebrow="Acerca de mí"
        title="Eduardo Cano"
        lead="Experiencia institucional en delitos fiscales y financieros, llevada a una práctica de defensa penal directa y personal."
        aside={
          <figure className="cp-interior-portrait">
            <img src="/media/eduardo-cano-escritorio.jpg" alt="Eduardo Cano en su despacho" />
          </figure>
        }
      />

      <section className="cp-interior-body">
        <div className="cp-wrap cp-about-layout">
          <div>
            <p className="cp-eyebrow">Trayectoria</p>
            <p className="cp-about-statement">{trajectory}</p>
          </div>
          <div className="cp-about-academics">
            <p className="cp-eyebrow">Formación especializada</p>
            <h2>Preparación para asuntos complejos.</h2>
            <ul className="cp-list">
              {academics.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        </div>
      </section>

      <InteriorCta
        title="La estrategia empieza por entender bien el problema."
        copy="Si estás enfrentando una investigación, una citación o una decisión penal importante, revisemos primero el contexto completo."
      />
    </PageShell>
  );
}
