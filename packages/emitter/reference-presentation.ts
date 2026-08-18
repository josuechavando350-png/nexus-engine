import { createHash } from "node:crypto";
import type { ExperienceDNA } from "@nexus/experience/dna";

export type ReferenceSurface = "TECHNOLOGY_SEQUENCE" | "HERO_BRAND";
export type ReferenceLabelPlacement = "BELOW" | "OVERLAY";
export type ReferenceArrowPolicy = "FORBID" | "ALLOW";
export type ReferenceOrdinalPolicy = "FORBID" | "ALLOW";

export interface ReferencePresentationObservation {
  id: string;
  sourceId: string;
  surface: ReferenceSurface;
  horizontalSequence?: boolean;
  centeredFocus?: boolean;
  adjacentPeek?: boolean;
  labelPlacement?: ReferenceLabelPlacement;
  activeItemViewportRatio?: number;
  arrowControlsObserved?: boolean;
  counterObserved?: boolean;
}

export interface ReferencePresentationOverrides {
  arrowControls?: ReferenceArrowPolicy;
  ordinalLabels?: ReferenceOrdinalPolicy;
  preserveUnlistedSurfaces?: boolean;
  requireHeroLogoMotion?: boolean;
  heroMotionEvidenceIds?: readonly string[];
}

export interface ReferencePresentationPlan {
  authority: "NEXUS_REFERENCE_PRESENTATION_V1";
  referenceId: string;
  rail: Readonly<{
    mode: "FOCUS_RAIL";
    activeItemViewportRatio: number;
    adjacentPeek: true;
    labelPlacement: "BELOW";
    controls: "NONE" | "ARROWS";
    counter: boolean;
    interaction: "SCROLL_SNAP_SWIPE";
    evidenceIds: readonly string[];
  }>;
  heroMotion: Readonly<{
    enabled: boolean;
    primitive: "NONE" | "TRACE_GLINT" | "MASK_REVEAL" | "FADE_FOCUS";
    durationMs: number;
    reducedMotionFallback: true;
    evidenceIds: readonly string[];
  }>;
  freezePolicy: Readonly<{ preserveUnlistedSurfaces: boolean }>;
  digest: `sha256:${string}`;
}

export interface ReferencePresentationCssArtifact {
  authority: "NEXUS_REFERENCE_PRESENTATION_EMITTER_V1";
  css: string;
  digest: `sha256:${string}`;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function assertEvidence(observation: ReferencePresentationObservation): void {
  if (!observation.id.trim() || !observation.sourceId.trim()) throw new Error("reference observation requires id and sourceId");
  if (observation.activeItemViewportRatio !== undefined && (!Number.isFinite(observation.activeItemViewportRatio) || observation.activeItemViewportRatio < 0.35 || observation.activeItemViewportRatio > 0.9)) {
    throw new Error("activeItemViewportRatio must be within [0.35,0.9]");
  }
}

export function deriveReferencePresentationPlan(input: {
  referenceId: string;
  dna?: ExperienceDNA;
  observations: readonly ReferencePresentationObservation[];
  userOverrides?: ReferencePresentationOverrides;
}): ReferencePresentationPlan {
  if (!input.referenceId.trim()) throw new Error("referenceId is required");
  if (!input.observations.length) throw new Error("reference observations are required");
  input.observations.forEach(assertEvidence);

  const technology = input.observations.filter((observation) => observation.surface === "TECHNOLOGY_SEQUENCE");
  const horizontal = technology.some((observation) => observation.horizontalSequence === true);
  const centered = technology.some((observation) => observation.centeredFocus === true);
  const peek = technology.some((observation) => observation.adjacentPeek === true);
  const labelBelow = technology.some((observation) => observation.labelPlacement === "BELOW");
  const ratios = technology
    .map((observation) => observation.activeItemViewportRatio)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!(horizontal && centered && peek && labelBelow && ratios.length)) {
    throw new Error("INSUFFICIENT_REFERENCE_EVIDENCE: focus rail requires horizontal, centered, adjacent-peek, below-label and measured active ratio evidence");
  }

  const activeItemViewportRatio = ratios[Math.floor(ratios.length / 2)]!;
  const overrides = input.userOverrides ?? {};
  const controls: "NONE" | "ARROWS" = overrides.arrowControls === "FORBID"
    ? "NONE"
    : technology.some((observation) => observation.arrowControlsObserved === true)
      ? "ARROWS"
      : "NONE";
  const counter = overrides.ordinalLabels === "FORBID"
    ? false
    : technology.some((observation) => observation.counterObserved === true);

  const requireHeroMotion = overrides.requireHeroLogoMotion === true;
  if (requireHeroMotion && !input.dna) throw new Error("hero logo motion requires ExperienceDNA");

  let heroMotion: ReferencePresentationPlan["heroMotion"] = Object.freeze({
    enabled: false,
    primitive: "NONE",
    durationMs: 0,
    reducedMotionFallback: true,
    evidenceIds: Object.freeze([]),
  });

  if (requireHeroMotion && input.dna) {
    const cinematicity = input.dna.cinematicity.value;
    const continuity = input.dna.motion.continuity.value;
    const spatiality = input.dna.interaction.spatiality.value;
    const primitive = cinematicity >= 0.67 || continuity >= 0.72
      ? "TRACE_GLINT" as const
      : spatiality >= 0.6
        ? "MASK_REVEAL" as const
        : "FADE_FOCUS" as const;
    const durationMs = Math.round(clamp(900 + continuity * 500, 900, 1400));
    const evidenceIds = Object.freeze([
      ...new Set([
        ...(overrides.heroMotionEvidenceIds ?? []),
        ...input.observations.filter((observation) => observation.surface === "HERO_BRAND").map((observation) => observation.id),
      ]),
    ]);
    heroMotion = Object.freeze({ enabled: true, primitive, durationMs, reducedMotionFallback: true, evidenceIds });
  }

  const core = Object.freeze({
    authority: "NEXUS_REFERENCE_PRESENTATION_V1" as const,
    referenceId: input.referenceId.trim(),
    rail: Object.freeze({
      mode: "FOCUS_RAIL" as const,
      activeItemViewportRatio: round(activeItemViewportRatio, 3),
      adjacentPeek: true as const,
      labelPlacement: "BELOW" as const,
      controls,
      counter,
      interaction: "SCROLL_SNAP_SWIPE" as const,
      evidenceIds: Object.freeze([...new Set(technology.flatMap((observation) => [observation.id, observation.sourceId]))]),
    }),
    heroMotion,
    freezePolicy: Object.freeze({ preserveUnlistedSurfaces: overrides.preserveUnlistedSurfaces !== false }),
  });

  return Object.freeze({ ...core, digest: sha256(JSON.stringify(core)) });
}

export function emitReferencePresentationCss(plan: ReferencePresentationPlan, dna: ExperienceDNA): ReferencePresentationCssArtifact {
  if (plan.authority !== "NEXUS_REFERENCE_PRESENTATION_V1") throw new Error("unsupported reference presentation authority");
  const ratio = Math.round(plan.rail.activeItemViewportRatio * 1000) / 10;
  const gapRem = round(0.65 + (1 - dna.density.compression.value) * 0.95, 2);
  const maxWidthPx = Math.round(560 + dna.media.dominance.value * 220);
  const logoScale = round(0.94 + dna.cinematicity.value * 0.04, 3);
  const motionDistance = round(10 + dna.interaction.spatiality.value * 18, 1);
  const duration = plan.heroMotion.durationMs || 1100;

  const css = `
.service-index{display:none!important}
.nexusReferenceRail{display:flex;gap:${gapRem}rem;overflow-x:auto;overscroll-behavior-inline:contain;scroll-snap-type:x mandatory;scroll-padding-inline:calc((100vw - min(${ratio}vw,${maxWidthPx}px))/2);padding-inline:calc((100vw - min(${ratio}vw,${maxWidthPx}px))/2);padding-block:clamp(2rem,5vw,5rem);margin-inline:calc(50% - 50vw);scrollbar-width:none;-webkit-overflow-scrolling:touch}
.nexusReferenceRail::-webkit-scrollbar{display:none}
.nexusReferenceRailItem{flex:0 0 min(${ratio}vw,${maxWidthPx}px);scroll-snap-align:center;scroll-snap-stop:always;margin:0;text-align:center}
.nexusReferenceRailMedia{display:grid;place-items:center;width:100%;aspect-ratio:4/5;overflow:hidden;background:#000;border-radius:var(--radius-md)}
.nexusReferenceRailMedia img{width:100%;height:100%;object-fit:contain}
.nexusReferenceRailLabel{display:block;margin-top:clamp(1.1rem,2.4vw,2rem);font-family:Georgia,"Times New Roman",serif;font-size:clamp(2rem,5.6vw,5.2rem);line-height:.92;letter-spacing:-.055em;color:var(--ink)}
.nexusBrandMotion{grid-column:4/13;min-height:650px;display:grid;place-items:center;position:relative;overflow:hidden;isolation:isolate}
.nexusBrandMotionInner{width:min(78%,900px);display:grid;place-items:center;position:relative}
.nexusBrandMotionLogo{width:100%;height:auto;transform:translateY(${motionDistance}px) scale(${logoScale});opacity:0;filter:blur(10px);animation:nexus-brand-logo ${duration}ms var(--ease) both}
.nexusBrandMotionGlint{position:absolute;inset:-15%;pointer-events:none;background:linear-gradient(110deg,transparent 35%,rgba(212,175,55,0) 42%,rgba(212,175,55,.72) 50%,rgba(212,175,55,0) 58%,transparent 65%);mix-blend-mode:screen;transform:translateX(-120%);animation:nexus-brand-glint ${Math.round(duration * 1.35)}ms var(--ease) ${Math.round(duration * 0.18)}ms both}
.nexusBrandMotionTagline{margin-top:clamp(1.2rem,2.5vw,2rem);font-size:.68rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);opacity:0;animation:nexus-brand-tag ${Math.round(duration * 0.72)}ms var(--ease) ${Math.round(duration * 0.32)}ms both}
@keyframes nexus-brand-logo{0%{opacity:0;filter:blur(10px);transform:translateY(${motionDistance}px) scale(${logoScale})}58%{opacity:1}100%{opacity:1;filter:blur(0);transform:none}}
@keyframes nexus-brand-glint{0%{opacity:0;transform:translateX(-120%)}18%{opacity:1}82%{opacity:1}100%{opacity:0;transform:translateX(120%)}}
@keyframes nexus-brand-tag{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(max-width:960px){.nexusBrandMotion{order:1;width:100%;min-height:68svh;grid-column:auto}.nexusBrandMotionInner{width:min(88%,700px)}}
@media(max-width:560px){.nexusBrandMotion{min-height:62svh}.nexusBrandMotionInner{width:94%}.nexusReferenceRailLabel{font-size:clamp(2.2rem,11vw,4.2rem)}}
@media(prefers-reduced-motion:reduce){.nexusBrandMotionLogo,.nexusBrandMotionGlint,.nexusBrandMotionTagline{animation:none!important;opacity:1!important;transform:none!important;filter:none!important}.nexusBrandMotionGlint{display:none}.nexusReferenceRail{scroll-behavior:auto}}
`.trim();

  if (plan.rail.controls === "NONE" && /\b(prev|next|arrow)\b/i.test(css)) throw new Error("forbidden arrow controls leaked into emitted CSS");
  return Object.freeze({ authority: "NEXUS_REFERENCE_PRESENTATION_EMITTER_V1", css, digest: sha256(css) });
}

export function renderHeroBrandMotionJsx(input: { logoSrc: string; alt: string; tagline: string }): string {
  if (!input.logoSrc.startsWith("/")) throw new Error("logoSrc must be a rooted public path");
  if (!input.alt.trim() || !input.tagline.trim()) throw new Error("hero brand motion requires alt and tagline");
  const logo = JSON.stringify(input.logoSrc);
  const alt = JSON.stringify(input.alt);
  return `<div className="nexusBrandMotion" aria-label=${alt}><div className="nexusBrandMotionInner"><img className="nexusBrandMotionLogo" src=${logo} alt=${alt} /><i className="nexusBrandMotionGlint" aria-hidden="true" /><p className="nexusBrandMotionTagline">${input.tagline}</p></div></div>`;
}

export function renderTechnologyRailJsx(): string {
  return `<div className="nexusReferenceRail" aria-label="Tecnología de Zona Dental Polanco">{technology.map((item) => (<figure className="nexusReferenceRailItem" key={item.id}><div className="nexusReferenceRailMedia"><img src={item.src} alt={item.alt} /></div><figcaption className="nexusReferenceRailLabel">{item.label}</figcaption></figure>))}</div>`;
}
