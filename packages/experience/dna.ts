import type { DirectionDescriptor, IntentScale, NonEmptyArray } from "./shared";
import { assertIntentScale, assertRationale, assertUiAgnostic } from "./shared";

export type ExperienceDNA = {
  version: 2;
  subject: string;
  principles: NonEmptyArray<string>;
  artDirectionVocabulary: readonly string[];
  composition: {
    asymmetry: IntentScale;
    gridDiscipline: IntentScale;
    overlap: IntentScale;
    continuity: IntentScale;
    dominantFlow: DirectionDescriptor;
  };
  density: {
    information: IntentScale;
    whitespace: IntentScale;
    compression: IntentScale;
  };
  geometry: {
    angularity: IntentScale;
    regularity: IntentScale;
    boundaryVisibility: IntentScale;
    dominantShape: DirectionDescriptor;
  };
  typography: {
    scaleContrast: IntentScale;
    hierarchyRigidity: IntentScale;
    expressiveType: IntentScale;
    voice: DirectionDescriptor;
  };
  media: {
    dominance: IntentScale;
    continuity: IntentScale;
    documentaryVsAbstract: IntentScale;
    role: DirectionDescriptor;
  };
  navigation: {
    persistence: IntentScale;
    visibility: IntentScale;
    topology: DirectionDescriptor;
  };
  interaction: {
    discoverability: IntentScale;
    directness: IntentScale;
    spatiality: IntentScale;
    language: DirectionDescriptor;
  };
  cta: {
    prominence: IntentScale;
    repetition: IntentScale;
    grammar: DirectionDescriptor;
  };
  motion: {
    intensity: IntentScale;
    continuity: IntentScale;
    choreography: DirectionDescriptor;
  };
  editoriality: IntentScale;
  cinematicity: IntentScale;
  ornamentation: IntentScale;
};

function validateDescriptor(descriptor: DirectionDescriptor, label: string): void {
  if (!descriptor.label.trim()) throw new Error(`${label}.label is required.`);
  assertRationale(descriptor.rationale, label);
}

export function defineExperienceDNA(input: ExperienceDNA): ExperienceDNA {
  assertUiAgnostic(input, "ExperienceDNA");
  if (input.version !== 2) throw new Error("ExperienceDNA.version must be 2.");
  if (!input.subject.trim()) throw new Error("ExperienceDNA.subject is required.");

  const scales: Array<[string, IntentScale]> = [
    ["composition.asymmetry", input.composition.asymmetry],
    ["composition.gridDiscipline", input.composition.gridDiscipline],
    ["composition.overlap", input.composition.overlap],
    ["composition.continuity", input.composition.continuity],
    ["density.information", input.density.information],
    ["density.whitespace", input.density.whitespace],
    ["density.compression", input.density.compression],
    ["geometry.angularity", input.geometry.angularity],
    ["geometry.regularity", input.geometry.regularity],
    ["geometry.boundaryVisibility", input.geometry.boundaryVisibility],
    ["typography.scaleContrast", input.typography.scaleContrast],
    ["typography.hierarchyRigidity", input.typography.hierarchyRigidity],
    ["typography.expressiveType", input.typography.expressiveType],
    ["media.dominance", input.media.dominance],
    ["media.continuity", input.media.continuity],
    ["media.documentaryVsAbstract", input.media.documentaryVsAbstract],
    ["navigation.persistence", input.navigation.persistence],
    ["navigation.visibility", input.navigation.visibility],
    ["interaction.discoverability", input.interaction.discoverability],
    ["interaction.directness", input.interaction.directness],
    ["interaction.spatiality", input.interaction.spatiality],
    ["cta.prominence", input.cta.prominence],
    ["cta.repetition", input.cta.repetition],
    ["motion.intensity", input.motion.intensity],
    ["motion.continuity", input.motion.continuity],
    ["editoriality", input.editoriality],
    ["cinematicity", input.cinematicity],
    ["ornamentation", input.ornamentation]
  ];

  scales.forEach(([label, scale]) => assertIntentScale(scale, label));

  validateDescriptor(input.composition.dominantFlow, "composition.dominantFlow");
  validateDescriptor(input.geometry.dominantShape, "geometry.dominantShape");
  validateDescriptor(input.typography.voice, "typography.voice");
  validateDescriptor(input.media.role, "media.role");
  validateDescriptor(input.navigation.topology, "navigation.topology");
  validateDescriptor(input.interaction.language, "interaction.language");
  validateDescriptor(input.cta.grammar, "cta.grammar");
  validateDescriptor(input.motion.choreography, "motion.choreography");

  return Object.freeze(input);
}

export const intent = (value: number, because: string, evidence?: readonly string[]): IntentScale => ({
  value,
  rationale: { because, evidence }
});

export const direction = (label: string, because: string, evidence?: readonly string[]): DirectionDescriptor => ({
  label,
  rationale: { because, evidence }
});
