/**
 * @status experimental
 *
 * STYLE_FINGERPRINT_V0
 *
 * Design rule (non-negotiable per NEXUS V1.1 correction):
 *
 *   THE FINGERPRINT DESCRIBES DESIGN.
 *   IT DOES NOT DEFINE THE DESIGN SPACE.
 *
 * A fingerprint is a structured OBSERVATION of an existing Experience,
 * never a menu of allowed choices. Every dimension below can express:
 *
 *   - a known, previously observed classification, OR
 *   - a custom label for something not seen before, OR
 *   - "unknown" when the observer cannot classify it yet.
 *
 * Nothing here is enforced at build time. Nothing here restricts what an
 * Experience is allowed to look like. This module has zero runtime
 * behavior today — it exists only as a shared vocabulary for describing
 * and later comparing Experiences (manually, by a human, for now).
 *
 * No AI, no computer vision, no automatic extraction. That is intentionally
 * out of scope for V0.
 */

/**
 * A single observed property.
 *
 * - "known": the observation matches a classification NEXUS has already
 *   named. The list of known values is expected to GROW over time as more
 *   Experiences are observed — it is a growing vocabulary, not a fixed enum
 *   contract. Do not treat the known values below as exhaustive or as
 *   guidance for what an Experience "should" pick from.
 * - "custom": the observer is naming something new. `label` is free text.
 * - "unknown": the observer chooses not to classify this property yet.
 */
export type Observation<Known extends string> =
  | { kind: "known"; value: Known }
  | { kind: "custom"; label: string; notes?: string }
  | { kind: "unknown" };

export function known<K extends string>(value: K): Observation<K> {
  return { kind: "known", value };
}

export function custom<K extends string>(
  label: string,
  notes?: string
): Observation<K> {
  return { kind: "custom", label, notes };
}

export function unknown<K extends string>(): Observation<K> {
  return { kind: "unknown" };
}

/* -------------------------------------------------------------------------
 * HERO
 * ---------------------------------------------------------------------- */

/**
 * Known values observed so far. Growing list — not a design menu.
 * Currently seeded only from _template-client's single known composition;
 * expect this list to be nearly meaningless until 3+ real Experiences have
 * been fingerprinted.
 */
export type KnownHeroArrangement =
  | "eyebrow-title-cta-stack"
  | "fullbleed-media-overlay"
  | "split-media-text"
  | "typographic-only";

export type HeroDescriptor = {
  arrangement: Observation<KnownHeroArrangement>;
  mediaPresence: Observation<"none" | "background" | "adjacent" | "dominant">;
  textDensity: Observation<"minimal" | "moderate" | "dense">;
  entryAction: Observation<"single-cta" | "dual-cta" | "no-cta" | "form">;
};

/* -------------------------------------------------------------------------
 * NAVIGATION
 * ---------------------------------------------------------------------- */

export type NavigationDescriptor = {
  persistence: Observation<"sticky" | "static" | "hidden-until-scroll">;
  density: Observation<"minimal" | "standard" | "dense">;
  ctaPresence: Observation<"none" | "single" | "multiple">;
};

/* -------------------------------------------------------------------------
 * TYPOGRAPHIC HIERARCHY
 * ---------------------------------------------------------------------- */

export type TypographyDescriptor = {
  scaleContrast: Observation<"subtle" | "moderate" | "extreme">;
  caseTreatment: Observation<"sentence" | "uppercase-labels" | "all-caps-display">;
  voice: Observation<"editorial" | "technical" | "conversational">;
};

/* -------------------------------------------------------------------------
 * CTA — described by observable properties, not a single closed tag
 * ---------------------------------------------------------------------- */

export type CtaDescriptor = {
  cornerProfile: Observation<"sharp" | "soft" | "full-round">;
  aspectTendency: Observation<"compact" | "elongated" | "square">;
  borderTreatment: Observation<"none" | "hairline" | "bold" | "double">;
  fillTreatment: Observation<"solid" | "outline" | "ghost" | "gradient" | "textured">;
  iconRelationship: Observation<"none" | "leading" | "trailing" | "icon-only">;
  textTreatment: Observation<"sentence-case" | "uppercase" | "mixed-emphasis">;
};

/* -------------------------------------------------------------------------
 * RADIUS DISTRIBUTION
 * ---------------------------------------------------------------------- */

export type RadiusDescriptor = {
  distribution: Observation<"none" | "sharp-accents" | "uniform-rounded" | "mixed">;
};

/* -------------------------------------------------------------------------
 * CARD DEPENDENCE
 * ---------------------------------------------------------------------- */

export type CardDependenceDescriptor = {
  relianceLevel: Observation<"none" | "low" | "moderate" | "heavy">;
  alternativeStructures: Observation<
    "editorial-blocks" | "timeline" | "list" | "collage" | "none-observed"
  >;
};

/* -------------------------------------------------------------------------
 * SECTION RHYTHM
 * ---------------------------------------------------------------------- */

export type SectionRhythmDescriptor = {
  pacing: Observation<"uniform" | "alternating" | "asymmetric">;
  verticalDensity: Observation<"airy" | "balanced" | "dense">;
};

/* -------------------------------------------------------------------------
 * ALIGNMENT TENDENCY
 * ---------------------------------------------------------------------- */

export type AlignmentDescriptor = {
  tendency: Observation<"centered" | "left-aligned" | "mixed-editorial">;
};

/* -------------------------------------------------------------------------
 * MEDIA TREATMENT
 * ---------------------------------------------------------------------- */

export type MediaDescriptor = {
  dominantType: Observation<"photography" | "illustration" | "icon-only" | "video" | "none">;
  treatment: Observation<"documentary" | "stylized" | "abstract">;
};

/* -------------------------------------------------------------------------
 * MOTION LANGUAGE
 * ---------------------------------------------------------------------- */

export type MotionDescriptor = {
  presence: Observation<"none" | "subtle" | "expressive">;
  character: Observation<"fade-rise" | "scale" | "parallax" | "stagger" | "instant">;
};

/* -------------------------------------------------------------------------
 * SURFACE TREATMENT
 * ---------------------------------------------------------------------- */

export type SurfaceDescriptor = {
  depth: Observation<"flat" | "layered-shadow" | "gradient" | "textured">;
};

/* -------------------------------------------------------------------------
 * DENSITY (overall)
 * ---------------------------------------------------------------------- */

export type DensityDescriptor = {
  overall: Observation<"airy" | "balanced" | "dense">;
};

/* -------------------------------------------------------------------------
 * FULL FINGERPRINT
 * ---------------------------------------------------------------------- */

export type StyleFingerprintV0 = {
  /** Freeform identifier for what was observed, e.g. "reference-meson". */
  subject: string;
  /** ISO date the observation was recorded. Fingerprints are snapshots, not live data. */
  observedAt: string;
  hero: HeroDescriptor;
  navigation: NavigationDescriptor;
  typography: TypographyDescriptor;
  cta: CtaDescriptor;
  radius: RadiusDescriptor;
  cardDependence: CardDependenceDescriptor;
  sectionRhythm: SectionRhythmDescriptor;
  alignment: AlignmentDescriptor;
  media: MediaDescriptor;
  motion: MotionDescriptor;
  surface: SurfaceDescriptor;
  density: DensityDescriptor;
  /** Anything observed that doesn't fit a dimension above. Never discard signal. */
  freeformNotes?: string;
};
