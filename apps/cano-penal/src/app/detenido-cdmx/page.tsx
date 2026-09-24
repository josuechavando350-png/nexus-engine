import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "../SiteChrome";
import { site } from "../content";

export const metadata: Metadata = {
  title: "Abogado para detenido en CDMX | Defensa penal",
  description: "Atención penal para familiares y personas ante una detención en Ciudad de México. Conoce cómo contactar a Eduardo Cano.",
  alternates: { canonical: "https://canopenal.com/detenido-cdmx" },
};

const essentials = [
  [ "Ubicación", "Identificar en qué lugar se encuentra la persona y qué autoridad intervino."],
  [ "Situación", "Ubicar si existe una detención, traslado, citación o diligencia en curso."],
  [ "Contacto", "Hablar directamente con el despacho para explicar el contexto general sin divulgar datos sensibles en formularios."],
] as const;

export default function DetenidoPage() {
  return (
    <PageShell>
      <div className="cp-det-hero">
        <div className="cp-det-photo" aria-hidden="true"><img src="/media/audiencia-01.jpg" alt="" /></div>
        <div className="cp-wrap cp-det-hero-content">
          <p className="cp-eyebrow">Defensa penal · Ciudad de México</p>
          <h1>Cuando alguien está detenido, <em>cada decisión cuenta.</em></h1>
          <p>Si detuvieron a un familiar o necesitas representación ante una autoridad, habla con un abogado penalista para revisar la situación concreta.</p>
          <div className="cp-det-actions">
            <a className="cp-btn cp-btn-solid" href={site.phoneHref}>Llamar al despacho →</a>
            <a className="cp-btn" href={site.whatsapp} target="_blank" rel="noopener noreferrer">Escribir por WhatsApp ↗</a>
          </div>
          <span className="cp-det-phone">{site.phoneDisplay}</span>
        </div>
        <span className="cp-det-vertical" aria-hidden="true">CANO / DEFENSA DESDE EL PRIMER MOMENTO</span>
      </div>
      <section className="cp-det-essentials">
        <div className="cp-wrap cp-det-essentials-grid">
          <div className="cp-det-title">
            <span>Orientación inicial</span>
            <h2>Primero, entendamos <strong>qué está pasando.</strong></h2>
            <p>No todas las detenciones tienen el mismo contexto. El siguiente paso depende de la autoridad, la etapa y los hechos.</p>
          </div>
          <div className="cp-det-steps">
            {essentials.map(([title,copy])=>(
              <article key={title}>
                <div><h3>{title}</h3><p>{copy}</p></div>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="cp-det-close">
        <div className="cp-wrap">
          <p className="cp-eyebrow">Defensa personal</p>
          <h2>La defensa empieza antes de llegar a la sala.</h2>
          <div><p>Eduardo Cano atiende personalmente la estrategia penal. Para situaciones relacionadas con audiencia inicial, consulta también la ruta correspondiente.</p>
          <Link href="/audiencia-inicial-control-detencion-cdmx">Conocer la ruta de audiencia inicial ↗</Link></div>
        </div>
      </section>
    </PageShell>
  );
}
