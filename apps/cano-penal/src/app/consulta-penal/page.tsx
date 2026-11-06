import type { Metadata } from "next";
import { PageShell } from "../SiteChrome";
import { ContactForm } from "../ContactForm";
import { site } from "../content";
import { CONSULTA_PHONE_LABEL, CONSULTA_PROOF, CONSULTA_SITUATIONS, CONSULTA_STEPS, whatsappWith } from "./landing";

/**
 * Landing page for Google Ads visitors only (CL | Amplia | PENAL first): one message, the
 * situations that bring paying clients, and WhatsApp or a call one tap away. It stays out of
 * organic search (noindex, not in the sitemap) so it never competes with the site's own pages.
 * For ad visitors the shared AdVisitorWhatsapp component prefixes "Hola, lo encontré en Google."
 * to every WhatsApp message here, and AdsConversionTracking reports each WhatsApp or call tap.
 */
export const metadata: Metadata = {
  title: "Abogado penalista en CDMX | Habla hoy con Eduardo Cano",
  description: "Atención penal directa con Eduardo Cano en Ciudad de México: detenciones, citatorios, órdenes de aprehensión y acusaciones. Escribe por WhatsApp o llama.",
  alternates: { canonical: "https://canopenal.com/consulta-penal" },
  robots: { index: false, follow: false },
};

function ContactButtons({ placement }: { placement: "hero" | "contact" }) {
  return (
    <div className="cp-lp-actions">
      <a className="cp-btn cp-btn-solid" href={site.whatsapp} target="_blank" rel="noopener noreferrer" data-nexus-signal={`lp-${placement}-whatsapp`}>Escríbeme por WhatsApp</a>
      <a className="cp-btn" href={site.phoneHref} data-nexus-signal={`lp-${placement}-call`}>Llamar · {CONSULTA_PHONE_LABEL}</a>
    </div>
  );
}

export default function ConsultaPenalPage() {
  return (
    <PageShell>
      <div className="cp-lp">
        <section className="cp-lp-hero" aria-labelledby="cp-lp-title">
          <img className="cp-lp-hero-image" src="/media/hero-eduardo.jpg" alt="" aria-hidden="true" />
          <div className="cp-wrap cp-lp-hero-content">
            <p className="cp-eyebrow">Eduardo Cano · Abogado penalista en CDMX</p>
            <h1 id="cp-lp-title">¿Tienes un problema penal? <strong>Habla hoy con un penalista.</strong></h1>
            <p className="cp-lp-lead">Atención directa con Eduardo Cano, sin intermediarios. 20 años ejerciendo exclusivamente en materia penal, en el fuero común y federal.</p>
            <ContactButtons placement="hero" />
          </div>
        </section>

        <section className="cp-lp-situations" aria-labelledby="cp-lp-situations-title">
          <div className="cp-wrap">
            <h2 id="cp-lp-situations-title">¿Qué está <strong>pasando?</strong></h2>
            <p className="cp-lp-hint">Toca tu caso y se abre WhatsApp con el mensaje listo.</p>
            <div className="cp-lp-situation-list">
              {CONSULTA_SITUATIONS.map((situation) => (
                <a
                  key={situation.id}
                  className="cp-btn cp-lp-situation"
                  href={whatsappWith(situation.message)}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-nexus-signal={`lp-situation-${situation.id}`}
                >
                  <span className="cp-lp-situation-title">{situation.title}</span>
                  <span className="cp-lp-situation-copy">{situation.copy}</span>
                  <span className="cp-lp-situation-arrow" aria-hidden="true">→</span>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section className="cp-lp-proof" aria-label="Experiencia">
          <div className="cp-wrap cp-lp-proof-grid">
            {CONSULTA_PROOF.map(([value, label]) => (
              <div key={label}><strong>{value}</strong><span>{label}</span></div>
            ))}
          </div>
          <div className="cp-wrap">
            <p className="cp-lp-proof-note">Fui Director de Investigaciones del área de Delitos Fiscales y Financieros de la Procuraduría Fiscal de la Federación. Entiendo cómo opera la autoridad porque formé parte de su estructura.</p>
          </div>
        </section>

        <section className="cp-lp-steps" aria-labelledby="cp-lp-steps-title">
          <div className="cp-wrap">
            <h2 id="cp-lp-steps-title">Cómo <strong>trabajamos</strong></h2>
            <ol className="cp-lp-step-list">
              {CONSULTA_STEPS.map(([title, copy], index) => (
                <li key={title}><span className="cp-lp-step-number" aria-hidden="true">{index + 1}</span><div><h3>{title}</h3><p>{copy}</p></div></li>
              ))}
            </ol>
          </div>
        </section>

        <section className="cp-lp-contact" id="contacto" aria-labelledby="cp-lp-contact-title">
          <div className="cp-wrap cp-lp-contact-grid">
            <div>
              <h2 id="cp-lp-contact-title">En derecho penal <strong>cada minuto cuenta</strong></h2>
              <ContactButtons placement="contact" />
              <p className="cp-lp-address"><strong>World Trade Center Ciudad de México</strong><span>Montecito 38, piso 28, oficina 16, colonia Nápoles, Benito Juárez, CDMX</span></p>
            </div>
            <div><ContactForm compact /></div>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
