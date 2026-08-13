import {
  Cluster,
  Container,
  Link
} from "@nexus/core";

export function SiteHeader() {
  return (
    <header className="nexus-site-header">
      <Container size="container.xl" paddingInline="space.md">
        <Cluster justify="space-between" wrap="nowrap">
          <Link className="nexus-brand" href="#main-content">
            NEXUS
          </Link>

          <nav className="nexus-nav" aria-label="Navegación principal">
            <Cluster gap="space.sm" wrap="nowrap">
              <Link href="#capabilities">Capabilities</Link>
              <Link href="#principles">Principles</Link>

              <Link
                className="nexus-nav-cta"
                href="#capabilities"
              >
                Build with Nexus
              </Link>
            </Cluster>
          </nav>
        </Cluster>
      </Container>
    </header>
  );
}
