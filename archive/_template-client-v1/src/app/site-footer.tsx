import {
  Cluster,
  Container,
  Link
} from "@nexus/core";

export function SiteFooter() {
  return (
    <footer className="nexus-site-footer">
      <Container size="container.xl" paddingInline="space.md">
        <div className="nexus-footer-inner">
          <div>
            <Link className="nexus-footer-brand" href="#main-content">
              NEXUS
            </Link>

            <p className="nexus-footer-copy">
              A stable foundation for experiences that should never feel the
              same.
            </p>
          </div>

          <Cluster
            className="nexus-footer-links"
            gap="space.md"
            align="center"
          >
            <Link href="#capabilities">Capabilities</Link>
            <Link href="#principles">Principles</Link>
            <Link href="#main-content">Back to top ↑</Link>
          </Cluster>
        </div>

        <div className="nexus-footer-meta">
          <span>NEXUS Web Engine</span>
          <span>Core stable. Experience free.</span>
        </div>
      </Container>
    </footer>
  );
}
