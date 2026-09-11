import type { Metadata } from "next";
import { Link } from "@nexus/core";
import { notFound } from "next/navigation";
import { PageShell } from "../../SiteChrome";
import { site } from "../../content";
import { getHighIntentLanding, highIntentLandings } from "../content";

export function generateStaticParams() {
  return highIntentLandings.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const landing = getHighIntentLanding(slug);
  if (!landing) return {};

  return {
    title: landing.metaTitle,
    description: landing.metaDescription,
    alternates: { canonical: `https://canopenal.com/situaciones/${landing.slug}` },
    robots: { index: true, follow: true },
  };
}

export default async function SituationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const landing = getHighIntentLanding(slug);
  if (!landing) notFound();

  const whatsappHref = `${site.whatsapp}?text=${encodeURIComponent(landing.whatsappText)}`;

  return (
    <PageShell>
      <section className="cp-page">
        <div className="cp-wrap cp-page-copy">
          <div className="cp-eyebrow">{landing.eyebrow}</div>
          <h1 className="cp-page-title">{landing.title}</h1>
          <div className="cp-copy" style={{ marginTop: "2.5rem" }}>
            {landing.intro.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </div>
          <div className="cp-actions">
            <a className="cp-btn cp-btn-solid" href={whatsappHref} target="_blank" rel="noopener noreferrer">Hablar por WhatsApp</a>
            <Link className="cp-btn" href="/#contacto">Solicitar valoración</Link>
          </div>
        </div>
      </section>

      <section className="cp-section">
        <div className="cp-wrap">
          <div className="cp-section-head">
            <div>
              <p className="cp-eyebrow">Estrategia</p>
              <h2>Qué importa <strong>desde el inicio</strong></h2>
            </div>
          </div>
          <div className="cp-paths">
            <article className="cp-path" tabIndex={0}>
              <h3>{landing.firstBlock.title}</h3>
              <p>{landing.firstBlock.body}</p>
            </article>
            <article className="cp-path" tabIndex={0}>
              <h3>{landing.secondBlock.title}</h3>
              <p>{landing.secondBlock.body}</p>
            </article>
          </div>
        </div>
      </section>

      <section className="cp-section">
        <div className="cp-wrap">
          <div className="cp-section-head">
            <div>
              <p className="cp-eyebrow">Revisión del caso</p>
              <h2>Una defensa <strong>sin improvisaciones</strong></h2>
            </div>
          </div>
          <div className="cp-why">
            {landing.checkpoints.map((checkpoint) => (
              <article tabIndex={0} key={checkpoint.title}>
                <h3>{checkpoint.title}</h3>
                <p>{checkpoint.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="cp-metrics">
        <div className="cp-wrap cp-metrics-grid">
          <div className="cp-metric"><strong>20</strong><span>Años ejerciendo exclusivamente en penal</span></div>
          <div className="cp-metric"><strong>700+</strong><span>Casos atendidos</span></div>
          <div className="cp-metric"><strong>CDMX</strong><span>Fuero común y federal</span></div>
        </div>
      </section>

      <section className="cp-section">
        <div className="cp-wrap cp-page-copy">
          <div className="cp-eyebrow">Contacto directo</div>
          <h2>Revisa tu situación <strong>antes de decidir</strong></h2>
          <div className="cp-copy" style={{ marginTop: "1.5rem" }}>
            <p>Cada asunto depende de sus hechos, del expediente y del momento procesal. La valoración inicial permite definir qué información hace falta y cuáles son los siguientes pasos.</p>
          </div>
          <div className="cp-actions">
            <a className="cp-btn cp-btn-solid" href={whatsappHref} target="_blank" rel="noopener noreferrer">Contactar a Eduardo Cano</a>
            <a className="cp-btn" href={site.phoneHref}>Llamar {site.phoneDisplay}</a>
            <Link className="cp-text-link" href={landing.relatedHref}>{landing.relatedLabel}</Link>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
