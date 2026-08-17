import {
  compareFingerprints,
  compileExperiencePlan,
  defineExperienceBrief,
  defineExperienceDNA,
  direction,
  intent,
  RECIPE_LIBRARY,
  resolveCapabilities,
  type StyleFingerprintV2
} from "@nexus/experience";

const why =
  "LA PAUSE is a Coyoacán restaurant whose strongest evidence is the lived patio, the food itself and the long-table feeling of lingering over breakfast or lunch; the experience must turn that atmosphere into confident menu, reservation and arrival decisions without becoming a generic restaurant gallery.";

export const brief = defineExperienceBrief({
  version: 2,
  id: "la-pause-coyoacan",
  brand: {
    name: "LA PAUSE",
    industry: "Restaurante mexicano e internacional",
    positioning: "Una pausa de comida, patio y sobremesa en una casona de Francisco Sosa, Coyoacán.",
    personality: ["acogedora", "coyoacanense", "sabrosa", "sin prisa"],
    audiences: ["vecinos y visitantes de Coyoacán", "parejas, familias y grupos que buscan desayuno o comida con terraza"]
  },
  commercialGoal: "Convertir interés visual en consulta de menú, reservación o visita física al restaurante.",
  priorities: ["Transmitir la experiencia real del patio", "Hacer legibles menú y reservación", "Facilitar llegada y contacto"],
  requiredCapabilityIds: ["menu", "reservation", "location", "media", "contact"],
  assets: [
    { id: "restaurant-sign", kind: "photography", status: "available", notes: "Fotografía aportada por el cliente." },
    { id: "food-and-patio-series", kind: "photography", status: "available", notes: "Serie fotográfica aportada por el cliente." }
  ],
  references: [
    {
      id: "current-la-pause-site",
      sourceLabel: "lapause.mx",
      observations: {
        architecture: "The current site exposes menu, reservations and events as core visitor tasks.",
        imageRelationship: "Food and terrace photography carry most of the atmosphere.",
        responsiveBehavior: "Essential restaurant tasks must remain direct on mobile."
      },
      adaptationRule: "inspire-not-copy",
      notes: "Retain business-critical access, replace the generic section stack."
    }
  ],
  forbiddenPatterns: [
    "nav + hero + features + gallery + contact",
    "decorative 01/02/03 numbering",
    "gratuitous arrow glyphs",
    "repeating card grids",
    "generic text-photo hero",
    "repeated split text-image sections",
    "generic beige premium styling",
    "pill/blob/gradient decoration without function"
  ],
  forbiddenWords: [],
  constraints: [
    { id: "semantic-order", statement: "The meal journey must preserve a coherent reading and action order on narrow viewports.", source: "accessibility", severity: "required" },
    { id: "photo-cost", statement: "The experience must remain understandable if rich photography is reduced or unavailable.", source: "performance", severity: "required" },
    { id: "contact-accuracy", statement: "Use the client-provided phone number and address as the primary contact source.", source: "business", severity: "required" },
    { id: "no-invented-menu", statement: "Do not fabricate prices or dishes that are not supported by supplied imagery or current public information.", source: "business", severity: "required" }
  ]
});

export const dna = defineExperienceDNA({
  version: 2,
  subject: brief.id,
  principles: [
    "Cross a threshold before reading a menu",
    "Treat photography as evidence of a real meal, not decoration",
    "Let the visitor move through a table rather than through website sections",
    "Make the final action feel like taking a seat"
  ],
  artDirectionVocabulary: ["casona", "patio", "mesa corrida", "sobremesa", "rojo mantel", "azulejo", "luz filtrada"],
  composition: {
    asymmetry: intent(0.76, why, ["restaurant-sign", "food-and-patio-series"]),
    gridDiscipline: intent(0.38, why),
    overlap: intent(0.48, why),
    continuity: intent(0.93, why),
    dominantFlow: direction("a continuous table runner that bends through thresholds, plates and patio evidence", why)
  },
  density: {
    information: intent(0.44, why),
    whitespace: intent(0.56, why),
    compression: intent(0.3, why)
  },
  geometry: {
    angularity: intent(0.32, why),
    regularity: intent(0.27, why),
    boundaryVisibility: intent(0.24, why),
    dominantShape: direction("long table bands interrupted by circular plate and doorway forms", why)
  },
  typography: {
    scaleContrast: intent(0.7, why),
    hierarchyRigidity: intent(0.36, why),
    expressiveType: intent(0.46, why),
    voice: direction("painted-sign warmth with compact menu annotation", why)
  },
  media: {
    dominance: intent(0.84, why),
    continuity: intent(0.88, why),
    documentaryVsAbstract: intent(0.96, why),
    role: direction("document the passage from street threshold to plate to patio table", why)
  },
  navigation: {
    persistence: intent(0.42, why),
    visibility: intent(0.7, why),
    topology: direction("three practical table tabs anchored to the meal journey", why)
  },
  interaction: {
    discoverability: intent(0.9, why),
    directness: intent(0.88, why),
    spatiality: intent(0.58, why),
    language: direction("move along the table; practical actions remain explicit", why)
  },
  cta: {
    prominence: intent(0.62, why),
    repetition: intent(0.14, why),
    grammar: direction("one seat-taking reservation action, with menu and directions as contextual utilities", why)
  },
  motion: {
    intensity: intent(0.34, why),
    continuity: intent(0.78, why),
    choreography: direction("slow table-runner drift and restrained plate reveals tied to reading progression", why)
  },
  editoriality: intent(0.44, why),
  cinematicity: intent(0.68, why),
  ornamentation: intent(0.18, why)
});

export const capabilities = resolveCapabilities(brief.requiredCapabilityIds);
export const recipe = RECIPE_LIBRARY["media-immersion"]!;
export const plan = compileExperiencePlan({ brief, dna, capabilities, recipe });

export const fingerprint: StyleFingerprintV2 = {
  version: 2,
  subject: brief.id,
  observedAt: "2026-08-16",
  openingSignature: "street-threshold-sign-becomes-table-runner",
  navigationSignature: "compact-table-tabs-menu-reserve-arrive",
  sectionSequence: ["threshold", "first-place-setting", "plate-run", "patio-breath", "take-a-seat"],
  structure: {
    cardReliance: 0.02,
    gridRegularity: 0.18,
    symmetry: 0.22,
    overlap: 0.48,
    whitespace: 0.56,
    continuity: 0.93
  },
  ctaGrammar: ["take-a-seat", "menu-context-link", "directions-context-link"],
  geometryGrammar: ["table-runner-band", "plate-circle", "doorway-crop", "offset-place-setting"],
  mediaGrammar: ["threshold-photo", "dish-as-course-marker", "patio-as-breath", "documentary-crop"],
  motionGrammar: ["runner-drift", "course-reveal", "reduced-motion-static-order"],
  typographyHierarchy: ["painted-sign-wordmark", "table-annotation", "meal-statement"]
};

const genericRestaurantFingerprint: StyleFingerprintV2 = {
  version: 2,
  subject: "generic-restaurant-stack",
  observedAt: "2026-08-16",
  openingSignature: "centered-copy-over-food-photo",
  navigationSignature: "top-nav-menu-gallery-contact",
  sectionSequence: ["hero", "features", "gallery", "menu", "contact"],
  structure: { cardReliance: 0.72, gridRegularity: 0.82, symmetry: 0.76, overlap: 0.12, whitespace: 0.52, continuity: 0.2 },
  ctaGrammar: ["primary-button", "secondary-button", "repeated-book-now"],
  geometryGrammar: ["rounded-card", "three-column-grid", "split-section"],
  mediaGrammar: ["hero-image", "gallery-grid", "alternating-split-photo"],
  motionGrammar: ["fade-up-sections"],
  typographyHierarchy: ["large-serif-display", "sans-body", "eyebrow"]
};

export const originalityReport = compareFingerprints(fingerprint, genericRestaurantFingerprint, {
  policy: {
    overallWarnAbove: 0.62,
    warnAbove: { opening: 0.8, navigation: 0.8, sequence: 0.72, structure: 0.76, ctaGrammar: 0.72 }
  }
});
