import { Cluster, Container, Link, Stack } from "@nexus/core";

/**
 * Demo content only. Categories (tacos, parrilla, alitas, hamburguesas,
 * antojos) reflect real known Mesón del 5 categories; specific dish names,
 * prices and descriptions below are illustrative placeholders, not the
 * production menu — see EXPRESSIVENESS.md "NO INVENTAR DATOS DE CLIENTES".
 */
const menu = [
  { name: "Tacos al carbón", desc: "Categoría de muestra — variedad de tacos cocinados al carbón." },
  { name: "Parrilla", desc: "Categoría de muestra — cortes y proteínas a la parrilla." },
  { name: "Alitas", desc: "Categoría de muestra — alitas con salsas variadas." },
  { name: "Hamburguesas", desc: "Categoría de muestra — hamburguesas de la casa." },
  { name: "Antojos", desc: "Categoría de muestra — botanas y antojos para compartir." }
];

export default function HomePage() {
  return (
    <>
      <header className="rm-topline">
        <Link href="#main-content" className="rm-wordmark">
          Mesón del 5
        </Link>
        <nav aria-label="Navegación principal">
          <Cluster gap="space.sm" wrap="nowrap">
            <Link href="#menu">Menú</Link>
            <Link href="#contacto">Contacto</Link>
          </Cluster>
        </nav>
      </header>

      <main id="main-content">
        <section className="rm-hero">
          <Container size="container.md" paddingInline="space.md">
            <span className="rm-hero-tag">Barrio · Fuego · Mesa</span>
            <h1 className="rm-hero-title">
              Se come <em>de verdad</em> junto al fuego.
            </h1>
            <p className="rm-hero-copy">
              Probe de experiencia — contenido de demostración. Cocina de
              carbón y parrilla, pensada para comer con las manos y quedarse
              un rato más.
            </p>
            <Stack gap="space.sm">
              <Cluster gap="space.sm">
                <Link className="rm-action" href="#menu">
                  Ver el menú
                </Link>
                <Link className="rm-action-ghost" href="#contacto">
                  Cómo llegar
                </Link>
              </Cluster>
            </Stack>
          </Container>

          <div
            className="rm-hero-media"
            role="img"
            aria-label="Fotografía de muestra de la parrilla — placeholder, no es una foto real del negocio"
          >
            <span className="rm-media-caption">Foto de muestra</span>
          </div>
        </section>

        <section className="rm-menu" id="menu">
          <Container size="container.md" paddingInline="space.md">
            <h2 className="rm-menu-heading">Lo que se cocina en la mesa.</h2>

            <div>
              {menu.map((item, index) => (
                <div className="rm-menu-row" key={item.name}>
                  <span className="rm-menu-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h3 className="rm-menu-name">{item.name}</h3>
                    <p className="rm-menu-desc">{item.desc}</p>
                  </div>
                  <div
                    className="rm-menu-swatch"
                    role="img"
                    aria-label={`Textura de muestra para ${item.name}`}
                  />
                </div>
              ))}
            </div>
          </Container>
        </section>

        <section className="rm-statement" id="contacto">
          <Container size="container.md" paddingInline="space.md">
            <p>El fuego no se apura. Tú tampoco deberías.</p>
          </Container>
        </section>
      </main>

      <footer className="rm-footer">
        <Container size="container.md" paddingInline="space.md">
          <Cluster justify="space-between" gap="space.md">
            <span>Mesón del 5 — experience probe</span>
            <span>NEXUS V1.1 — contenido de demostración</span>
          </Cluster>
        </Container>
      </footer>
    </>
  );
}
