import {
  Box,
  Button,
  Cluster,
  Container,
  Link,
  Section,
  Stack,
  VisuallyHidden
} from "@nexus/core";

/**
 * Structural placeholder only. Every string below is a placeholder to
 * replace, not a suggested composition. There is deliberately no Hero,
 * no card grid, no marketing pattern, no default art direction here —
 * that is the entire point of this file. An Experience built from this
 * seed should not need to fight or delete anything below; it should
 * simply replace it.
 */
export default function HomePage() {
  return (
    <>
      <header>
        <Container size="container.xl" paddingInline="space.md">
          <Cluster justify="space-between" wrap="nowrap">
            <Link href="#main-content">[ Marca — reemplazar ]</Link>
            <nav aria-label="Navegación principal">
              <Cluster gap="space.sm" wrap="nowrap">
                <Link href="#main-content">[ Enlace 1 ]</Link>
                <Link href="#main-content">[ Enlace 2 ]</Link>
              </Cluster>
            </nav>
          </Cluster>
        </Container>
      </header>

      <main id="main-content">
        <Section>
          <Container size="container.xl" paddingInline="space.md">
            <Stack gap="space.md">
              <Box>
                <h1>[ Título — reemplazar ]</h1>
                <p>[ Bloque de apertura — reemplazar. No es un Hero por defecto. ]</p>
              </Box>

              <Cluster gap="space.sm">
                <Button>[ Acción — reemplazar ]</Button>
              </Cluster>
            </Stack>
          </Container>
        </Section>

        <Section>
          <Container size="container.xl" paddingInline="space.md">
            <Box>
              <p>
                [ Contenido — reemplazar. Este bloque no asume cards,
                galería, ni ninguna estructura visual específica. ]
              </p>
            </Box>
          </Container>
        </Section>
      </main>

      <footer>
        <Container size="container.xl" paddingInline="space.md">
          <p>
            <VisuallyHidden>Pie de página — </VisuallyHidden>
            [ Pie — reemplazar ]
          </p>
        </Container>
      </footer>
    </>
  );
}
