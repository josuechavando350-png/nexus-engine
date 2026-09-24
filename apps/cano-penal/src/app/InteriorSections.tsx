import type { ReactNode } from "react";
import { Link } from "@nexus/core";
import { site } from "./content";

export function InteriorHero({
  eyebrow,
  title,
  lead,
  marker,
  aside,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  marker?: string;
  aside?: ReactNode;
}) {
  return (
    <section className="cp-interior-hero">
      <div className="cp-interior-ambient" aria-hidden="true" />
      <div className="cp-wrap cp-interior-hero-grid">
        <div className="cp-interior-hero-copy">
          <p className="cp-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {lead ? <p className="cp-interior-lead">{lead}</p> : null}
        </div>
        <div className="cp-interior-aside">
          {aside ?? (
            <>
              <span className="cp-interior-marker">{marker ?? "CANO"}</span>
              <span className="cp-interior-rule" aria-hidden="true" />
              <p>Defensa penal estratégica en Ciudad de México.</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function InteriorCta({
  eyebrow = "Siguiente paso",
  title = "Tu caso merece una estrategia antes de una reacción.",
  copy = "Cuéntanos qué está pasando. La primera decisión es entender bien el problema y actuar con tiempo.",
}: {
  eyebrow?: string;
  title?: string;
  copy?: string;
}) {
  return (
    <section className="cp-interior-cta">
      <div className="cp-wrap cp-interior-cta-grid">
        <div>
          <p className="cp-eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <div className="cp-interior-cta-actions">
          <p>{copy}</p>
          <div className="cp-actions">
            <a className="cp-btn cp-btn-solid" href={site.whatsapp} target="_blank" rel="noopener noreferrer">
              Escribir por WhatsApp
            </a>
            <a className="cp-btn" href={site.phoneHref}>
              Llamar {site.phoneDisplay}
            </a>
            <Link className="cp-text-link" href="/#contacto">
              Ver datos de contacto
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function EditorialParagraphs({
  paragraphs,
}: {
  paragraphs: readonly string[];
}) {
  return (
    <div className="cp-interior-editorial-list">
      {paragraphs.map((paragraph, index) => (
        <article className="cp-interior-editorial-row" key={paragraph}>
          <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <p>{paragraph}</p>
        </article>
      ))}
    </div>
  );
}
