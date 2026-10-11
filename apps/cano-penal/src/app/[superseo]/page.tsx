import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { PageShell } from "../SiteChrome";
import { site } from "../content";
import { superseoPagina, superseoRedireccion, superseoSlugs } from "../../superseo/paquete";
import "./superseo.css";

const BASE = "https://canopenal.com";

// Solo existen las rutas que SUPERSEO publicó o redirige; cualquier otra es 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return superseoSlugs().map((superseo) => ({ superseo }));
}

export async function generateMetadata({ params }: { params: Promise<{ superseo: string }> }): Promise<Metadata> {
  const { superseo } = await params;
  const pagina = superseoPagina(superseo);
  if (!pagina) return {};
  return {
    title: pagina.titulo,
    description: pagina.descripcion,
    alternates: { canonical: `${BASE}${pagina.ruta}` },
    robots: { index: true, follow: true },
  };
}

export default async function SuperseoPage({ params }: { params: Promise<{ superseo: string }> }) {
  const { superseo } = await params;
  const destino = superseoRedireccion(superseo);
  if (destino) permanentRedirect(destino);
  const pagina = superseoPagina(superseo);
  if (!pagina) notFound();

  const url = `${BASE}${pagina.ruta}`;
  const esquema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "LegalService",
        "@id": `${BASE}/#despacho`,
        name: site.name,
        telephone: site.phoneDisplay,
        address: site.address,
        areaServed: pagina.zona_nombre ?? site.serviceArea,
        url: BASE,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Inicio", item: `${BASE}/` },
          { "@type": "ListItem", position: 2, name: "Orientación penal", item: `${BASE}/orientacion-penal` },
          { "@type": "ListItem", position: 3, name: pagina.h1, item: url },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: pagina.faq.map((f) => ({ "@type": "Question", name: f.pregunta, acceptedAnswer: { "@type": "Answer", text: f.respuesta } })),
      },
    ],
  };

  return (
    <PageShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(esquema).replace(/</g, "\\u003c") }} />
      <article className="ss-page">
        <header className="ss-hero">
          <div className="cp-wrap">
            <nav className="ss-crumbs" aria-label="Ruta de navegación">
              <Link href="/">Inicio</Link> / <Link href="/orientacion-penal">Orientación penal</Link>
            </nav>
            <p className="cp-eyebrow">Defensa penal · {pagina.zona_nombre ?? site.serviceArea}</p>
            <h1>{pagina.h1}</h1>
            <p className="ss-lead">{pagina.descripcion}</p>
            <div className="ss-actions">
              <a className="cp-btn cp-btn-solid" href={site.whatsapp} target="_blank" rel="noopener noreferrer" data-nexus-signal={`superseo-whatsapp-${pagina.id}`}>Escribir por WhatsApp ↗</a>
              <a className="cp-btn" href={site.phoneHref} data-nexus-signal={`superseo-call-${pagina.id}`}>Llamar al despacho →</a>
            </div>
          </div>
        </header>

        <div className="cp-wrap ss-body">
          <section className="ss-quick" aria-labelledby="ss-quick-title">
            <h2 id="ss-quick-title">Qué hacer ahora</h2>
            <ol>{pagina.respuesta_rapida.map((paso) => <li key={paso}>{paso}</li>)}</ol>
          </section>

          {pagina.datos_locales.length > 0 && (
            <section className="ss-data" aria-labelledby="ss-data-title">
              <h2 id="ss-data-title">Lo que dicen los datos{pagina.zona_nombre ? ` de ${pagina.zona_nombre}` : ""}</h2>
              <ul>{pagina.datos_locales.map((d) => <li key={d.dato}>{d.dato} <span>Fuente: {d.fuente}</span></li>)}</ul>
            </section>
          )}

          {pagina.secciones.map((s) => (
            <section className="ss-section" key={s.titulo}>
              <h2>{s.titulo}</h2>
              {s.parrafos.map((p) => <p key={p}>{p}</p>)}
            </section>
          ))}

          <section className="ss-faq" aria-labelledby="ss-faq-title">
            <h2 id="ss-faq-title">Preguntas frecuentes</h2>
            {pagina.faq.map((f) => (
              <details key={f.pregunta}>
                <summary>{f.pregunta}</summary>
                <p>{f.respuesta}</p>
              </details>
            ))}
          </section>

          {pagina.enlaces.length > 0 && (
            <nav className="ss-related" aria-label="Páginas relacionadas">
              <h2>También te puede servir</h2>
              <ul>{pagina.enlaces.map((e) => <li key={e.ruta}><Link href={e.ruta}>{e.texto}</Link></li>)}</ul>
            </nav>
          )}

          {pagina.aviso && <p className="ss-notice">{pagina.aviso}</p>}

          <section className="ss-close">
            <h2>Explica tu situación al despacho</h2>
            <a className="ss-phone" href={site.phoneHref} data-nexus-signal={`superseo-call-close-${pagina.id}`}>{site.phoneDisplay}</a>
            <a className="cp-btn cp-btn-solid" href={site.whatsapp} target="_blank" rel="noopener noreferrer" data-nexus-signal={`superseo-whatsapp-close-${pagina.id}`}>WhatsApp ↗</a>
          </section>
        </div>
      </article>
    </PageShell>
  );
}
