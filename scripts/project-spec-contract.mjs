import { createHash } from "node:crypto";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const RESERVED_PREFIXES = ["_", "reference-", "v2-probe-", "probe-", "test-"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const HEX_RE = /^#[A-Fa-f0-9]{6}$/u;
const MAX_SERVICES = 100;
const MAX_PALETTE = 32;
const MAX_PROHIBITIONS = 100;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, field) {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} contains unknown or missing fields`);
  }
}

function text(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  if (normalized.includes(String.fromCharCode(0))) throw new Error(`${field} contains a NUL byte`);
  return normalized;
}

function optionalText(value, field, maxLength) {
  return value === undefined ? undefined : text(value, field, maxLength);
}

function boundedArray(value, field, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${field} must contain ${minimum}..${maximum} items`);
  }
  return value;
}

function httpUrl(value, field) {
  const normalized = text(value, field, 2_048);
  let parsed;
  try { parsed = new URL(normalized); } catch { throw new Error(`${field} must be an absolute URL`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${field} must use HTTP(S)`);
  return parsed.toString();
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export function assertClientSlug(value) {
  const slug = text(value, "slug", 80);
  if (!SLUG_RE.test(slug) || slug.includes("--") || RESERVED_PREFIXES.some((prefix) => slug.startsWith(prefix))) {
    throw new Error("slug uses a reserved or invalid client-project name");
  }
  return slug;
}

export function parseProjectSpecification(input, expectedSlug) {
  exactKeys(input, ["schemaVersion", "slug", "business", "artDirection"], "project specification");
  if (input.schemaVersion !== 1) throw new Error("project specification schemaVersion must be 1");
  const slug = assertClientSlug(input.slug);
  if (expectedSlug !== undefined && slug !== assertClientSlug(expectedSlug)) throw new Error("project specification slug does not match target slug");

  exactKeys(input.business, ["name", "industry", "location", "contact", "confirmedServices"], "business");
  exactKeys(input.business.contact, ["phone", "email", "website", "address"].filter((key) => input.business.contact[key] !== undefined), "business.contact");
  const contact = {
    ...(input.business.contact.phone !== undefined ? { phone: text(input.business.contact.phone, "business.contact.phone", 100) } : {}),
    ...(input.business.contact.email !== undefined ? { email: text(input.business.contact.email, "business.contact.email", 320) } : {}),
    ...(input.business.contact.website !== undefined ? { website: httpUrl(input.business.contact.website, "business.contact.website") } : {}),
    ...(input.business.contact.address !== undefined ? { address: text(input.business.contact.address, "business.contact.address", 1_000) } : {}),
  };
  if (contact.email && !EMAIL_RE.test(contact.email)) throw new Error("business.contact.email is invalid");

  const serviceNames = new Set();
  const confirmedServices = boundedArray(input.business.confirmedServices, "business.confirmedServices", 1, MAX_SERVICES).map((service, index) => {
    if (!isRecord(service)) throw new Error(`business.confirmedServices[${index}] must be an object`);
    exactKeys(service, ["name", ...(service.description !== undefined ? ["description"] : [])], `business.confirmedServices[${index}]`);
    const name = text(service.name, `business.confirmedServices[${index}].name`, 240);
    const key = name.toLocaleLowerCase("en-US");
    if (serviceNames.has(key)) throw new Error("business.confirmedServices names must be unique");
    serviceNames.add(key);
    const description = optionalText(service.description, `business.confirmedServices[${index}].description`, 2_000);
    return { name, ...(description ? { description } : {}) };
  });

  exactKeys(input.artDirection, ["palette", "typography", "heroComposition", "sectionRhythm", "motion", "prohibitions"], "artDirection");
  const paletteRoles = new Set();
  const palette = boundedArray(input.artDirection.palette, "artDirection.palette", 2, MAX_PALETTE).map((entry, index) => {
    exactKeys(entry, ["hex", "role", "rationale"], `artDirection.palette[${index}]`);
    const hex = text(entry.hex, `artDirection.palette[${index}].hex`, 7).toUpperCase();
    if (!HEX_RE.test(hex)) throw new Error(`artDirection.palette[${index}].hex must be #RRGGBB`);
    const role = text(entry.role, `artDirection.palette[${index}].role`, 120);
    const roleKey = role.toLocaleLowerCase("en-US");
    if (paletteRoles.has(roleKey)) throw new Error("artDirection.palette roles must be unique");
    paletteRoles.add(roleKey);
    return { hex, role, rationale: text(entry.rationale, `artDirection.palette[${index}].rationale`, 1_000) };
  });

  const typographyInput = input.artDirection.typography;
  exactKeys(typographyInput, ["display", "body", "rationale"], "artDirection.typography");
  const typography = {
    display: text(typographyInput.display, "artDirection.typography.display", 240),
    body: text(typographyInput.body, "artDirection.typography.body", 240),
    rationale: text(typographyInput.rationale, "artDirection.typography.rationale", 1_000),
  };

  const directionBlock = (value, field) => {
    exactKeys(value, ["direction", "rationale"], field);
    return {
      direction: text(value.direction, `${field}.direction`, 2_000),
      rationale: text(value.rationale, `${field}.rationale`, 1_000),
    };
  };
  const motionInput = input.artDirection.motion;
  exactKeys(motionInput, ["direction", "reducedMotionBehavior", "rationale"], "artDirection.motion");
  const motion = {
    direction: text(motionInput.direction, "artDirection.motion.direction", 2_000),
    reducedMotionBehavior: text(motionInput.reducedMotionBehavior, "artDirection.motion.reducedMotionBehavior", 1_000),
    rationale: text(motionInput.rationale, "artDirection.motion.rationale", 1_000),
  };
  const prohibitionValues = boundedArray(input.artDirection.prohibitions, "artDirection.prohibitions", 1, MAX_PROHIBITIONS)
    .map((item, index) => text(item, `artDirection.prohibitions[${index}]`, 1_000));
  if (new Set(prohibitionValues.map((item) => item.toLocaleLowerCase("en-US"))).size !== prohibitionValues.length) {
    throw new Error("artDirection.prohibitions must be unique");
  }

  return deepFreeze({
    schemaVersion: 1,
    slug,
    business: {
      name: text(input.business.name, "business.name", 240),
      industry: text(input.business.industry, "business.industry", 240),
      location: text(input.business.location, "business.location", 500),
      contact,
      confirmedServices,
    },
    artDirection: {
      palette,
      typography,
      heroComposition: directionBlock(input.artDirection.heroComposition, "artDirection.heroComposition"),
      sectionRhythm: directionBlock(input.artDirection.sectionRhythm, "artDirection.sectionRhythm"),
      motion,
      prohibitions: prohibitionValues,
    },
  });
}

export function projectSpecDigest(spec) {
  return `sha256:${createHash("sha256").update(JSON.stringify(spec)).digest("hex")}`;
}

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function hex({ r, g, b }) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function mix(first, second, secondWeight) {
  const a = rgb(first); const b = rgb(second);
  return hex({ r: a.r * (1 - secondWeight) + b.r * secondWeight, g: a.g * (1 - secondWeight) + b.g * secondWeight, b: a.b * (1 - secondWeight) + b.b * secondWeight });
}

function relativeLuminance(value) {
  const channel = (component) => {
    const normalized = component / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const color = rgb(value);
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first, second) {
  const a = relativeLuminance(first); const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function readableText(background) {
  const dark = "#111111"; const light = "#FFFFFF";
  return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

function paletteMatch(palette, expression, excludedHex) {
  return palette.find((entry) => expression.test(entry.role) && entry.hex !== excludedHex)?.hex;
}

function safeFontStack(direction, display) {
  const normalized = direction.toLocaleLowerCase("en-US");
  if (/mono|monospace|code/u.test(normalized)) return 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace';
  if (/serif|editorial|roman|book/u.test(normalized)) return 'Georgia, Cambria, "Times New Roman", serif';
  if (/sans|grotesk|humanist|neo.?grotesk/u.test(normalized)) return 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  return display ? 'Georgia, Cambria, "Times New Roman", serif' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
}

export function deriveCompiledDesign(spec) {
  const palette = spec.artDirection.palette;
  const surface = paletteMatch(palette, /surface|background|canvas|base/u) ?? palette[0].hex;
  const accent = paletteMatch(palette, /accent|primary|brand|highlight/u, surface) ?? palette.find((entry) => entry.hex !== surface)?.hex ?? palette[1].hex;
  const content = readableText(surface);
  const inverseSurface = content;
  const inverseContent = readableText(inverseSurface);
  const focus = contrastRatio(accent, surface) >= 3 ? accent : content;
  const directionalText = [spec.artDirection.heroComposition.direction, spec.artDirection.sectionRhythm.direction, ...spec.artDirection.prohibitions].join(" ").toLocaleLowerCase("en-US");
  const motionText = spec.artDirection.motion.direction.toLocaleLowerCase("en-US");
  const radiusMode = /sharp|square|angular|rectilinear|no rounded|no radius/u.test(directionalText)
    ? "SHARP"
    : /rounded|soft|organic|pill/u.test(directionalText)
      ? "SOFT"
      : "MEASURED";
  const compositionMode = /split|asymmetr/u.test(spec.artDirection.heroComposition.direction.toLocaleLowerCase("en-US"))
    ? "SPLIT"
    : /center|centred|centered/u.test(spec.artDirection.heroComposition.direction.toLocaleLowerCase("en-US"))
      ? "CENTERED"
      : "EDITORIAL";
  const rhythmMode = /open|airy|generous|spacious/u.test(spec.artDirection.sectionRhythm.direction.toLocaleLowerCase("en-US"))
    ? "SPACIOUS"
    : /dense|compact|tight/u.test(spec.artDirection.sectionRhythm.direction.toLocaleLowerCase("en-US"))
      ? "COMPACT"
      : "MEASURED";
  const motionMode = /none|static|no motion/u.test(motionText) ? "NONE" : /slow|cinematic|deliberate/u.test(motionText) ? "SLOW" : /fast|short|snappy/u.test(motionText) ? "FAST" : "MEASURED";
  const radii = radiusMode === "SHARP" ? ["0", "0", "0"] : radiusMode === "SOFT" ? ["0.5rem", "0.9rem", "1.4rem"] : ["0.125rem", "0.25rem", "0.5rem"];
  const durations = motionMode === "NONE" ? ["0ms", "0ms", "0ms"] : motionMode === "SLOW" ? ["180ms", "360ms", "620ms"] : motionMode === "FAST" ? ["90ms", "160ms", "260ms"] : ["120ms", "240ms", "420ms"];
  const theme = {
    "space.xs": "0.5rem", "space.sm": "0.75rem", "space.md": "1rem", "space.lg": "1.5rem", "space.xl": "2.5rem",
    "container.sm": "40rem", "container.md": "56rem", "container.lg": "72rem", "container.xl": "88rem",
    "focus.ring": focus, "focus.offset": "4px",
    "motion.duration.instant": "0ms", "motion.duration.fast": durations[0], "motion.duration.base": durations[1], "motion.duration.slow": durations[2],
    "motion.easing.standard": "ease", "motion.easing.decelerate": "ease-out", "motion.easing.accelerate": "ease-in", "motion.easing.linear": "linear",
    "surface.base": surface,
    "surface.elevated": mix(surface, content, 0.06),
    "surface.inverse": inverseSurface,
    "surface.overlay": mix(surface, content, 0.16),
    "content.primary": content,
    "content.secondary": mix(content, surface, 0.32),
    "content.inverse": inverseContent,
    "content.disabled": mix(content, surface, 0.56),
    "accent.default": accent,
    "accent.emphasis": mix(accent, content, 0.14),
    "accent.muted": mix(accent, surface, 0.68),
    "border.subtle": mix(content, surface, 0.82),
    "border.strong": mix(content, surface, 0.58),
    "radius.sm": radii[0], "radius.md": radii[1], "radius.lg": radii[2], "radius.full": "9999px",
  };
  return deepFreeze({
    compositionMode,
    rhythmMode,
    motionMode,
    radiusMode,
    displayFontStack: safeFontStack(spec.artDirection.typography.display, true),
    bodyFontStack: safeFontStack(spec.artDirection.typography.body, false),
    selectedPalette: { surface, accent },
    theme,
  });
}

const GENERATED_PATHS = Object.freeze([
  "README.md",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/project-data.ts",
  "src/app/project.css",
  "src/app/theme.ts",
  "src/app/theme-contract.ts",
]);

export function compileProjectSources(spec) {
  const design = deriveCompiledDesign(spec);
  const digest = projectSpecDigest(spec);
  const projectData = { schemaVersion: 1, authority: "NEXUS_COMPILED_PROJECT_DATA_V1", specDigest: digest, business: spec.business, artDirection: spec.artDirection, compiledDesign: { compositionMode: design.compositionMode, rhythmMode: design.rhythmMode, motionMode: design.motionMode, radiusMode: design.radiusMode } };
  const files = new Map();
  files.set("README.md", `# NEXUS client app\n\nGenerated factual bootstrap for \`${spec.slug}\`. The source specification and compiler evidence live under \`.nexus/\`.\n`);
  files.set("src/app/project-data.ts", `export const projectData = ${JSON.stringify(projectData, null, 2)} as const;\n`);
  files.set("src/app/theme.ts", `import type { NexusTheme } from "@nexus/core/foundation/theme";\n\nexport const experienceTheme: NexusTheme = ${JSON.stringify(design.theme, null, 2)};\n`);
  files.set("src/app/theme-contract.ts", `import type { TokenRole } from "@nexus/core/foundation/tokens";\nimport type { NexusTheme } from "@nexus/core/foundation/theme";\n\nconst REQUIRED_CLIENT_ROLES: readonly TokenRole[] = ${JSON.stringify(Object.keys(design.theme), null, 2)};\n\nexport function assertClientTheme(theme: NexusTheme): void {\n  const missing = REQUIRED_CLIENT_ROLES.filter((role) => theme[role] === undefined);\n  if (missing.length) throw new Error(\`NEXUS client theme is incomplete: \${missing.join(", ")}\`);\n}\n`);
  files.set("src/app/layout.tsx", `import type { Metadata } from "next";\nimport type { CSSProperties } from "react";\nimport { REDUCED_MOTION_CSS, SR_ONLY_CSS, skipLinkProps, themeToCssVariables } from "@nexus/core";\nimport "@nexus/core/foundation/tokens/tokens.css";\nimport "./reset.css";\nimport "./a11y-gap.css";\nimport "./project.css";\nimport { projectData } from "./project-data";\nimport { assertClientTheme } from "./theme-contract";\nimport { experienceTheme } from "./theme";\n\nexport const metadata: Metadata = {\n  title: projectData.business.name,\n  description: projectData.business.industry + " · " + projectData.business.location,\n};\n\nassertClientTheme(experienceTheme);\nconst themeStyle = themeToCssVariables(experienceTheme) as CSSProperties;\nconst skipLink = skipLinkProps();\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="es">\n      <head>\n        <style dangerouslySetInnerHTML={{ __html: SR_ONLY_CSS }} />\n        <style dangerouslySetInnerHTML={{ __html: REDUCED_MOTION_CSS }} />\n      </head>\n      <body style={themeStyle}>\n        <a {...skipLink}>Saltar al contenido principal</a>\n        {children}\n      </body>\n    </html>\n  );\n}\n`);
  files.set("src/app/page.tsx", `import { Box, Cluster, Container, Section, Stack } from "@nexus/core";\nimport { projectData } from "./project-data";\n\nfunction contactHref(kind: "phone" | "email" | "website", value: string): string {\n  if (kind === "phone") return "tel:" + value.replace(/[^+0-9]/g, "");\n  if (kind === "email") return "mailto:" + value;\n  return value;\n}\n\nexport default function HomePage() {\n  const contact = projectData.business.contact;\n  const phone = "phone" in contact ? contact.phone : undefined;\n  const email = "email" in contact ? contact.email : undefined;\n  const website = "website" in contact ? contact.website : undefined;\n  const address = "address" in contact ? contact.address : undefined;\n  const contactItems = [\n    phone ? { kind: "phone" as const, label: "Teléfono", value: phone } : null,\n    email ? { kind: "email" as const, label: "Correo", value: email } : null,\n    website ? { kind: "website" as const, label: "Sitio", value: website } : null,\n  ].filter((item): item is NonNullable<typeof item> => item !== null);\n  const rootClass = "nx-client nx-composition-" + projectData.compiledDesign.compositionMode.toLowerCase() + " nx-rhythm-" + projectData.compiledDesign.rhythmMode.toLowerCase();\n  return (\n    <div className={rootClass}>\n      <header className="nx-client-header">\n        <Container size="container.xl" paddingInline="space.md">\n          <Cluster justify="space-between" wrap="nowrap">\n            <strong className="nx-client-brand">{projectData.business.name}</strong>\n            <nav aria-label="Navegación principal">\n              <Cluster gap="space.sm" wrap="nowrap">\n                <a href="#servicios">Servicios</a>\n                <a href="#contacto">Contacto</a>\n              </Cluster>\n            </nav>\n          </Cluster>\n        </Container>\n      </header>\n      <main id="main-content">\n        <Section className="nx-client-hero">\n          <Container size="container.xl" paddingInline="space.md">\n            <div className="nx-client-hero-grid">\n              <Stack gap="space.md">\n                <p className="nx-client-kicker">{projectData.business.industry}</p>\n                <h1>{projectData.business.name}</h1>\n                <p className="nx-client-location">{projectData.business.location}</p>\n              </Stack>\n              <Box className="nx-client-hero-aside">\n                <p>{projectData.artDirection.heroComposition.direction}</p>\n              </Box>\n            </div>\n          </Container>\n        </Section>\n        <Section id="servicios" className="nx-client-section">\n          <Container size="container.xl" paddingInline="space.md">\n            <Stack gap="space.lg">\n              <div>\n                <p className="nx-client-kicker">Servicios confirmados</p>\n                <h2>Servicios</h2>\n              </div>\n              <div className="nx-client-services">\n                {projectData.business.confirmedServices.map((service) => (\n                  <article key={service.name}>\n                    <h3>{service.name}</h3>\n                    {"description" in service ? <p>{service.description}</p> : null}\n                  </article>\n                ))}\n              </div>\n            </Stack>\n          </Container>\n        </Section>\n        <Section id="contacto" className="nx-client-section nx-client-contact">\n          <Container size="container.xl" paddingInline="space.md">\n            <Stack gap="space.lg">\n              <div>\n                <p className="nx-client-kicker">Contacto</p>\n                <h2>{projectData.business.location}</h2>\n                {address ? <p>{address}</p> : null}\n              </div>\n              {contactItems.length ? (\n                <ul className="nx-client-contact-list">\n                  {contactItems.map((item) => (\n                    <li key={item.kind}><a href={contactHref(item.kind, item.value)}>{item.label}: {item.value}</a></li>\n                  ))}\n                </ul>\n              ) : null}\n            </Stack>\n          </Container>\n        </Section>\n      </main>\n      <footer className="nx-client-footer">\n        <Container size="container.xl" paddingInline="space.md">\n          <p>{projectData.business.name}</p>\n        </Container>\n      </footer>\n    </div>\n  );\n}\n`);
  files.set("src/app/project.css", `.nx-client {\n  min-height: 100vh;\n  background: var(--surface-base);\n  color: var(--content-primary);\n  font-family: ${design.bodyFontStack};\n}\n.nx-client a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 0.2em; }\n.nx-client-header { padding-block: var(--space-md); border-bottom: 1px solid var(--border-subtle); }\n.nx-client-brand, .nx-client h1, .nx-client h2, .nx-client h3 { font-family: ${design.displayFontStack}; }\n.nx-client h1 { margin: 0; max-width: 15ch; font-size: clamp(2.75rem, 8vw, 7.5rem); line-height: 0.92; letter-spacing: -0.045em; }\n.nx-client h2 { margin: 0; font-size: clamp(2rem, 5vw, 4.5rem); line-height: 1; }\n.nx-client h3 { margin: 0; font-size: clamp(1.35rem, 2.5vw, 2rem); }\n.nx-client p { max-width: 62ch; }\n.nx-client-kicker { margin: 0; color: var(--accent-default); font-size: 0.78rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }\n.nx-client-location { margin: 0; color: var(--content-secondary); font-size: clamp(1rem, 2vw, 1.35rem); }\n.nx-client-hero { min-height: min(78vh, 56rem); display: grid; align-items: center; border-bottom: 1px solid var(--border-subtle); }\n.nx-client-hero-grid { display: grid; gap: clamp(2rem, 6vw, 7rem); align-items: end; }\n.nx-composition-split .nx-client-hero-grid { grid-template-columns: minmax(0, 1.45fr) minmax(16rem, 0.55fr); }\n.nx-composition-centered .nx-client-hero-grid { justify-items: center; text-align: center; }\n.nx-composition-centered .nx-client-hero-grid > * { align-items: center; }\n.nx-client-hero-aside { padding: var(--space-lg); border-left: 1px solid var(--border-strong); color: var(--content-secondary); }\n.nx-client-section { padding-block: clamp(4rem, 9vw, 8rem); border-bottom: 1px solid var(--border-subtle); }\n.nx-rhythm-compact .nx-client-section { padding-block: clamp(2.5rem, 5vw, 4.5rem); }\n.nx-rhythm-spacious .nx-client-section { padding-block: clamp(6rem, 12vw, 11rem); }\n.nx-client-services { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 1px; background: var(--border-subtle); border: 1px solid var(--border-subtle); }\n.nx-client-services article { min-height: 13rem; padding: clamp(1.25rem, 3vw, 2.5rem); background: var(--surface-base); }\n.nx-client-services article p { color: var(--content-secondary); }\n.nx-client-contact { background: var(--surface-elevated); }\n.nx-client-contact-list { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--space-sm); }\n.nx-client-footer { padding-block: var(--space-lg); }\n@media (max-width: 760px) {\n  .nx-composition-split .nx-client-hero-grid { grid-template-columns: 1fr; }\n  .nx-client-hero-aside { border-left: 0; border-top: 1px solid var(--border-strong); padding-inline: 0; }\n  .nx-client-header nav { display: none; }\n}\n@media (prefers-reduced-motion: reduce) {\n  .nx-client *, .nx-client *::before, .nx-client *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }\n}\n`);
  return deepFreeze({
    specDigest: digest,
    design,
    generatedPaths: GENERATED_PATHS,
    files,
    evidence: {
      authority: "NEXUS_PROJECT_SPEC_COMPILER_V1",
      schemaVersion: 1,
      specDigest: digest,
      generatedPaths: GENERATED_PATHS,
      design: { compositionMode: design.compositionMode, rhythmMode: design.rhythmMode, motionMode: design.motionMode, radiusMode: design.radiusMode, selectedPalette: design.selectedPalette },
    },
  });
}

export function addWorkspaceImporterFromSeed(lockfileText, slug) {
  if (typeof lockfileText !== "string" || !lockfileText.startsWith("lockfileVersion: '9.0'")) throw new Error("unsupported pnpm lockfile format");
  const targetHeader = `  apps/${assertClientSlug(slug)}:`;
  const lines = lockfileText.split("\n");
  if (lines.includes(targetHeader)) throw new Error(`workspace lockfile already contains apps/${slug}`);
  const seedIndex = lines.indexOf("  apps/_experience-seed:");
  if (seedIndex < 0) throw new Error("workspace lockfile does not contain apps/_experience-seed importer");
  let end = seedIndex + 1;
  while (end < lines.length && !/^ {2}\S.*:\s*$/u.test(lines[end])) end += 1;
  const seedBlock = lines.slice(seedIndex, end);
  if (seedBlock.length < 3) throw new Error("experience-seed lockfile importer is malformed");
  const clientBlock = [...seedBlock];
  clientBlock[0] = targetHeader;
  lines.splice(end, 0, ...clientBlock);
  return lines.join("\n");
}