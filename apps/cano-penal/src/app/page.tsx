import type { Metadata } from "next";
import { Link } from "@nexus/core";
import { headers } from "next/headers";
import { AD_CONTEXT_HEADERS } from "../ad-context";
import { readCanoProgrammaticSeoPage } from "../programmatic-seo";
import { homeHeroForAdExperience } from "./ad-context-copy";
import { PageShell } from "./SiteChrome";
import { HomeSplash } from "./HomeSplash";
import { ContactForm } from "./ContactForm";
import { cases, site, trajectory } from "./content";

export const runtime = "edge";

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
                <span className="cp-hero-role">Defensa penal estratégica · CDMX</span>
              </div>
              <h1><span>Conozco cómo investiga</span><br /><strong>la autoridad.</strong></h1>
              <p className="cp-v2-kicker">Trabajé dentro de ella.</p>
              <p className="cp-lead">Dirigí investigaciones de delitos fiscales y financieros dentro de la Procuraduría Fiscal de la Federación. Hoy diseño la defensa de empresarios, directivos y particulares en asuntos penales de alta complejidad.</p>
              <div className="cp-actions cp-v2-actions">
                <Link className="cp-btn cp-btn-solid" href="#empresa">Asunto empresarial o fiscal</Link>
                <Link className="cp-btn" href="/detenido-cdmx">Tengo una urgencia penal</Link>
              </div>
            </div>
          </div>
          <div className="cp-v2-hero-foot cp-wrap" aria-label="Credenciales principales">
            <span>20 años · exclusivamente penal</span>
            <span>Ex Director de Investigaciones · PFF</span>
            <span>700+ asuntos atendidos</span>
          </div>
        </section>

        <section className="cp-section cp-v2-paths-section" aria-labelledby="rutas-title">
          <div className="cp-wrap">
            <div className="cp-v2-section-intro">
              <p className="cp-eyebrow">Dos contextos. Dos formas de intervenir.</p>
              <h2 id="rutas-title">El problema penal no siempre <strong>empieza igual.</strong></h2>
            </div>
            <div className="cp-v2-path-grid">
              <article className="cp-v2-path cp-v2-path-premium" id="empresa">
                <div>
                  <p className="cp-eyebrow">Empresas y directivos</p>
                  <h3>Defensa penal económica, fiscal y empresarial.</h3>
                  <p>Investigaciones fiscales y financieras, fraude empresarial, responsabilidad de administradores y asuntos donde están en juego patrimonio, empresa y reputación.</p>
                </div>
                <Link className="cp-text-link" href="/guias/defensa-penal-empresa-delitos-financieros">Evaluar un asunto empresarial o fiscal</Link>
              </article>
              <article className="cp-v2-path cp-v2-path-urgent">
                <div>
                  <p className="cp-eyebrow">Urgencias y defensa personal</p>
                  <h3>Cuando cada decisión procesal empieza a importar ahora.</h3>
                  <p>Detención, citatorio, audiencia inicial, carpeta de investigación, orden de aprehensión, medidas cautelares e intervención inmediata.</p>
                </div>
                <Link className="cp-text-link" href="/detenido-cdmx">Necesito defensa ahora</Link>
              </article>
            </div>
          </div>
        </section>

        <section className="cp-v2-proof">
          <div className="cp-wrap cp-v2-proof-grid">
            <div className="cp-v2-proof-title">
              <p className="cp-eyebrow">Experiencia desde ambos lados</p>
              <h2>Primero investigó.<br /><strong>Ahora defiende.</strong></h2>
            </div>
            <div className="cp-v2-proof-copy">
              <p>{trajectory}</p>
              <div className="cp-v2-proof-rail">
                <div><span>2006</span><strong>Delitos fiscales y financieros</strong><p>Ingreso a la Procuraduría Fiscal de la Federación.</p></div>
                <div><span>PFF</span><strong>Director de Investigaciones</strong><p>Experiencia directa en la construcción institucional de investigaciones.</p></div>
                <div><span>HOY</span><strong>CANO Estrategia Penal</strong><p>Defensa penal directa, estratégica y especializada.</p></div>
              </div>
              <Link className="cp-text-link" href="/acerca-de-mi">Ver trayectoria y formación</Link>
            </div>
          </div>
        </section>

        <section className="cp-section cp-v2-specialty">
          <div className="cp-wrap cp-v2-specialty-grid">
            <div>
              <p className="cp-eyebrow">Territorio de especialización</p>
              <h2>Penal económico y fiscal <strong>sin lenguaje de plantilla.</strong></h2>
              <p className="cp-v2-muted">La estrategia cambia cuando una investigación puede afectar libertad, patrimonio, operación empresarial y reputación al mismo tiempo.</p>
            </div>
            <div className="cp-v2-service-list">
              <Link href="/areas/delitos-fiscales-y-financieros"><strong>Delitos fiscales y financieros</strong><i>↗</i></Link>
              <Link href="/guias/defensa-penal-empresa-delitos-financieros"><strong>Defensa penal empresarial</strong><i>↗</i></Link>
              <Link href="/guias/requerimiento-sat-riesgo-penal"><strong>Requerimientos del SAT y riesgo penal</strong><i>↗</i></Link>
              <Link href="/guias/responsabilidad-penal-representante-legal-contador"><strong>Representantes legales y contadores</strong><i>↗</i></Link>
            </div>
          </div>
        </section>

        <section className="cp-section cp-v2-cases" id="casos">
          <div className="cp-wrap">
            <div className="cp-section-head">
              <div><p className="cp-eyebrow">Experiencia aplicada</p><h2>Casos que muestran <strong>cómo se piensa una defensa.</strong></h2></div>
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

        <section className="cp-v2-intelligence">
          <div className="cp-wrap">
            <div className="cp-v2-intelligence-head">
              <div><p className="cp-eyebrow">CANO Intelligence</p><h2>Entender el riesgo <strong>antes de reaccionar.</strong></h2></div>
              <p>Análisis para empresarios, directivos y particulares sobre el punto exacto donde un problema fiscal, financiero o corporativo empieza a adquirir dimensión penal.</p>
            </div>
            <div className="cp-v2-intelligence-grid">
              <Link href="/guias/requerimiento-sat-riesgo-penal"><span>Análisis</span><strong>Requerimientos del SAT y riesgo penal</strong><p>Qué cambia cuando el asunto deja de ser únicamente fiscal.</p></Link>
              <Link href="/guias/responsabilidad-penal-representante-legal-contador"><span>Análisis</span><strong>Representante legal y contador</strong><p>Responsabilidad, exposición y decisiones que no deben improvisarse.</p></Link>
              <Link href="/guias/defensa-penal-empresa-delitos-financieros"><span>Análisis</span><strong>Defensa penal empresarial</strong><p>Cómo se estructura una respuesta cuando el expediente afecta al negocio.</p></Link>
            </div>
          </div>
        </section>

        <section className="cp-contact-section cp-v2-contact" id="contacto">
          <div className="cp-contact-image" role="img" aria-label="Eduardo Cano en su escritorio" />
          <div className="cp-contact">
            <div>
              <p className="cp-eyebrow">Contacto confidencial</p>
              <h2>Primero entendemos <strong>qué está en juego.</strong></h2>
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
