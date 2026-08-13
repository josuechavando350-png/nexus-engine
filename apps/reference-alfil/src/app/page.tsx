import { Cluster, Container, Link } from "@nexus/core";

/**
 * Demo content only. Alfil is a real beauty salon & spa (Azcapotzalco,
 * CDMX); service categories below are generic/illustrative, not the real
 * service list, prices, or specific claims — see EXPRESSIVENESS.md
 * "NO INVENTAR DATOS DE CLIENTES".
 */
const services = [
  { name: "Corte", desc: "Categoría de muestra — servicios de corte." },
  { name: "Color", desc: "Categoría de muestra — coloración y tratamientos de color." },
  { name: "Tratamiento facial", desc: "Categoría de muestra — cuidado facial." },
  { name: "Spa", desc: "Categoría de muestra — experiencias de spa." }
];

export default function HomePage() {
  return (
    <>
      <header className="ra-topline">
        <Link href="#main-content" className="ra-wordmark">
          Alfil
        </Link>
        <nav aria-label="Navegación principal">
          <Cluster gap="space.sm" wrap="nowrap">
            <Link href="#servicios">Servicios</Link>
            <Link href="#contacto">Contacto</Link>
          </Cluster>
        </nav>
      </header>

      <main id="main-content">
        <section className="ra-hero">
          <Container size="container.lg" paddingInline="space.md">
            <h1 className="ra-hero-title">
              La belleza es una forma de <span className="ra-accent-word">precisión</span>.
            </h1>
          </Container>

          <div className="ra-hero-aside">
            <p>
              Probe de experiencia — contenido de demostración. Un espacio
              pensado con la misma atención que un buen corte: nada de más.
            </p>
            <div style={{ marginTop: "1.5rem" }}>
              <Link className="ra-action-link" href="#servicios">
                Ver servicios
              </Link>
            </div>
          </div>
        </section>

        <section className="ra-services" id="servicios">
          <Container size="container.lg" paddingInline="space.md">
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
              <div
                className="ra-media"
                role="img"
                aria-label="Fotografía de muestra del espacio — placeholder, no es una foto real del negocio"
              />
            </div>
            <span className="ra-media-caption" style={{ display: "block", textAlign: "right", marginTop: "-2.5rem", marginBottom: "2.5rem" }}>
              Foto de muestra
            </span>

            <h2 className="ra-services-heading">Lo que se hace con cuidado.</h2>

            <div>
              {services.map((service, index) => (
                <div className="ra-service-row" key={service.name}>
                  <span className="ra-service-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3 className="ra-service-name">{service.name}</h3>
                    <p className="ra-service-desc">{service.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </Container>
        </section>

        <section className="ra-statement" id="contacto">
          <Container size="container.lg" paddingInline="space.md">
            <p>Menos ruido. Mejor resultado.</p>
            <div style={{ marginTop: "2rem" }}>
              <Link className="ra-action-outline" href="#contacto">
                Agendar una cita
              </Link>
            </div>
          </Container>
        </section>
      </main>

      <footer className="ra-footer">
        <Container size="container.lg" paddingInline="space.md">
          <Cluster justify="space-between" gap="space.md">
            <span>Alfil — experience probe</span>
            <span>NEXUS V1.1 — contenido de demostración</span>
          </Cluster>
        </Container>
      </footer>
    </>
  );
}
