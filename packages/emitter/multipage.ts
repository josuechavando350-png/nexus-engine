import { createHash } from "node:crypto";
import type { ExperienceBrief } from "@nexus/experience/brief";
import type { ExperiencePlan } from "@nexus/experience/compiler";
import type { DnaContentConstraints } from "@nexus/experience/content-constraints";
import type { ExperienceDNA } from "@nexus/experience/dna";

export interface GeneratedCopyInput {
  role: string;
  text: string;
  sourceId: string;
}

export interface GeneratedMediaInput {
  assetId: string;
  role: string;
  publicPath: string;
  sourceDigest: `sha256:${string}`;
  alt: string;
}

export interface GeneratedActionInput {
  capabilityId: string;
  label: string;
  href: string;
  sourceId: string;
  emphasis?: "primary" | "secondary";
}

export interface GeneratedRoute {
  path: string;
  navLabel: string;
  purpose: string;
  capabilityIds: readonly string[];
  copyRoles: readonly string[];
  mediaRoles: readonly string[];
}

export interface GeneratedSourceFile {
  path: string;
  content: string;
  digest: `sha256:${string}`;
  provenanceIds: readonly string[];
}

export interface MultipageGenerationResult {
  authority: "NEXUS_MULTIPAGE_GENERATOR_V1";
  projectId: string;
  routes: readonly GeneratedRoute[];
  files: readonly GeneratedSourceFile[];
  provenanceIds: readonly string[];
  generationDigest: `sha256:${string}`;
}

const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const slug = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const escapeJson = (value: unknown): string => JSON.stringify(value, null, 2).replace(/<\//g, "<\\/");

function labels(locale: string) {
  const es = locale.toLowerCase().startsWith("es");
  return es
    ? { home: "Inicio", explore: "Conoce", proof: "Confianza", visit: "Ubicación", contact: "Contacto", details: "Información", menu: "Menú", skip: "Saltar al contenido", mediaFallback: "Imagen del proyecto" }
    : { home: "Home", explore: "Explore", proof: "Proof", visit: "Visit", contact: "Contact", details: "Details", menu: "Menu", skip: "Skip to content", mediaFallback: "Project image" };
}

function assertInputs(input: {
  brief: ExperienceBrief;
  plan: ExperiencePlan;
  contentConstraints: DnaContentConstraints;
  copy: readonly GeneratedCopyInput[];
  media: readonly GeneratedMediaInput[];
  actions: readonly GeneratedActionInput[];
  tokenCss: string;
}): void {
  if (!input.tokenCss.trim()) throw new Error("multipage generation requires emitted token CSS");
  if (input.plan.unresolvedDecisions.length) throw new Error(`multipage generation refused unresolved plan decisions: ${input.plan.unresolvedDecisions.join("; ")}`);

  const copyRoles = new Set(input.copy.map((item) => item.role));
  for (const role of input.contentConstraints.requiredCopyRoles) if (!copyRoles.has(role)) throw new Error(`multipage generation missing required copy role ${role}`);
  const mediaRoles = new Set(input.media.map((item) => item.role));
  for (const role of input.contentConstraints.requiredPhotoRoles) if (!mediaRoles.has(role)) throw new Error(`multipage generation missing required media role ${role}`);

  for (const item of input.copy) {
    if (!item.role.trim() || !item.text.trim() || !item.sourceId.trim()) throw new Error("generated copy requires role, text and sourceId");
  }
  for (const item of input.media) {
    if (!item.assetId.trim() || !item.role.trim() || !item.publicPath.startsWith("/") || !/^sha256:[a-f0-9]{64}$/.test(item.sourceDigest) || !item.alt.trim()) {
      throw new Error("generated media requires assetId, role, rooted publicPath, canonical sourceDigest and alt");
    }
  }
  for (const action of input.actions) {
    if (!action.capabilityId.trim() || !action.label.trim() || !action.sourceId.trim()) throw new Error("generated action requires capabilityId, label and sourceId");
    if (!/^(https?:|tel:|mailto:)/.test(action.href)) throw new Error(`unsupported generated action href: ${action.href}`);
  }
}

function routeGroups(plan: ExperiencePlan): Readonly<Record<string, readonly string[]>> {
  const groups: Record<string, string[]> = { explore: [], proof: [], visit: [], contact: [] };
  for (const placement of plan.capabilityPlacements) {
    if (placement.capabilityId === "location" || placement.capabilityId === "map") groups.visit.push(placement.capabilityId);
    else if (placement.matchedRole === "conversion" || ["contact", "whatsapp", "booking", "reservation", "lead-capture", "quote-request", "forms"].includes(placement.capabilityId)) groups.contact.push(placement.capabilityId);
    else if (placement.matchedRole === "proof" || placement.matchedRole === "trust" || ["reviews", "social-proof"].includes(placement.capabilityId)) groups.proof.push(placement.capabilityId);
    else if (placement.matchedRole === "discovery" || placement.matchedRole === "utility") groups.explore.push(placement.capabilityId);
  }
  return Object.freeze(Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, Object.freeze([...new Set(values)])])));
}

function deriveRoutes(input: {
  plan: ExperiencePlan;
  copy: readonly GeneratedCopyInput[];
  media: readonly GeneratedMediaInput[];
  locale: string;
}): readonly GeneratedRoute[] {
  const l = labels(input.locale);
  const groups = routeGroups(input.plan);
  const copyRoles = input.copy.map((item) => item.role);
  const mediaRoles = input.media.map((item) => item.role);
  const routes: GeneratedRoute[] = [{
    path: "/",
    navLabel: l.home,
    purpose: input.plan.narrativeSequence[0]?.purpose ?? "Establish the project and primary next action.",
    capabilityIds: Object.freeze(input.plan.capabilityPlacements.filter((placement) => placement.priority === "primary").map((placement) => placement.capabilityId)),
    copyRoles: Object.freeze(copyRoles.filter((role) => ["headline", "value-proposition", "differentiators", "primary-cta"].includes(role))),
    mediaRoles: Object.freeze(mediaRoles.filter((role) => ["hero-media", "cinematic-sequence"].includes(role))),
  }];

  const definitions = [
    { key: "explore", path: "/explore", navLabel: l.explore, copy: ["offer-and-pricing", "subscription-value", "differentiators"], media: ["documentary-context"] },
    { key: "proof", path: "/proof", navLabel: l.proof, copy: ["proof", "credentials-and-proof"], media: ["proof-media", "documentary-context"] },
    { key: "visit", path: "/visit", navLabel: l.visit, copy: ["location-and-hours"], media: ["documentary-context"] },
    { key: "contact", path: "/contact", navLabel: l.contact, copy: ["qualification-and-contact", "booking-details", "primary-cta"], media: [] },
  ] as const;

  for (const definition of definitions) {
    const capabilities = groups[definition.key] ?? [];
    const routeCopy = copyRoles.filter((role) => definition.copy.includes(role as never));
    const routeMedia = mediaRoles.filter((role) => definition.media.includes(role as never));
    if (!capabilities.length && !routeCopy.length && !routeMedia.length) continue;
    routes.push({
      path: definition.path,
      navLabel: definition.navLabel,
      purpose: input.plan.narrativeSequence.find((stage) => stage.capabilityIds.some((id) => capabilities.includes(id)))?.purpose ?? `Present ${definition.key} information supported by project evidence.`,
      capabilityIds: Object.freeze([...capabilities]),
      copyRoles: Object.freeze(routeCopy),
      mediaRoles: Object.freeze(routeMedia),
    });
  }

  if (routes.length === 1) {
    const secondary = input.plan.narrativeSequence[1];
    routes.push({ path: "/details", navLabel: l.details, purpose: secondary?.purpose ?? "Provide additional project detail.", capabilityIds: Object.freeze(secondary?.capabilityIds ?? []), copyRoles: Object.freeze(copyRoles.filter((role) => !routes[0]!.copyRoles.includes(role))), mediaRoles: Object.freeze(mediaRoles.filter((role) => !routes[0]!.mediaRoles.includes(role))) });
  }
  return Object.freeze(routes.map((route) => Object.freeze(route)));
}

function routeModel(route: GeneratedRoute, copy: readonly GeneratedCopyInput[], media: readonly GeneratedMediaInput[], actions: readonly GeneratedActionInput[]) {
  const capabilitySet = new Set(route.capabilityIds);
  return {
    ...route,
    copy: copy.filter((item) => route.copyRoles.includes(item.role)),
    media: media.filter((item) => route.mediaRoles.includes(item.role)),
    actions: actions.filter((item) => capabilitySet.has(item.capabilityId) || (route.path === "/" && item.emphasis === "primary")),
  };
}

function generatedCss(dna: ExperienceDNA): string {
  const asymmetry = dna.composition.asymmetry.value;
  const boundaries = dna.geometry.boundaryVisibility.value;
  const editorial = dna.editoriality.value;
  const persistence = dna.navigation.persistence.value;
  const mediaDominance = dna.media.dominance.value;
  const expressive = dna.typography.expressiveType.value;
  const primarySpan = Math.round(6 + asymmetry * 2);
  const mediaSpan = Math.max(4, 12 - primarySpan);
  const borderAlpha = Number((0.08 + boundaries * 0.16).toFixed(3));
  const mediaRatio = mediaDominance >= 0.7 ? "4 / 5" : mediaDominance >= 0.45 ? "4 / 3" : "16 / 10";
  const bodyFamily = expressive >= 0.62 || editorial >= 0.68 ? 'ui-serif, Georgia, Cambria, "Times New Roman", serif' : 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  return `
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--nexus-surface-0);color:var(--nexus-text-strong);font-family:${bodyFamily};line-height:1.55}a{color:inherit}img{display:block;max-width:100%}.skip{position:absolute;left:-9999px;top:0}.skip:focus{left:var(--nexus-space-3);top:var(--nexus-space-3);z-index:100;background:var(--nexus-surface-0);padding:var(--nexus-space-2)}.siteHeader{${persistence >= 0.55 ? "position:sticky;top:0;" : ""}z-index:30;backdrop-filter:blur(18px);background:color-mix(in oklch,var(--nexus-surface-0) 88%,transparent);border-bottom:1px solid color-mix(in oklch,var(--nexus-text-strong) ${Math.round(borderAlpha * 100)}%,transparent)}.nav{width:min(calc(100% - 2rem),var(--nexus-container-wide));margin:auto;min-height:4.75rem;display:flex;align-items:center;justify-content:space-between;gap:var(--nexus-space-4)}.brand{text-decoration:none;font-weight:650;letter-spacing:-.025em}.navLinks{display:flex;flex-wrap:wrap;gap:var(--nexus-space-3);align-items:center}.navLinks a{text-decoration:none;font-size:.92rem}.page{width:min(calc(100% - 2rem),var(--nexus-container-wide));margin:auto;padding:clamp(4rem,8vw,8.5rem) 0}.opening{max-width:var(--nexus-container-narrow);padding-bottom:clamp(3rem,7vw,7rem)}.eyebrow{font-size:.78rem;text-transform:uppercase;letter-spacing:.16em;color:var(--nexus-text-muted)}h1{font-size:clamp(var(--nexus-type-step-4),7vw,var(--nexus-type-step-5));line-height:.94;letter-spacing:-.055em;margin:.35em 0}.lede{font-size:clamp(1.1rem,2vw,var(--nexus-type-step-2));color:var(--nexus-text-muted);max-width:48rem}.actions{display:flex;flex-wrap:wrap;gap:var(--nexus-space-2);margin-top:var(--nexus-space-5)}.action{display:inline-flex;min-height:3rem;align-items:center;padding:.75rem 1.15rem;border:1px solid color-mix(in oklch,var(--nexus-text-strong) 18%,transparent);border-radius:var(--nexus-radius-sm);text-decoration:none}.action[data-emphasis="primary"]{background:var(--nexus-text-strong);color:var(--nexus-surface-0)}.sections{display:grid;gap:clamp(4rem,8vw,9rem)}.section{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:clamp(1.25rem,4vw,4rem);align-items:start;padding-top:clamp(2rem,4vw,4rem);border-top:1px solid color-mix(in oklch,var(--nexus-text-strong) ${Math.round(borderAlpha * 100)}%,transparent)}.copyBlock{grid-column:span ${primarySpan};max-width:48rem}.copyBlock h2{font-size:clamp(var(--nexus-type-step-2),4vw,var(--nexus-type-step-4));line-height:1.02;letter-spacing:-.04em;margin:0 0 .6em}.copyBlock p{white-space:pre-line;color:var(--nexus-text-muted);font-size:1.03rem}.mediaBlock{grid-column:span ${mediaSpan};margin:0}.mediaBlock img{width:100%;aspect-ratio:${mediaRatio};object-fit:cover;border-radius:var(--nexus-radius-md)}.mediaBlock figcaption{margin-top:.65rem;color:var(--nexus-text-muted);font-size:.78rem}.footer{width:min(calc(100% - 2rem),var(--nexus-container-wide));margin:auto;padding:3rem 0 4rem;border-top:1px solid color-mix(in oklch,var(--nexus-text-strong) ${Math.round(borderAlpha * 100)}%,transparent);color:var(--nexus-text-muted);font-size:.85rem}@media(max-width:768px){.nav{align-items:flex-start;padding:1rem 0}.navLinks{justify-content:flex-end}.page{padding-top:4.5rem}.section{grid-template-columns:1fr}.copyBlock,.mediaBlock{grid-column:1}.opening{padding-bottom:3.5rem}h1{font-size:clamp(3rem,15vw,5.5rem)}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`.trim();
}

function componentSource(locale: string): string {
  const l = labels(locale);
  return `"use client";\nimport Link from "next/link";\nimport { usePathname } from "next/navigation";\nimport { site } from "./site-data";\n\nexport function SiteNav(){const pathname=usePathname();return <header className="siteHeader"><nav className="nav" aria-label="${l.menu}"><Link className="brand" href="/">{site.brand}</Link><div className="navLinks">{site.routes.map((route)=><Link key={route.path} href={route.path} aria-current={pathname===route.path?"page":undefined}>{route.navLabel}</Link>)}</div></nav></header>}\n\nexport function ExperiencePage({routePath}:{routePath:string}){const route=site.routeContent.find((item)=>item.path===routePath)??site.routeContent[0];if(!route)return null;const headline=route.copy.find((item)=>item.role==="headline")??site.copy.find((item)=>item.role==="headline");const lede=route.copy.find((item)=>item.role==="value-proposition")??site.copy.find((item)=>item.role==="value-proposition");const body=route.copy.filter((item)=>!["headline","value-proposition","primary-cta"].includes(item.role));return <><a className="skip" href="#main">${l.skip}</a><SiteNav/><main id="main" className="page"><div className="opening"><div className="eyebrow">{route.navLabel}</div>{headline&&<h1>{headline.text}</h1>}{lede&&<p className="lede">{lede.text}</p>}<div className="actions">{route.actions.map((action)=><a className="action" data-emphasis={action.emphasis??"secondary"} key={action.href} href={action.href}>{action.label}</a>)}</div></div><div className="sections">{body.map((item,index)=><section className="section" key={item.role}><div className="copyBlock"><div className="eyebrow">{item.role.replaceAll("-"," ")}</div><h2>{item.text.split(/[.!?]/)[0]}</h2><p>{item.text}</p></div>{route.media[index]&&<figure className="mediaBlock"><img src={route.media[index].publicPath} alt={route.media[index].alt}/></figure>}</section>)}{route.media.slice(body.length).map((media)=><section className="section" key={media.assetId}><div className="copyBlock"><div className="eyebrow">{media.role.replaceAll("-"," ")}</div></div><figure className="mediaBlock"><img src={media.publicPath} alt={media.alt}/></figure></section>)}</div></main><footer className="footer">{site.brand}</footer></>}\n`;
}

export function emitMultipageNextApp(input: {
  projectId: string;
  locale: string;
  brief: ExperienceBrief;
  dna: ExperienceDNA;
  plan: ExperiencePlan;
  contentConstraints: DnaContentConstraints;
  tokenCss: string;
  copy: readonly GeneratedCopyInput[];
  media: readonly GeneratedMediaInput[];
  actions: readonly GeneratedActionInput[];
}): MultipageGenerationResult {
  if (!input.projectId.trim()) throw new Error("multipage generation requires projectId");
  if (!input.locale.trim()) throw new Error("multipage generation requires locale");
  assertInputs(input);
  const routes = deriveRoutes({ plan: input.plan, copy: input.copy, media: input.media, locale: input.locale });
  if (routes.length < 2) throw new Error("multipage generation must produce at least two routes");

  const routeContent = routes.map((route) => routeModel(route, input.copy, input.media, input.actions));
  const siteData = { projectId: input.projectId, brand: input.brief.brand.name, routes: routes.map(({ path, navLabel }) => ({ path, navLabel })), routeContent, copy: input.copy, media: input.media, dnaSubject: input.dna.subject, recipeId: input.plan.recipeId };
  const provenanceIds = [...new Set([
    ...input.copy.map((item) => item.sourceId),
    ...input.media.map((item) => item.sourceDigest),
    ...input.actions.map((item) => item.sourceId),
    ...input.brief.constraints.map((constraint) => `constraint:${constraint.id}`),
  ])].sort((a, b) => a.localeCompare(b, "en"));

  const files: Array<{ path: string; content: string; provenanceIds: readonly string[] }> = [
    { path: "src/app/site-data.ts", content: `export const site = ${escapeJson(siteData)} as const;\n`, provenanceIds },
    { path: "src/app/generated.css", content: `${input.tokenCss.trim()}\n${generatedCss(input.dna)}\n`, provenanceIds },
    { path: "src/app/ExperiencePage.tsx", content: componentSource(input.locale), provenanceIds },
    { path: "src/app/layout.tsx", content: `import type { Metadata } from "next";\nimport "./generated.css";\nexport const metadata: Metadata = { title: ${JSON.stringify(input.brief.brand.name)}, description: ${JSON.stringify(input.brief.brand.positioning)} };\nexport default function RootLayout({children}:{children:React.ReactNode}){return <html lang=${JSON.stringify(input.locale.split("-")[0] || "en")}><body>{children}</body></html>}\n`, provenanceIds },
    { path: "src/app/page.tsx", content: `import { ExperiencePage } from "./ExperiencePage";\nexport default function Page(){return <ExperiencePage routePath="/"/>}\n`, provenanceIds },
  ];

  for (const route of routes.filter((route) => route.path !== "/")) {
    const segment = slug(route.path);
    if (!segment) throw new Error(`invalid generated route ${route.path}`);
    files.push({ path: `src/app/${segment}/page.tsx`, content: `import { ExperiencePage } from "../ExperiencePage";\nexport default function Page(){return <ExperiencePage routePath=${JSON.stringify(route.path)}/>}\n`, provenanceIds });
  }

  const generatedFiles: GeneratedSourceFile[] = files.map((file) => Object.freeze({ path: file.path, content: file.content, digest: sha256(file.content), provenanceIds: Object.freeze([...file.provenanceIds]) }));
  const generationDigest = sha256(JSON.stringify(generatedFiles.map(({ path, digest }) => ({ path, digest }))));
  return Object.freeze({ authority: "NEXUS_MULTIPAGE_GENERATOR_V1", projectId: input.projectId, routes, files: Object.freeze(generatedFiles), provenanceIds: Object.freeze(provenanceIds), generationDigest });
}
