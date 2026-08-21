export type DesignDnaApproval = Readonly<{
  authority: "HUMAN_ART_DIRECTOR";
  approvedBy: string;
  approvedAt: string;
}>;

export type TypographyDna = Readonly<{
  displayFamily: string;
  bodyFamily: string;
  detailFamily?: string;
  displayWeightRange: readonly [number, number];
  bodyWeightRange: readonly [number, number];
  fluidScaleRatio: number;
  opticalSizing: "AUTO" | "REQUIRED" | "NOT_APPLICABLE";
  headingWrap: "BALANCE" | "PRETTY" | "NORMAL";
  bodyWrap: "PRETTY" | "NORMAL";
}>;

export type CompositionDna = Readonly<{
  alignment: "ASYMMETRIC" | "MIXED" | "SYMMETRIC";
  density: "AIRY" | "BALANCED" | "DENSE";
  sectionRhythm: "IRREGULAR" | "MEASURED" | "COMPACT";
  imageBehavior: readonly string[];
  requiredPatterns: readonly string[];
  forbiddenPatterns: readonly string[];
}>;

export type GeometryDna = Readonly<{
  cornerLanguage: "SHARP" | "SUBTLE" | "SOFT" | "MIXED";
  maximumRepeatedCardColumns: number;
  borderLanguage: readonly string[];
  shapeLanguage: readonly string[];
}>;

export type MotionDna = Readonly<{
  profileId: string;
  intensity: "QUIET" | "CONTROLLED" | "EXPRESSIVE";
  reducedMotionRequired: true;
  scrollDrivenAllowed: boolean;
  viewTransitionsAllowed: boolean;
}>;

export type ProjectDesignDna = Readonly<{
  schemaVersion: 1;
  projectId: string;
  revision: number;
  intent: string;
  typography: TypographyDna;
  composition: CompositionDna;
  geometry: GeometryDna;
  motion: MotionDna;
  approval: DesignDnaApproval;
}>;

const nonEmpty = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
};

const uniqueStrings = (values: readonly string[], label: string): readonly string[] => {
  const normalized = values.map((value) => nonEmpty(value, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} cannot contain duplicates`);
  return Object.freeze(normalized);
};

const weightRange = (range: readonly [number, number], label: string): readonly [number, number] => {
  const [minimum, maximum] = range;
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum > 1000 || minimum > maximum) {
    throw new Error(`${label} must be an integer range inside 1..1000`);
  }
  return Object.freeze([minimum, maximum]);
};

export function validateProjectDesignDna(input: ProjectDesignDna): ProjectDesignDna {
  if (input.schemaVersion !== 1) throw new Error("unsupported Project Design DNA schemaVersion");
  const projectId = nonEmpty(input.projectId, "projectId");
  const intent = nonEmpty(input.intent, "intent");
  if (!Number.isInteger(input.revision) || input.revision < 1) throw new Error("revision must be an integer >= 1");
  if (!Number.isFinite(input.typography.fluidScaleRatio) || input.typography.fluidScaleRatio <= 1 || input.typography.fluidScaleRatio > 2) {
    throw new Error("typography.fluidScaleRatio must be > 1 and <= 2");
  }
  if (!Number.isInteger(input.geometry.maximumRepeatedCardColumns) || input.geometry.maximumRepeatedCardColumns < 0 || input.geometry.maximumRepeatedCardColumns > 12) {
    throw new Error("geometry.maximumRepeatedCardColumns must be an integer in 0..12");
  }
  if (input.motion.reducedMotionRequired !== true) throw new Error("motion.reducedMotionRequired must remain true");
  const approvedBy = nonEmpty(input.approval.approvedBy, "approval.approvedBy");
  const approvedAtMs = Date.parse(input.approval.approvedAt);
  if (!Number.isFinite(approvedAtMs)) throw new Error("approval.approvedAt must be an ISO-compatible timestamp");

  return Object.freeze({
    ...input,
    projectId,
    intent,
    typography: Object.freeze({
      ...input.typography,
      displayFamily: nonEmpty(input.typography.displayFamily, "typography.displayFamily"),
      bodyFamily: nonEmpty(input.typography.bodyFamily, "typography.bodyFamily"),
      detailFamily: input.typography.detailFamily ? nonEmpty(input.typography.detailFamily, "typography.detailFamily") : undefined,
      displayWeightRange: weightRange(input.typography.displayWeightRange, "typography.displayWeightRange"),
      bodyWeightRange: weightRange(input.typography.bodyWeightRange, "typography.bodyWeightRange"),
    }),
    composition: Object.freeze({
      ...input.composition,
      imageBehavior: uniqueStrings(input.composition.imageBehavior, "composition.imageBehavior"),
      requiredPatterns: uniqueStrings(input.composition.requiredPatterns, "composition.requiredPatterns"),
      forbiddenPatterns: uniqueStrings(input.composition.forbiddenPatterns, "composition.forbiddenPatterns"),
    }),
    geometry: Object.freeze({
      ...input.geometry,
      borderLanguage: uniqueStrings(input.geometry.borderLanguage, "geometry.borderLanguage"),
      shapeLanguage: uniqueStrings(input.geometry.shapeLanguage, "geometry.shapeLanguage"),
    }),
    motion: Object.freeze({ ...input.motion, profileId: nonEmpty(input.motion.profileId, "motion.profileId") }),
    approval: Object.freeze({ ...input.approval, approvedBy, approvedAt: new Date(approvedAtMs).toISOString() }),
  });
}

export function assertDesignDnaApproved(input: ProjectDesignDna): void {
  const dna = validateProjectDesignDna(input);
  if (dna.approval.authority !== "HUMAN_ART_DIRECTOR") throw new Error("Project Design DNA requires human art-direction approval");
}
