import { Link } from "@nexus/core";
import { PageShell } from "./SiteChrome";
import { areas, cases, site, trajectory } from "./content";

const audienceFiles = ["audiencia-01.jpg", "audiencia-02.jpg", "audiencia-03.jpg", "audiencia-04.jpg", "audiencia-05.jpg"] as const;

// PageShell renders <main id="main-content"> for the global skip-link target.
export default function HomePage() {
  return (
    <PageShell>
      <section className="cp-hero">
        <img className="cp-hero-image" src="/media/hero-eduardo.jpg" alt="Eduardo Cano de pie con los brazos cruzados" />
        <div className="cp-hero-shade" aria-hidden="true" />
        <div className="cp-wrap cp-hero-content">
          <div className="cp-hero-copy">
            <h1>Conozco cómo investiga la autoridad.<br />Trabajé dentro de ella.</h1>
            <p className="cp-lead">20 años defendiendo exclusivamente en materia penal. Dirigí investigaciones en la Procuraduría Fiscal de la Federación. Hoy uso esa experiencia para defenderte.</p>
            <div className="cp-actions">
              <Link className="cp-btn cp-btn-solid" href="#contacto">Hablemos de tu caso</Link>
              <Link className="cp-btn" href="#asesoria">Diagnóstico y estrategia — $2,500</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="cp-section">
        <div className="cp-wrap">
          <div className="cp-section-head"><h2>¿Cuál es tu situación?</h2></div>
          <div className="cp-paths">
            <article className="cp-path"><h3>Me llegó un citatorio</h3><p>De la Fiscalía o de un Juez. Lo que se hace antes de la primera audiencia define el resto del caso.</p><a className="cp-btn" target="_blank" rel="noopener noreferrer" href="https://wa.me/5215560501901?text=Hola%20licenciado%2C%20me%20lleg%C3%B3%20un%20citatorio%20y%20necesito%20asesor%C3%ADa">Quiero asesoría</a></article>
            <article className="cp-path"><h3>Detuvieron a alguien</h3><p>Atención inmediata, a cualquier hora. Las primeras horas son las que más pesan.</p><a className="cp-btn cp-btn-solid" target="_blank" rel="noopener noreferrer" href="https://wa.me/5215560501901?text=Hola%20licenciado%2C%20detuvieron%20a%20un%20familiar%20y%20necesito%20ayuda%20urgente">Necesito ayuda ahora</a></article>
          </div>
        </div>
      </section>

      <section className="cp-section" id="acerca">
        <div className="cp-wrap">
          <div className="cp-section-head"><h2>Por qué elegirme</h2></div>
          <div className="cp-why">
            <article><h3>Especialización</h3><p>Soy abogado especialista en derecho penal. No soy generalista y aunque las conozco, no atiendo otras ramas del derecho.</p></article>
            <article><h3>Personalización</h3><p>Tu caso lo atiendo personalmente. La estrategia la diseño directamente, no la delego. Asumo representación total en diligencias y audiencias.</p></article>
            <article><h3>Cercanía</h3><p>No hay intermediarios. Mantengo comunicación constante para que sepas en todo momento qué sucede con tu caso.</p></article>
            <article><h3>Experiencia</h3><p>Entiendo cómo opera la autoridad porque formé parte de su estructura.</p></article>
          </div>
        </div>
      </section>

      <section className="cp-metrics"><div className="cp-wrap cp-metrics-grid"><div className="cp-metric"><strong>20</strong><span>Años ejerciendo exclusivamente en penal</span></div><div className="cp-metric"><strong>700+</strong><span>Casos atendidos</span></div><div className="cp-metric"><strong>CDMX</strong><span>Fuero común y federal</span></div></div></section>

      <section className="cp-section cp-trajectory"><div className="cp-wrap cp-copy"><h2>Trayectoria</h2><p>{trajectory}</p><Link className="cp-text-link" href="/acerca-de-mi">Conoce mi trayectoria completa</Link></div></section>

      <section className="cp-section" id="areas"><div className="cp-wrap"><div className="cp-section-head"><h2>Áreas de práctica</h2></div><div className="cp-areas">{areas.map(([name, href]) => <Link className="cp-area" key={href} href={href}>{name}</Link>)}</div></div></section>

      <section className="cp-section" id="casos"><div className="cp-wrap"><div className="cp-section-head"><h2>Casos</h2><Link className="cp-text-link" href="/casos">Ver todos los casos</Link></div><div className="cp-cases">{[cases[1], cases[4], cases[2]].map(([title, body]) => <article className="cp-case" key={title}><h3>{title}</h3><p>{body}</p></article>)}</div></div></section>

      <section className="cp-section"><div className="cp-wrap"><div className="cp-section-head"><h2>En sala, en cada audiencia.</h2></div><div className="cp-audiences">{audienceFiles.map(file => <img src={`/media/${file}`} alt="" tabIndex={0} key={file} />)}</div></div></section>

      <section className="cp-section" id="asesoria"><div className="cp-wrap cp-advisory"><div><h2>Asesoría legal penal presencial</h2><p>Valoración y estudio inicial de tu situación. Resolvemos todas tus dudas y defines la estrategia de tu caso. Sin tiempo límite, porque los problemas penales son complejos.</p></div><div className="cp-price"><span>Diagnóstico y estrategia</span><strong>$2,500</strong></div></div></section>

      <section className="cp-section" id="contacto"><div className="cp-wrap cp-contact"><div><h2>En derecho penal cada minuto cuenta</h2><div className="cp-contact-details"><strong>World Trade Center Ciudad de México</strong><span>Montecito 38, piso 28, oficina 16, colonia Nápoles, Benito Juárez, CDMX</span><a className="cp-text-link cp-map-link" href="https://www.google.com/maps/search/?api=1&amp;query=World%20Trade%20Center%20Ciudad%20de%20M%C3%A9xico%2C%20Montecito%2038%2C%20piso%2028%2C%20oficina%2016%2C%20N%C3%A1poles%2C%20Benito%20Ju%C3%A1rez%2C%20CDMX" target="_blank" rel="noopener noreferrer">Ver ubicación en Google Maps</a><a href={site.phoneHref}>{site.phoneDisplay}</a><a href={`mailto:${site.email}`}>{site.email}</a></div></div><div><form className="cp-form"><input aria-label="Nombre" name="nombre" placeholder="Nombre" /><input aria-label="Teléfono" name="telefono" placeholder="Teléfono" /><input className="full" aria-label="Correo" name="correo" type="email" placeholder="Correo" /><textarea className="full" aria-label="Mensaje" name="mensaje" placeholder="Mensaje" /></form><a className="cp-btn cp-btn-solid cp-contact-action" href="https://wa.me/5215560501901" target="_blank" rel="noopener noreferrer">Enviar por WhatsApp</a></div></div></section>
    </PageShell>
  );
}
