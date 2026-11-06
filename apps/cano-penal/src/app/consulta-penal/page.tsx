import type { Metadata } from "next";
import { ClientInteractions } from "../ClientInteractions";
import { AdVisitorWhatsapp } from "../AdVisitorWhatsapp";
import { SiteFooter } from "../SiteChrome";
import { site } from "../content";
import { CONSULTA_FONT_VARIABLES } from "./fonts";
import { LandingHeader, WhatsappGlyph } from "./LandingChrome";
import { CONSULTA_MAPS_URL, CONSULTA_PHONE_LABEL, CONSULTA_SITUATIONS, CONSULTA_STEPS, whatsappWith } from "./landing";
import "./consulta-penal.css";

/**
 * Landing page for Google Ads visitors only (CL | Amplia | PENAL first). It stays out of organic
 * search (noindex, not in the sitemap) so it never competes with the site's own pages.
 * AdVisitorWhatsapp prefixes "Hola, lo encontré en Google." to every WhatsApp message for ad
 * visitors, and AdsConversionTracking (root layout) reports each WhatsApp or call tap.
 */
export const metadata: Metadata = {
  title: { absolute: "Eduardo Cano | Abogado penalista en la Ciudad de México" },
  description: "Atención penal directa con Eduardo Cano en la Ciudad de México: detenciones, citatorios, órdenes de aprehensión, acusaciones y víctimas. Escribe por WhatsApp o llama.",
  alternates: { canonical: "https://canopenal.com/consulta-penal" },
  robots: { index: false, follow: false },
};

function ContactButtons({ placement }: { placement: "hero" | "contact" }) {
  return (
    <div className="cp-lp-actions">
      <a className="cp-btn cp-btn-solid cp-lp-primary" href={site.whatsapp} target="_blank" rel="noopener noreferrer" data-nexus-signal={`lp-${placement}-whatsapp`}>
        <WhatsappGlyph className="cp-lp-primary-glyph" />Escríbeme por WhatsApp
      </a>
      <a className="cp-btn cp-lp-secondary" href={site.phoneHref} data-nexus-signal={`lp-${placement}-call`}>Llamar al {CONSULTA_PHONE_LABEL}</a>
    </div>
  );
}

export default function ConsultaPenalPage() {
  return (
    <>
      <ClientInteractions />
      <AdVisitorWhatsapp />
      <div className={`cp-lp ${CONSULTA_FONT_VARIABLES}`}>
        <LandingHeader />
        <main id="main-content" className="cp-main cp-lp-main">
          <section className="cp-lp-hero" aria-labelledby="cp-lp-title">
            <div className="cp-lp-hero-media">
              <img src="/media/hero-eduardo.jpg" alt="Eduardo Cano de pie, con los brazos cruzados, en su despacho" fetchPriority="high" />
            </div>
            <div className="cp-wrap cp-lp-hero-body">
              <p className="cp-lp-name">Eduardo Cano</p>
              <h1 id="cp-lp-title">Abogado penalista en la Ciudad de México.</h1>
              <p className="cp-lp-lead">Lo que se hace antes de la primera audiencia define el resto del caso. Te atiendo personalmente, sin intermediarios y a cualquier hora.</p>
              <ContactButtons placement="hero" />
            </div>
          </section>

          <section className="cp-lp-situations" aria-labelledby="cp-lp-situations-title">
            <div className="cp-wrap cp-lp-split">
              <div className="cp-lp-intro">
                <h2 id="cp-lp-situations-title">¿Qué está pasando?</h2>
                <p>Elige tu situación. Se abre WhatsApp con el mensaje ya escrito y me llega directamente.</p>
              </div>
              <ul className="cp-lp-situation-list">
                {CONSULTA_SITUATIONS.map((situation) => (
                  <li key={situation.id}>
                    <a className="cp-btn cp-lp-situation" href={whatsappWith(situation.message)} target="_blank" rel="noopener noreferrer" data-nexus-signal={`lp-situation-${situation.id}`}>
                      <span className="cp-lp-situation-text">
                        <span className="cp-lp-situation-title">{situation.title}</span>
                        <span className="cp-lp-situation-copy">{situation.copy}</span>
                      </span>
                      <WhatsappGlyph className="cp-lp-situation-glyph" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="cp-lp-authority" aria-label="Trayectoria">
            <figure className="cp-lp-authority-media">
              <img src="/media/eduardo-cano-escritorio.jpg" alt="Eduardo Cano firmando documentos en su despacho" loading="lazy" decoding="async" />
            </figure>
            <div className="cp-lp-authority-body">
              <blockquote className="cp-lp-quote"><p>Entiendo cómo opera la autoridad porque formé parte de su estructura.</p></blockquote>
              <p className="cp-lp-credential"><span className="cp-lp-credential-name">Eduardo Cano.</span> Fui Director de Investigaciones del área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación.</p>
              <p className="cp-lp-record">Veinte años dedicados exclusivamente al derecho penal y más de setecientos casos atendidos, en el fuero común y en el federal.</p>
            </div>
          </section>

          <section className="cp-lp-process" aria-labelledby="cp-lp-process-title">
            <div className="cp-wrap cp-lp-split">
              <div className="cp-lp-intro">
                <h2 id="cp-lp-process-title">Cómo empezamos</h2>
              </div>
              <ol className="cp-lp-steps">
                {CONSULTA_STEPS.map(([title, copy]) => (
                  <li key={title}><h3>{title}</h3><p>{copy}</p></li>
                ))}
              </ol>
            </div>
          </section>

          <section className="cp-lp-close" id="contacto" aria-labelledby="cp-lp-close-title">
            <div className="cp-wrap cp-lp-close-grid">
              <div>
                <h2 id="cp-lp-close-title">En derecho penal, cada minuto cuenta.</h2>
                <ContactButtons placement="contact" />
              </div>
              <div className="cp-lp-close-place">
                <address className="cp-lp-address">
                  <span>World Trade Center Ciudad de México</span>
                  <span>Montecito 38, piso 28, oficina 16</span>
                  <span>Colonia Nápoles, Benito Juárez, CDMX</span>
                </address>
                <a className="cp-btn cp-lp-maplink" href={CONSULTA_MAPS_URL} target="_blank" rel="noopener noreferrer" data-nexus-signal="lp-map">Ver ubicación en Google Maps</a>
              </div>
            </div>
          </section>
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
