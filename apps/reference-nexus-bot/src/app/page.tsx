import { Cluster, Container, Link, VisuallyHidden } from "@nexus/core";

/**
 * The four modules below reflect Nexus Bot Studio's real, already-known
 * product lines (Nexus Web / Growth / Sales / Automation) — not invented
 * client data. Copy is written plainly, avoiding "AI-powered" marketing
 * language per the brief.
 */
const modules = [
  {
    label: "[ WEB ]",
    name: "Nexus Web",
    desc: "Páginas web construidas sobre el mismo motor NEXUS."
  },
  {
    label: "[ GROWTH ]",
    name: "Nexus Growth",
    desc: "Adquisición, SEO y medición de resultados."
  },
  {
    label: "[ SALES ]",
    name: "Nexus Sales",
    desc: "Atención y ventas asistidas."
  },
  {
    label: "[ AUTOMATION ]",
    name: "Nexus Automation",
    desc: "Automatización de procesos repetitivos."
  }
];

export default function HomePage() {
  return (
    <>
      <header className="rnb-topline">
        <Link href="#main-content" className="rnb-wordmark">
          NEXUS BOT STUDIO
        </Link>
        <span className="rnb-status">
          <span className="rnb-status-dot" aria-hidden="true" />
          probe activo
        </span>
      </header>

      <main id="main-content">
        <section className="rnb-hero">
          <Container size="container.lg" paddingInline="space.md">
            <span className="rnb-hero-tag">SISTEMA / 01</span>
            <h1 className="rnb-hero-title">
              Tecnología propia para negocios que operan con estructura.
            </h1>
            <p className="rnb-hero-copy">
              Probe de experiencia — contenido de demostración. Cuatro
              módulos, un mismo motor.
            </p>
            <div style={{ marginTop: "1.75rem" }}>
              <Cluster gap="space.sm">
                <Link className="rnb-action" href="#modulos">
                  [ Ver módulos ]
                </Link>
                <Link className="rnb-action-outline" href="#contacto">
                  [ Contacto ]
                </Link>
              </Cluster>
            </div>
          </Container>

          <Container size="container.lg" paddingInline="space.md">
            <div className="rnb-diagram" aria-hidden="true">
              <div className="rnb-diagram-row">
                <span>core</span>
                <span>estable</span>
              </div>
              <div className="rnb-diagram-row">
                <span>experience</span>
                <span>en probe</span>
              </div>
              <div className="rnb-diagram-row">
                <span>seguridad</span>
                <span>activa</span>
              </div>
              <div className="rnb-diagram-row">
                <span>accesibilidad</span>
                <span>activa</span>
              </div>
            </div>
          </Container>
        </section>

        <section id="modulos">
          <Container size="container.lg">
            <h2>
              <VisuallyHidden>Módulos</VisuallyHidden>
            </h2>
            <div className="rnb-modules">
              {modules.map((mod) => (
                <div className="rnb-module" key={mod.name}>
                  <span className="rnb-module-label">{mod.label}</span>
                  <h3 className="rnb-module-name">{mod.name}</h3>
                  <p className="rnb-module-desc">{mod.desc}</p>
                </div>
              ))}
            </div>
          </Container>
        </section>

        <section className="rnb-statement" id="contacto">
          <Container size="container.lg" paddingInline="space.md">
            <p>Un motor. Cuatro módulos. Cero plantillas.</p>
          </Container>
        </section>
      </main>

      <footer className="rnb-footer">
        <Container size="container.lg" paddingInline="space.md">
          <Cluster justify="space-between" gap="space.md">
            <span>NEXUS BOT STUDIO — experience probe</span>
            <span>NEXUS V1.1 — contenido de demostración</span>
          </Cluster>
        </Container>
      </footer>
    </>
  );
}
