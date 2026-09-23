import { Link } from "@nexus/core";
import { site } from "./content";

type Props = { slug: string; heading: string; paragraphs: readonly string[] };

function ContactLink({ children }: { children: React.ReactNode }) {
  return <a className="cp-area-contact-link" href={site.whatsapp} target="_blank" rel="noopener noreferrer">{children}<span aria-hidden="true">↗</span></a>;
}

/* Every approved practice area receives its own layout, rhythm and reading order. */
export function AreaExperience({ slug, heading, paragraphs: p }: Props) {
  switch (slug) {
    case "delitos-fiscales-y-financieros":
      return <>
        <section className="cp-af-hero">
          <div className="cp-wrap cp-af-hero-grid">
            <div><p className="cp-area-overline">CANO / Defensa especializada</p><h1>{heading}</h1><p className="cp-af-intro">{p[0]}</p></div>
            <aside className="cp-af-hero-aside"><span>FISCAL<br />FINANCIERO</span><p>El expediente empieza antes de la imputación.</p><Link href="/guias/requerimiento-sat-riesgo-penal">Requerimientos del SAT ↗</Link></aside>
          </div>
        </section>
        <section className="cp-af-record"><div className="cp-wrap cp-af-record-grid"><div><p className="cp-area-overline">Perspectiva de defensa</p><h2>Conocer cómo se construye una investigación.</h2><p>{p[1]}</p></div><div className="cp-af-record-list"><span>Ámbitos de intervención</span><p>{p[2]}</p><Link href="/guias/responsabilidad-penal-representante-legal-contador">Representantes y contadores ↗</Link><Link href="/herramientas/calendario-fiscal">Explorar calendario fiscal ↗</Link></div></div></section>
        <section className="cp-af-closing"><div className="cp-wrap"><p className="cp-area-overline">Una decisión informada</p>{p.slice(3).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}<ContactLink>Solicitar revisión penal-fiscal</ContactLink></div></section>
      </>;
    case "delitos-patrimoniales-y-fraude":
      return <>
        <section className="cp-ap-hero"><div className="cp-wrap cp-ap-hero-grid"><div><p className="cp-area-overline">Patrimonio y prueba</p><h1>{heading}</h1></div><div className="cp-ap-hero-panel"><span>El punto de partida</span><p>{p[0]}</p></div></div></section>
        <section className="cp-ap-analysis"><div className="cp-wrap"><header><p className="cp-area-overline">Lectura del asunto</p><h2>Primero, distinguir los hechos.</h2></header><div className="cp-ap-analysis-grid"><article><span>Naturaleza de los hechos</span><p>{p[1]}</p></article><article><span>Alcance de la representación</span><p>{p[2]}</p></article></div></div></section>
        <section className="cp-ap-contact"><div className="cp-wrap"><span>Defensa y representación</span><h2>Una estrategia parte del expediente, no de suposiciones.</h2><ContactLink>Plantear el asunto al despacho</ContactLink></div></section>
      </>;
    case "homicidio-y-delitos-violentos":
      return <>
        <section className="cp-ah-hero"><img src="/media/audiencia-03.jpg" alt="" aria-hidden="true" /><div className="cp-ah-shade" /><div className="cp-wrap cp-ah-hero-inner"><p className="cp-area-overline">Atención penal</p><h1>{heading}</h1><p>{p[0]}</p><ContactLink>Contactar al abogado</ContactLink></div></section>
        <section className="cp-ah-evidence"><div className="cp-wrap cp-ah-evidence-grid"><div><span>El expediente</span><h2>La prueba, examinada a detalle.</h2></div><div><p>{p[1]}</p><p>{p[2]}</p></div></div></section>
        <section className="cp-ah-final"><div className="cp-wrap"><p className="cp-area-overline">Siguiente paso</p>{p.slice(3).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}<a href={site.phoneHref}>Llamar al {site.phoneDisplay} →</a></div></section>
      </>;
    case "delitos-sexuales":
      return <>
        <section className="cp-as-hero"><div className="cp-wrap cp-as-hero-inner"><p className="cp-area-overline">Discreción y rigor</p><span className="cp-as-watermark" aria-hidden="true">RESERVA</span><h1>{heading}</h1><p>{p[0]}</p></div></section>
        <section className="cp-as-reading"><div className="cp-wrap cp-as-reading-grid"><div><span>Confidencialidad</span><h2>Un tratamiento cuidadoso del asunto.</h2></div><div><p>{p[1]}</p><div className="cp-as-reading-rule" /><p>{p[2]}</p></div></div></section>
        <section className="cp-as-contact"><div className="cp-wrap"><p>{p[3]}</p><ContactLink>Solicitar contacto privado</ContactLink></div></section>
      </>;
    case "corrupcion-y-administracion-publica":
      return <>
        <section className="cp-ac-hero"><div className="cp-wrap"><div className="cp-ac-topline"><span>CANO / Materia penal</span><span>Servicio público</span></div><h1>{heading}</h1><div className="cp-ac-hero-foot"><span>Administración pública <i aria-hidden="true">/</i> Particulares</span><p>{p[0]}</p></div></div></section>
        <section className="cp-ac-context"><div className="cp-wrap cp-ac-context-grid"><div><p className="cp-area-overline">Intersección jurídica</p><h2>Una investigación puede avanzar en distintos frentes.</h2></div><div><p>{p[1]}</p><div className="cp-ac-scope"><span>Asuntos que atiende CANO</span><p>{p[2]}</p></div></div></div></section>
        <section className="cp-ac-contact"><div className="cp-wrap"><span>Revisión del expediente</span><ContactLink>Consultar sobre el procedimiento</ContactLink></div></section>
      </>;
    case "despojo-y-defensa-de-victimas":
      return <>
        <section className="cp-av-hero"><div className="cp-av-image" role="presentation" /><div className="cp-wrap cp-av-hero-inner"><p className="cp-area-overline">Representación de víctimas</p><h1>{heading}</h1><p>{p[0]}</p></div></section>
        <section className="cp-av-rights"><div className="cp-wrap cp-av-rights-grid"><div><span className="cp-area-overline">La persona afectada</span><h2>Participar en el proceso.</h2></div><div><p>{p[1]}</p><p>{p[2]}</p></div></div></section>
        <section className="cp-av-next"><div className="cp-wrap"><p>Representación desde la revisión de los hechos.</p><ContactLink>Solicitar asesoría para víctimas</ContactLink></div></section>
      </>;
    case "justicia-penal-para-adolescentes":
      return <>
        <section className="cp-aj-hero"><div className="cp-wrap cp-aj-hero-grid"><div><p className="cp-area-overline">Sistema especializado</p><h1>{heading}</h1></div><aside><p>{p[0]}</p></aside></div></section>
        <section className="cp-aj-process"><div className="cp-wrap"><div className="cp-aj-process-title"><span>Un procedimiento propio</span><h2>Comprender el sistema antes de decidir.</h2></div><div className="cp-aj-process-columns"><article><span>Decisiones iniciales</span><p>{p[1]}</p></article><article><span>Acompañamiento</span><p>{p[2]}</p></article></div></div></section>
        <section className="cp-aj-contact"><div className="cp-wrap"><ContactLink>Consultar un asunto de adolescentes</ContactLink></div></section>
      </>;
    case "amparo-recursos-y-apelaciones":
      return <>
        <section className="cp-aa-hero"><div className="cp-wrap cp-aa-hero-grid"><div><p className="cp-area-overline">Revisión de resoluciones</p><h1>{heading}</h1><p>{p[0]}</p></div><aside><span aria-hidden="true">↗</span><p>Revisar la resolución y el momento procesal.</p></aside></div></section>
        <section className="cp-aa-path"><div className="cp-wrap cp-aa-path-grid"><div><h2>Identificar la vía aplicable.</h2><p>{p[1]}</p></div><div><h2>Revisar el alcance.</h2><p>{p[2]}</p></div></div></section>
        <section className="cp-aa-contact"><div className="cp-wrap"><div>{p.slice(3).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div><ContactLink>Solicitar revisión de la resolución</ContactLink></div></section>
      </>;
    default:
      return null;
  }
}
