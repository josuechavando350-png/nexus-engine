import {
  Box,
  Cluster,
  Container,
  Grid,
  Link,
  Section,
  Stack
} from "@nexus/core";
import { Reveal } from "./reveal";

const capabilities = [
  {
    eyebrow: "Foundation",
    title: "Semantic by default",
    description:
      "Tokens, typography and themes provide a stable visual language without coupling Core to a brand.",
    delay: "none"
  },
  {
    eyebrow: "Composition",
    title: "Built to compose",
    description:
      "Structural primitives create responsive experiences without rebuilding layout foundations for every client.",
    delay: "short"
  },
  {
    eyebrow: "Accessibility",
    title: "Inclusive at the core",
    description:
      "Keyboard navigation, visible focus, reduced motion and semantic contracts are part of the engine.",
    delay: "medium"
  },
  {
    eyebrow: "Motion",
    title: "Motion with intent",
    description:
      "Semantic duration and easing roles provide consistent interaction without hardcoding animation decisions.",
    delay: "long"
  }
] as const;

export default function HomePage() {
  return (
    <main id="main-content">
      <Section>
        <Container size="container.xl" paddingInline="space.md">
          <Reveal>
            <Stack>
              <Box>
                <p className="nexus-eyebrow">NEXUS / WEB ENGINE</p>

                <h1 className="nexus-hero-title">
                  One foundation.
                  <br />
                  Infinite experiences.
                </h1>

                <p className="nexus-hero-copy">
                  A reusable web engine for building fast, accessible and
                  visually ambitious client experiences without rebuilding the
                  foundation every time.
                </p>
              </Box>

              <Cluster>
                <Link
                  className="nexus-primary-action"
                  href="#capabilities"
                >
                  Explore the engine
                </Link>

                <Link
                  className="nexus-secondary-action"
                  href="#principles"
                >
                  View principles
                </Link>
              </Cluster>
            </Stack>
          </Reveal>
        </Container>
      </Section>

      <Section>
        <Container size="container.xl" paddingInline="space.md">
          <Reveal>
            <Box>
              <p className="nexus-section-label">ENGINE / 01</p>

              <h2 className="nexus-section-title">
                Complexity underneath.
                <br />
                Clarity on the surface.
              </h2>
            </Box>
          </Reveal>
        </Container>
      </Section>

      <section id="capabilities">
        <Container size="container.xl" paddingInline="space.md">
          <Grid>
            {capabilities.map((capability) => (
              <Box key={capability.title}>
                <Reveal delay={capability.delay}>
                  <article className="nexus-capability-card">
                    <p className="nexus-card-eyebrow">
                      {capability.eyebrow}
                    </p>

                    <h3>{capability.title}</h3>

                    <p>{capability.description}</p>
                  </article>
                </Reveal>
              </Box>
            ))}
          </Grid>
        </Container>
      </section>

      <section id="principles" className="nexus-statement">
        <Container size="container.xl" paddingInline="space.md">
          <Reveal>
            <p>
              Core stays stable.
              <br />
              Experiences stay free.
            </p>
          </Reveal>
        </Container>
      </section>
    </main>
  );
}
