import { createHash } from "node:crypto";
import type { ExperienceBrief } from "./brief";
import { resolveCapabilities, type CapabilityDefinition } from "./capabilities";
import { compileExperiencePlan, type ExperiencePlan } from "./compiler";
import { deriveDnaContentConstraints, toContentReadinessPolicy, type BusinessContentProfile, type DnaContentConstraints } from "./content-constraints";
import { defineExperienceDNA, direction, intent, type ExperienceDNA } from "./dna";
import { RECIPE_LIBRARY, type RecipeDefinition } from "./recipes";
import type { ContentReadinessPolicy } from "./content-readiness";

export type ExperienceEvidenceSignal = Readonly<{
  id: string;
  source: "brief" | "reference" | "constraint" | "asset";
  text: string;
}>;

export type AutonomousExperienceResult = Readonly<{
  authority: "NEXUS_AUTONOMOUS_EXPERIENCE_V1";
  evidence: readonly ExperienceEvidenceSignal[];
  dna: ExperienceDNA;
  recipe: RecipeDefinition;
  plan: ExperiencePlan;
  contentConstraints: DnaContentConstraints;
  readinessPolicy: ContentReadinessPolicy;
}>;

type SemanticAxis = Readonly<{
  positive: readonly string[];
  negative: readonly string[];
  label: string;
}>;

type ScoredIntent = Readonly<{
  value: number;
  evidenceIds: readonly string[];
  because: string;
}>;

const AXES = Object.freeze({
  asymmetry: { label: "spatial asymmetry", positive: ["asymmetric", "imbalance", "tension", "unexpected", "editorial", "expressive"], negative: ["symmetric", "uniform", "ordered", "systematic", "disciplined"] },
  gridDiscipline: { label: "grid discipline", positive: ["precise", "structured", "ordered", "systematic", "clarity", "professional", "disciplined"], negative: ["organic", "free", "fluid", "experimental", "unstructured"] },
  overlap: { label: "spatial layering", positive: ["layer", "immersive", "spatial", "cinematic", "overlap", "depth"], negative: ["flat", "minimal", "separate", "simple"] },
  continuity: { label: "continuity", positive: ["continuous", "flow", "journey", "immersive", "cinematic", "seamless"], negative: ["index", "modular", "comparison", "scan", "discrete"] },
  information: { label: "information density", positive: ["detail", "inform", "catalog", "technical", "compare", "information", "explain"], negative: ["minimal", "quiet", "atmosphere", "sparse"] },
  whitespace: { label: "whitespace", positive: ["minimal", "quiet", "calm", "refined", "luxury", "boutique", "spacious"], negative: ["dense", "compact", "information", "catalog", "busy"] },
  compression: { label: "content compression", positive: ["dense", "compact", "scan", "operational", "efficient"], negative: ["spacious", "calm", "quiet", "luxury", "boutique", "editorial"] },
  angularity: { label: "geometric angularity", positive: ["sharp", "precise", "architectural", "technical", "angular"], negative: ["soft", "organic", "gentle", "rounded"] },
  regularity: { label: "geometric regularity", positive: ["systematic", "consistent", "structured", "professional", "regular"], negative: ["expressive", "irregular", "experimental", "organic"] },
  boundaryVisibility: { label: "boundary visibility", positive: ["structured", "index", "system", "precise", "separate"], negative: ["seamless", "immersive", "continuous", "blended"] },
  scaleContrast: { label: "typographic scale contrast", positive: ["editorial", "expressive", "dramatic", "cinematic", "bold"], negative: ["quiet", "subtle", "systematic", "restrained"] },
  hierarchyRigidity: { label: "hierarchy rigidity", positive: ["clear", "precise", "professional", "structured", "direct"], negative: ["playful", "experimental", "fluid", "ambiguous"] },
  expressiveType: { label: "expressive typography", positive: ["editorial", "expressive", "distinctive", "boutique", "character"], negative: ["technical", "utilitarian", "neutral", "systematic"] },
  mediaDominance: { label: "media dominance", positive: ["photography", "visual", "immersive", "cinematic", "documentary", "gallery", "image"], negative: ["text-first", "data", "index", "utilitarian"] },
  mediaContinuity: { label: "media continuity", positive: ["sequence", "continuous", "story", "cinematic", "journey"], negative: ["single", "isolated", "index", "catalog"] },
  documentary: { label: "documentary media", positive: ["real", "documentary", "proof", "authentic", "photography", "evidence"], negative: ["abstract", "illustrative", "conceptual", "fictional"] },
  persistence: { label: "navigation persistence", positive: ["accessible", "direct", "utility", "always", "persistent", "contact"], negative: ["immersive", "hidden", "minimal navigation"] },
  visibility: { label: "navigation visibility", positive: ["clear", "direct", "accessible", "orientation", "utility"], negative: ["hidden", "discover", "experimental"] },
  discoverability: { label: "interaction discoverability", positive: ["clear", "accessible", "direct", "obvious", "guided"], negative: ["hidden", "experimental", "mysterious"] },
  directness: { label: "interaction directness", positive: ["direct", "book", "buy", "contact", "inquire", "visit", "efficient"], negative: ["explore", "immersive", "slow", "reflective"] },
  spatiality: { label: "interaction spatiality", positive: ["spatial", "immersive", "layer", "cinematic", "depth"], negative: ["linear", "index", "utilitarian"] },
  ctaProminence: { label: "CTA prominence", positive: ["book", "buy", "contact", "inquire", "reserve", "conversion", "direct"], negative: ["awareness", "editorial", "explore", "inform"] },
  ctaRepetition: { label: "CTA repetition", positive: ["persistent", "urgent", "conversion", "direct", "repeat"], negative: ["restrained", "quiet", "editorial", "minimal"] },
  motionIntensity: { label: "motion intensity", positive: ["motion", "dynamic", "cinematic", "energetic", "animated"], negative: ["calm", "quiet", "restrained", "reduced motion", "static"] },
  motionContinuity: { label: "motion continuity", positive: ["continuous", "flow", "cinematic", "seamless", "choreography"], negative: ["instant", "static", "discrete", "utilitarian"] },
  editoriality: { label: "editoriality", positive: ["editorial", "story", "narrative", "journal", "curated", "boutique"], negative: ["dashboard", "utility", "dense", "transactional"] },
  cinematicity: { label: "cinematicity", positive: ["cinematic", "immersive", "atmosphere", "dramatic", "sequence"], negative: ["utilitarian", "index", "static", "technical"] },
  ornamentation: { label: "ornamentation", positive: ["ornament", "decorative", "expressive", "luxury", "crafted"], negative: ["minimal", "restrained", "functional", "utilitarian", "quiet"] },
} satisfies Record<string, SemanticAxis>);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const normalize = (value: string): string => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

function containsTerm(text: string, term: string): boolean {
  return normalize(text).includes(normalize(term));
}

function collectEvidence(brief: ExperienceBrief): readonly ExperienceEvidenceSignal[] {
  const evidence: ExperienceEvidenceSignal[] = [
    { id: "brief:positioning", source: "brief", text: brief.brand.positioning },
    { id: "brief:commercial-goal", source: "brief", text: brief.commercialGoal },
    ...brief.brand.personality.map((text, index) => ({ id: `brief:personality:${index + 1}`, source: "brief" as const, text })),
    ...brief.priorities.map((text, index) => ({ id: `brief:priority:${index + 1}`, source: "brief" as const, text })),
    ...brief.constraints.map((constraint) => ({ id: `constraint:${constraint.id}`, source: "constraint" as const, text: constraint.statement })),
    ...brief.assets.map((asset) => ({ id: `asset:${asset.id}`, source: "asset" as const, text: `${asset.kind} ${asset.status} ${asset.notes ?? ""}`.trim() })),
  ];

  for (const reference of brief.references) {
    for (const [key, value] of Object.entries(reference.observations)) {
      if (typeof value === "string" && value.trim()) {
        evidence.push({ id: `reference:${reference.id}:${key}`, source: "reference", text: value.trim() });
      }
    }
    if (reference.notes?.trim()) evidence.push({ id: `reference:${reference.id}:notes`, source: "reference", text: reference.notes.trim() });
  }

  const seen = new Set<string>();
  return Object.freeze(evidence.filter((signal) => signal.text.trim() && !seen.has(signal.id) && seen.add(signal.id)).map((signal) => Object.freeze(signal)));
}

function scoreIntent(axis: SemanticAxis, evidence: readonly ExperienceEvidenceSignal[]): ScoredIntent {
  let positive = 0;
  let negative = 0;
  const matched: string[] = [];
  for (const signal of evidence) {
    const positiveHits = axis.positive.filter((term) => containsTerm(signal.text, term)).length;
    const negativeHits = axis.negative.filter((term) => containsTerm(signal.text, term)).length;
    if (positiveHits || negativeHits) matched.push(signal.id);
    positive += positiveHits;
    negative += negativeHits;
  }

  const directional = positive + negative;
  const value = directional === 0 ? 0.5 : clamp01(0.5 + (positive - negative) / (2 * Math.max(2, directional)));
  const evidenceIds = matched.length ? [...new Set(matched)] : evidence.slice(0, Math.min(3, evidence.length)).map((signal) => signal.id);
  const because = directional === 0
    ? `Project evidence contains no explicit semantic pull on ${axis.label}; NEXUS retains a neutral intent rather than inventing a style preference.`
    : `Project evidence contains ${positive} supporting and ${negative} opposing semantic signal(s) for ${axis.label}; NEXUS derives the intent from those supplied signals.`;
  return Object.freeze({ value: Number(value.toFixed(4)), evidenceIds: Object.freeze(evidenceIds), because });
}

function descriptor(label: string, because: string, evidenceIds: readonly string[]) {
  return direction(label, because, evidenceIds);
}

function vocabulary(evidence: readonly ExperienceEvidenceSignal[]): readonly string[] {
  const stop = new Set(["the", "and", "with", "from", "that", "this", "para", "con", "una", "uno", "por", "del", "las", "los", "que", "site", "website"]);
  const counts = new Map<string, number>();
  for (const signal of evidence) {
    for (const token of normalize(signal.text).match(/[a-z0-9-]{4,}/g) ?? []) {
      if (stop.has(token) || /^\d+$/.test(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return Object.freeze([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en")).slice(0, 12).map(([token]) => token));
}

export function synthesizeExperienceDNA(brief: ExperienceBrief): ExperienceDNA {
  const evidence = collectEvidence(brief);
  if (!evidence.length) throw new Error("Autonomous ExperienceDNA synthesis requires project evidence.");
  const s = (key: keyof typeof AXES) => scoreIntent(AXES[key], evidence);

  const asymmetry = s("asymmetry");
  const grid = s("gridDiscipline");
  const overlap = s("overlap");
  const continuity = s("continuity");
  const angularity = s("angularity");
  const expressive = s("expressiveType");
  const mediaDominance = s("mediaDominance");
  const documentary = s("documentary");
  const persistence = s("persistence");
  const directness = s("directness");
  const spatiality = s("spatiality");
  const ctaProminence = s("ctaProminence");
  const motionIntensity = s("motionIntensity");
  const motionContinuity = s("motionContinuity");

  const principles = [...new Set([...brief.brand.personality, ...brief.priorities])].filter((value) => value.trim());
  if (!principles.length) throw new Error("Autonomous ExperienceDNA synthesis requires at least one project principle.");

  return defineExperienceDNA({
    version: 2,
    subject: brief.brand.name,
    principles: [principles[0]!, ...principles.slice(1)],
    artDirectionVocabulary: vocabulary(evidence),
    composition: {
      asymmetry: intent(asymmetry.value, asymmetry.because, asymmetry.evidenceIds),
      gridDiscipline: intent(grid.value, grid.because, grid.evidenceIds),
      overlap: intent(overlap.value, overlap.because, overlap.evidenceIds),
      continuity: intent(continuity.value, continuity.because, continuity.evidenceIds),
      dominantFlow: descriptor(
        continuity.value >= 0.64 ? "continuous narrative progression" : asymmetry.value >= 0.62 ? "offset focal progression" : "measured sequential progression",
        "The dominant flow is selected from the evidence-derived continuity and asymmetry intents, not from an industry template.",
        [...new Set([...continuity.evidenceIds, ...asymmetry.evidenceIds])],
      ),
    },
    density: {
      information: (() => { const x = s("information"); return intent(x.value, x.because, x.evidenceIds); })(),
      whitespace: (() => { const x = s("whitespace"); return intent(x.value, x.because, x.evidenceIds); })(),
      compression: (() => { const x = s("compression"); return intent(x.value, x.because, x.evidenceIds); })(),
    },
    geometry: {
      angularity: intent(angularity.value, angularity.because, angularity.evidenceIds),
      regularity: (() => { const x = s("regularity"); return intent(x.value, x.because, x.evidenceIds); })(),
      boundaryVisibility: (() => { const x = s("boundaryVisibility"); return intent(x.value, x.because, x.evidenceIds); })(),
      dominantShape: descriptor(
        angularity.value >= 0.62 ? "precise directional geometry" : angularity.value <= 0.38 ? "soft continuous geometry" : "restrained neutral geometry",
        "Geometry follows the evidence-derived angularity intent without selecting a component shape.",
        angularity.evidenceIds,
      ),
    },
    typography: {
      scaleContrast: (() => { const x = s("scaleContrast"); return intent(x.value, x.because, x.evidenceIds); })(),
      hierarchyRigidity: (() => { const x = s("hierarchyRigidity"); return intent(x.value, x.because, x.evidenceIds); })(),
      expressiveType: intent(expressive.value, expressive.because, expressive.evidenceIds),
      voice: descriptor(
        expressive.value >= 0.62 ? "distinctive editorial voice" : expressive.value <= 0.38 ? "restrained utilitarian voice" : "controlled contemporary voice",
        "Typographic voice is derived from evidence about expression versus utility; font selection remains an emitter concern.",
        expressive.evidenceIds,
      ),
    },
    media: {
      dominance: intent(mediaDominance.value, mediaDominance.because, mediaDominance.evidenceIds),
      continuity: (() => { const x = s("mediaContinuity"); return intent(x.value, x.because, x.evidenceIds); })(),
      documentaryVsAbstract: intent(documentary.value, documentary.because, documentary.evidenceIds),
      role: descriptor(
        documentary.value >= 0.62 ? "documentary evidence carrier" : mediaDominance.value >= 0.62 ? "atmospheric narrative carrier" : "supporting contextual evidence",
        "Media role follows evidence-derived documentary and dominance intents and does not prescribe image placement.",
        [...new Set([...documentary.evidenceIds, ...mediaDominance.evidenceIds])],
      ),
    },
    navigation: {
      persistence: intent(persistence.value, persistence.because, persistence.evidenceIds),
      visibility: (() => { const x = s("visibility"); return intent(x.value, x.because, x.evidenceIds); })(),
      topology: descriptor(
        persistence.value >= 0.62 ? "persistent orientation network" : continuity.value >= 0.62 ? "narrative waypoint network" : "direct hierarchical network",
        "Navigation topology follows evidence-derived persistence and continuity without prescribing a navigation component.",
        [...new Set([...persistence.evidenceIds, ...continuity.evidenceIds])],
      ),
    },
    interaction: {
      discoverability: (() => { const x = s("discoverability"); return intent(x.value, x.because, x.evidenceIds); })(),
      directness: intent(directness.value, directness.because, directness.evidenceIds),
      spatiality: intent(spatiality.value, spatiality.because, spatiality.evidenceIds),
      language: descriptor(
        spatiality.value >= 0.62 ? "spatial reveal and progression" : directness.value >= 0.62 ? "immediate explicit response" : "measured progressive disclosure",
        "Interaction language is selected from evidence-derived directness and spatiality rather than a fixed interaction pattern.",
        [...new Set([...directness.evidenceIds, ...spatiality.evidenceIds])],
      ),
    },
    cta: {
      prominence: intent(ctaProminence.value, ctaProminence.because, ctaProminence.evidenceIds),
      repetition: (() => { const x = s("ctaRepetition"); return intent(x.value, x.because, x.evidenceIds); })(),
      grammar: descriptor(
        ctaProminence.value >= 0.62 ? "explicit outcome-led action" : "contextual restrained action",
        "CTA grammar follows the supplied commercial intent and evidence rather than a conversion template.",
        ctaProminence.evidenceIds,
      ),
    },
    motion: {
      intensity: intent(motionIntensity.value, motionIntensity.because, motionIntensity.evidenceIds),
      continuity: intent(motionContinuity.value, motionContinuity.because, motionContinuity.evidenceIds),
      choreography: descriptor(
        motionIntensity.value <= 0.38 ? "restrained state transitions" : motionContinuity.value >= 0.62 ? "continuous guided transitions" : "selective emphasis transitions",
        "Motion choreography follows evidence-derived intensity and continuity and remains subject to reduced-motion fallback.",
        [...new Set([...motionIntensity.evidenceIds, ...motionContinuity.evidenceIds])],
      ),
    },
    editoriality: (() => { const x = s("editoriality"); return intent(x.value, x.because, x.evidenceIds); })(),
    cinematicity: (() => { const x = s("cinematicity"); return intent(x.value, x.because, x.evidenceIds); })(),
    ornamentation: (() => { const x = s("ornamentation"); return intent(x.value, x.because, x.evidenceIds); })(),
  });
}

function recipeDistance(dna: ExperienceDNA, recipeId: string): number {
  switch (recipeId) {
    case "editorial-sequence": return Math.abs(1 - dna.editoriality.value) + Math.abs(0.8 - dna.density.whitespace.value) + Math.abs(0.35 - dna.density.compression.value);
    case "media-immersion": return Math.abs(1 - dna.media.dominance.value) + Math.abs(1 - dna.cinematicity.value) + Math.abs(1 - dna.composition.continuity.value);
    case "dense-index": return Math.abs(1 - dna.density.information.value) + Math.abs(1 - dna.density.compression.value) + Math.abs(1 - dna.composition.gridDiscipline.value);
    case "asymmetric-field": return Math.abs(1 - dna.composition.asymmetry.value) + Math.abs(1 - dna.composition.overlap.value) + Math.abs(0.7 - dna.typography.scaleContrast.value);
    case "continuous-bands": return Math.abs(1 - dna.composition.continuity.value) + Math.abs(0.8 - dna.composition.gridDiscipline.value) + Math.abs(0.65 - dna.density.information.value);
    default: return Number.POSITIVE_INFINITY;
  }
}

export function selectRecipeFromDNA(dna: ExperienceDNA): RecipeDefinition {
  const candidates = Object.values(RECIPE_LIBRARY);
  if (!candidates.length) throw new Error("NEXUS recipe library is empty.");
  return [...candidates].sort((a, b) => recipeDistance(dna, a.id) - recipeDistance(dna, b.id) || a.id.localeCompare(b.id, "en"))[0]!;
}

export function synthesizeAutonomousExperience(input: {
  brief: ExperienceBrief;
  businessProfile: BusinessContentProfile;
  capabilities?: readonly CapabilityDefinition[];
}): AutonomousExperienceResult {
  const evidence = collectEvidence(input.brief);
  const dna = synthesizeExperienceDNA(input.brief);
  const recipe = selectRecipeFromDNA(dna);
  const capabilities = input.capabilities ?? resolveCapabilities(input.brief.requiredCapabilityIds);
  const plan = compileExperiencePlan({ brief: input.brief, dna, capabilities, recipe });
  const contentConstraints = deriveDnaContentConstraints(dna, input.businessProfile);
  const readinessPolicy = toContentReadinessPolicy(contentConstraints);
  return Object.freeze({
    authority: "NEXUS_AUTONOMOUS_EXPERIENCE_V1",
    evidence,
    dna,
    recipe,
    plan,
    contentConstraints,
    readinessPolicy,
  });
}

export function autonomousExperienceDigest(result: AutonomousExperienceResult): `sha256:${string}` {
  const canonical = JSON.stringify({
    authority: result.authority,
    evidence: result.evidence,
    dna: result.dna,
    recipeId: result.recipe.id,
    plan: result.plan,
    contentConstraints: result.contentConstraints,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
