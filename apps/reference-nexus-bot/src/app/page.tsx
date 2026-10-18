import { Link } from "@nexus/core";

export default function HomePage() {
  return (
    <main className="nbm-shell" id="main-content">
      <div className="nbm-atmosphere" aria-hidden="true" />

      <header className="nbm-topbar">
        <Link href="#main-content" className="nbm-wordmark">
          NEXUS BOT STUDIO
        </Link>
        <Link href="#contacto" className="nbm-contact-link">
          Contacto
        </Link>
      </header>

      <section className="nbm-hero" aria-labelledby="nbm-hero-title">
        <h1 id="nbm-hero-title" className="nbm-hero-title">
          CREAMOS SISTEMAS INTELIGENTES.
        </h1>
        <p className="nbm-hero-copy">
          Agentes, automatizaciones y software que trabajan por ti.
        </p>
      </section>

      <section className="nbm-statement" aria-label="Propuesta">
        <p>
          Diseñamos y construimos sistemas que conectan, deciden y ejecutan.
          Menos esfuerzo. Más resultados.
        </p>
      </section>

      <section className="nbm-services" aria-label="Capacidades">
        <p>
          Web · automatización · IA · integraciones · desarrollo a medida
        </p>
      </section>

      <section className="nbm-close" id="contacto" aria-labelledby="nbm-close-title">
        <h2 id="nbm-close-title">HABLEMOS DE LO QUE PODEMOS CONSTRUIR JUNTOS.</h2>
        <a className="nbm-mail" href="mailto:hola@nexusbotstudio.com">
          hola@nexusbotstudio.com
        </a>
      </section>
    </main>
  );
}
