import { createHash } from "node:crypto";
import type { EngineConstraint } from "@nexus/experience/shared";
import type { GeneratedSourceFile, MultipageGenerationResult } from "./multipage";

export interface EvidenceBoundLocation {
  address: string;
  sourceId: string;
}

export interface EvidenceBoundReview {
  text: string;
  sourceId: string;
  provider: "GOOGLE_MAPS";
  author?: string;
  rating?: number;
}

export interface ExperienceFeatureInput {
  generation: MultipageGenerationResult;
  locale: string;
  constraints: readonly (EngineConstraint | string)[];
  location?: EvidenceBoundLocation;
  reviews?: readonly EvidenceBoundReview[];
  minimumReviewItems?: number;
}

const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const normalize = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const escaped = (value: unknown): string => JSON.stringify(value, null, 2).replace(/<\//g, "<\\/");

function validateLocation(location: EvidenceBoundLocation | undefined): EvidenceBoundLocation | undefined {
  if (!location) return undefined;
  const address = location.address.trim();
  const sourceId = location.sourceId.trim();
  if (!address || !sourceId) throw new Error("map/location feature requires evidence-bound address and sourceId");
  return Object.freeze({ address, sourceId });
}

function validateReviews(reviews: readonly EvidenceBoundReview[], minimumReviewItems: number): readonly EvidenceBoundReview[] {
  if (!Number.isInteger(minimumReviewItems) || minimumReviewItems < 0) throw new Error("minimumReviewItems must be a non-negative integer");
  const normalized = reviews.map((review, index) => {
    const text = review.text.trim();
    const sourceId = review.sourceId.trim();
    if (!text || !sourceId || review.provider !== "GOOGLE_MAPS") throw new Error(`review ${index + 1} must contain exact text, sourceId and GOOGLE_MAPS provider provenance`);
    if (review.rating !== undefined && (!Number.isFinite(review.rating) || review.rating < 0 || review.rating > 5)) throw new Error(`review ${index + 1} rating must be in [0,5]`);
    return Object.freeze({ ...review, text, sourceId, author: review.author?.trim() || undefined });
  });
  if (normalized.length < minimumReviewItems) throw new Error(`review evidence requirement needs at least ${minimumReviewItems} Google Maps review item(s), but only ${normalized.length} were supplied`);
  if (new Set(normalized.map((review) => review.sourceId)).size !== normalized.length) throw new Error("Google Maps review sourceIds must be unique per evidence item");
  return Object.freeze(normalized);
}

function greenCapabilities(constraints: readonly (EngineConstraint | string)[]): readonly string[] {
  const statements = constraints.map((constraint) => typeof constraint === "string" ? constraint : constraint.statement);
  const capabilities = new Set<string>();
  for (const statement of statements) {
    const text = normalize(statement);
    if (text.includes("whatsapp") && /\b(green|verde)\b/.test(text)) capabilities.add("whatsapp");
  }
  return Object.freeze([...capabilities].sort((a, b) => a.localeCompare(b, "en")));
}

function featureCss(): string {
  return `
.action[data-semantic-tone="green"]{background:oklch(62% .16 145);border-color:oklch(62% .16 145);color:white}.mapWrap{grid-column:1/-1;margin:0}.mapFrame{display:block;width:100%;min-height:420px;border:0;border-radius:var(--nexus-radius-md);background:var(--nexus-surface-1)}.reviewsGrid{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr));gap:var(--nexus-space-3)}.reviewCard{border:1px solid color-mix(in oklch,var(--nexus-text-strong) 12%,transparent);border-radius:var(--nexus-radius-md);padding:clamp(1.1rem,2.5vw,1.8rem);background:var(--nexus-surface-1)}.reviewMeta{font-size:.78rem;color:var(--nexus-text-muted);margin-top:var(--nexus-space-2)}@media(max-width:768px){.mapFrame{min-height:340px}}
`.trim();
}

function featureComponentSource(locale: string): string {
  const es = locale.toLowerCase().startsWith("es");
  const menu = es ? "Menú" : "Menu";
  const reviewsLabel = es ? "Reseñas verificadas en Google Maps" : "Verified Google Maps reviews";
  const mapLabel = es ? "Mapa de ubicación" : "Location map";
  return `"use client";\nimport Link from "next/link";\nimport { usePathname } from "next/navigation";\nimport { site } from "./site-data";\nimport { features } from "./features-data";\n\nexport function SiteNav(){const pathname=usePathname();return <header className="siteHeader"><nav className="nav" aria-label=${JSON.stringify(menu)}><Link className="brand" href="/">{site.brand}</Link><div className="navLinks">{site.routes.map((route)=><Link key={route.path} href={route.path} aria-current={pathname===route.path?"page":undefined}>{route.navLabel}</Link>)}</div></nav></header>}\n\nexport function SiteFooter(){return <footer className="footer">{site.brand}</footer>}\n\nexport function ExperiencePage({routePath}:{routePath:string}){const route=site.routeContent.find((item)=>item.path===routePath)??site.routeContent[0];if(!route)return null;const lede=route.copy.find((item)=>item.role==="value-proposition")??site.copy.find((item)=>item.role==="value-proposition");const body=route.copy.filter((item)=>!["headline","value-proposition","primary-cta"].includes(item.role));const showMap=Boolean(features.location&&(route.path==="/visit"||route.capabilityIds.includes("map")||route.capabilityIds.includes("location")));const showReviews=features.reviews.length>0&&(route.path==="/proof"||route.capabilityIds.includes("reviews")||route.capabilityIds.includes("social-proof"));return <><div className="opening"><div className="eyebrow">{route.navLabel}</div>{lede&&<p className="lede">{lede.text}</p>}<div className="actions">{route.actions.map((action)=>{const tone=features.greenCapabilities.includes(action.capabilityId)?"green":undefined;return <a className="action" data-semantic-tone={tone} data-emphasis={action.emphasis??"secondary"} data-capability={action.capabilityId} key={action.href} href={action.href}>{action.label}</a>})}</div></div><div className="sections">{body.map((item,index)=><section className="section" key={item.role}><div className="copyBlock"><div className="eyebrow">{item.role.replaceAll("-"," ")}</div><h2>{item.text.split(/[.!?]/)[0]}</h2><p>{item.text}</p></div>{route.media[index]&&<figure className="mediaBlock"><img src={route.media[index].publicPath} alt={route.media[index].alt}/></figure>}</section>)}{route.media.slice(body.length).map((media)=><section className="section" key={media.assetId}><div className="copyBlock"><div className="eyebrow">{media.role.replaceAll("-"," ")}</div></div><figure className="mediaBlock"><img src={media.publicPath} alt={media.alt}/></figure></section>)}{showMap&&features.location&&<section className="section" aria-label=${JSON.stringify(mapLabel)}><div className="mapWrap"><iframe className="mapFrame" title=${JSON.stringify(mapLabel)} loading="lazy" referrerPolicy="no-referrer-when-downgrade" src={features.location.embedUrl}/></div></section>}{showReviews&&<section className="section" aria-label=${JSON.stringify(reviewsLabel)}><div className="copyBlock"><div className="eyebrow">${reviewsLabel}</div></div><div className="reviewsGrid">{features.reviews.map((review)=><article className="reviewCard" key={review.sourceId}><p>{review.text}</p><div className="reviewMeta">{review.author??"Google Maps"}{review.rating!==undefined?\` · \${review.rating}/5\`:""}</div></article>)}</div></section>}</div></>}\n`;
}

export function augmentExperienceFeatures(input: ExperienceFeatureInput): MultipageGenerationResult {
  const location = validateLocation(input.location);
  const reviews = validateReviews(input.reviews ?? [], input.minimumReviewItems ?? 0);
  const greens = greenCapabilities(input.constraints);
  const featureData = Object.freeze({
    location: location ? Object.freeze({ ...location, embedUrl: `https://www.google.com/maps?q=${encodeURIComponent(location.address)}&output=embed` }) : null,
    reviews,
    greenCapabilities: greens,
  });
  const featureProvenance = [
    ...(location ? [location.sourceId] : []),
    ...reviews.map((review) => review.sourceId),
    ...greens.map((capability) => `constraint:semantic-color:${capability}`),
  ];

  const files = input.generation.files.map((file) => {
    if (file.path === "src/app/ExperiencePage.tsx") {
      const content = featureComponentSource(input.locale);
      return Object.freeze({ ...file, content, digest: sha256(content), provenanceIds: Object.freeze([...new Set([...file.provenanceIds, ...featureProvenance])]) });
    }
    if (file.path === "src/app/generated.css") {
      const content = `${file.content.trim()}\n${featureCss()}\n`;
      return Object.freeze({ ...file, content, digest: sha256(content), provenanceIds: Object.freeze([...new Set([...file.provenanceIds, ...featureProvenance])]) });
    }
    return file;
  });
  const featureContent = `import type { Features } from "./generated-types";\nexport const features: Features = ${escaped(featureData)};\n`;
  const featureFile: GeneratedSourceFile = Object.freeze({ path: "src/app/features-data.ts", content: featureContent, digest: sha256(featureContent), provenanceIds: Object.freeze(featureProvenance) });
  const withFeatures = Object.freeze([...files, featureFile]);
  const provenanceIds = Object.freeze([...new Set([...input.generation.provenanceIds, ...featureProvenance])].sort((a, b) => a.localeCompare(b, "en")));
  const generationDigest = sha256(JSON.stringify(withFeatures.map(({ path, digest }) => ({ path, digest }))));
  return Object.freeze({ ...input.generation, files: withFeatures, provenanceIds, generationDigest });
}
