import type { Metadata } from "next";
import { InteriorCta, InteriorHero } from "../InteriorSections";
import { PageShell } from "../SiteChrome";
import { academics, trajectory } from "../content";

export const metadata: Metadata = {
  title: "Eduardo Cano | Trayectoria en defensa penal y delitos fiscales",
  description: "Trayectoria profesional de Eduardo Cano: experiencia institucional en delitos fiscales y financieros y práctica especializada de defensa penal.",
  alternates: { canonical: "https://canopenal.com/acerca-de-mi" },
};

export default function AboutPage() {
  return (
    <PageShell>
      <InteriorHero
        eyebrow="Eduardo Cano"
        title="Primero investigué. Ahora defiendo."
        lead="Mi experiencia institucional en delitos fiscales y financieros hoy forma parte de una práctica de defensa penal directa, especializada y documentable."
        aside={
          <figure className="cp-interior-portrait">
            <img src="/media/eduardo-cano-escritorio.jpg" alt="Eduardo Cano en su despacho" />
          </figure>
        }
      />

      <section className="cp-interior-body">
        <div className="cp-wrap cp-proof-center">
          <div className="cp-proof-center-intro">
            <p className="cp-eyebrow">Trayectoria</p>
            <p className="cp-about-statement">{trajectory}</p>
          </div>

          <div className="cp-proof-center-rail" aria-label="Trayectoria profesional">
            <article>
              <span>Inicio</span>
              <h2>Delitos fiscales y financieros</h2>
              <p>Ingresé al área especializada de la Procuraduría Fiscal de la Federación en 2006.</p>
            </article>
            <article>
              <span>Responsabilidad institucional</span>
              <h2>Dirección de investigaciones</h2>
              <p>Ascendí hasta dirigir investigaciones en esa misma materia.</p>
            </article>
            <article>
              <span>Práctica actual</span>
              <h2>Defensa penal estratégica</h2>
              <p>Hoy aplico esa experiencia al análisis y defensa de asuntos penales complejos.</p>
            </article>
          </div>

          <div className="cp-about-academics">
            <p className="cp-eyebrow">Formación especializada</p>
            <h2>Preparación para asuntos complejos.</h2>
            <ul className="cp-list">
              {academics.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>

          <div className="cp-proof-center-note">
            <p className="cp-eyebrow">Criterio de prueba</p>
            <p>Esta página distingue trayectoria profesional, formación y experiencia de cualquier promesa de resultado. Los cargos, estudios, participaciones y demás credenciales que se publiquen deben contar con respaldo verificable antes de presentarse como prueba.</p>
          </div>
        </div>
      </section>

      <InteriorCta
        eyebrow="Evaluación del asunto"
        title="La experiencia importa cuando cambia las preguntas que se hacen al expediente."
        copy="Si estás enfrentando una investigación, una citación o una decisión penal importante, revisemos primero el contexto completo."
      />
    </PageShell>
  );
}
