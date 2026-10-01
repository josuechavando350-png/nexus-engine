import type { Metadata } from "next";
import { Link } from "@nexus/core";
import { headers } from "next/headers";
import { AD_CONTEXT_HEADERS } from "../ad-context";
import { readCanoProgrammaticSeoPage } from "../programmatic-seo";
import { homeHeroForAdExperience } from "./ad-context-copy";
import { PageShell } from "./SiteChrome";
import { HomeSplash } from "./HomeSplash";
import { ContactForm } from "./ContactForm";
import { areas, cases, site, trajectory } from "./content";

export const runtime = "edge";

const audienceFiles = ["audiencia-01.jpg", "audiencia-02.jpg", "audiencia-03.jpg", "audiencia-04.jpg", "audiencia-05.jpg"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const governed = await readCanoProgrammaticSeoPage([]);
  if (!governed) return {};
  return {
    title: governed.title,
    description: governed.description,
    alternates: { canonical: governed.canonicalUrl },
    robots: { index: governed.indexable, follow: true },
  };
}

export default async function HomePage() {
  const requestHeaders = await headers();
  const hero = homeHeroForAdExperience(requestHeaders.get(AD_CONTEXT_HEADERS.experience));

  return (
    <>
      <HomeSplash />
      <PageShell>
        <section className="cp-hero cp-hero-v2" data-nexus-ad-experience={hero.id}>
          <img className="cp-hero-image" src="/media/hero-eduardo.jpg" alt="Eduardo Cano de pie con los brazos cruzados" />
          <div className="cp-hero-shade" aria-hidden="true" />
          <div className="cp-wrap cp-hero-content">
            <div className="cp-hero-copy">
              <div className="cp-hero-identification" aria-label="Eduardo Cano, abogado penalista">
                <span className="cp-hero-name">Eduardo Cano</span>
                <span className="cp-hero-role">Abogado penalista · CDMX</span>
              </div>
              <h1><span>Conozco cómo investiga</span><br /><strong>la autoridad.</strong></h1>
              <p className="cp-v2-kicker">Trabajé dentro de ella.</p>
              <p className="cp-lead">Dirigí investigaciones de delitos fiscales y financieros dentro de la Procuraduría Fiscal de la Federación. Hoy diseño personalmente la defensa de empresarios, directivos y particulares en asuntos penales complejos.</p>
              <div className="cp-actions cp-v2-actions">
                <Link className="cp-btn cp-btn-solid" href="/evaluacion-empresarial" data-nexus-signal="hero-enterprise">Asunto empresarial o fiscal</Link>
                <Link className="cp-btn" href="/detenido-cdmx" data-nexus-signal="hero-urgent">Tengo una urgencia penal</Link>
              </div>
            </div>
          </div>
          <div className="cp-v2-hero-foot cp-wrap" aria-label="Credenciales principales">
            <span>20 años · exclusivamente penal</span>
            <span>Ex Director de Investigaciones · PFF</span>
            <span>700+ asuntos atendidos</span>
          </div>
        </section>

        <section className="cp-section cp-v2-paths-section" aria-labelledby="empresa-title">
          <div className="cp-wrap cp-v2-specialty-grid">
            <div>
              <p className="cp-eyebrow">Empresas y directivos</p>
              <h2 id="empresa-title">Defensa penal <strong>patrimonial, fiscal y empresarial.</strong></h2>
              <p className="cp-v2-muted">Intervengo cuando una investigación puede afectar al mismo tiempo libertad, patrimonio, operación empresarial y reputación.</p>
              <div className="cp-actions">
                <Link className="cp-btn cp-btn-solid" href="/evaluacion-empresarial" data-nexus-signal="home-enterprise-evaluation">Solicitar evaluación confidencial</Link>
                <Link className="cp-btn" href="/defensa-penal-empresarial">Conocer la defensa empresarial</Link>
              </div>
            </div>
            <div className="cp-v2-service-list">
              <Link href="/defensa-penal-fiscal"><strong>Defensa penal fiscal</strong><i>↗</i></Link>
              <Link href="/defraudacion-fiscal"><strong>Defraudación fiscal</strong><i>↗</i></Link>
              <Link href="/delitos-financieros"><strong>Delitos financieros</strong><i>↗</i></Link>
              <Link href="/fraude-empresarial"><strong>Fraude y defensa patrimonial</strong><i>↗</i></Link>
              <Link href="/representante-legal-investigacion-penal"><strong>Representantes legales y administradores</strong><i>↗</i></Link>
            </div>
          </div>
        </section>

        <section className="cp-section cp-preserved-situations" aria-labelledby="situacion-title">
          <div className="cp-wrap">
            <div className="cp-section-head">
              <div><p className="cp-eyebrow">Orientación inicial</p><h2 id="situacion-title">¿Cuál es tu <strong>situación?</strong></h2></div>
            </div>
            <div className="cp-paths cp-paths-three">
              <article className="cp-path" tabIndex={0}>
                <h3>Me llegó un citatorio</h3>
                <p>De la Fiscalía, de la FGR o de un Juez. Lo que se hace antes de comparecer puede cambiar el resto del caso.</p>
                <div className="cp-actions">
                  <Link className="cp-btn" href="/citatorio-ministerio-publico-cdmx">Qué hacer ante un citatorio</Link>
                  <Link className="cp-text-link" href="/citatorio-fgr">Citatorio de la FGR</Link>
                </div>
              </article>
              <article className="cp-path" tabIndex={0}>
                <h3>Detuvieron a alguien</h3>
                <p>Atención inmediata. Las primeras horas pueden condicionar decisiones procesales importantes.</p>
                <Link className="cp-btn cp-btn-solid" href="/detenido-cdmx" data-nexus-signal="home-detention">Necesito ayuda ahora</Link>
              </article>
              <article className="cp-path cp-path-victim" tabIndex={0}>
                <h3>Fui víctima de un delito</h3>
                <p>Asesoría, representación y protección de tus derechos durante la investigación y el proceso.</p>
                <a className="cp-btn" target="_blank" rel="noopener noreferrer" href={site.whatsapp} data-nexus-signal="home-victim-whatsapp">Quiero asesoría</a>
              </article>
            </div>
          </div>
        </section>

        <section className="cp-section cp-preserved-why" id="acerca">
          <div className="cp-wrap">
            <div className="cp-section-head">
              <div><p className="cp-eyebrow">Defensa personal</p><h2>Por qué <strong>elegirme</strong></h2></div>
            </div>
            <div className="cp-why">
              <article tabIndex={0}><h3>Especialización</h3><p>Soy abogado especialista en derecho penal. No soy generalista y no atiendo otras ramas como práctica principal.</p></article>
              <article tabIndex={0}><h3>Personalización</h3><p>Diseño personalmente la estrategia de los asuntos que acepto y participo directamente en las decisiones relevantes de la defensa.</p></article>
              <article tabIndex={0}><h3>Cercanía</h3><p>Mantengo comunicación directa para que conozcas qué ocurre, qué sigue y qué decisiones requieren tu participación.</p></article>
              <article tabIndex={0}><h3>Experiencia</h3><p>Conozco cómo opera la autoridad porque formé parte de su estructura y dirigí investigaciones en materia fiscal y financiera.</p></article>
            </div>
          </div>
        </section>

        <section className="cp-v2-proof cp-preserved-trajectory">
          <div className="cp-wrap cp-v2-proof-grid">
            <div className="cp-v2-proof-title">
              <p className="cp-eyebrow">Acerca de mí</p>
              <h2>Primero investigué.<br /><strong>Ahora defiendo.</strong></h2>
            </div>
            <div className="cp-v2-proof-copy">
              <p>{trajectory}</p>
              <div className="cp-v2-proof-rail">
                <div><span>2006</span><strong>Delitos fiscales y financieros</strong><p>Inicié mi trayectoria en la Procuraduría Fiscal de la Federación.</p></div>
                <div><span>PFF</span><strong>Director de Investigaciones</strong><p>Ascendí hasta dirigir investigaciones en esa misma materia.</p></div>
                <div><span>HOY</span><strong>CANO Estrategia Penal</strong><p>Aplico esa experiencia a una defensa penal directa, estratégica y especializada.</p></div>
              </div>
              <Link className="cp-text-link" href="/acerca-de-mi">Conoce mi trayectoria completa</Link>
            </div>
          </div>
        </section>

        <section className="cp-metrics cp-preserved-metrics">
          <div className="cp-wrap cp-metrics-layout">
            <div className="cp-metrics-about">
              <div className="cp-eyebrow">Trayectoria</div>
              <h2>Experiencia <strong>aplicada.</strong></h2>
              <p>La experiencia institucional sólo importa si ayuda a leer mejor el expediente, anticipar decisiones y construir una estrategia más precisa.</p>
            </div>
            <div className="cp-metrics-grid">
              <div className="cp-metric"><strong>20</strong><span>Años ejerciendo exclusivamente en penal</span></div>
              <div className="cp-metric"><strong>700+</strong><span>Casos atendidos</span></div>
              <div className="cp-metric"><strong>CDMX</strong><span>Fuero común y federal</span></div>
            </div>
          </div>
        </section>

        <section className="cp-section cp-v2-cases" id="casos">
          <div className="cp-wrap">
            <div className="cp-section-head">
              <div><p className="cp-eyebrow">Experiencia aplicada</p><h2>Casos que muestran <strong>cómo pienso una defensa.</strong></h2></div>
              <Link className="cp-text-link" href="/casos">Ver todos los casos</Link>
            </div>
            <div className="cp-v2-case-grid">
              {[cases[4], cases[0], cases[1]].map(([title, body]) => (
                <article className="cp-v2-case" key={title}>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </article>
              ))}
            </div>
            <p className="cp-v2-case-note">Los resultados anteriores no garantizan resultados futuros. Cada asunto depende de sus hechos, etapa procesal y evidencia disponible.</p>
          </div>
        </section>

        <section className="cp-section cp-preserved-audiences">
          <div className="cp-wrap">
            <div className="cp-section-head">
              <div><p className="cp-eyebrow">Defensa presente</p><h2>En sala, en cada <strong>audiencia.</strong></h2></div>
            </div>
            <div className="cp-audiences">
              {audienceFiles.map(file => <img src={`/media/${file}`} alt="" tabIndex={0} key={file} />)}
            </div>
          </div>
        </section>

        <section className="cp-v2-intelligence">
          <div className="cp-wrap">
            <div className="cp-v2-intelligence-head">
              <div><p className="cp-eyebrow">CANO Intelligence</p><h2>Entender el riesgo <strong>antes de reaccionar.</strong></h2></div>
              <p>Escribo sobre investigaciones, riesgo penal-fiscal y decisiones empresariales desde la experiencia de haber trabajado dentro de la autoridad y hoy ejercer la defensa.</p>
            </div>
            <div className="cp-v2-intelligence-grid">
              <Link href="/guias/requerimiento-sat-riesgo-penal"><span>Análisis</span><strong>Requerimientos del SAT y riesgo penal</strong><p>Qué cambia cuando un asunto deja de ser únicamente fiscal.</p></Link>
              <Link href="/guias/responsabilidad-penal-representante-legal-contador"><span>Análisis</span><strong>Representante legal y contador</strong><p>Responsabilidad, exposición y decisiones que no conviene improvisar.</p></Link>
              <Link href="/guias/defensa-penal-empresa-delitos-financieros"><span>Análisis</span><strong>Defensa penal empresarial</strong><p>Cómo estructuro una respuesta cuando el expediente también afecta al negocio.</p></Link>
            </div>
            <Link className="cp-text-link cp-intelligence-more" href="/intelligence">Explorar CANO Intelligence</Link>
          </div>
        </section>

        <section className="cp-section cp-preserved-advisory" id="asesoria">
          <div className="cp-wrap cp-advisory">
            <div>
              <p className="cp-eyebrow">Consulta personal</p>
              <h2><span className="cp-title-line">Asesoría legal</span><span className="cp-title-line">penal presencial</span></h2>
              <p>Valoro y estudio inicialmente tu situación, resuelvo tus dudas y te explico qué opciones existen antes de definir la estrategia del caso.</p>
              <Link className="cp-text-link" href="/diagnostico-penal">Conocer el diagnóstico penal</Link>
            </div>
            <div className="cp-price"><span>Diagnóstico y estrategia</span><strong>$2,500</strong><small>MXN · para asuntos individuales no urgentes</small></div>
          </div>
        </section>

        <section className="cp-contact-section cp-v2-contact" id="contacto">
          <div className="cp-contact-image" role="img" aria-label="Eduardo Cano en su escritorio" />
          <div className="cp-contact">
            <div>
              <p className="cp-eyebrow">Contacto confidencial</p>
              <h2>Primero entiendo <strong>qué está en juego.</strong></h2>
              <p className="cp-v2-muted">Comparte únicamente información general en este primer contacto. Los documentos o datos sensibles se solicitan por un canal adecuado después de revisar el asunto.</p>
              <div className="cp-contact-details">
                <strong>World Trade Center Ciudad de México</strong>
                <span>Montecito 38, piso 28, oficina 16, colonia Nápoles, Benito Juárez, CDMX</span>
                <a href={site.phoneHref}>{site.phoneDisplay}</a>
                <a href={`mailto:${site.email}`}>{site.email}</a>
              </div>
            </div>
            <div><ContactForm compact /></div>
          </div>
        </section>
      </PageShell>
    </>
  );
}
